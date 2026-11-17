/**
 * Pet Friend: ONE Apps Script server for all three tabs of the app.
 *
 *   POS        search, sale, today                       body {action, pin, ...}       -> {ok, data} / {ok:false, error}
 *   Orders     listOrders, getOrder, fulfill,            body {action, key, ...}       -> {ok, ...}  / {ok:false, error}
 *              getReturnable, processReturn,
 *              listPOs, getPO, receivePO (receiving supplier purchase orders)
 *   Shipments  saveShipment, saveOther, getShipment,     body {fn, args: [pin, ...]}   -> {result}   / {error}
 *              checkPin
 *
 * Each part keeps its own login (POS_PIN, APP_KEY, APP_PIN) and answers in the same format as
 * before, so the app only needs this script's URL.
 *
 * Script Properties (Project Settings > Script properties). Values are never in this file.
 *   Shared
 *     SHOPIFY_STORE          xxx.myshopify.com
 *     SHOPIFY_CLIENT_ID      Orders' Shopify app (Dev Dashboard): client ID   } used for Orders, Returns and
 *     SHOPIFY_CLIENT_SECRET  Orders' Shopify app: client secret               } Shipments' item lists
 *     SHOPIFY_TOKEN          (optional) permanent shpat_ token, used only if the two above are not set
 *   POS
 *     POS_PIN                the POS PIN
 *     SHOP                   store handle, e.g. petfriendstores (without .myshopify.com)
 *     CLIENT_ID, CLIENT_SECRET   the POS Shopify app (can be the same app as Orders)
 *   Orders
 *     APP_KEY                the Orders app key
 *     SHOPIFY_LOCATION_ID    (optional) where returns are restocked if the original location is unknown
 *   Shipments
 *     APP_PIN                the Shipments PIN
 *     SHEET_ID               the Google Sheet's ID (only if this script is NOT opened from that sheet)
 *     PHOTO_FOLDER_ID        (optional; created on first photo)
 *     BOSTA_API_KEY, BOSTA_AUTH_HEADER_NAME, BOSTA_DELIVERY_URL (optional), BOSTA_FEES_URL (optional)
 *     FLAG_REGEX             (optional, default "bulky")
 *
 * Shopify scopes for the Orders app: read_orders, read_products,
 *   read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders,
 *   read_returns, write_returns (and read_locations for restocking),
 *   and for receiving from suppliers: read_inventory_purchase_orders, read_inventory_transfers,
 *   read_inventory, write_inventory_shipments_received_items, write_inventory_shipments.
 *
 * Deploy: Deploy > Manage deployments (or New deployment) > Web app, Execute as: Me, Who has access: Anyone.
 * Run installTrigger() once for the hourly Bosta sync. Run testAll() to check the setup.
 */

const P = PropertiesService.getScriptProperties();

/* =====================================================================================
 * Entry points
 * ===================================================================================== */

function doGet() {
  return json_({ ok: true, service: 'petfriend', parts: ['pos', 'orders', 'shipments'] });
}

function doPost(e) {
  let q;
  try { q = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Bad request' }); }
  if (q && q.fn) return json_(shipmentsApi_(q));                                // Shipments: {fn, args}
  if (q && Object.prototype.hasOwnProperty.call(POS_ACTIONS, q.action)) return json_(posApi_(q));
  if (q && Object.prototype.hasOwnProperty.call(ORDER_ACTIONS, q.action)) return json_(ordersApi_(q));
  return json_({ ok: false, error: 'Unknown action' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* =====================================================================================
 * Shopify (Orders, Returns, Shipments)
 * ===================================================================================== */

const SHOPIFY_API = '2025-01';

// Admin API token. Client credentials (tokens last 24h, cached); a fixed SHOPIFY_TOKEN only if no client ID is set.
function getToken_() {
  const id = P.getProperty('SHOPIFY_CLIENT_ID'), secret = P.getProperty('SHOPIFY_CLIENT_SECRET');
  if (!id || !secret) {
    const fixed = P.getProperty('SHOPIFY_TOKEN');
    if (fixed) return fixed;
    throw new Error('Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in Script Properties');
  }
  const cache = CacheService.getScriptCache();
  const cached = cache.get('shopify_token');
  if (cached) return cached;
  const res = UrlFetchApp.fetch('https://' + P.getProperty('SHOPIFY_STORE') + '/admin/oauth/access_token', {
    method: 'post',
    payload: { grant_type: 'client_credentials', client_id: id, client_secret: secret },
    muteHttpExceptions: true
  });
  const j = JSON.parse(res.getContentText());
  if (!j.access_token) throw new Error('Token request failed: ' + res.getContentText());
  cache.put('shopify_token', j.access_token, 20 * 60 * 60); // 20h, token lives 24h
  return j.access_token;
}

function shopify_(query, variables) { return shopifyAt_(SHOPIFY_API, query, variables); }

function shopifyAt_(version, query, variables, retried) {
  const res = UrlFetchApp.fetch('https://' + P.getProperty('SHOPIFY_STORE') + '/admin/api/' + version + '/graphql.json', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Shopify-Access-Token': getToken_() },
    payload: JSON.stringify({ query: query, variables: variables || {} }),
    muteHttpExceptions: true
  });
  const j = JSON.parse(res.getContentText());
  // A cached token keeps the permissions it was issued with: after adding scopes to the Shopify app,
  // "Access denied" means it is out of date, so get a fresh one and try once more.
  if (!retried && (res.getResponseCode() === 401 || /access denied/i.test(JSON.stringify(j.errors || '')))) {
    CacheService.getScriptCache().remove('shopify_token');
    return shopifyAt_(version, query, variables, true);
  }
  if (j.errors) throw new Error('Shopify: ' + (Array.isArray(j.errors) ? j.errors.map(function (x) { return x.message; }).join('; ') : JSON.stringify(j.errors)));
  return j.data;
}

function userErrors_(errs) {
  if (errs && errs.length) throw new Error(errs.map(function (x) { return x.message; }).join('; '));
}

/* =====================================================================================
 * POS
 * ===================================================================================== */

const POS_ACTIONS = { search: posSearch_, sale: posSale_, today: posToday_ };
const POS_API = '2026-10';
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100; // Shopify accepts at most 2 decimals

function posApi_(r) {
  try {
    if (r.pin !== P.getProperty('POS_PIN')) throw new Error('Wrong PIN');
    return { ok: true, data: POS_ACTIONS[r.action](r) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// POS Shopify app token (client credentials grant, token lasts 24h), cached
function posToken_(force) {
  const cache = CacheService.getScriptCache();
  if (!force && cache.get('tok')) return cache.get('tok');
  const res = UrlFetchApp.fetch('https://' + P.getProperty('SHOP') + '.myshopify.com/admin/oauth/access_token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'client_credentials', client_id: P.getProperty('CLIENT_ID'), client_secret: P.getProperty('CLIENT_SECRET') }
  });
  const j = JSON.parse(res.getContentText());
  if (!j.access_token) throw new Error('Token request failed: ' + res.getContentText());
  cache.put('tok', j.access_token, 21000); // ~5.8h, safely under the 24h expiry
  return j.access_token;
}

function posGql_(query, variables, retried) {
  const res = UrlFetchApp.fetch('https://' + P.getProperty('SHOP') + '.myshopify.com/admin/api/' + POS_API + '/graphql.json', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'X-Shopify-Access-Token': posToken_(retried) },
    payload: JSON.stringify({ query, variables })
  });
  if (res.getResponseCode() === 401 && !retried) return posGql_(query, variables, true);
  const j = JSON.parse(res.getContentText());
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

function posChk_(errs, step) { if (errs && errs.length) throw new Error('[v2 ' + step + '] ' + errs.map(x => x.message).join('; ')); }

function posSearch_(r) {
  const q = String(r.q).trim();
  const query = /^\d+$/.test(q) ? `barcode:${q} OR sku:${q}` : q;
  return posGql_(`query($q:String!){productVariants(first:8,query:$q){nodes{id displayName sku barcode price inventoryQuantity}}}`, { q: query }).productVariants.nodes;
}

function posSale_(r) {
  // Verify listed prices on the server, then set any lower price as an exact price override (no % rounding issues)
  const lp = {};
  const v = posGql_(`query($ids:[ID!]!){shop{currencyCode} nodes(ids:$ids){... on ProductVariant{id price}}}`, { ids: r.items.map(i => i.id) });
  v.nodes.forEach(n => lp[n.id] = Number(n.price));
  const cur = v.shop.currencyCode;
  const edits = [];
  const lineItems = r.items.map(i => {
    const li = { variantId: i.id, quantity: i.qty }, list = lp[i.id], p = r2(i.price);
    if (!(p >= 0) || p > list) throw new Error('Price must be between 0 and the listed price');
    if (p < list) {
      li.priceOverride = { amount: p.toFixed(2), currencyCode: cur };
      edits.push(i.id.split('/').pop() + ': ' + list + ' -> ' + p);
    }
    return li;
  });
  const input = { tags: ['POS'], note: 'POS cash sale' + (edits.length ? ' | price changed: ' + edits.join(', ') : ''), lineItems };
  const dv = r2(r.discountValue || 0);
  if (dv > 0) {
    if (r.discountType !== 'amount' && dv > 100) throw new Error('Discount cannot exceed 100%');
    input.appliedDiscount = { valueType: r.discountType === 'amount' ? 'FIXED_AMOUNT' : 'PERCENTAGE', value: dv, title: 'POS discount' };
  }

  let d = posGql_(`mutation($i:DraftOrderInput!){draftOrderCreate(input:$i){draftOrder{id} userErrors{message}}}`, { i: input });
  posChk_(d.draftOrderCreate.userErrors, 'create');

  d = posGql_(`mutation($id:ID!){draftOrderComplete(id:$id,paymentPending:false){draftOrder{order{id name totalPriceSet{shopMoney{amount}} fulfillmentOrders(first:5){nodes{id}}}} userErrors{message}}}`,
    { id: d.draftOrderCreate.draftOrder.id });
  posChk_(d.draftOrderComplete.userErrors, 'complete');
  const o = d.draftOrderComplete.draftOrder.order;

  // Fulfill immediately so stock is deducted and the order closes
  const f = posGql_(`mutation($f:FulfillmentInput!){fulfillmentCreate(fulfillment:$f){userErrors{message}}}`,
    { f: { notifyCustomer: false, lineItemsByFulfillmentOrder: o.fulfillmentOrders.nodes.map(n => ({ fulfillmentOrderId: n.id })) } });
  posChk_(f.fulfillmentCreate.userErrors, 'fulfill');

  return { name: o.name, total: o.totalPriceSet.shopMoney.amount };
}

function posToday_() {
  const day = Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyy-MM-dd');
  return posGql_(`query($q:String!){orders(first:100,query:$q){nodes{name createdAt totalPriceSet{shopMoney{amount}}}}}`, { q: `tag:POS created_at:>=${day}` })
    .orders.nodes.map(o => ({ name: o.name, time: o.createdAt, total: o.totalPriceSet.shopMoney.amount }));
}

/* =====================================================================================
 * Orders: fulfill + returns
 * ===================================================================================== */

const ORDER_ACTIONS = {
  listOrders: function () { return listOrders_(); },
  getOrder: function (r) { return getOrder_(r.query); },
  fulfill: function (r) { return fulfill_(r.items, r.notify); },
  getReturnable: function (r) { return getReturnable_(r); },
  processReturn: function (r) { return processReturn_(r); },
  listPOs: function () { return listPOs_(); },
  getPO: function (r) { return getPO_(r); },
  receivePO: function (r) { return receivePO_(r); }
};

function ordersApi_(r) {
  try {
    const key = P.getProperty('APP_KEY');
    if (!key || r.key !== key) return { ok: false, error: 'Wrong app key' };
    return ORDER_ACTIONS[r.action](r);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// Open orders that still need fulfilling (unfulfilled or partially fulfilled), oldest first
function listOrders_() {
  const data = shopify_(
    `query {
      orders(first: 100, sortKey: CREATED_AT, reverse: false,
             query: "status:open AND (fulfillment_status:unshipped OR fulfillment_status:partial)") {
        edges { node {
          name createdAt cancelledAt displayFulfillmentStatus
          currentSubtotalLineItemsQuantity
          shippingAddress { name city }
        } }
      }
    }`
  );
  const orders = data.orders.edges
    .map(function (e) { return e.node; })
    .filter(function (o) { return !o.cancelledAt; })
    .map(function (o) {
      return {
        name: o.name,
        createdAt: o.createdAt,
        status: o.displayFulfillmentStatus,
        qty: o.currentSubtotalLineItemsQuantity,
        customer: o.shippingAddress ? o.shippingAddress.name : '',
        city: o.shippingAddress ? o.shippingAddress.city : ''
      };
    });
  return { ok: true, orders: orders };
}

function getOrder_(raw) {
  const q = String(raw || '').trim().replace(/^#/, '');
  if (!q) return { ok: false, error: 'Enter an order number' };

  const data = shopify_(
    `query($q: String!) {
      orders(first: 1, query: $q) {
        edges { node {
          id name cancelledAt displayFulfillmentStatus
          fulfillmentOrders(first: 10) { edges { node {
            id status
            assignedLocation { name }
            lineItems(first: 100) { edges { node {
              id remainingQuantity
              lineItem {
                title variantTitle sku
                image { url }
                variant { barcode }
              }
            } } }
          } } }
        } }
      }
    }`,
    { q: 'name:' + q }
  );

  const edge = data.orders.edges[0];
  if (!edge) return { ok: false, error: 'Order ' + q + ' not found' };
  const order = edge.node;
  if (order.cancelledAt) return { ok: false, error: 'Order ' + order.name + ' is cancelled' };

  const items = [];
  order.fulfillmentOrders.edges.forEach(function (fe) {
    const fo = fe.node;
    if (fo.status !== 'OPEN' && fo.status !== 'IN_PROGRESS') return;
    fo.lineItems.edges.forEach(function (le) {
      const li = le.node;
      if (li.remainingQuantity < 1) return;
      items.push({
        foId: fo.id,
        foliId: li.id,
        need: li.remainingQuantity,
        title: li.lineItem.title + (li.lineItem.variantTitle ? ' - ' + li.lineItem.variantTitle : ''),
        sku: li.lineItem.sku || '',
        barcode: (li.lineItem.variant && li.lineItem.variant.barcode) || '',
        image: li.lineItem.image ? li.lineItem.image.url : ''
      });
    });
  });

  if (!items.length) {
    return { ok: false, error: 'Order ' + order.name + ' has nothing left to fulfill (' + order.displayFulfillmentStatus + ')' };
  }
  return { ok: true, order: { id: order.id, name: order.name }, items: items };
}

function fulfill_(items, notify) {
  if (!items || !items.length) return { ok: false, error: 'No items' };

  const grouped = {};
  items.forEach(function (it) {
    (grouped[it.foId] = grouped[it.foId] || []).push({ id: it.foliId, quantity: it.qty });
  });
  const lineItemsByFulfillmentOrder = Object.keys(grouped).map(function (foId) {
    return { fulfillmentOrderId: foId, fulfillmentOrderLineItems: grouped[foId] };
  });

  const data = shopify_(
    `mutation($f: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $f) {
        fulfillment { id status }
        userErrors { field message }
      }
    }`,
    { f: { notifyCustomer: !!notify, lineItemsByFulfillmentOrder: lineItemsByFulfillmentOrder } }
  );

  const r = data.fulfillmentCreate;
  if (r.userErrors && r.userErrors.length) {
    return { ok: false, error: r.userErrors.map(function (u) { return u.message; }).join('; ') };
  }
  return { ok: true, status: r.fulfillment.status };
}

/** Returns: fulfilled items on an order that can still be returned. */
function getReturnable_(body) {
  const num = String(body.query || '').replace(/[^0-9a-z]/gi, '');
  if (!num) throw new Error('Missing order number');

  const found = shopify_(
    'query($q: String!) { orders(first: 1, query: $q) { nodes { id name } } }',
    { q: 'name:#' + num + ' OR name:' + num }
  );
  const order = found.orders.nodes[0];
  if (!order) throw new Error('Order ' + num + ' not found');

  const data = shopify_(
    'query($id: ID!) {' +
    '  returnableFulfillments(orderId: $id, first: 25) { nodes {' +
    '    fulfillment { location { id } }' +
    '    returnableFulfillmentLineItems(first: 100) { nodes {' +
    '      quantity' +
    '      fulfillmentLineItem { id lineItem { title sku image { url } variant { barcode sku } } }' +
    '    } }' +
    '  } }' +
    '}',
    { id: order.id }
  );

  const items = [];
  data.returnableFulfillments.nodes.forEach(function (rf) {
    const locationId = rf.fulfillment && rf.fulfillment.location ? rf.fulfillment.location.id : '';
    rf.returnableFulfillmentLineItems.nodes.forEach(function (n) {
      if (!n.quantity) return;
      const li = n.fulfillmentLineItem.lineItem || {};
      const v = li.variant || {};
      items.push({
        fliId: n.fulfillmentLineItem.id,
        locationId: locationId,
        title: li.title || 'Item',
        sku: v.sku || li.sku || '',
        barcode: v.barcode || '',
        image: li.image ? li.image.url : '',
        need: n.quantity            // how many can be returned
      });
    });
  });

  return { ok: true, order: { id: order.id, name: order.name }, items: items };
}

/** Returns: creates the return in Shopify and (optionally) restocks the items. No refund is made here. */
function processReturn_(body) {
  const items = (body.items || []).filter(function (i) { return i.fliId && i.qty > 0; });
  if (!body.orderId || !items.length) throw new Error('Nothing to return');
  const reason = body.reason || 'UNKNOWN';

  const created = shopify_(
    'mutation($input: ReturnInput!) {' +
    '  returnCreate(returnInput: $input) {' +
    '    return { id name reverseFulfillmentOrders(first: 10) { nodes {' +
    '      lineItems(first: 100) { nodes { id totalQuantity fulfillmentLineItem { id } } }' +
    '    } } }' +
    '    userErrors { field message }' +
    '  }' +
    '}',
    {
      input: {
        orderId: body.orderId,
        notifyCustomer: !!body.notify,
        returnLineItems: items.map(function (i) {
          return { fulfillmentLineItemId: i.fliId, quantity: Number(i.qty), returnReason: reason };
        })
      }
    }
  );
  userErrors_(created.returnCreate.userErrors);
  const ret = created.returnCreate.return;

  if (body.restock) {
    const locByFli = {};
    items.forEach(function (i) { locByFli[i.fliId] = i.locationId; });
    let fallbackLoc = null;
    const inputs = [];
    ret.reverseFulfillmentOrders.nodes.forEach(function (rfo) {
      rfo.lineItems.nodes.forEach(function (li) {
        let loc = li.fulfillmentLineItem && locByFli[li.fulfillmentLineItem.id];
        if (!loc) loc = fallbackLoc || (fallbackLoc = defaultLocation_());
        inputs.push({
          reverseFulfillmentOrderLineItemId: li.id,
          quantity: li.totalQuantity,
          dispositionType: 'RESTOCKED',
          locationId: loc
        });
      });
    });
    if (inputs.length) {
      const disp = shopify_(
        'mutation($d: [ReverseFulfillmentOrderDisposeInput!]!) {' +
        '  reverseFulfillmentOrderDispose(dispositionInputs: $d) { userErrors { field message } }' +
        '}',
        { d: inputs }
      );
      // The return already exists at this point, so say so if restocking fails
      try { userErrors_(disp.reverseFulfillmentOrderDispose.userErrors); }
      catch (e) { throw new Error('Return ' + ret.name + ' was created, but restocking failed: ' + e.message); }
    }
  }

  return { ok: true, returnName: ret.name };
}

function defaultLocation_() {
  const id = P.getProperty('SHOPIFY_LOCATION_ID');
  if (id) return id;
  const d = shopify_('{ locations(first: 1) { nodes { id } } }');
  if (!d.locations.nodes.length) throw new Error('No Shopify location found for restocking');
  return d.locations.nodes[0].id;
}

/* =====================================================================================
 * Orders: receiving stock from suppliers (Shopify purchase orders)
 *
 * A purchase order (PO) that is ORDERED has one or more inventory transfers; the goods arrive on
 * the transfers' shipments. Receiving = inventoryShipmentReceive on those shipment lines (ACCEPTED),
 * which adds the stock at the PO's destination location. Anything not scanned stays open on the PO.
 * If a transfer has no shipment yet, one is created for exactly what was scanned, then received.
 * Needs API 2026-10 or later (purchase orders became readable there).
 * ===================================================================================== */

const RECEIVE_API = '2026-10';
const PO_ITEM_FIELDS = 'inventoryItem { id sku variants(first: 1) { nodes { displayName barcode sku } } }';

function poItem_(inv, extra) {
  const v = (inv && inv.variants && inv.variants.nodes[0]) || {};
  return Object.assign({ title: v.displayName || 'Item', sku: v.sku || (inv && inv.sku) || '', barcode: v.barcode || '', image: '' }, extra);
}
function digits_(s) { return String(s || '').replace(/\D/g, ''); }

/** Purchase orders still waiting for stock (status ORDERED, not fully received). */
function listPOs_() {
  const d = shopifyAt_(RECEIVE_API,
    'query { inventoryPurchaseOrders(first: 100, query: "status:ORDERED") { nodes {' +
    '  id name orderedAt origin { supplierName } destination { name }' +
    '  transfers(first: 3) { nodes { totalQuantity receivedQuantity } }' +
    '} } }');
  const orders = d.inventoryPurchaseOrders.nodes.map(function (po) {
    const total = po.transfers.nodes.reduce(function (s, t) { return s + t.totalQuantity; }, 0);
    const received = po.transfers.nodes.reduce(function (s, t) { return s + t.receivedQuantity; }, 0);
    return {
      id: po.id, name: po.name, status: 'ORDERED',
      customer: po.origin && po.origin.supplierName || '',      // shown where the customer is for orders
      city: po.destination && po.destination.name || '',
      createdAt: po.orderedAt,
      qty: Math.max(0, total - received)
    };
  }).filter(function (po) { return po.qty > 0; });
  return { ok: true, orders: orders };
}

/** One purchase order with everything still to receive, line by line. */
function getPO_(body) {
  const q = String(body.query || '').trim().toUpperCase(), num = digits_(q);
  if (!num) throw new Error('Enter a purchase order number');
  const list = shopifyAt_(RECEIVE_API, 'query { inventoryPurchaseOrders(first: 250, query: "status:ORDERED") { nodes { id name } } }')
    .inventoryPurchaseOrders.nodes;
  const found = list.filter(function (po) { return po.name.toUpperCase() === q; })[0] ||
                list.filter(function (po) { return digits_(po.name) === num; })[0];
  if (!found) throw new Error('Purchase order ' + q + ' not found (or not marked as ordered)');

  const po = shopifyAt_(RECEIVE_API,
    'query($id: ID!) { inventoryPurchaseOrder(id: $id) { id name origin { supplierName } destination { name }' +
    '  transfers(first: 5) { nodes { id status shipments(first: 10) { nodes { id status } } } }' +
    '} }', { id: found.id }).inventoryPurchaseOrder;

  const items = [];
  po.transfers.nodes.forEach(function (t) {
    const open = t.shipments.nodes.filter(function (sh) { return sh.status === 'IN_TRANSIT' || sh.status === 'PARTIALLY_RECEIVED'; });
    open.forEach(function (sh) {
      const lines = shopifyAt_(RECEIVE_API,
        'query($id: ID!) { inventoryShipment(id: $id) { lineItems(first: 250) { nodes { id unreceivedQuantity ' + PO_ITEM_FIELDS + ' } } } }',
        { id: sh.id }).inventoryShipment.lineItems.nodes;
      lines.forEach(function (l) {
        if (l.unreceivedQuantity > 0) items.push(poItem_(l.inventoryItem, { shipmentId: sh.id, sliId: l.id, need: l.unreceivedQuantity }));
      });
    });
    if (!open.length && t.status !== 'TRANSFERRED' && t.status !== 'CANCELED') {
      // No incoming shipment yet: offer what has not been shipped; a shipment is created when receiving
      const lines = shopifyAt_(RECEIVE_API,
        'query($id: ID!) { inventoryTransfer(id: $id) { lineItems(first: 250) { nodes { shippableQuantity ' + PO_ITEM_FIELDS + ' } } } }',
        { id: t.id }).inventoryTransfer.lineItems.nodes;
      lines.forEach(function (l) {
        if (l.shippableQuantity > 0 && l.inventoryItem) items.push(poItem_(l.inventoryItem, { transferId: t.id, inventoryItemId: l.inventoryItem.id, need: l.shippableQuantity }));
      });
    }
  });
  if (!items.length) throw new Error('Purchase order ' + po.name + ' has nothing left to receive');
  return {
    ok: true,
    order: { id: po.id, name: po.name, supplier: po.origin && po.origin.supplierName || '', location: po.destination && po.destination.name || '' },
    items: items
  };
}

/** Receives the scanned quantities (ACCEPTED) into stock. requestId makes a repeated tap safe. */
function receivePO_(body) {
  const items = (body.items || []).filter(function (i) { return Number(i.qty) > 0; });
  if (!items.length) throw new Error('Nothing to receive');
  const rid = String(body.requestId || Utilities.getUuid());
  const byShip = {}, byTransfer = {};
  items.forEach(function (i) {
    if (i.shipmentId && i.sliId) (byShip[i.shipmentId] = byShip[i.shipmentId] || []).push({ shipmentLineItemId: i.sliId, quantity: Number(i.qty), reason: 'ACCEPTED' });
    else if (i.transferId && i.inventoryItemId) (byTransfer[i.transferId] = byTransfer[i.transferId] || []).push({ inventoryItemId: i.inventoryItemId, quantity: Number(i.qty) });
  });

  let step = 0, done = 0;
  try {
    Object.keys(byTransfer).forEach(function (tid) {
      const c = shopifyAt_(RECEIVE_API,
        'mutation($input: InventoryShipmentCreateInput!, $key: String!) {' +
        '  inventoryShipmentCreateInTransit(input: $input) @idempotent(key: $key) {' +
        '    inventoryShipment { id lineItems(first: 250) { nodes { id quantity } } }' +
        '    userErrors { field message }' +
        '  }' +
        '}', { input: { movementId: tid, lineItems: byTransfer[tid] }, key: rid + '-t' + (step++) });
      userErrors_(c.inventoryShipmentCreateInTransit.userErrors);
      const sh = c.inventoryShipmentCreateInTransit.inventoryShipment;
      byShip[sh.id] = (byShip[sh.id] || []).concat(sh.lineItems.nodes.map(function (l) {
        return { shipmentLineItemId: l.id, quantity: l.quantity, reason: 'ACCEPTED' };
      }));
    });
    Object.keys(byShip).forEach(function (sid) {
      const res = shopifyAt_(RECEIVE_API,
        'mutation($id: ID!, $li: [InventoryShipmentReceiveItemInput!], $key: String!) {' +
        '  inventoryShipmentReceive(id: $id, lineItems: $li) @idempotent(key: $key) {' +
        '    inventoryShipment { id status }' +
        '    userErrors { field message }' +
        '  }' +
        '}', { id: sid, li: byShip[sid], key: rid + '-s' + (step++) });
      userErrors_(res.inventoryShipmentReceive.userErrors);
      done += byShip[sid].reduce(function (s, l) { return s + l.quantity; }, 0);
    });
  } catch (e) {
    if (done) throw new Error(done + ' items were received, then it stopped: ' + e.message + '. Load the purchase order again to see what is left.');
    throw e;
  }
  return { ok: true, received: done };
}

/* =====================================================================================
 * Shipments: photos + Bosta bulky tracker
 * ===================================================================================== */

const SHIP_FNS = { saveShipment: saveShipment, saveOther: saveOther, getShipment: getShipment, checkPin: checkPin };
const DEFAULT_URL = 'https://app.bosta.co/api/v2/deliveries/business/{tn}';
const HEAD = {
  Shipments: ['Time', 'Tracking', 'FileId', 'PhotoURL', 'Note', 'ScannedBy', 'Carrier'],
  Tracking: ['Tracking', 'FirstScanned', 'Photos', 'BostaState', 'Size', 'Done'],
  Bulky: ['Tracking', 'Order', 'Size', 'ExpectedFeeVAT', 'ShippingFee', 'SizeCost', 'MaterialFee',
    'FinalBostaFees', 'State', 'Items', 'PhotoLinks', 'DetectedAt', 'FinalizedAt', 'Status']
};

/** Shipments JSON API (body {fn, args}) */
function shipmentsApi_(q) {
  try {
    if (!Object.prototype.hasOwnProperty.call(SHIP_FNS, q.fn)) throw new Error('Bad request');
    return { result: SHIP_FNS[q.fn].apply(null, q.args || []) };
  } catch (err) { return { error: err.message }; }
}

function checkPin(pin) { pin_(pin); return true; }
function sh_(name) {
  const ss = SpreadsheetApp.getActive() || SpreadsheetApp.openById(P.getProperty('SHEET_ID'));
  let s = ss.getSheetByName(name);
  if (!s) { s = ss.insertSheet(name); s.appendRow(HEAD[name]); s.setFrozenRows(1); }
  return s;
}
function pin_(p) { if (String(p) !== P.getProperty('APP_PIN')) throw new Error('Wrong PIN'); }
function folder_() {
  let id = P.getProperty('PHOTO_FOLDER_ID');
  if (!id) { id = DriveApp.createFolder('Shipment Photos').getId(); P.setProperty('PHOTO_FOLDER_ID', id); }
  return DriveApp.getFolderById(id);
}
function carrierCol_() { const s = sh_('Shipments'); if (!s.getRange(1, 7).getValue()) s.getRange(1, 7).setValue('Carrier'); return s; }
function rows_(name) { const v = sh_(name).getDataRange().getValues(); v.shift(); return v; }
function findRow_(name, tn) {
  const v = sh_(name).getRange(1, 1, sh_(name).getLastRow(), 1).getValues();
  for (let i = 1; i < v.length; i++) if (String(v[i][0]) === tn) return i + 1;
  return 0;
}

/** photos: array of data URLs (jpeg) */
function saveShipment(pin, tn, photos, note, force) {
  pin_(pin); tn = String(tn).replace(/\D/g, '').slice(-10);
  if (!/^\d{10}$/.test(tn)) throw new Error('Need at least 10 digits of the barcode');
  if (!photos || !photos.length) throw new Error('Add at least one photo');
  if (!force && !findRow_('Tracking', tn) && P.getProperty('BOSTA_API_KEY')) {
    try { bosta_(tn); } catch (e) {               // block misreads: number must exist in Bosta
      if (/Bosta (400|404)/.test(e.message)) throw new Error(tn + ' not found in Bosta. Misread, scan again.');
    }
  }
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const r0 = findRow_('Tracking', tn);
    if (r0 && !force && Number(sh_('Tracking').getRange(r0, 3).getValue()) > 0) {
      const first = rows_('Shipments').find(x => String(x[1]) === tn);
      return { duplicate: true, at: first ? Utilities.formatDate(new Date(first[0]), 'Africa/Cairo', 'dd MMM HH:mm') : '' };
    }
    const user = Session.getActiveUser().getEmail() || 'app', now = new Date(), f = folder_();
    photos.forEach((d, i) => {
      const blob = Utilities.newBlob(Utilities.base64Decode(d.split(',')[1]), 'image/jpeg',
        tn + '_' + Utilities.formatDate(now, 'Africa/Cairo', 'yyyyMMdd-HHmmss') + '_' + (i + 1) + '.jpg');
      const file = f.createFile(blob);
      carrierCol_().appendRow([now, "'" + tn, file.getId(), file.getUrl(), note || '', user, 'Bosta']);
    });
    const r = findRow_('Tracking', tn), t = sh_('Tracking');
    if (r) t.getRange(r, 3).setValue(Number(t.getRange(r, 3).getValue()) + photos.length);
    else t.appendRow(["'" + tn, now, photos.length, '', '', false]);
    return { saved: photos.length };
  } finally { lock.releaseLock(); }
}

/** Other carriers / no tracking: saved to Shipments only (never to Tracking, so Bosta sync ignores it). */
function saveOther(pin, carrier, ref, photos, note) {
  pin_(pin); carrier = String(carrier || '').trim() || 'Other';
  if (!photos || !photos.length) throw new Error('Add at least one photo');
  const now = new Date();
  ref = String(ref || '').trim().toUpperCase().replace(/\s+/g, '') ||
    'OTH-' + Utilities.formatDate(now, 'Africa/Cairo', 'yyyyMMdd-HHmmss');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const user = Session.getActiveUser().getEmail() || 'app', f = folder_(), s = carrierCol_();
    photos.forEach((d, i) => {
      const file = f.createFile(Utilities.newBlob(Utilities.base64Decode(d.split(',')[1]), 'image/jpeg',
        ref.replace(/[^\w-]/g, '_') + '_' + Utilities.formatDate(now, 'Africa/Cairo', 'yyyyMMdd-HHmmss') + '_' + (i + 1) + '.jpg'));
      s.appendRow([now, "'" + ref, file.getId(), file.getUrl(), note || '', user, carrier]);
    });
    return { saved: photos.length, ref: ref };
  } finally { lock.releaseLock(); }
}

/** q = Bosta tracking (last 10 digits used) or any other-carrier reference / OTH- code. */
function getShipment(pin, q) {
  pin_(pin); q = String(q).trim().toUpperCase().replace(/\s+/g, '');
  const d = q.replace(/\D/g, ''), t10 = d.length >= 10 ? d.slice(-10) : '';
  const rows = rows_('Shipments').filter(r => { const s = String(r[1]).toUpperCase(); return s === q || (t10 && s === t10); });
  const photos = rows.slice(-8).map(r => ({
    time: Utilities.formatDate(new Date(r[0]), 'Africa/Cairo', 'dd MMM HH:mm'), note: r[4], url: r[3],
    img: 'data:image/jpeg;base64,' + Utilities.base64Encode(DriveApp.getFileById(r[2]).getBlob().getBytes())
  }));
  const carrier = rows.length ? String(rows[rows.length - 1][6] || 'Bosta') : (t10 ? 'Bosta' : '');
  const t = t10 && carrier === 'Bosta' ? rows_('Tracking').find(r => String(r[0]) === t10) : null;
  const b = t ? rows_('Bulky').find(r => String(r[0]) === t10) : null;
  return { tn: t ? t10 : q, carrier, photos, state: t ? t[3] : '', size: t ? t[4] : '',
    bulky: b ? { size: b[2], expected: b[3], final: b[7], status: b[13], items: b[9] } : null };
}

/* ---------- Bosta sync (hourly) ---------- */
function installTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncBosta').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncBosta').timeBased().everyHours(1).create();
}
function bosta_(tn) {
  const url = (P.getProperty('BOSTA_DELIVERY_URL') || DEFAULT_URL).replace('{tn}', tn), h = {};
  h[P.getProperty('BOSTA_AUTH_HEADER_NAME') || 'Authorization'] = P.getProperty('BOSTA_API_KEY');
  const res = UrlFetchApp.fetch(url, { headers: h, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Bosta ' + res.getResponseCode() + ' for ' + tn);
  return JSON.parse(res.getContentText()).data;
}
/** Walk the delivery log oldest->newest; the last pricing values win. */
function pricing_(d) {
  const o = { size: '', ship: '', sizeCost: '', material: '', vat: '' };
  (d.log || []).forEach(e => {
    const a = e.actionsList || {};
    if (a.pricingPackageSize && a.pricingPackageSize.after) o.size = a.pricingPackageSize.after.name;
    if (a.pricing_size_name) o.size = a.pricing_size_name.after;
    const p = a.pricing && a.pricing.after;
    if (p) { o.ship = p.shippingFee; o.sizeCost = p.size && p.size.cost; o.vat = p.priceAfterVat;
      o.material = p.bostaMaterialFee ? p.bostaMaterialFee.amount : ''; }
    if (a.pricing_shippingFee) o.ship = a.pricing_shippingFee.after;
    if (a.pricing_size_cost) o.sizeCost = a.pricing_size_cost.after;
    if (a.pricing_priceAfterVat) o.vat = a.pricing_priceAfterVat.after;
    if (a.pricing_bostaMaterialFee) o.material = a.pricing_bostaMaterialFee.after.amount;
  });
  const cc = d.wallet && d.wallet.cashCycle;
  if (cc && cc.size) o.size = cc.size;           // final word after delivery
  o.final = cc ? Number(cc.bosta_fees) : '';
  return o;
}
/** Item list for the Bulky sheet: from Shopify (same Shopify login as Orders), else from Bosta's package details. */
function items_(d) {
  const store = P.getProperty('SHOPIFY_STORE');
  if (store && d.shopifyOrderId) try {
    const r = UrlFetchApp.fetch('https://' + store + '/admin/api/' + SHOPIFY_API + '/orders/' + d.shopifyOrderId + '.json?fields=name,line_items',
      { headers: { 'X-Shopify-Access-Token': getToken_() }, muteHttpExceptions: true });
    const o = JSON.parse(r.getContentText()).order;
    return o.line_items.map(l => (l.sku || '-') + ' | ' + l.title + ' x' + l.quantity).join('\n');
  } catch (e) { /* fall back below */ }
  const pd = d.specs && d.specs.packageDetails;
  return pd ? pd.description + ' (items: ' + pd.itemsCount + ')' : '';
}
/** Pull tracking numbers of ALL shipments from the same Bosta fees feed your fees script uses
 *  (BOSTA_FEES_URL, covering recent days) and add unseen ones to Tracking with 0 photos. */
function importFromFees() {
  const url = P.getProperty('BOSTA_FEES_URL'); if (!url) return;
  const h = {}; h[P.getProperty('BOSTA_AUTH_HEADER_NAME') || 'Authorization'] = P.getProperty('BOSTA_API_KEY');
  const res = UrlFetchApp.fetch(url, { headers: h, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Fees feed ' + res.getResponseCode());
  const found = {};
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') Object.keys(o).forEach(k => {
      if (/tracking/i.test(k) && /^\d{6,}$/.test(String(o[k]))) found[String(o[k]).slice(-10)] = 1; else walk(o[k]);
    });
  })(JSON.parse(res.getContentText()));
  const T = sh_('Tracking'), have = {};
  T.getDataRange().getValues().forEach(r => have[String(r[0])] = 1);
  const add = Object.keys(found).filter(tn => !have[tn]).map(tn => ["'" + tn, new Date(), 0, '', '', false]);
  if (add.length) T.getRange(T.getLastRow() + 1, 1, add.length, 6).setValues(add);
}
function syncBosta(only) {
  if (typeof only !== 'string') only = '';        // a time trigger passes an event object here
  if (!only) try { importFromFees(); } catch (e) { console.error('importFromFees', e.message); }
  const t0 = Date.now(), flag = new RegExp(P.getProperty('FLAG_REGEX') || 'bulky', 'i');
  const T = sh_('Tracking'), data = T.getDataRange().getValues();
  for (let i = 1; i < data.length && Date.now() - t0 < 300000; i++) {
    if (data[i][5] === true && !only) continue;
    const tn = String(data[i][0]);
    if (only && tn !== only) continue;
    try {
      const d = bosta_(tn), p = pricing_(d), old = (Date.now() - new Date(data[i][1])) > 60 * 864e5;
      T.getRange(i + 1, 4, 1, 3).setValues([[d.state && d.state.value, p.size, p.final !== '' || old]]);
      if (!flag.test(p.size || '')) continue;
      const B = sh_('Bulky'), r = findRow_('Bulky', tn), now = new Date();
      const links = rows_('Shipments').filter(x => String(x[1]) === tn).map(x => x[3]).join('\n');
      const row = [ "'" + tn, d.businessReference, p.size, p.vat, p.ship, p.sizeCost, p.material, p.final,
        d.state && d.state.value, items_(d), links, now, p.final !== '' ? now : '', p.final !== '' ? 'Charged' : 'Flagged' ];
      if (r) { const cur = B.getRange(r, 1, 1, 14).getValues()[0]; row[11] = cur[11]; if (!row[12]) row[12] = cur[12];
        B.getRange(r, 1, 1, 14).setValues([row]); }
      else B.appendRow(row);
    } catch (e) {
      console.error(tn, e.message);
      if (/Bosta (400|404)/.test(e.message))             // not a Bosta shipment (misread): mark & stop retrying
        T.getRange(i + 1, 4, 1, 3).setValues([['NOT IN BOSTA', '', true]]);
    }
  }
}

/* =====================================================================================
 * Tests: run from the Apps Script editor (select the function, Run, then View > Logs)
 * ===================================================================================== */

/** Checks every Script Property and that each part can log in. Changes nothing. */
function testAll() {
  const need = {
    'Shared (Orders/Shipments)': ['SHOPIFY_STORE', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'],
    'POS': ['POS_PIN', 'SHOP', 'CLIENT_ID', 'CLIENT_SECRET'],
    'Orders': ['APP_KEY'],
    'Shipments': ['APP_PIN', 'BOSTA_API_KEY']
  };
  Object.keys(need).forEach(function (part) {
    need[part].forEach(function (k) { Logger.log((P.getProperty(k) ? 'OK       ' : 'MISSING  ') + part + ': ' + k); });
  });
  Logger.log((SpreadsheetApp.getActive() || P.getProperty('SHEET_ID') ? 'OK       ' : 'MISSING  ') + 'Shipments: sheet (open from the sheet, or set SHEET_ID)');
  Logger.log('Hourly Bosta sync trigger: ' + (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'syncBosta') ? 'installed' : 'NOT installed, run installTrigger()'));

  try { Logger.log('Orders Shopify: ' + shopify_('{ shop { name } }').shop.name); } catch (e) { Logger.log('Orders Shopify FAILED: ' + e.message); }
  try { Logger.log('Receiving: ' + listPOs_().orders.length + ' purchase order(s) waiting'); } catch (e) { Logger.log('Receiving FAILED (scopes?): ' + e.message); }
  try { Logger.log('POS Shopify: ' + posGql_('{ shop { name } }').shop.name); } catch (e) { Logger.log('POS Shopify FAILED: ' + e.message); }
  try { Logger.log('Shipments sheet: ' + sh_('Tracking').getParent().getName()); } catch (e) { Logger.log('Shipments sheet FAILED: ' + e.message); }

  // Routing and logins through doPost (wrong logins must be refused)
  const call = function (body) { return JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }).getContent()); };
  Logger.log('POS wrong PIN refused: ' + (call({ action: 'today', pin: 'x' }).ok === false));
  Logger.log('Orders wrong key refused: ' + (call({ action: 'listOrders', key: 'x' }).ok === false));
  Logger.log('Shipments wrong PIN refused: ' + !!call({ fn: 'checkPin', args: ['x'] }).error);
  Logger.log('POS today with real PIN ok: ' + call({ action: 'today', pin: P.getProperty('POS_PIN') }).ok);
  Logger.log('Orders list with real key ok: ' + call({ action: 'listOrders', key: P.getProperty('APP_KEY') }).ok);
}

/** Run after changing a Shopify app's scopes: forgets the saved Shopify tokens so new ones are fetched. */
function resetTokens() {
  CacheService.getScriptCache().removeAll(['shopify_token', 'tok']);
  Logger.log('Saved Shopify tokens cleared. The next request gets fresh ones.');
}

/** Returns: read-only check that the Shopify app may read returns (needs read_returns). */
function testReturns() {
  const r = getReturnable_({ query: TEST_ORDER });
  Logger.log('Returnable items on ' + r.order.name + ': ' + r.items.length);
  r.items.forEach(function (i) { Logger.log('  ' + i.need + ' x ' + i.title + ' | barcode: ' + (i.barcode || '-')); });
}

/** Orders: read-only check of one real order. */
const TEST_ORDER = '1001'; // <-- put a real open order number here
function testOrders() {
  const r = getOrder_(TEST_ORDER);
  if (!r.ok) { Logger.log('getOrder FAILED: ' + r.error); return; }
  Logger.log('Order ' + r.order.name + ' - ' + r.items.length + ' line(s) to fulfill');
  r.items.forEach(function (i) {
    Logger.log('  ' + i.need + ' x ' + i.title + ' | SKU: ' + (i.sku || '-') + ' | barcode: ' + (i.barcode || 'MISSING'));
  });
  const list = listOrders_();
  Logger.log('Open orders list: ' + (list.ok ? list.orders.length + ' order(s)' : 'FAILED'));
}

/** Shipments: uses a known Light Bulky shipment, then check the Tracking and Bulky sheets. */
function testBulky() {
  const tn = '9022895919', T = sh_('Tracking'), r = findRow_('Tracking', tn);
  if (r) T.getRange(r, 6).setValue(false); else T.appendRow(["'" + tn, new Date(), 0, '', '', false]);
  syncBosta(tn);
  const b = rows_('Bulky').find(x => String(x[0]) === tn);
  console.log(b ? 'BULKY ROW: ' + JSON.stringify(b.slice(0, 9)) : 'No Bulky row. Check the log above for the Bosta error.');
}
function debugFees() {
  const h = {}; h[P.getProperty('BOSTA_AUTH_HEADER_NAME') || 'Authorization'] = P.getProperty('BOSTA_API_KEY');
  console.log('Header:', Object.keys(h)[0], '| key length:', (h[Object.keys(h)[0]] || '').length);
  const r = UrlFetchApp.fetch(P.getProperty('BOSTA_FEES_URL'), { headers: h, muteHttpExceptions: true });
  console.log(r.getResponseCode(), r.getContentText().slice(0, 1500));
}
