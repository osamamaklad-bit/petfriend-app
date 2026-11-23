/**
 * Pet Friend: ONE Apps Script server for all three tabs of the app.
 *
 *   POS        search, sale, today                       body {action, pin, ...}       -> {ok, data} / {ok:false, error}
 *   Orders     listOrders, getOrder, fulfill,            body {action, key, ...}       -> {ok, ...}  / {ok:false, error}
 *              getReturnable, processReturn,
 *              listPOs, getPO, receivePO (receiving supplier purchase orders),
 *              setItemMeta (edit an item's bin locations / expiry dates),
 *              listPickLists, getPickList, createPickList (pick lists of the orders ready to pick),
 *              dailySummary (today's numbers for the Today tab)
 *   Shipments  saveShipment, saveOther, getShipment,     body {fn, args: [pin, ...]}   -> {result}   / {error}
 *              checkPin
 *
 * Each part keeps its own login (POS_PIN, APP_KEY, APP_PIN) and answers in the same format as
 * before, so the app only needs this script's URL.
 *
 * Script Properties (Project Settings > Script properties). Values are never in this file.
 *   Shared
 *     SHOPIFY_STORE          xxx.myshopify.com (or just xxx, or the full https:// link)
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
 *     BIN_VARIANT_METAFIELD  (optional) variant bin-location metafield shown in Receive, default custom.bin_location
 *     BIN_PRODUCT_METAFIELD  (optional) product bin-location metafield shown in Receive, default custom.bin_location
 *     EXPIRY_METAFIELD       (optional) product expiry-date metafield, default custom.expiry_date
 *     TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (optional) Telegram group notifications; TELEGRAM_OFF to silence kinds
 *     EXPIRY_PREV_METAFIELD  (optional) expiry date of the previous batch, default custom.expiry_date_of_previous_batch
 *   Shipments
 *     APP_PIN                the Shipments PIN
 *     SHEET_ID               the Google Sheet's ID (only if this script is NOT opened from that sheet)
 *     PHOTO_FOLDER_ID        (optional; created on first photo)
 *     BOSTA_API_KEY, BOSTA_AUTH_HEADER_NAME, BOSTA_DELIVERY_URL (optional), BOSTA_FEES_URL (optional)
 *     BOSTA_TRACK_URL        (optional) tracking page put on fulfillments, with {tn} for the number
 *     FLAG_REGEX             (optional, default "bulky")
 *
 * Shopify scopes for the Orders app: read_orders, read_products,
 *   read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders,
 *   read_returns, write_returns (and read_locations for restocking),
 *   and for receiving from suppliers: read_inventory_purchase_orders, read_inventory_transfers,
 *   read_inventory, write_inventory (extra units beyond the PO), write_inventory_shipments_received_items, write_inventory_shipments,
 *   and write_products to edit bin locations / expiry dates.
 *
 * Deploy: Deploy > Manage deployments (or New deployment) > Web app, Execute as: Me, Who has access: Anyone.
 * Run installTrigger() once for the hourly Bosta sync. Run testAll() to check the setup.
 */

const P = PropertiesService.getScriptProperties();

/* =====================================================================================
 * Entry points
 * ===================================================================================== */

// Shown when the web-app URL is opened in a browser: tells which version of this file is deployed.
const SERVER_VERSION = '2026-11-23.3';

function doGet() {
  return json_({ ok: true, service: 'petfriend', version: SERVER_VERSION, parts: ['pos', 'orders', 'shipments'] });
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

const SHOPIFY_API = '2026-10';   // keep on a supported Admin API version (2025-01 was retired)

// SHOPIFY_STORE may be written as "petfriendstores", "petfriendstores.myshopify.com" or a full https:// link
function storeHost_() {
  const raw = String(P.getProperty('SHOPIFY_STORE') || '').trim()
    .replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.myshopify\.com$/i, '');
  if (!raw) throw new Error('Set SHOPIFY_STORE in Script Properties');
  return raw + '.myshopify.com';
}

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
  const res = UrlFetchApp.fetch('https://' + storeHost_() + '/admin/oauth/access_token', {
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
  let res, j;
  for (let tries = 0; ; tries++) {
    res = UrlFetchApp.fetch('https://' + storeHost_() + '/admin/api/' + version + '/graphql.json', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Shopify-Access-Token': getToken_() },
      payload: JSON.stringify({ query: query, variables: variables || {} }),
      muteHttpExceptions: true
    });
    j = JSON.parse(res.getContentText());
    // Too many requests at once (e.g. the expiry report reading every product): wait and try again
    const throttled = res.getResponseCode() === 429 || /THROTTLED/.test(JSON.stringify(j.errors || ''));
    if (!throttled || tries >= 4) break;
    Utilities.sleep(2000 * (tries + 1));
  }
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
    if (r.action === 'sale') return { ok: true, data: posSaleOnce_(r) };
    return { ok: true, data: POS_ACTIONS[r.action](r) };
  } catch (err) {
    logError_('POS', r.action, err);
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

// A repeated "Complete cash sale" (e.g. the answer was lost on a weak connection) returns the sale
// already made for that saleId instead of creating a second order.
function posSaleOnce_(r) {
  const id = String(r.saleId || '');
  if (!/^[\w-]{8,80}$/.test(id)) return posSale_(r);          // older app without saleId
  const cache = CacheService.getScriptCache(), key = 'pos_sale_' + id;
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const done = cache.get(key);
    if (done) return JSON.parse(done);
    const res = posSale_(r);
    cache.put(key, JSON.stringify(res), 6 * 60 * 60);
    return res;
  } finally { lock.releaseLock(); }
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
  getOrder: function (r) { return getOrder_(r.query, r.allowDone); },
  addOrderTracking: function (r) { return addOrderTracking_(r.orderName, r.tracking, r.notify); },
  fulfill: function (r) { return fulfill_(r.items, r.notify, r.orderName, r.tracking); },
  checkWaybill: function (r) { return checkWaybill_(r.code, r.orderName); },
  getReturnable: function (r) { return getReturnable_(r); },
  processReturn: function (r) { return processReturn_(r); },
  listPOs: function () { return listPOs_(); },
  setPOHidden: function (r) { return setPOHidden_(r); },
  getPO: function (r) { return getPO_(r); },
  receivePO: function (r) { return receivePO_(r); },
  setItemMeta: function (r) { return setItemMeta_(r); },
  listPickLists: function () { return listPickLists_(); },
  getPickList: function (r) { return getPickList_(r.id); },
  createPickList: function () { return createPickList_('manual'); },
  setPickListDone: function (r) { return setPickListDone_(r); },
  dailySummary: function () { return dailySummary_(); },
  expiryReport: function (r) { return expiryReport_(r); },
  lookupProduct: function (r) { return lookupProduct_(r); }
};

function ordersApi_(r) {
  try {
    const key = P.getProperty('APP_KEY');
    if (!key || r.key !== key) return { ok: false, error: 'Wrong app key' };
    return ORDER_ACTIONS[r.action](r);
  } catch (err) {
    logError_('Orders', r.action, err);
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

function getOrder_(raw, allowDone) {
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
                variant { barcode ${metaQuery_('variant')} product { ${metaQuery_('product')} } }
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
        image: li.lineItem.image ? li.lineItem.image.url : '',
        binVariant: binValue_(li.lineItem.variant && li.lineItem.variant.vBin),
        binProduct: binValue_(li.lineItem.variant && li.lineItem.variant.product && li.lineItem.variant.product.pBin),
        expProduct: binValue_(li.lineItem.variant && li.lineItem.variant.product && li.lineItem.variant.product.pExp),
        expPrevProduct: binValue_(li.lineItem.variant && li.lineItem.variant.product && li.lineItem.variant.product.pExpPrev)
      });
    });
  });
  // walk the shelves in order: sort by variant bin, else product bin (items without a bin last)
  items.sort(function (a, b) {
    const x = a.binVariant || a.binProduct, y = b.binVariant || b.binProduct;
    if (!x !== !y) return x ? -1 : 1;
    return String(x || '').localeCompare(String(y || ''), undefined, { numeric: true, sensitivity: 'base' });
  });

  if (!items.length) {
    // Fulfill can still add a Bosta tracking number to an order that is already fulfilled
    if (allowDone && /FULFILLED/.test(String(order.displayFulfillmentStatus))) {
      const t = orderFulfillments_(order.name);
      return { ok: true, order: { id: order.id, name: order.name }, items: [], done: true, status: order.displayFulfillmentStatus,
        tracking: t.target ? t.target.numbers : [] };
    }
    return { ok: false, error: 'Order ' + order.name + ' has nothing left to fulfill (' + order.displayFulfillmentStatus + ')' };
  }
  return { ok: true, order: { id: order.id, name: order.name }, items: items };
}

/** Fulfill: is this scanned code a Bosta waybill, and is it for this order? Bosta keeps the Shopify order with the
 *  shipment (businessReference, e.g. "petsfriend-5972:#14071"). Only a Bosta waybill whose order matches (or that has
 *  no order on it) can be put on the fulfillment. */
function checkWaybill_(code, orderName) {
  const digits = String(code || '').replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 20) return { ok: true, bosta: false };
  if (!P.getProperty('BOSTA_API_KEY')) throw new Error('Bosta is not set up (BOSTA_API_KEY)');
  const tn = digits.length >= 10 ? digits.slice(-10) : digits;
  let d;
  try { d = bosta_(tn); } catch (e) {
    if (/Bosta (400|404)/.test(e.message)) return { ok: true, bosta: false, tn: tn };
    throw e;
  }
  const ref = String((d && d.businessReference) || ''), refNum = (ref.match(/#?\s*(\d+)\s*$/) || [])[1] || '';
  const want = String(orderName || '').replace(/\D/g, '');
  return { ok: true, bosta: true, tn: tn, ref: ref, refOrder: refNum ? '#' + refNum : '',
    matches: !refNum || !want || refNum === want, state: (d && d.state && d.state.value) || '' };
}
/** The order's shipments (fulfillments) and the one a tracking number is added to: the newest that is not cancelled. */
function orderFulfillments_(orderName) {
  const num = String(orderName || '').replace(/\D/g, '');
  if (!num) throw new Error('Missing order number');
  const o = shopify_('query($q: String!) { orders(first: 1, query: $q) { nodes { id name cancelledAt ' +
    'fulfillments(first: 20) { id status createdAt trackingInfo(first: 10) { number company url } } } } }', { q: 'name:#' + num + ' OR name:' + num }).orders.nodes[0];
  if (!o) throw new Error('Order ' + orderName + ' not found');
  const live = (o.fulfillments || []).filter(function (f) { return f.status !== 'CANCELLED' && f.status !== 'FAILURE' && f.status !== 'ERROR'; })
    .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
  const f = live[0];
  return { order: o, target: f ? { id: f.id, info: f.trackingInfo || [], numbers: (f.trackingInfo || []).map(function (t) { return t.number; }).filter(Boolean) } : null };
}
/** Adds a Bosta tracking number to an order that is already fulfilled (its newest shipment). Same checks as Fulfill:
 *  the number must be a Bosta waybill for this order. Numbers already on the shipment are kept, never replaced. */
function addOrderTracking_(orderName, code, notify) {
  const w = checkWaybill_(code, orderName);
  if (!w.bosta) throw new Error(String(code) + ' is not a Bosta waybill');
  if (!w.matches) throw new Error('Waybill ' + w.tn + ' is for order ' + w.refOrder + ' in Bosta, not ' + orderName);
  const of = orderFulfillments_(orderName);
  if (of.order.cancelledAt) throw new Error('Order ' + of.order.name + ' is cancelled');
  if (!of.target) throw new Error('Order ' + of.order.name + ' has no shipment yet: fulfill it first');
  if (of.target.numbers.indexOf(w.tn) !== -1) return { ok: true, already: true, tracking: w.tn, order: of.order.name };
  const all = of.target.numbers.concat([w.tn]), url = bostaTrackingUrl_(w.tn);
  const input = all.length === 1 ? { company: 'Bosta', number: w.tn } : { company: 'Bosta', numbers: all };
  if (url && all.length === 1) input.url = url;
  const r = shopify_('mutation($id: ID!, $t: FulfillmentTrackingInput!, $n: Boolean) { fulfillmentTrackingInfoUpdate(fulfillmentId: $id, ' +
    'trackingInfoInput: $t, notifyCustomer: $n) { fulfillment { id } userErrors { field message } } }', { id: of.target.id, t: input, n: !!notify })
    .fulfillmentTrackingInfoUpdate;
  userErrors_(r.userErrors);
  logActivity_('Orders', 'tracking', of.order.name, 0, { tracking: w.tn });
  try { addTracking_([w.tn]); } catch (e) { console.warn('addTracking_', e.message); }
  return { ok: true, tracking: w.tn, order: of.order.name, numbers: all };
}

function bostaTrackingUrl_(tn) {
  const t = P.getProperty('BOSTA_TRACK_URL');          // optional, e.g. a Bosta tracking page with {tn} in it
  return t && /^https:\/\//.test(t) ? t.replace('{tn}', encodeURIComponent(tn)) : '';
}

function fulfill_(items, notify, orderName, tracking) {
  if (!items || !items.length) return { ok: false, error: 'No items' };
  // a Bosta waybill scanned with the order: checked again here, so only a real Bosta number for this order is saved
  let track = null;
  if (tracking) {
    const w = checkWaybill_(tracking, orderName);
    if (!w.bosta) throw new Error(String(tracking) + ' is not a Bosta waybill');
    if (!w.matches) throw new Error('Waybill ' + w.tn + ' is for order ' + w.refOrder + ' in Bosta, not ' + orderName);
    track = { company: 'Bosta', number: w.tn };
    const url = bostaTrackingUrl_(w.tn);
    if (url) track.url = url;
  }

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
    { f: Object.assign({ notifyCustomer: !!notify, lineItemsByFulfillmentOrder: lineItemsByFulfillmentOrder }, track ? { trackingInfo: track } : {}) }
  );

  const r = data.fulfillmentCreate;
  if (r.userErrors && r.userErrors.length) {
    return { ok: false, error: r.userErrors.map(function (u) { return u.message; }).join('; ') };
  }
  logActivity_('Orders', 'fulfill', orderName || '', items.reduce(function (t, i) { return t + (Number(i.qty) || 0); }, 0), track ? { tracking: track.number } : null);
  // the hourly Bosta check now follows this shipment too (size, bulky fee)
  if (track) try { addTracking_([track.number]); } catch (e) { console.warn('addTracking_', e.message); }
  return { ok: true, status: r.fulfillment.status, tracking: track ? track.number : '' };
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
          // returnReason still works in 2026-10 (deprecated); the note keeps the reason readable if it is removed later
          return { fulfillmentLineItemId: i.fliId, quantity: Number(i.qty), returnReason: reason, returnReasonNote: 'Reason: ' + reason };
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

  logActivity_('Orders', 'return', ret.name, items.reduce(function (t, i) { return t + (Number(i.qty) || 0); }, 0), { restock: !!body.restock, reason: reason });
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
// Item metafields shown (and editable) in Receive: bin location on the variant and on the product,
// expiry date on the product. Each is "namespace.key"; defaults below (they match the store's
// definitions), change with the Script Properties named here.
const ITEM_META = {
  // the expiry date can be edited in Receive and Check; bin locations only in Receive (Purchase orders tab)
  binVariant: { prop: 'BIN_VARIANT_METAFIELD',    def: 'custom.bin_location', owner: 'variant', alias: 'vBin', type: 'single_line_text_field', editable: 'receive', label: 'Variant bin' },
  binProduct: { prop: 'BIN_PRODUCT_METAFIELD',    def: 'custom.bin_location', owner: 'product', alias: 'pBin', type: 'single_line_text_field', editable: 'receive', label: 'Product bin' },
  expProduct: { prop: 'EXPIRY_METAFIELD',         def: 'custom.expiry_date',  owner: 'product', alias: 'pExp', type: 'date', editable: true, label: 'Expiry date' },
  // the expiry date of the batch before the current one (stock of both can be on the shelf)
  expPrevProduct: { prop: 'EXPIRY_PREV_METAFIELD', def: 'custom.expiry_date_of_previous_batch', owner: 'product', alias: 'pExpPrev', type: 'date', editable: true, label: 'Expiry date of previous batch' }
};
function metaKey_(name) {
  const f = ITEM_META[name];
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(P.getProperty(f.prop) || f.def);
  if (!m) throw new Error(f.prop + ' must look like ' + f.def);
  return { namespace: m[1], key: m[2] };
}
function metaQuery_(owner) {   // "vBin: metafield(...) { value type } vExp: ..." for the variant or the product
  return Object.keys(ITEM_META).filter(function (n) { return ITEM_META[n].owner === owner; }).map(function (n) {
    const k = metaKey_(n);
    return ITEM_META[n].alias + ': metafield(namespace: "' + k.namespace + '", key: "' + k.key + '") { value type }';
  }).join(' ');
}
function poItemFields_() {
  // image: the variant's own picture, else the product's main picture
  const img = 'preview { image { url(transform: { maxWidth: 160, maxHeight: 160 }) } }';
  return 'inventoryItem { id sku variants(first: 1) { nodes { id displayName barcode sku ' + metaQuery_('variant') +
    ' media(first: 1) { nodes { ' + img + ' } }' +
    ' product { id ' + metaQuery_('product') + ' featuredMedia { ' + img + ' } } } } }';
}
function metaValues_(variant) {
  const out = {};
  Object.keys(ITEM_META).forEach(function (n) {
    const f = ITEM_META[n], host = f.owner === 'variant' ? variant : (variant && variant.product);
    out[n] = binValue_(host && host[f.alias]);
  });
  return out;
}

function poItem_(inv, extra) {
  const v = (inv && inv.variants && inv.variants.nodes[0]) || {};
  return Object.assign({
    title: v.displayName || 'Item', sku: v.sku || (inv && inv.sku) || '', barcode: v.barcode || '', image: mediaUrl_(v),
    variantId: v.id || '', productId: (v.product && v.product.id) || '', inventoryItemId: (inv && inv.id) || ''
  }, metaValues_(v), extra);
}
function mediaUrl_(v) {
  const pick = function (m) { return m && m.preview && m.preview.image && m.preview.image.url || ''; };
  return pick(v.media && v.media.nodes && v.media.nodes[0]) || pick(v.product && v.product.featuredMedia);
}
// Metafield values come as text; list-type metafields come as JSON arrays: show them comma-separated
function binValue_(mf) {
  if (!mf || mf.value == null) return '';
  const v = String(mf.value);
  try { const j = JSON.parse(v); if (Array.isArray(j)) return j.join(', '); } catch (e) {}
  return v;
}

/** Saves the expiry date for one item (body.values.expProduct). Bin locations sent here are ignored: read-only.
 *  An empty value removes the metafield. Uses the type of the store's metafield definition when there is one. */
function setItemMeta_(body) {
  if (!body.variantId) throw new Error('Missing item');
  const vals = body.values || {};
  const cur = shopifyAt_(RECEIVE_API, 'query($id: ID!) { productVariant(id: $id) { id ' + metaQuery_('variant') +
    ' product { id ' + metaQuery_('product') + ' } } }', { id: body.variantId }).productVariant;
  if (!cur) throw new Error('Item not found in Shopify');
  const sets = [], dels = [], changes = [];
  Object.keys(ITEM_META).forEach(function (n) {
    if (!Object.prototype.hasOwnProperty.call(vals, n)) return;
    const ed = ITEM_META[n].editable;
    if (!ed || (ed !== true && ed !== body.where)) return;   // bin locations: only from Receive (Purchase orders)
    const f = ITEM_META[n], k = metaKey_(n), host = f.owner === 'variant' ? cur : cur.product;
    const existing = host[f.alias], v = String(vals[n] == null ? '' : vals[n]).trim();
    if (v === binValue_(existing)) return;                        // unchanged
    changes.push({ field: f.label, from: binValue_(existing), to: v });
    if (!v) { if (existing) dels.push({ ownerId: host.id, namespace: k.namespace, key: k.key }); return; }
    const type = (existing && existing.type) || metaDefType_(f.owner, k) || f.type;
    let value = v;
    if (/^list\./.test(type)) value = JSON.stringify(v.split(',').map(function (x) { return x.trim(); }).filter(Boolean));
    if (type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(f.label + ' must be a date (YYYY-MM-DD)');
    sets.push({ ownerId: host.id, namespace: k.namespace, key: k.key, type: type, value: value });
  });
  if (sets.length) {
    const r = shopifyAt_(RECEIVE_API, 'mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { key } userErrors { field message } } }', { m: sets });
    userErrors_(r.metafieldsSet.userErrors);
  }
  if (dels.length) {
    const r = shopifyAt_(RECEIVE_API, 'mutation($m: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $m) { userErrors { field message } } }', { m: dels });
    userErrors_(r.metafieldsDelete.userErrors);
  }
  const now = shopifyAt_(RECEIVE_API, 'query($id: ID!) { productVariant(id: $id) { id ' + metaQuery_('variant') +
    ' product { id ' + metaQuery_('product') + ' } } }', { id: body.variantId }).productVariant;
  if (changes.length) logEdits_(body, changes);
  return { ok: true, values: metaValues_(now), changed: sets.length + dels.length };
}

/* Change log of bin locations and expiry dates edited from the app: one row per changed value, with the old and the
 * new value (sheet "Edits", kept like the other logs). */
const EDITS_HEAD = ['Time', 'Where', 'Product', 'SKU', 'Field', 'Old value', 'New value'];
function logEdits_(body, changes) {
  try {
    const ss = SpreadsheetApp.getActive() || SpreadsheetApp.openById(P.getProperty('SHEET_ID') || P.getProperty('SPREADSHEET_ID'));
    let s = ss.getSheetByName('Edits');
    if (!s) { s = ss.insertSheet('Edits'); s.appendRow(EDITS_HEAD); s.setFrozenRows(1); }
    const where = body.where === 'receive' ? 'Purchase orders' + (body.po ? ' ' + String(body.po).slice(0, 30) : '') : body.where === 'check' ? 'Check' : 'App';
    const now = new Date(), txt = function (v) { return "'" + String(v == null ? '' : v).slice(0, 200); };
    const rows = changes.map(function (c) { return [now, where, txt(body.title || ''), txt(body.sku || ''), c.field, txt(c.from), txt(c.to)]; });
    s.getRange(s.getLastRow() + 1, 1, rows.length, EDITS_HEAD.length).setValues(rows);
  } catch (e) { console.error('logEdits_', e.message); }
}
// Type of the store's metafield definition (e.g. "date", "single_line_text_field", "list.single_line_text_field")
function metaDefType_(owner, k) {
  const d = shopifyAt_(RECEIVE_API, 'query($o: MetafieldOwnerType!, $ns: String!, $key: String!) {' +
    ' metafieldDefinitions(first: 1, ownerType: $o, namespace: $ns, key: $key) { nodes { type { name } } } }',
    { o: owner === 'variant' ? 'PRODUCTVARIANT' : 'PRODUCT', ns: k.namespace, key: k.key });
  const n = d.metafieldDefinitions.nodes[0];
  return n ? n.type.name : '';
}
function digits_(s) { return String(s || '').replace(/\D/g, ''); }

/** All ORDERED purchase orders, page by page (Shopify lists them oldest first and has no sort option). */
function allPOs_(fields, pageSize, maxPages) {
  const out = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const d = shopifyAt_(RECEIVE_API,
      'query($after: String) { inventoryPurchaseOrders(first: ' + pageSize + ', after: $after, query: "status:ORDERED") {' +
      ' nodes { ' + fields + ' } pageInfo { hasNextPage endCursor } } }', { after: after }).inventoryPurchaseOrders;
    Array.prototype.push.apply(out, d.nodes);
    if (!d.pageInfo || !d.pageInfo.hasNextPage) break;
    after = d.pageInfo.endCursor;
  }
  return out;
}

/** Purchase orders still waiting for stock (status ORDERED, not fully received), newest first. */
/* Purchase orders removed from the app's list ("Remove"): Shopify has no way to delete a purchase order through its
 * API, so the app only hides it, on every phone. It stays in Shopify unchanged, can still be opened by its number,
 * and "Show hidden" brings it back. */
const HIDDEN_PO_SHEET = 'HiddenPOs';
function hiddenPOSheet_() {
  const ss = SpreadsheetApp.getActive() || SpreadsheetApp.openById(P.getProperty('SHEET_ID') || P.getProperty('SPREADSHEET_ID'));
  let s = ss.getSheetByName(HIDDEN_PO_SHEET);
  if (!s) { s = ss.insertSheet(HIDDEN_PO_SHEET); s.appendRow(['Id', 'Name', 'HiddenAt']); s.setFrozenRows(1); }
  return s;
}
function hiddenPOs_() {
  const s = hiddenPOSheet_(), n = s.getLastRow(), out = {};
  if (n < 2) return out;
  s.getRange(2, 1, n - 1, 1).getValues().forEach(function (r) { if (r[0]) out[String(r[0])] = 1; });
  return out;
}
function setPOHidden_(r) {
  const id = String((r && r.id) || ''), name = String((r && r.name) || '').slice(0, 50), hide = r.hidden !== false;
  if (!/^gid:\/\/shopify\/[A-Za-z]*PurchaseOrder\/\d+$/.test(id)) throw new Error('Unknown purchase order');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const s = hiddenPOSheet_(), n = s.getLastRow(), col = n > 1 ? s.getRange(2, 1, n - 1, 1).getValues() : [];
    for (let i = col.length - 1; i >= 0; i--) if (String(col[i][0]) === id) deleteDataRows_(s, i + 2, 1);
    if (hide) s.appendRow([id, "'" + name, new Date()]);
  } finally { lock.releaseLock(); }
  logActivity_('Orders', hide ? 'remove PO' : 'show PO', name || id, 0);
  return { ok: true, id: id, hidden: hide };
}

function listPOs_() {
  const hidden = hiddenPOs_();
  const nodes = allPOs_('id name orderedAt dateCreated origin { supplierName } destination { name }' +
    ' transfers(first: 3) { nodes { totalQuantity receivedQuantity } }', 100, 10);
  const orders = nodes.map(function (po) {
    const total = po.transfers.nodes.reduce(function (s, t) { return s + t.totalQuantity; }, 0);
    const received = po.transfers.nodes.reduce(function (s, t) { return s + t.receivedQuantity; }, 0);
    return {
      id: po.id, name: po.name, status: 'ORDERED',
      customer: po.origin && po.origin.supplierName || '',      // shown where the customer is for orders
      city: po.destination && po.destination.name || '',
      createdAt: po.orderedAt || po.dateCreated,
      qty: Math.max(0, total - received),
      hidden: !!hidden[po.id]
    };
  }).filter(function (po) { return po.qty > 0; })
    .sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }); // newest first
  return { ok: true, orders: orders };
}

/** One purchase order with everything still to receive, line by line. */
function getPO_(body) {
  const q = String(body.query || '').trim().toUpperCase(), num = digits_(q);
  if (!num) throw new Error('Enter a purchase order number');
  const list = allPOs_('id name', 250, 20);
  const found = list.filter(function (po) { return po.name.toUpperCase() === q; })[0] ||
                list.filter(function (po) { return digits_(po.name) === num; })[0];
  if (!found) throw new Error('Purchase order ' + q + ' not found (or not marked as ordered)');

  const po = shopifyAt_(RECEIVE_API,
    'query($id: ID!) { inventoryPurchaseOrder(id: $id) { id name origin { supplierName } destination { name location { id } }' +
    '  transfers(first: 5) { nodes { id status shipments(first: 10) { nodes { id status } } } }' +
    '} }', { id: found.id }).inventoryPurchaseOrder;

  const items = [];
  po.transfers.nodes.forEach(function (t) {
    // DRAFT shipments count too: they are marked in transit when received (no second shipment is created)
    const open = t.shipments.nodes.filter(function (sh) { return sh.status === 'IN_TRANSIT' || sh.status === 'PARTIALLY_RECEIVED' || sh.status === 'DRAFT'; });
    open.forEach(function (sh) {
      const lines = shopifyAt_(RECEIVE_API,
        'query($id: ID!) { inventoryShipment(id: $id) { lineItems(first: 250) { nodes { id unreceivedQuantity ' + poItemFields_() + ' } } } }',
        { id: sh.id }).inventoryShipment.lineItems.nodes;
      lines.forEach(function (l) {
        if (l.unreceivedQuantity > 0) items.push(poItem_(l.inventoryItem, { shipmentId: sh.id, sliId: l.id, need: l.unreceivedQuantity, draft: sh.status === 'DRAFT' }));
      });
    });
    if (!open.length && t.status !== 'TRANSFERRED' && t.status !== 'CANCELED') {
      // No incoming shipment yet: offer what has not been shipped; a shipment is created when receiving
      const lines = shopifyAt_(RECEIVE_API,
        'query($id: ID!) { inventoryTransfer(id: $id) { lineItems(first: 250) { nodes { shippableQuantity ' + poItemFields_() + ' } } } }',
        { id: t.id }).inventoryTransfer.lineItems.nodes;
      lines.forEach(function (l) {
        if (l.shippableQuantity > 0 && l.inventoryItem) items.push(poItem_(l.inventoryItem, { transferId: t.id, inventoryItemId: l.inventoryItem.id, need: l.shippableQuantity }));
      });
    }
  });
  if (!items.length) throw new Error('Purchase order ' + po.name + ' has nothing left to receive');
  return {
    ok: true,
    order: { id: po.id, name: po.name, supplier: po.origin && po.origin.supplierName || '', location: po.destination && po.destination.name || '',
      locationId: po.destination && po.destination.location && po.destination.location.id || '' },
    items: items
  };
}

/** Receives a purchase order's items. Per item: qty = units accepted into stock (may be MORE than expected),
 *  rejected / canceled = units refused or not coming, need = units expected on that line.
 *  Up to `need`: accepted / rejected / canceled are recorded on the shipment (inventoryShipmentReceive).
 *  Above `need`: the extra accepted units are added to stock at the PO's location (inventoryAdjustQuantities,
 *  reason "received"). requestId makes a repeated tap safe (Shopify idempotency keys). */
function receivePO_(body) {
  const items = (body.items || []).map(function (i) {
    const need = Math.max(0, Number(i.need) || 0), qty = Math.max(0, Number(i.qty) || 0);
    const rej = Math.max(0, Number(i.rejected) || 0), can = Math.max(0, Number(i.canceled) || 0);
    if (rej + can > need) throw new Error('Too many rejected / cancelled for one item (more than expected)');
    const acc = Math.min(qty, need - rej - can);     // what fits on the purchase order line; the rest is extra
    return { i: i, acc: acc, rej: rej, can: can, extra: qty - acc };
  }).filter(function (x) { return x.acc + x.rej + x.can + x.extra > 0; });
  if (!items.length) throw new Error('Nothing to receive');
  const rid = String(body.requestId || Utilities.getUuid());
  const lines = function (id, x) {   // receive entries for one shipment line
    const out = [];
    if (x.acc) out.push({ shipmentLineItemId: id, quantity: x.acc, reason: 'ACCEPTED' });
    if (x.rej) out.push({ shipmentLineItemId: id, quantity: x.rej, reason: 'REJECTED' });
    if (x.can) out.push({ shipmentLineItemId: id, quantity: x.can, reason: 'CANCELED' });
    return out;
  };
  const byShip = {}, byTransfer = {}, extras = [];
  items.forEach(function (x) {
    const i = x.i;
    if (x.extra) {
      if (!body.locationId || !i.inventoryItemId) throw new Error('Cannot add extra units: the purchase order has no location');
      extras.push({ inventoryItemId: i.inventoryItemId, delta: x.extra });
    }
    if (!(x.acc + x.rej + x.can)) return;
    if (i.shipmentId && i.sliId) byShip[i.shipmentId] = (byShip[i.shipmentId] || []).concat(lines(i.sliId, x));
    else if (i.transferId && i.inventoryItemId) (byTransfer[i.transferId] = byTransfer[i.transferId] || []).push(x);
  });

  let step = 0;
  const done = { accepted: 0, rejected: 0, canceled: 0, extra: 0 };
  try {
    // Transfers without a shipment yet: create one for exactly what is handled now, then receive it
    Object.keys(byTransfer).forEach(function (tid) {
      const xs = byTransfer[tid];
      const c = shopifyAt_(RECEIVE_API,
        'mutation($input: InventoryShipmentCreateInput!, $key: String!) {' +
        '  inventoryShipmentCreateInTransit(input: $input) @idempotent(key: $key) {' +
        '    inventoryShipment { id lineItems(first: 250) { nodes { id quantity inventoryItem { id } } } }' +
        '    userErrors { field message }' +
        '  }' +
        '}', { input: { movementId: tid, lineItems: xs.map(function (x) { return { inventoryItemId: x.i.inventoryItemId, quantity: x.acc + x.rej + x.can }; }) },
               key: rid + '-t' + (step++) });
      userErrors_(c.inventoryShipmentCreateInTransit.userErrors);
      const sh = c.inventoryShipmentCreateInTransit.inventoryShipment;
      xs.forEach(function (x) {
        const l = sh.lineItems.nodes.filter(function (n) { return n.inventoryItem && n.inventoryItem.id === x.i.inventoryItemId; })[0];
        if (l) byShip[sh.id] = (byShip[sh.id] || []).concat(lines(l.id, x));
      });
    });
    // Draft shipments must be in transit before they can be received
    const drafts = {};
    items.forEach(function (x) { if (x.i.draft && x.i.shipmentId) drafts[x.i.shipmentId] = 1; });
    Object.keys(drafts).forEach(function (sid) {
      const m = shopifyAt_(RECEIVE_API,
        'mutation($id: ID!, $key: String!) { inventoryShipmentMarkInTransit(id: $id) @idempotent(key: $key) {' +
        ' inventoryShipment { id status } userErrors { field message } } }', { id: sid, key: rid + '-m' + sid.split('/').pop() });
      userErrors_(m.inventoryShipmentMarkInTransit.userErrors);
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
      byShip[sid].forEach(function (l) {
        if (l.reason === 'ACCEPTED') done.accepted += l.quantity;
        else if (l.reason === 'REJECTED') done.rejected += l.quantity;
        else done.canceled += l.quantity;
      });
    });
    // Units beyond what the purchase order expected: add them to stock at the PO's location
    if (extras.length) {
      const a = shopifyAt_(RECEIVE_API,
        'mutation($input: InventoryAdjustQuantitiesInput!, $key: String!) {' +
        '  inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {' +
        '    inventoryAdjustmentGroup { id }' +
        '    userErrors { field message }' +
        '  }' +
        '}', { input: { name: 'available', reason: 'received',
                 referenceDocumentUri: 'petfriend://purchase-order/' + encodeURIComponent(String(body.poName || 'PO')),
                 changes: extras.map(function (e) { return { inventoryItemId: e.inventoryItemId, locationId: body.locationId, delta: e.delta, changeFromQuantity: null }; }) },
               key: rid + '-x' });
      userErrors_(a.inventoryAdjustQuantities.userErrors);
      done.extra = extras.reduce(function (t, e) { return t + e.delta; }, 0);
    }
  } catch (e) {
    const got = done.accepted + done.rejected + done.canceled;
    if (got) throw new Error(got + ' items were recorded, then it stopped: ' + e.message + '. Load the purchase order again to see what is left.');
    throw e;
  }
  logActivity_('Orders', 'receive', body.poName || '', done.accepted + done.extra, { extra: done.extra, rejected: done.rejected, canceled: done.canceled });
  return { ok: true, received: done.accepted + done.extra, accepted: done.accepted, extra: done.extra, rejected: done.rejected, canceled: done.canceled };
}

/* =====================================================================================
 * Pick list: products of the orders ready to pick, combined per variant and sorted by bin
 *
 * Eligible order: open, not cancelled, UNFULFILLED, and either PAID, or tagged "confirmed"
 * without "not confirmed yet". Same variant in several orders = one line with the total
 * quantity and the order numbers. Sorted by variant bin, else product bin (numeric order).
 *
 * Pick lists are published IN THE APP only (no email). Each one is a snapshot of the eligible
 * orders that were not on an earlier pick list, saved in the "PickLists" sheet:
 *   - automatic (scheduledPicklistCheck, every 10 min): from 10:00 (the 10:00 one collects everything
 *     waiting since the last list) until 14:00, not on Fridays, a new list whenever new orders qualify;
 *   - manual: the app's "Create pick list now" button (any time), or createPickListNow() in the editor.
 * Run createPicklistTrigger() once. The sheet is this script's spreadsheet (or SHEET_ID).
 * ===================================================================================== */

const PICK_API = RECEIVE_API;   // 2026-10

function pickOrdersQuery_() {
  const img = 'preview { image { url(transform: { maxWidth: 200, maxHeight: 200 }) } }';
  const bv = metaKey_('binVariant'), bp = metaKey_('binProduct');
  // small pages keep each request under Shopify's query-cost limit (1000)
  return 'query($cursor: String, $q: String, $sort: OrderSortKeys) { orders(first: 10, after: $cursor, query: $q, sortKey: $sort) {' +
    ' pageInfo { hasNextPage endCursor }' +
    ' nodes { id name cancelledAt displayFulfillmentStatus displayFinancialStatus tags' +
    '  lineItems(first: 40) { nodes { quantity title variantTitle' +
    '   variant { id sku title media(first: 1) { nodes { ' + img + ' } }' +
    '    metafield(namespace: "' + bv.namespace + '", key: "' + bv.key + '") { value }' +
    '    product { id title featuredMedia { ' + img + ' } metafield(namespace: "' + bp.namespace + '", key: "' + bp.key + '") { value } } } } } } } }';
}

function pickEligible_(order) {
  if (order.cancelledAt || order.displayFulfillmentStatus !== 'UNFULFILLED') return false;
  const tags = (order.tags || []).map(function (t) { return String(t).trim().toLowerCase(); });
  const confirmed = tags.indexOf('confirmed') !== -1 && tags.indexOf('not confirmed yet') === -1;
  return confirmed || order.displayFinancialStatus === 'PAID';
}

/** Collects eligible orders matching `q` and combines their products. skip(orderId) -> true leaves an order out. */
function buildPickList_(q, sort, skip) {
  const products = {}, orderIds = [];
  let cursor = null, pages = 0;
  do {
    const d = shopifyAt_(PICK_API, pickOrdersQuery_(), { cursor: cursor, q: q, sort: sort }).orders;
    d.nodes.forEach(function (order) {
      if (!pickEligible_(order) || (skip && skip(order.id))) return;
      orderIds.push(order.id);
      (order.lineItems.nodes || []).forEach(function (li) {
        const v = li.variant;
        if (!v) return;
        const prod = v.product || {};
        const title = li.title || prod.title || v.title || 'Unknown Product';
        const rawVar = li.variantTitle || v.title || '';
        const variantName = rawVar && rawVar !== 'Default Title' ? rawVar : '';
        const pick = function (m) { return m && m.preview && m.preview.image && m.preview.image.url || ''; };
        const image = pick(v.media && v.media.nodes && v.media.nodes[0]) || pick(prod.featuredMedia);
        const productBin = binValue_(prod.metafield), variantBin = binValue_(v.metafield);
        const qty = Number(li.quantity) || 0;
        const e = products[v.id];
        if (!e) products[v.id] = { key: v.id, image: image, title: title, variantName: variantName, sku: v.sku || '', quantity: qty,
          productBin: productBin, variantBin: variantBin, orders: [order.name || ''] };
        else {
          e.quantity += qty;
          if (e.orders.indexOf(order.name) === -1) e.orders.push(order.name);
          if (!e.image && image) e.image = image;
          if (!e.productBin && productBin) e.productBin = productBin;
          if (!e.variantBin && variantBin) e.variantBin = variantBin;
          if (!e.variantName && variantName) e.variantName = variantName;
        }
      });
    });
    cursor = d.pageInfo.hasNextPage ? d.pageInfo.endCursor : null;
  } while (cursor && ++pages < 100);
  const truncated = !!cursor;   // more than 1000 open orders: the rest is left for the next pick list
  if (truncated) console.warn('Pick list: stopped after 1000 orders; the rest goes on the next list');
  const list = Object.keys(products).map(function (k) { return products[k]; });
  list.sort(function (a, b) {
    return String(a.variantBin || a.productBin || '').localeCompare(String(b.variantBin || b.productBin || ''), undefined, { numeric: true, sensitivity: 'base' });
  });
  return { orderIds: orderIds, products: list, truncated: truncated };
}

const PL_SHEET = 'PickLists';
const PL_HEAD = ['Id', 'CreatedAt', 'Kind', 'Orders', 'Products', 'OrderIds', 'Data'];
const PL_KEEP_DAYS = 30;          // older pick lists are removed from the sheet
const PL_CHUNK = 45000;           // a sheet cell holds at most 50,000 characters: long lists use several cells

function plSheet_() {
  const ss = SpreadsheetApp.getActive() || SpreadsheetApp.openById(P.getProperty('SHEET_ID') || P.getProperty('SPREADSHEET_ID'));
  let s = ss.getSheetByName(PL_SHEET);
  if (!s) { s = ss.insertSheet(PL_SHEET); s.appendRow(PL_HEAD); s.setFrozenRows(1); }
  return s;
}
function plRows_() {
  const s = plSheet_(), n = s.getLastRow();
  if (n < 2) return [];
  return s.getRange(2, 1, n - 1, s.getLastColumn()).getValues();
}
function plSummary_(row) {
  return { id: String(row[0]), createdAt: new Date(row[1]).toISOString(), kind: String(row[2]), orders: Number(row[3]), products: Number(row[4]) };
}

/** Eligible open orders that are not on an earlier pick list. */
function newPickOrders_() {
  const done = {};
  plRows_().forEach(function (row) { String(row[5] || '').split(',').forEach(function (id) { if (id) done[id] = 1; }); });
  return buildPickList_('status:open fulfillment_status:unfulfilled', 'CREATED_AT', function (id) { return !!done[id]; });
}

/** Makes a new pick list of the eligible orders not listed before. kind: 'auto' | 'manual'. */
function createPickList_(kind) {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    plPrune_();                                   // drop pick lists older than PL_KEEP_DAYS
    const pl = newPickOrders_();
    if (!pl.orderIds.length) return { ok: true, created: false };
    const now = new Date(), tz = Session.getScriptTimeZone();
    const s = plSheet_();
    let id = 'PL-' + Utilities.formatDate(now, tz, 'yyyyMMdd-HHmm');
    const ids = {}; plRows_().forEach(function (row) { ids[String(row[0])] = 1; });
    for (let k = 2; ids[id]; k++) id = 'PL-' + Utilities.formatDate(now, tz, 'yyyyMMdd-HHmm') + '-' + k;
    const data = JSON.stringify(pl.products), chunks = [];
    for (let i = 0; i < data.length; i += PL_CHUNK) chunks.push(data.slice(i, i + PL_CHUNK));
    // the leading apostrophe makes Sheets keep each chunk as plain text (it is not part of the stored value)
    s.appendRow([id, now, kind, pl.orderIds.length, pl.products.length, "'" + pl.orderIds.join(',')].concat(chunks.map(function (c) { return "'" + c; })));
    logActivity_('Pick list', kind, id, pl.orderIds.length, { products: pl.products.length });
    tgNotify_('picklist', '🧾 قائمة تجميع جديدة (' + (kind === 'manual' ? 'يدوية' : 'تلقائية') + ')\n' + pl.orderIds.length + ' طلب · ' + pl.products.length + ' منتج' +
      (pl.truncated ? '\n⚠️ فيه أكتر من 1000 طلب مستني: اعمل قائمة تانية للباقي' : '') + '\nافتح التطبيق ← قائمة التجميع');
    return { ok: true, created: true, truncated: pl.truncated, pickList: { id: id, createdAt: now.toISOString(), kind: kind, orders: pl.orderIds.length, products: pl.products.length } };
  } finally { lock.releaseLock(); }
}

function plPrune_() {
  const s = plSheet_(), rows = plRows_(), cutoff = Date.now() - PL_KEEP_DAYS * 864e5;
  for (let i = rows.length - 1; i >= 0; i--) if (new Date(rows[i][1]).getTime() < cutoff) deleteDataRows_(s, i + 2, 1);
}
/** Deletes sheet rows. Google Sheets refuses to delete every row under the frozen header, so when that is what
 *  is asked (all rows old), the rows are emptied instead: blank rows at the end are ignored and reused. */
function deleteDataRows_(s, from, count) {
  try { s.deleteRows(from, count); }
  catch (e) { s.getRange(from, 1, count, Math.max(1, s.getLastColumn())).clearContent(); }
}

/** For the app: the pick lists of the last 7 days, newest first (summaries only). */
function listPickLists_() {
  const cutoff = Date.now() - 7 * 864e5, done = plDone_();
  const lists = plRows_().map(plSummary_).filter(function (x) { return new Date(x.createdAt).getTime() >= cutoff; })
    .sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); }).slice(0, 50)
    .map(function (x) { return Object.assign(x, { done: !!done[x.id], doneAt: done[x.id] || '' }); });
  return { ok: true, pickLists: lists };
}

/* Finished pick lists: the app hides them. Kept in their own sheet (one row per finished list), so every phone
 * sees the same thing; rows of lists that no longer exist are removed. */
const PL_DONE_SHEET = 'PickListsDone';
function plDoneSheet_() {
  const ss = SpreadsheetApp.getActive() || SpreadsheetApp.openById(P.getProperty('SHEET_ID') || P.getProperty('SPREADSHEET_ID'));
  let s = ss.getSheetByName(PL_DONE_SHEET);
  if (!s) { s = ss.insertSheet(PL_DONE_SHEET); s.appendRow(['Id', 'DoneAt']); s.setFrozenRows(1); }
  return s;
}
function plDone_() {
  const s = plDoneSheet_(), n = s.getLastRow(), out = {};
  if (n < 2) return out;
  s.getRange(2, 1, n - 1, 2).getValues().forEach(function (r) { if (r[0]) out[String(r[0])] = new Date(r[1]).toISOString(); });
  return out;
}
/** done = true: mark the pick list finished (hidden in the app); false: open it again. */
function setPickListDone_(r) {
  const id = String((r && r.id) || '');
  const ids = {}; plRows_().forEach(function (x) { ids[String(x[0])] = 1; });
  if (!ids[id]) throw new Error('Pick list not found');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const s = plDoneSheet_(), n = s.getLastRow();
    const col = n > 1 ? s.getRange(2, 1, n - 1, 1).getValues() : [];
    // drop this list's old mark and marks of lists that no longer exist (bottom up, so row numbers stay right)
    for (let i = col.length - 1; i >= 0; i--) {
      const v = String(col[i][0]);
      if (v === id || !ids[v]) deleteDataRows_(s, i + 2, 1);
    }
    if (r.done !== false) s.appendRow([id, new Date()]);
  } finally { lock.releaseLock(); }
  logActivity_('Pick list', r.done !== false ? 'done' : 'reopen', id, 0);
  return { ok: true, id: id, done: r.done !== false };
}

/** For the app: one pick list with its products. */
function getPickList_(id) {
  const row = plRows_().filter(function (r) { return String(r[0]) === String(id); })[0];
  if (!row) throw new Error('Pick list not found');
  const data = row.slice(6).filter(function (c) { return c !== '' && c != null; }).join('');
  const done = plDone_();
  return { ok: true, pickList: Object.assign(plSummary_(row), { items: data ? JSON.parse(data) : [], orderStatus: orderStatus_(String(row[5] || '')),
    done: !!done[String(id)], doneAt: done[String(id)] || '' }) };
}

/** Current fulfillment status of a pick list's orders: { '#1001': 'FULFILLED', ... } (empty if Shopify can't be read). */
function orderStatus_(idsCsv) {
  const ids = idsCsv.replace(/^'/, '').split(',').filter(Boolean), out = {};
  try {
    for (let i = 0; i < ids.length; i += 100) {
      shopify_('query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id name displayFulfillmentStatus cancelledAt } } }', { ids: ids.slice(i, i + 100) })
        .nodes.forEach(function (n) { if (n && n.name) out[n.name] = n.cancelledAt ? 'CANCELLED' : n.displayFulfillmentStatus; });
    }
  } catch (e) { console.warn('orderStatus_', e.message); }
  return out;
}

/** Editor: make a pick list now (same as the app's button). */
function createPickListNow() {
  const r = createPickList_('manual');
  Logger.log(r.created ? 'Pick list ' + r.pickList.id + ': ' + r.pickList.orders + ' order(s), ' + r.pickList.products + ' product(s)' : 'No new eligible orders.');
}

/** Time trigger: every 10 minutes, 10:00 to before 14:00, not on Fridays (script time zone). */
function scheduledPicklistCheck() {
  const tz = Session.getScriptTimeZone(), now = new Date();
  const day = Number(Utilities.formatDate(now, tz, 'u')), hour = Number(Utilities.formatDate(now, tz, 'H'));
  if (day === 5) { Logger.log('Friday - Picklist is disabled.'); return; }
  if (hour < 10 || hour >= 14) { Logger.log('Outside Picklist working hours.'); return; }
  pruneLogs_();
  let r;
  try { r = createPickList_('auto'); } catch (e) { logError_('Pick list', 'auto', e); throw e; }
  Logger.log(r.created ? 'Pick list ' + r.pickList.id + ' published: ' + r.pickList.orders + ' order(s)' : 'No new eligible orders.');
}

/** Run once: installs the 10-minute trigger (and removes the old email triggers). */
function createPicklistTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'scheduledPicklistCheck' || t.getHandlerFunction() === 'checkNewOrdersAndEmailPicklist') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scheduledPicklistCheck').timeBased().everyMinutes(10).create();
}

/* =====================================================================================
 * Activity log, error log and the Today summary
 *
 * Sheet "Activity": every fulfill, return, receive, pick list and shipment photo done through the app.
 * Sheet "Errors":   every error the script hits (wrong PIN / app key are not logged), so problems show up
 *                   in the Today tab before staff report them.
 * Rows older than 60 days are removed once a day (by the pick list trigger).
 * ===================================================================================== */

const LOG_KEEP_DAYS = 60;
const LOG_HEAD = { Activity: ['Time', 'Part', 'Action', 'Ref', 'Qty', 'Details'], Errors: ['Time', 'Part', 'Action', 'Message'] };

function logSheet_(name) {
  const ss = SpreadsheetApp.getActive() || SpreadsheetApp.openById(P.getProperty('SHEET_ID') || P.getProperty('SPREADSHEET_ID'));
  let s = ss.getSheetByName(name);
  if (!s) { s = ss.insertSheet(name); s.appendRow(LOG_HEAD[name]); s.setFrozenRows(1); }
  return s;
}
function logActivity_(part, action, ref, qty, details) {
  try { logSheet_('Activity').appendRow([new Date(), part, action, "'" + String(ref || ''), Number(qty) || 0, details ? "'" + JSON.stringify(details) : '']); }
  catch (e) { console.error('logActivity_', e.message); }
}
function logError_(part, action, err) {
  const msg = String((err && err.message) || err || '');
  if (/^Wrong (PIN|app key)$/.test(msg)) return;     // someone typing a wrong login is not a fault
  try { logSheet_('Errors').appendRow([new Date(), part, action || '', "'" + msg.slice(0, 1000)]); }
  catch (e) { console.error('logError_', e.message); }
  // Telegram: at most one message per part / action every 30 minutes, so a repeating error does not flood the group
  try {
    const c = CacheService.getScriptCache(), k = 'tg_err_' + String(part + '_' + (action || '')).slice(0, 200);
    if (!c.get(k)) { c.put(k, '1', 1800); tgNotify_('errors', '⚠️ خطأ في التطبيق\n' + part + (action ? ' / ' + action : '') + '\n' + msg.slice(0, 500)); }
  } catch (e) { console.error('tg error notice', e.message); }
}
/** The last `max` rows of a log sheet (newest last). */
function logRows_(name, max) {
  const s = logSheet_(name), n = s.getLastRow();
  if (n < 2) return [];
  const from = Math.max(2, n - (max || 3000) + 1);
  return s.getRange(from, 1, n - from + 1, LOG_HEAD[name].length).getValues();
}
/** Removes log rows older than LOG_KEEP_DAYS, at most once a day. */
function pruneLogs_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('logs_pruned')) return;
  const cutoff = Date.now() - LOG_KEEP_DAYS * 864e5;
  ['Activity', 'Errors', 'Edits'].forEach(function (name) {
    try {
      const s = name === 'Edits' ? (SpreadsheetApp.getActive() || SpreadsheetApp.openById(P.getProperty('SHEET_ID') || P.getProperty('SPREADSHEET_ID'))).getSheetByName('Edits') : logSheet_(name);
      if (!s) return;
      const n = s.getLastRow();
      if (n < 2) return;
      const times = s.getRange(2, 1, n - 1, 1).getValues();
      let old = 0;
      while (old < times.length && new Date(times[old][0]).getTime() < cutoff) old++;
      if (old) deleteDataRows_(s, 2, old);
    } catch (e) { console.error('pruneLogs_', name, e.message); }
  });
  cache.put('logs_pruned', '1', 20 * 60 * 60);
}

/** Today's numbers for the Today tab (script time zone). */
function dailySummary_() {
  const tz = Session.getScriptTimeZone(), day = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const isToday = function (d) { return d && Utilities.formatDate(new Date(d), tz, 'yyyy-MM-dd') === day; };
  const acts = logRows_('Activity').filter(function (x) { return isToday(x[0]); });
  const pick = function (part, actions) { return acts.filter(function (x) { return x[1] === part && actions.indexOf(x[2]) !== -1; }); };
  const tally = function (rows) { return { count: rows.length, qty: rows.reduce(function (t, x) { return t + (Number(x[4]) || 0); }, 0) }; };
  const detail = function (x) { try { return JSON.parse(String(x[5] || '{}').replace(/^'/, '')); } catch (e) { return {}; } };

  const recv = pick('Orders', ['receive']);
  const received = tally(recv);
  ['extra', 'rejected', 'canceled'].forEach(function (k) { received[k] = recv.reduce(function (t, x) { return t + (Number(detail(x)[k]) || 0); }, 0); });

  let pos;
  try { const t = posToday_(); pos = { count: t.length, total: Math.round(t.reduce(function (s, o) { return s + Number(o.total); }, 0) * 100) / 100 }; }
  catch (e) { pos = { error: String(e.message || e) }; }
  let openOrders = null;
  try { openOrders = listOrders_().orders.length; } catch (e) { /* shown as "?" */ }

  const errs = logRows_('Errors', 500).filter(function (x) { return isToday(x[0]); });
  return {
    ok: true, date: day, generatedAt: new Date().toISOString(),
    pos: pos,
    fulfilled: tally(pick('Orders', ['fulfill'])),
    returns: tally(pick('Orders', ['return'])),
    received: received,
    pickLists: tally(pick('Pick list', ['auto', 'manual'])),
    photos: tally(pick('Shipments', ['photo'])),
    returnPhotos: tally(pick('Shipments', ['return photo'])),
    openOrders: openOrders,
    bosta: (function () { try { return bostaStatus_(); } catch (e) { return { error: e.message }; } })(),
    bulky: tally(pick('Shipments', ['bulky'])),
    errors: { count: errs.length, last: errs.slice(-10).reverse().map(function (x) {
      return { time: new Date(x[0]).toISOString(), part: String(x[1]), action: String(x[2]), message: String(x[3]).replace(/^'/, '') };
    }) }
  };
}

/* =====================================================================================
 * Check a product (Orders tab, "Check" mode): scan or type a barcode, SKU or name and see the
 * picture, price, stock per location, bin locations and expiry date. Read-only.
 * ===================================================================================== */
function lookupProduct_(r) {
  const text = String((r && r.code) || '').trim().slice(0, 100);
  if (!text) throw new Error('Scan or type a barcode, SKU or name');
  const q = function (v) { return '"' + String(v).replace(/["\\]/g, '') + '"'; };
  // the same code may be stored with or without leading zeros (UPC-A 12 digits = EAN-13 with a leading 0)
  const codes = [text];
  if (/^\d+$/.test(text)) {
    const bare = text.replace(/^0+/, '');
    [bare, ('0000000000000' + bare).slice(-12), ('0000000000000' + bare).slice(-13), ('00000000000000' + bare).slice(-14)].forEach(function (c) {
      if (bare.length >= 6 && c.length >= bare.length && codes.indexOf(c) === -1) codes.push(c);
    });
  }
  const byCode = codes.map(function (c) { return 'barcode:' + q(c) + ' OR sku:' + q(c); }).join(' OR ');
  const img = 'preview { image { url(transform: { maxWidth: 600, maxHeight: 600 }) } }';
  const query = 'query($q: String!) { shop { currencyCode } productVariants(first: 10, query: $q) { nodes {' +
    ' id title displayName sku barcode barcodes(first: 5) { nodes { value } } price compareAtPrice inventoryQuantity ' + metaQuery_('variant') +
    ' media(first: 1) { nodes { ' + img + ' } }' +
    ' product { id title status variantsCount { count } ' + metaQuery_('product') + ' featuredMedia { ' + img + ' } }' +
    ' inventoryItem { tracked inventoryLevels(first: 10) { nodes { location { name } quantities(names: ["available"]) { quantity } } } } } } }';
  let d = shopifyAt_(RECEIVE_API, query, { q: byCode }), how = 'code';
  if (!d.productVariants.nodes.length && /[^\d\s-]/.test(text)) {          // nothing by code: try the name
    d = shopifyAt_(RECEIVE_API, query, { q: text.replace(/["\\:()]/g, ' ') }); how = 'name';
  }
  const items = d.productVariants.nodes.map(function (v) {
    const meta = metaValues_(v), levels = (v.inventoryItem && v.inventoryItem.inventoryLevels && v.inventoryItem.inventoryLevels.nodes) || [];
    return {
      variantId: v.id, productId: v.product && v.product.id, title: v.displayName || v.title,
      variantTitle: (v.product && v.product.variantsCount && v.product.variantsCount.count > 1) ? v.title : '',
      sku: v.sku || '', barcode: v.barcode || '',
      // a variant can now have several barcodes (Shopify 2026): list them all, first one first
      barcodes: ((v.barcodes && v.barcodes.nodes) || []).map(function (b) { return b.value; }).filter(function (b, i, a) { return b && a.indexOf(b) === i; }), price: v.price, compareAtPrice: v.compareAtPrice || '',
      stock: v.inventoryQuantity, tracked: !(v.inventoryItem && v.inventoryItem.tracked === false),
      locations: levels.map(function (l) {
        const a = (l.quantities || []).filter(function (x) { return x; })[0];
        return { name: l.location && l.location.name, available: a ? a.quantity : 0 };
      }),
      status: v.product && v.product.status, image: mediaUrl_(v),
      binVariant: meta.binVariant, binProduct: meta.binProduct, expProduct: meta.expProduct, expPrevProduct: meta.expPrevProduct
    };
  });
  return { ok: true, query: text, by: how, currency: d.shop && d.shop.currencyCode, items: items };
}

/* =====================================================================================
 * Telegram notifications to the store's group
 * Script Properties: TELEGRAM_BOT_TOKEN (from @BotFather, secret: never in the code), TELEGRAM_CHAT_ID (the group,
 * found with telegramFindChat), TELEGRAM_OFF (optional, comma list of kinds to silence: picklist, bulky, errors,
 * daily). Without a token or chat id nothing is sent. Run installTelegramTrigger once for the 9 pm daily report.
 * ===================================================================================== */
const TG_KINDS = ['picklist', 'bulky', 'errors', 'daily'];
function tgNotify_(kind, text) {
  const off = String(P.getProperty('TELEGRAM_OFF') || '').toLowerCase().split(/[\s,]+/);
  if (off.indexOf(kind) !== -1) return false;
  return tgSend_(text);
}
function tgSend_(text) {
  const token = P.getProperty('TELEGRAM_BOT_TOKEN'), chat = P.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chat) return false;
  try {
    const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 4000), disable_web_page_preview: true })
    });
    if (res.getResponseCode() !== 200) { console.error('Telegram ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300)); return false; }
    return true;
  } catch (e) { console.error('Telegram', e.message); return false; }   // never logError_ here: it would notify again
}
/** Editor, once: after adding the bot to the group and writing any message there, finds the group and saves its id. */
function telegramFindChat() {
  const token = P.getProperty('TELEGRAM_BOT_TOKEN');
  if (!token) { Logger.log('Set TELEGRAM_BOT_TOKEN in Script Properties first (the token @BotFather gave you).'); return; }
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true });
  const j = JSON.parse(res.getContentText());
  if (!j.ok) { Logger.log('Telegram refused the token: ' + (j.description || res.getResponseCode())); return; }
  const chats = {};
  (j.result || []).forEach(function (u) {
    const m = u.message || u.my_chat_member || u.channel_post || {}, c = m.chat;
    if (c && (c.type === 'group' || c.type === 'supergroup')) chats[c.id] = c.title || String(c.id);
  });
  const ids = Object.keys(chats);
  if (!ids.length) { Logger.log('No group found. Add the bot to the group, write any message in the group, then run this again.'); return; }
  ids.forEach(function (id) { Logger.log('Group: ' + chats[id] + '  id: ' + id); });
  if (ids.length === 1) {
    P.setProperty('TELEGRAM_CHAT_ID', ids[0]);
    Logger.log('Saved TELEGRAM_CHAT_ID. Sending a test message...');
    Logger.log(tgSend_('✅ بتفريند: الإشعارات شغالة في الجروب ده.') ? 'Test message sent.' : 'Test message failed: see the log above.');
  } else Logger.log('More than one group: copy the right id into TELEGRAM_CHAT_ID yourself.');
}
/** Editor: sends a test message to the group. */
function testTelegram() { Logger.log(tgSend_('✅ بتفريند: رسالة تجربة.') ? 'Sent.' : 'Not sent: check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.'); }
/** Editor, once: the daily report at 21:00 (script time zone). */
function installTelegramTrigger() {
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'dailyTelegramReport'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyTelegramReport').timeBased().atHour(21).everyDays(1).create();
  Logger.log('Daily Telegram report: every day around 21:00.');
}
/** Time trigger: the day in one message (same numbers as the Today tab) + products expired / expiring in 7 days. */
function dailyTelegramReport() {
  const d = dailySummary_(), L = [];
  L.push('📊 ملخص اليوم ' + d.date);
  if (d.pos && !d.pos.error) L.push('🛒 الكاشير: ' + d.pos.count + ' عملية · ' + d.pos.total + ' جنيه');
  L.push('✅ طلبات اتجهزت: ' + d.fulfilled.count + ' (' + d.fulfilled.qty + ' قطعة)');
  if (d.openOrders != null) L.push('⏳ طلبات مفتوحة: ' + d.openOrders);
  L.push('↩️ مرتجعات: ' + d.returns.count + ' (' + d.returns.qty + ' قطعة)');
  L.push('📥 استلام من الموردين: ' + d.received.qty + ' قطعة' + (d.received.extra ? ' · زيادة ' + d.received.extra : '') +
    (d.received.rejected ? ' · مرفوض ' + d.received.rejected : ''));
  L.push('🧾 قوائم تجميع: ' + d.pickLists.count);
  L.push('📷 صور شحنات: ' + d.photos.qty + (d.returnPhotos && d.returnPhotos.qty ? ' · صور مرتجعات: ' + d.returnPhotos.qty : ''));
  if (d.bulky && d.bulky.count) L.push('📦 شحنات بالكي: ' + d.bulky.count);
  try {
    const ex = expiryReport_({}).items.filter(function (x) { return x.stock > 0 && x.daysLeft <= 7; });
    const past = ex.filter(function (x) { return x.daysLeft < 0; }), soon = ex.filter(function (x) { return x.daysLeft >= 0; });
    if (past.length) L.push('⛔ منتهي الصلاحية وموجود بالمخزون: ' + past.length + '\n' + past.slice(0, 5).map(function (x) { return '  • ' + x.title + ' (' + x.expiry + ')'; }).join('\n'));
    if (soon.length) L.push('⚠️ صلاحيته بتخلص خلال 7 أيام: ' + soon.length + '\n' + soon.slice(0, 5).map(function (x) { return '  • ' + x.title + ' (' + x.expiry + ')'; }).join('\n'));
  } catch (e) { L.push('⚠️ تعذر فحص الصلاحية'); }
  L.push(d.errors.count ? '❗ أخطاء اليوم: ' + d.errors.count : '👍 مفيش أخطاء النهارده');
  return tgNotify_('daily', L.join('\n'));
}

/* =====================================================================================
 * Expiry report (Today tab): active products whose expiry date (custom.expiry_date) is past
 * or within EXPIRY_DAYS days, soonest first. Shopify cannot filter on the date, so every
 * active product is read (100 per page); the result is cached for an hour.
 * ===================================================================================== */
const EXPIRY_DAYS = 90, EXPIRY_MAX_PAGES = 80, EXPIRY_MAX_ITEMS = 300;
function expiryReport_(r) {
  const cache = CacheService.getScriptCache(), ck = 'expiry_report_v1';
  if (!(r && r.refresh)) {
    const hit = cache.get(ck);
    if (hit) { const o = JSON.parse(hit); o.cached = true; return o; }
  }
  const tz = Session.getScriptTimeZone(), today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const dayNo = function (iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5 : null; };
  const t0 = dayNo(today);
  const img = 'preview { image { url(transform: { maxWidth: 120, maxHeight: 120 }) } }';
  const k = metaKey_('expProduct'), kb = metaKey_('binProduct'), kv = metaKey_('binVariant');
  const query = 'query($after: String) { products(first: 100, after: $after, query: "status:active") { pageInfo { hasNextPage endCursor } nodes {' +
    ' id title totalInventory pExp: metafield(namespace: "' + k.namespace + '", key: "' + k.key + '") { value }' +
    ' pBin: metafield(namespace: "' + kb.namespace + '", key: "' + kb.key + '") { value }' +
    ' featuredMedia { ' + img + ' }' +
    ' variants(first: 1) { nodes { sku barcode vBin: metafield(namespace: "' + kv.namespace + '", key: "' + kv.key + '") { value } } } } } }';
  const items = [];
  let after = null, pages = 0, scanned = 0, withDate = 0, more = true;
  const started = Date.now();   // Google stops a run after 6 minutes: return what was read after 4
  while (more && pages < EXPIRY_MAX_PAGES && Date.now() - started < 240000) {
    const page = shopifyAt_(RECEIVE_API, query, { after: after }).products;
    pages++;
    page.nodes.forEach(function (p) {
      scanned++;
      const exp = p.pExp && String(p.pExp.value || ''), d = dayNo(exp);
      if (d == null) return;
      withDate++;
      const left = d - t0;
      if (left > EXPIRY_DAYS) return;
      const v = (p.variants && p.variants.nodes[0]) || {};
      items.push({ productId: p.id, title: p.title, expiry: exp.slice(0, 10), daysLeft: left, stock: Number(p.totalInventory) || 0,
        sku: v.sku || '', barcode: v.barcode || '', bin: binValue_(v.vBin) || binValue_(p.pBin),
        image: (p.featuredMedia && p.featuredMedia.preview && p.featuredMedia.preview.image && p.featuredMedia.preview.image.url) || '' });
    });
    more = page.pageInfo.hasNextPage; after = page.pageInfo.endCursor;
  }
  items.sort(function (a, b) { return a.daysLeft - b.daysLeft || (b.stock - a.stock); });
  const out = { ok: true, today: today, days: EXPIRY_DAYS, generatedAt: new Date().toISOString(), scanned: scanned, withDate: withDate,
    truncated: more || items.length > EXPIRY_MAX_ITEMS, items: items.slice(0, EXPIRY_MAX_ITEMS) };
  try { cache.put(ck, JSON.stringify(out), 3600); } catch (e) { /* too big to cache: fine */ }
  return out;
}

/* =====================================================================================
 * Shipments: photos + Bosta bulky tracker
 * ===================================================================================== */

const SHIP_FNS = { saveShipment: saveShipment, saveReturn: saveReturn, saveOther: saveOther, getShipment: getShipment, checkPin: checkPin };
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
  } catch (err) { logError_('Shipments', q.fn, err); return { error: err.message }; }
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
    logActivity_('Shipments', 'photo', tn, photos.length);
    return { saved: photos.length };
  } finally { lock.releaseLock(); }
}

/** A shipment coming BACK (returned by Bosta or by the customer): photos saved to Shipments with carrier
 *  "Bosta return". Does not touch Tracking (that sheet follows outgoing shipments and their fees). */
function saveReturn(pin, tn, photos, note, force) {
  pin_(pin); tn = String(tn).replace(/\D/g, '').slice(-10);
  if (!/^\d{10}$/.test(tn)) throw new Error('Need at least 10 digits of the barcode');
  if (!photos || !photos.length) throw new Error('Add at least one photo');
  if (!force && P.getProperty('BOSTA_API_KEY')) {
    try { bosta_(tn); } catch (e) {               // block misreads: number must exist in Bosta
      if (/Bosta (400|404)/.test(e.message)) throw new Error(tn + ' not found in Bosta. Misread, scan again.');
    }
  }
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (!force) {
      const first = rows_('Shipments').find(x => String(x[1]) === tn && /return$/i.test(String(x[6] || '')));
      if (first) return { duplicate: true, at: Utilities.formatDate(new Date(first[0]), 'Africa/Cairo', 'dd MMM HH:mm') };
    }
    const user = Session.getActiveUser().getEmail() || 'app', now = new Date(), f = folder_(), s = carrierCol_();
    photos.forEach((d, i) => {
      const file = f.createFile(Utilities.newBlob(Utilities.base64Decode(d.split(',')[1]), 'image/jpeg',
        'RETURN_' + tn + '_' + Utilities.formatDate(now, 'Africa/Cairo', 'yyyyMMdd-HHmmss') + '_' + (i + 1) + '.jpg'));
      s.appendRow([now, "'" + tn, file.getId(), file.getUrl(), note || '', user, 'Bosta return']);
    });
    logActivity_('Shipments', 'return photo', tn, photos.length);
    return { saved: photos.length };
  } finally { lock.releaseLock(); }
}

/** Other carriers / no tracking: saved to Shipments only (never to Tracking, so Bosta sync ignores it). */
function saveOther(pin, carrier, ref, photos, note, isReturn) {
  pin_(pin); carrier = String(carrier || '').trim() || 'Other';
  if (isReturn) carrier += ' return';
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
    logActivity_('Shipments', isReturn ? 'return photo' : 'photo', ref, photos.length, { carrier: carrier });
    return { saved: photos.length, ref: ref };
  } finally { lock.releaseLock(); }
}

/** q = Bosta tracking (last 10 digits used) or any other-carrier reference / OTH- code. */
function getShipment(pin, q) {
  pin_(pin); q = String(q).trim().toUpperCase().replace(/\s+/g, '');
  const d = q.replace(/\D/g, ''), t10 = d.length >= 10 ? d.slice(-10) : '';
  const rows = rows_('Shipments').filter(r => { const s = String(r[1]).toUpperCase(); return s === q || (t10 && s === t10); });
  const isRet = r => /return$/i.test(String(r[6] || ''));
  const photos = rows.slice(-8).map(r => ({
    time: Utilities.formatDate(new Date(r[0]), 'Africa/Cairo', 'dd MMM HH:mm'), note: r[4], url: r[3], ret: isRet(r),
    img: 'data:image/jpeg;base64,' + Utilities.base64Encode(DriveApp.getFileById(r[2]).getBlob().getBytes())
  }));
  const out = rows.filter(r => !isRet(r)), retRows = rows.filter(isRet);
  const carrier = out.length ? String(out[out.length - 1][6] || 'Bosta')
    : retRows.length ? String(retRows[retRows.length - 1][6]).replace(/\s*return$/i, '') || 'Bosta' : (t10 ? 'Bosta' : '');
  const t = t10 && carrier === 'Bosta' ? rows_('Tracking').find(r => String(r[0]) === t10) : null;
  const b = t ? rows_('Bulky').find(r => String(r[0]) === t10) : null;
  return { tn: t ? t10 : q, carrier, photos, returned: retRows.length > 0, state: t ? t[3] : '', size: t ? t[4] : '',
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
  const store = P.getProperty('SHOPIFY_STORE') ? storeHost_() : '';
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
 *  (BOSTA_FEES_URL, e.g. .../wallet/transactions?page=1&pageSize=50) and add unseen ones to Tracking with
 *  0 photos. Reads up to BOSTA_FEES_PAGES pages (default 5): page 1 alone holds only the newest 50 entries,
 *  and payouts and other entries without a shipment take room there too. */
function importFromFees() {
  const url = P.getProperty('BOSTA_FEES_URL'); if (!url) return { pages: 0, found: 0, added: 0, skipped: 'no BOSTA_FEES_URL' };
  const h = {}; h[P.getProperty('BOSTA_AUTH_HEADER_NAME') || 'Authorization'] = P.getProperty('BOSTA_API_KEY');
  const maxPages = /[?&]page=\d+/.test(url) ? Math.max(1, Number(P.getProperty('BOSTA_FEES_PAGES')) || 5) : 1;
  const found = {};
  let pages = 0;
  for (let n = 1; n <= maxPages; n++) {
    const res = UrlFetchApp.fetch(maxPages > 1 ? url.replace(/([?&]page=)\d+/, '$1' + n) : url, { headers: h, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { if (n === 1) throw new Error('Fees feed ' + res.getResponseCode()); break; }
    pages++;
    const before = Object.keys(found).length;
    let entries = 0;
    (function walk(o) {
      if (Array.isArray(o)) { entries += o.length; return o.forEach(walk); }
      if (o && typeof o === 'object') Object.keys(o).forEach(k => {
        if (/tracking/i.test(k) && /^\d{6,}$/.test(String(o[k]))) found[String(o[k]).slice(-10)] = 1; else walk(o[k]);
      });
    })(JSON.parse(res.getContentText()));
    if (!entries || Object.keys(found).length === before && n > 1) break;   // an empty page: the end
  }
  const added = addTracking_(Object.keys(found));
  return { pages: pages, found: Object.keys(found).length, added: added };
}
/** Adds tracking numbers that are not in Tracking yet (0 photos, not done). Returns how many were added. */
function addTracking_(list) {
  const T = sh_('Tracking'), have = {};
  T.getDataRange().getValues().forEach(r => have[String(r[0])] = 1);
  const seen = {}, add = list.filter(tn => tn && !have[tn] && !seen[tn] && (seen[tn] = 1)).map(tn => ["'" + tn, new Date(), 0, '', '', false]);
  if (add.length) T.getRange(T.getLastRow() + 1, 1, add.length, 6).setValues(add);
  return add.length;
}
/** Second source: Bosta tracking numbers written on Shopify fulfillments (e.g. by Bosta's Shopify app) in the
 *  last 7 days. A number from another carrier is harmless: Bosta answers 404 and the row is marked NOT IN BOSTA. */
function importFromShopify_() {
  if (!P.getProperty('SHOPIFY_STORE')) return { found: 0, added: 0, skipped: 'no SHOPIFY_STORE' };
  const since = Utilities.formatDate(new Date(Date.now() - 7 * 864e5), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  const d = shopify_('query($q: String!) { orders(first: 100, query: $q, sortKey: UPDATED_AT, reverse: true) { nodes { name ' +
    'fulfillments(first: 5) { trackingInfo(first: 3) { number company url } } } } }', { q: "updated_at:>='" + since + "' fulfillment_status:shipped" });
  const found = [];
  d.orders.nodes.forEach(o => (o.fulfillments || []).forEach(f => (f.trackingInfo || []).forEach(t => {
    const num = String(t.number || '').replace(/\D/g, ''), isBosta = /bosta/i.test((t.company || '') + ' ' + (t.url || ''));
    if (num.length >= 8 && (isBosta || (!t.company && num.length <= 10))) found.push(num.slice(-10));
  })));
  return { found: found.length, added: addTracking_(found) };
}
function syncBosta(only) {
  if (typeof only !== 'string') only = '';        // a time trigger passes an event object here
  const st = { at: new Date().toISOString(), fees: null, shopify: null, checked: 0, bulkyNew: 0, bulkyUpdated: 0, failed: 0, firstError: '' };
  if (!only) {
    try { st.fees = importFromFees(); } catch (e) { st.fees = { error: e.message }; logError_('Shipments', 'Bosta fees import', e); }
    try { st.shopify = importFromShopify_(); } catch (e) { st.shopify = { error: e.message }; logError_('Shipments', 'Bosta numbers from Shopify', e); }
  }
  const t0 = Date.now(), flag = new RegExp(P.getProperty('FLAG_REGEX') || 'bulky', 'i');
  const T = sh_('Tracking'), data = T.getDataRange().getValues();
  // newest first, so new shipments are checked even when an old backlog does not fit in one run
  for (let i = data.length - 1; i >= 1 && Date.now() - t0 < 300000; i--) {
    if (data[i][5] === true && !only) continue;
    const tn = String(data[i][0]);
    if (only && tn !== only) continue;
    try {
      st.checked++;
      const d = bosta_(tn), p = pricing_(d), old = (Date.now() - new Date(data[i][1])) > 60 * 864e5;
      T.getRange(i + 1, 4, 1, 3).setValues([[d.state && d.state.value, p.size, p.final !== '' || old]]);
      if (!flag.test(p.size || '')) continue;
      const B = sh_('Bulky'), r = findRow_('Bulky', tn), now = new Date();
      const links = rows_('Shipments').filter(x => String(x[1]) === tn).map(x => x[3]).join('\n');
      const row = [ "'" + tn, d.businessReference, p.size, p.vat, p.ship, p.sizeCost, p.material, p.final,
        d.state && d.state.value, items_(d), links, now, p.final !== '' ? now : '', p.final !== '' ? 'Charged' : 'Flagged' ];
      if (r) { const cur = B.getRange(r, 1, 1, 14).getValues()[0]; row[11] = cur[11]; if (!row[12]) row[12] = cur[12];
        B.getRange(r, 1, 1, 14).setValues([row]); st.bulkyUpdated++; }
      else { B.appendRow(row); st.bulkyNew++; logActivity_('Shipments', 'bulky', tn, 1, { size: p.size, order: d.businessReference });
        tgNotify_('bulky', '📦 شحنة بالكي\nالبوليصة: ' + tn + '\nالطلب: ' + (d.businessReference || '-') + '\nالمقاس: ' + p.size +
          '\nالرسوم: ' + (p.final !== '' ? p.final + ' جنيه (اتخصمت)' : (p.vat || '?') + ' جنيه (متوقعة)')); }
    } catch (e) {
      console.error(tn, e.message);
      if (/Bosta (400|404)/.test(e.message))             // not a Bosta shipment (misread): mark & stop retrying
        T.getRange(i + 1, 4, 1, 3).setValues([['NOT IN BOSTA', '', true]]);
      else { st.failed++; if (!st.firstError) st.firstError = tn + ': ' + e.message; }
    }
  }
  // e.g. an expired Bosta key fails every shipment: one line in Errors per run, not one per shipment
  if (st.failed) logError_('Shipments', 'Bosta sync', new Error(st.failed + ' shipment(s) failed. First: ' + st.firstError));
  if (!only) try { P.setProperty('BOSTA_LAST_SYNC', JSON.stringify(st)); } catch (e) {}
  return st;
}
/** For the Today tab: the last automatic Bosta sync, and the open (not finished) shipments. */
function bostaStatus_() {
  let last = null;
  try { last = JSON.parse(P.getProperty('BOSTA_LAST_SYNC') || 'null'); } catch (e) {}
  const trig = (function () { try { return ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'syncBosta'); } catch (e) { return null; } })();
  let open = 0, tracked = 0;
  try { rows_('Tracking').forEach(r => { tracked++; if (r[5] !== true) open++; }); } catch (e) {}
  return { last: last, trigger: trig, tracked: tracked, open: open };
}

/* =====================================================================================
 * Tests: run from the Apps Script editor (select the function, Run, then View > Logs)
 * ===================================================================================== */

/** Checks every Script Property and that each part can log in. Changes nothing. */
function testAll() {
  Logger.log('Script version in the editor: ' + SERVER_VERSION + ' (open the web-app URL to see the deployed one)');
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
  Logger.log('Telegram: ' + (!P.getProperty('TELEGRAM_BOT_TOKEN') ? 'off (no TELEGRAM_BOT_TOKEN)' : !P.getProperty('TELEGRAM_CHAT_ID') ? 'token set, no group yet: run telegramFindChat()'
    : 'on' + (P.getProperty('TELEGRAM_OFF') ? ' (silenced: ' + P.getProperty('TELEGRAM_OFF') + ')' : '')) +
    ' | daily report trigger: ' + (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'dailyTelegramReport') ? 'installed' : 'NOT installed, run installTelegramTrigger()'));

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
