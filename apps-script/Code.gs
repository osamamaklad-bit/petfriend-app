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
 *   Tasks      tasksInit, taskSave, taskDone, staffSave, repeatSave ... body {action, tpin, ...}  (staff tasks + Telegram)
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
 *     LABELS_FOLDER_ID       (made automatically) the Drive folder for label PDFs
 *     MANAGER_PIN            the manager's Tasks pass (each employee's own pass is set in the app)
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
const SERVER_VERSION = '2026-11-28.1';

function doGet() {
  return json_({ ok: true, service: 'petfriend', version: SERVER_VERSION, parts: ['pos', 'orders', 'shipments'] });
}

function doPost(e) {
  let q;
  try { q = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Bad request' }); }
  if (q && q.fn) return json_(shipmentsApi_(q));                                // Shipments: {fn, args}
  if (q && Object.prototype.hasOwnProperty.call(POS_ACTIONS, q.action)) return json_(posApi_(q));
  if (q && Object.prototype.hasOwnProperty.call(ORDER_ACTIONS, q.action)) return json_(ordersApi_(q));
  if (q && Object.prototype.hasOwnProperty.call(TASK_ACTIONS, q.action)) return json_(tasksApi_(q));
  return json_({ ok: false, error: 'Unknown action' });
}

function json_(obj) {
  // every reply says which server version answered: the app warns when it is older than the app needs
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) obj.sv = SERVER_VERSION;
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
  // the saved token belongs to this Client ID + secret: a changed secret never reuses a token made from the old one
  const cache = CacheService.getScriptCache(), key = tokKey_('orders');
  const cached = cache.get(key);
  if (cached) return cached;
  const res = UrlFetchApp.fetch('https://' + storeHost_() + '/admin/oauth/access_token', {
    method: 'post',
    payload: { grant_type: 'client_credentials', client_id: id, client_secret: secret },
    muteHttpExceptions: true
  });
  const j = JSON.parse(res.getContentText());
  if (!j.access_token) throw new Error('Token request failed: ' + res.getContentText());
  cache.put(key, j.access_token, 20 * 60 * 60); // 20h, token lives 24h
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
    CacheService.getScriptCache().remove(tokKey_('orders'));
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
// The POS store: SHOP may be written as "petfriendstores", "petfriendstores.myshopify.com" or a full https:// link
// (like SHOPIFY_STORE). Before, only the short name worked: anything else made a wrong address and Shopify answered
// with a web page ("Unexpected token '<' ... is not valid JSON").
function posHost_() {
  const raw = String(P.getProperty('SHOP') || P.getProperty('SHOPIFY_STORE') || '').trim()
    .replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.myshopify\.com$/i, '');
  if (!raw) throw new Error('Set SHOP in Script Properties (the store name, e.g. petfriendstores)');
  return raw + '.myshopify.com';
}
/** Shopify's answer as JSON, or a clear error when it is a web page (wrong store name, app not installed, outage). */
function posJson_(res, what) {
  const t = res.getContentText();
  try { return JSON.parse(t); } catch (e) {
    throw new Error('Shopify (POS ' + what + ') answered HTTP ' + res.getResponseCode() + ' with a web page, not data. ' +
      'Check SHOP (' + posHost_() + '), CLIENT_ID and CLIENT_SECRET in Script Properties, and that the POS app is installed in Shopify.');
  }
}
// When the POS app's own login is refused (wrong / regenerated CLIENT_ID / CLIENT_SECRET, app removed), the POS uses
// the Orders app's login for the same store instead of stopping. Remembered for an hour, then the POS login is tried again.
function posToken_(force) {
  const cache = CacheService.getScriptCache();
  const own = cache.get(tokKey_('pos'));
  if (!force && own) return own;
  // the Orders app login is used only while the POS secret is still the one that was refused
  if (!force && cache.get('pos_use_orders_app') === tokKey_('pos')) return getToken_();
  try { return posOwnToken_(cache); } catch (e) {
    const sameStore = (function () { try { return storeHost_().toLowerCase() === posHost_().toLowerCase(); } catch (x) { return false; } })();
    if (!sameStore || !(P.getProperty('SHOPIFY_CLIENT_ID') || P.getProperty('SHOPIFY_TOKEN'))) throw e;
    console.warn('POS login refused, using the Orders app login: ' + e.message);
    try { watchSecrets_(); } catch (x) {}
    if (!cache.get('pos_fallback_noted')) { cache.put('pos_fallback_noted', '1', 6 * 3600); logError_('POS', 'login', new Error('POS app login refused, the POS uses the Orders app login for now. ' + e.message)); }
    cache.put('pos_use_orders_app', tokKey_('pos'), 3600);
    if (force) cache.remove(tokKey_('orders'));
    return getToken_();
  }
}
function posOwnToken_(cache) {
  const res = UrlFetchApp.fetch('https://' + posHost_() + '/admin/oauth/access_token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'client_credentials', client_id: P.getProperty('CLIENT_ID'), client_secret: P.getProperty('CLIENT_SECRET') }
  });
  const j = posJson_(res, 'login');
  if (!j.access_token) throw new Error('POS login to Shopify failed (HTTP ' + res.getResponseCode() + '): ' + String(j.error_description || j.error || j.errors || '').slice(0, 200));
  cache.put(tokKey_('pos'), j.access_token, 21000); // ~5.8h, safely under the 24h expiry
  return j.access_token;
}

function posGql_(query, variables, retried) {
  const res = UrlFetchApp.fetch('https://' + posHost_() + '/admin/api/' + POS_API + '/graphql.json', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'X-Shopify-Access-Token': posToken_(retried) },
    payload: JSON.stringify({ query, variables })
  });
  // an old or revoked token: get a fresh one once (Shopify can answer 401 / 403, sometimes with a web page)
  if ((res.getResponseCode() === 401 || res.getResponseCode() === 403) && !retried) return posGql_(query, variables, true);
  const j = posJson_(res, 'request');
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
  addOrderTracking: function (r) { return addOrderTracking_(r.orderName, r.tracking, r.notify, r.photo); },
  fulfill: function (r) { return fulfill_(r.items, r.notify, r.orderName, r.tracking, r.photo, r.carrier); },
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
  lookupProduct: function (r) { return lookupProduct_(r); },
  saveLabels: function (r) { return saveLabels_(r); },
  bulkyList: function (r) { return Object.assign(bulkyRecent_(r.days), { job: bulkyJobState_() }); },
  bulkyCheck: function (r) { return bulkyBackfill_(r.days); }
};

function ordersApi_(r) {
  try {
    const key = P.getProperty('APP_KEY');
    if (!key || r.key !== key) return { ok: false, error: 'Wrong app key' };
    return ORDER_ACTIONS[r.action](r);
  } catch (err) {
    if (!err.user) logError_('Orders', r.action, err);    // typing mistakes are shown in the app, not logged
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
                variant { id barcode ${metaQuery_('variant')} product { ${metaQuery_('product')} } }
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
        variantId: (li.lineItem.variant && li.lineItem.variant.id) || '',
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
  addBarcodes_(items);
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
function addOrderTracking_(orderName, code, notify, photo) {
  needShipmentPhoto_(code, photo);
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
  const saved = saveOrderPhoto_({ tn: w.tn, photo: photo, order: of.order.name, carrier: 'Bosta' });
  return { ok: true, tracking: w.tn, order: of.order.name, numbers: all, photo: saved };
}

function bostaTrackingUrl_(tn) {
  const t = P.getProperty('BOSTA_TRACK_URL');          // optional, e.g. a Bosta tracking page with {tn} in it
  return t && /^https:\/\//.test(t) ? t.replace('{tn}', encodeURIComponent(tn)) : '';
}

/* Fulfill and Returns need the shipment: its barcode scanned (step 1) and a photo of it (step 2), owner's rule. The
 * photo is saved like a Shipments photo (Drive + sheet "Shipments"; a Bosta one is also followed by the bulky check). */
function needShipmentPhoto_(code, photo) {
  if (!String(code || '').trim()) throw uerr_('Step 1: scan the shipment barcode first');
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(String(photo || ''))) throw uerr_('Step 2: take the shipment photo first');
  if (String(photo).length > 8 * 1024 * 1024) throw uerr_('The photo is too large: take it again');
}
/** Saves the shipment photo of an order (after Shopify accepted the fulfillment / return). Never fails the action:
 *  a problem is reported back as photo: false. */
function saveOrderPhoto_(o) {
  try {
    const tn = String(o.tn), now = new Date(), user = Session.getActiveUser().getEmail() || 'app';
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      const mime = (/^data:(image\/\w+);/.exec(o.photo) || [])[1] || 'image/jpeg';
      const file = folder_().createFile(Utilities.newBlob(Utilities.base64Decode(String(o.photo).split(',')[1]), mime,
        (o.isReturn ? 'RETURN_' : '') + tn.replace(/[^\w-]/g, '_') + '_' + Utilities.formatDate(now, 'Africa/Cairo', 'yyyyMMdd-HHmmss') + '_1.jpg'));
      carrierCol_().appendRow([now, "'" + tn, file.getId(), file.getUrl(), 'Order ' + (o.order || ''), user, o.carrier + (o.isReturn ? ' return' : '')]);
      if (!o.isReturn && o.carrier === 'Bosta') {                       // followed by the bulky check, like a Shipments photo
        const r = findRow_('Tracking', tn), t = sh_('Tracking');
        if (r) t.getRange(r, 3).setValue(Number(t.getRange(r, 3).getValue()) + 1);
        else t.appendRow(["'" + tn, now, 1, '', '', false]);
      }
    } finally { lock.releaseLock(); }
    logActivity_('Shipments', o.isReturn ? 'return photo' : 'photo', tn, 1, { order: o.order || '', carrier: o.carrier });
    return true;
  } catch (e) { logError_('Shipments', 'order photo', e); return false; }
}

function fulfill_(items, notify, orderName, tracking, photo, carrier) {
  if (!items || !items.length) return { ok: false, error: 'No items' };
  needShipmentPhoto_(tracking, photo);
  // a Bosta waybill scanned with the order: checked again here, so only a real Bosta number for this order is saved
  let track = null;
  carrier = String(carrier || '').trim().slice(0, 40);
  if (carrier) track = { company: carrier, number: String(tracking).trim().slice(0, 60) };   // another carrier: kept as typed
  else if (tracking) {
    const w = checkWaybill_(tracking, orderName);
    if (!w.bosta) throw uerr_(String(tracking) + ' is not a Bosta waybill');
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
  // the photo (and, for Bosta, the hourly bulky check) follows this shipment
  const saved = saveOrderPhoto_({ tn: track.number, photo: photo, order: orderName, carrier: carrier || 'Bosta' });
  return { ok: true, status: r.fulfillment.status, tracking: track ? track.number : '', photo: saved };
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
    '      fulfillmentLineItem { id lineItem { title sku image { url } variant { id barcode sku } } }' +
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
        variantId: v.id || '',
        image: li.image ? li.image.url : '',
        need: n.quantity            // how many can be returned
      });
    });
  });

  addBarcodes_(items);
  return { ok: true, order: { id: order.id, name: order.name }, items: items };
}

/** Returns: creates the return in Shopify and (optionally) restocks the items. No refund is made here. */
function processReturn_(body) {
  const items = (body.items || []).filter(function (i) { return i.fliId && i.qty > 0; });
  if (!body.orderId || !items.length) throw new Error('Nothing to return');
  needShipmentPhoto_(body.shipment, body.photo);
  // the return shipment: a Bosta number must exist in Bosta (a misread is caught); another carrier is kept as typed
  const carrier = String(body.carrier || '').trim().slice(0, 40);
  let shipTn = String(body.shipment).trim().slice(0, 60);
  if (!carrier) {
    shipTn = shipTn.replace(/\D/g, '').slice(-10);
    if (shipTn.length < 9) throw uerr_('Not a Bosta waybill: ' + body.shipment + '. Scan again, or choose Other carrier.');
    if (P.getProperty('BOSTA_API_KEY')) {
      try { bosta_(shipTn); } catch (e) { if (/Bosta (400|404)/.test(e.message)) throw uerr_(shipTn + ' not found in Bosta. Scan again, or choose Other carrier.'); }
    }
  }
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

  logActivity_('Orders', 'return', ret.name, items.reduce(function (t, i) { return t + (Number(i.qty) || 0); }, 0), { restock: !!body.restock, reason: reason, shipment: shipTn });
  const saved = saveOrderPhoto_({ tn: shipTn, photo: body.photo, order: body.orderName || ret.name, carrier: carrier || 'Bosta', isReturn: true });
  return { ok: true, returnName: ret.name, photo: saved };
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
/** Every barcode of a variant (Shopify 2026 allows several; `barcode` is the first), first one first, no repeats. */
function barcodes_(v) {
  if (!v) return [];
  return [v.barcode].concat(((v.barcodes && v.barcodes.nodes) || []).map(function (b) { return b && b.value; }))
    .map(function (b) { return String(b || '').trim(); }).filter(function (b, i, a) { return b && a.indexOf(b) === i; });
}
/** Adds `barcodes` (all of the variant's barcodes) to items that have a variantId. Asked separately, 50 variants at a
 *  time, so the big order / purchase order queries stay under Shopify's query-cost limit. If it fails, scanning still
 *  works with the first barcode. */
function addBarcodes_(items) {
  const ids = items.map(function (i) { return i.variantId; }).filter(function (id, k, a) { return id && a.indexOf(id) === k; });
  const by = {};
  try {
    for (let k = 0; k < ids.length; k += 50) {
      shopifyAt_(RECEIVE_API, 'query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id barcode barcodes(first: 10) { nodes { value } } } } }',
        { ids: ids.slice(k, k + 50) }).nodes.forEach(function (n) { if (n && n.id) by[n.id] = barcodes_(n); });
    }
  } catch (e) { console.warn('addBarcodes_', e.message); }
  items.forEach(function (i) { i.barcodes = by[i.variantId] || (i.barcode ? [i.barcode] : []); });
  return items;
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
  addBarcodes_(items);
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
  const bv = metaKey_('binVariant'), bp = metaKey_('binProduct'), ex = metaKey_('expProduct'), ep = metaKey_('expPrevProduct');
  // small pages keep each request under Shopify's query-cost limit (1000)
  return 'query($cursor: String, $q: String, $sort: OrderSortKeys) { orders(first: 10, after: $cursor, query: $q, sortKey: $sort) {' +
    ' pageInfo { hasNextPage endCursor }' +
    ' nodes { id name cancelledAt displayFulfillmentStatus displayFinancialStatus tags' +
    '  lineItems(first: 40) { nodes { quantity title variantTitle' +
    '   variant { id sku title media(first: 1) { nodes { ' + img + ' } }' +
    '    metafield(namespace: "' + bv.namespace + '", key: "' + bv.key + '") { value }' +
    '    product { id title featuredMedia { ' + img + ' } metafield(namespace: "' + bp.namespace + '", key: "' + bp.key + '") { value }' +
    '     pExp: metafield(namespace: "' + ex.namespace + '", key: "' + ex.key + '") { value } pExpPrev: metafield(namespace: "' + ep.namespace + '", key: "' + ep.key + '") { value } } } } } } } }';
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
        const expiry = binValue_(prod.pExp), expPrev = binValue_(prod.pExpPrev);   // the previous batch is picked first
        const qty = Number(li.quantity) || 0;
        const e = products[v.id];
        if (!e) products[v.id] = { key: v.id, image: image, title: title, variantName: variantName, sku: v.sku || '', quantity: qty,
          productBin: productBin, variantBin: variantBin, expiry: expiry, expPrev: expPrev, orders: [order.name || ''] };
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
      (pl.truncated ? '\n⚠️ يوجد أكثر من 1000 طلب في الانتظار: أنشئ قائمة أخرى للباقي' : '') + '\nافتح التطبيق ← قائمة التجميع');
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
  if (/^Wrong (PIN|app key|Tasks pass)$/.test(msg)) return;     // someone typing a wrong login is not a fault
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
 * Barcode labels: the app makes the PDF (one 50 x 25 mm page per label) and this saves it in the Google Drive folder
 * "PetFriend Labels" (LABELS_FOLDER_ID), to open and print from the computer.
 * ===================================================================================== */
function labelsFolder_() {
  const id = P.getProperty('LABELS_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* deleted: make a new one */ } }
  const f = DriveApp.createFolder('PetFriend Labels');
  P.setProperty('LABELS_FOLDER_ID', f.getId());
  return f;
}
function saveLabels_(r) {
  const b64 = String((r && r.pdf) || '');
  if (!/^JVBERi0/.test(b64)) throw new Error('Not a PDF');                 // "%PDF-" in base64
  if (b64.length > 14 * 1024 * 1024) throw new Error('Too many labels in one file: print fewer at a time');
  const name = (String(r.name || 'Labels.pdf').replace(/[^\w\- ().]/g, '').slice(0, 120) || 'Labels') .replace(/(\.pdf)?$/i, '.pdf');
  const folder = labelsFolder_();
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b64), 'application/pdf', name));
  logActivity_('Labels', 'pdf', name, Number(r.count) || 0, { where: String(r.where || '') });
  let folderUrl = '';
  try { folderUrl = folder.getUrl(); } catch (e) {}
  return { ok: true, url: file.getUrl(), name: name, folderUrl: folderUrl };
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
 * Shopify logins: set from a menu in the spreadsheet, and watched for changes
 * The Project Settings page of Apps Script saves ALL Script Properties at once, with the values it showed when it was
 * opened: saving from a stale page (or a second tab) puts old secrets back. So:
 *  - menu "بتفريند" in the spreadsheet: enter a new Client ID / secret; it is checked with Shopify first and saved
 *    only if Shopify accepts it (no Project Settings page involved)
 *  - watchSecrets_ (every hour, with the Bosta check, and when a login is refused) keeps a short fingerprint of each
 *    secret (never the secret) and logs to Errors (and Telegram) when one changes, or goes back to an older value.
 * ===================================================================================== */
const LOGINS = {
  pos:    { name: 'POS',    id: 'CLIENT_ID',         secret: 'CLIENT_SECRET',         host: function () { return posHost_(); },   cache: 'tok' },
  orders: { name: 'Orders', id: 'SHOPIFY_CLIENT_ID', secret: 'SHOPIFY_CLIENT_SECRET', host: function () { return storeHost_(); }, cache: 'shopify_token' }
};
/** Cache key of a saved Shopify token: tied to a fingerprint of its Client ID + secret, so when the secret changes in
 *  Script Properties the token made from the old secret is never used again (a new one is fetched at once). */
function tokKey_(kind) {
  const L = LOGINS[kind];
  return L.cache + '_' + fingerprint_(String(P.getProperty(L.id) || '') + ':' + String(P.getProperty(L.secret) || ''));
}
const WATCHED_SECRETS = ['CLIENT_ID', 'CLIENT_SECRET', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'APP_KEY', 'POS_PIN', 'APP_PIN', 'MANAGER_PIN', 'BOSTA_API_KEY', 'TELEGRAM_BOT_TOKEN'];
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('بتفريند')
      .addItem('تحديث بيانات دخول شوبيفاي للكاشير', 'menuSetPosLogin')
      .addItem('تحديث بيانات دخول شوبيفاي للطلبات', 'menuSetOrdersLogin')
      .addSeparator()
      .addItem('كلمة مرور المدير للمهام', 'menuSetManagerPin')
      .addItem('تشغيل نظام المهام (تيليجرام)', 'installTasksTriggers')
      .addItem('الشحنات كبيرة الحجم لآخر 14 يومًا', 'bulkyLast14Days')
      .addItem('فحص كل الإعدادات', 'testAll')
      .addToUi();
  } catch (e) { /* not opened from the spreadsheet */ }
}
/** Sheet menu: the manager's Tasks pass, saved without the Project Settings page (which can put old secrets back). */
function menuSetManagerPin() {
  const ui = SpreadsheetApp.getUi();
  const a = ui.prompt('كلمة مرور المدير للمهام', 'اكتب كلمة مرور المدير (4 أحرف أو أرقام على الأقل). بها تفتح تبويب المهام وتضيف الموظفين والمهام.', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  const pin = String(a.getResponseText() || '').trim();
  if (pin.length < 4) { ui.alert('❌ يجب أن تتكون كلمة المرور من 4 أحرف أو أرقام على الأقل.'); return; }
  P.setProperty('MANAGER_PIN', pin);
  watchSecrets_('saved from the menu');
  ui.alert('✅ تم الحفظ. اكتبها في إعدادات تبويب المهام في التطبيق.');
}
function menuSetPosLogin() { menuSetLogin_('pos'); }
function menuSetOrdersLogin() { menuSetLogin_('orders'); }
function menuSetLogin_(kind) {
  const ui = SpreadsheetApp.getUi(), L = LOGINS[kind];
  const a = ui.prompt('Shopify ' + L.name + ': Client ID', 'From Shopify: Settings > Apps > Develop apps > the ' + L.name + ' app > API credentials.\nLeave empty to keep the current Client ID.', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  const b = ui.prompt('Shopify ' + L.name + ': Client secret', 'Paste the Client secret. It is checked with Shopify before it is saved.', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  const r = setShopifyLogin_(kind, a.getResponseText(), b.getResponseText());
  ui.alert(r.ok ? '✅ تم: قبِل شوبيفاي البيانات وحُفظت.' : '❌ لم يتم الحفظ: ' + r.error);
}
/** Checks a Client ID / secret with Shopify (client credentials) and saves them only if Shopify gives a token. */
function setShopifyLogin_(kind, id, secret) {
  const L = LOGINS[kind];
  if (!L) return { ok: false, error: 'Unknown login' };
  id = String(id || '').trim() || String(P.getProperty(L.id) || '');
  secret = String(secret || '').trim();
  if (!id || !secret) return { ok: false, error: 'Client ID and Client secret are needed' };
  let res;
  try {
    res = UrlFetchApp.fetch('https://' + L.host() + '/admin/oauth/access_token', { method: 'post', muteHttpExceptions: true,
      payload: { grant_type: 'client_credentials', client_id: id, client_secret: secret } });
  } catch (e) { return { ok: false, error: 'Shopify could not be reached: ' + e.message }; }
  let j = null; try { j = JSON.parse(res.getContentText()); } catch (e) {}
  if (!j || !j.access_token) return { ok: false, error: 'Shopify refused this Client ID / secret (HTTP ' + res.getResponseCode() + '). Nothing was changed.' };
  P.setProperties((function () { const o = {}; o[L.id] = id; o[L.secret] = secret; return o; })());
  const c = CacheService.getScriptCache();
  c.put(tokKey_(kind), j.access_token, kind === 'pos' ? 21000 : 20 * 3600);
  if (kind === 'pos') c.remove('pos_use_orders_app');
  watchSecrets_('saved from the menu');
  return { ok: true };
}
/** Short fingerprint of a secret (FNV-1a, 8 hex characters): shows that a value changed, never what it is. */
function fingerprint_(v) {
  let h = 2166136261; const s = String(v);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
function watchSecrets_(why) {
  let seen = {};
  try { seen = JSON.parse(P.getProperty('SECRET_WATCH') || '{}'); } catch (e) { seen = {}; }
  const now = new Date().toISOString(), notes = [];
  WATCHED_SECRETS.forEach(function (k) {
    const v = P.getProperty(k), fp = v ? fingerprint_(v) : '-', h = seen[k] || (seen[k] = []);
    if (!h.length) { h.push({ fp: fp, at: now }); return; }
    if (h[h.length - 1].fp === fp) return;
    const older = h.slice(0, -1).filter(function (x) { return x.fp === fp; })[0];
    notes.push(k + (older ? ' went BACK to an older value (first seen ' + older.at.slice(0, 16).replace('T', ' ') + ' UTC)' : fp === '-' ? ' was deleted' : ' changed') +
      (why === 'saved from the menu' ? ' (saved from the menu)' : ''));
    h.push({ fp: fp, at: now });
    if (h.length > 6) h.shift();
  });
  try { P.setProperty('SECRET_WATCH', JSON.stringify(seen)); } catch (e) {}
  if (notes.length && why !== 'saved from the menu') logError_('Settings', 'secret changed', new Error(notes.join('; ') + '. Did someone save the Project Settings page? Use the بتفريند menu in the sheet instead.'));
  else if (notes.length) logActivity_('Settings', 'login saved', notes.join('; '), 0);
  return notes;
}

/* =====================================================================================
 * Telegram notifications to the store's group
 * Script Properties: TELEGRAM_BOT_TOKEN (from @BotFather, secret: never in the code), TELEGRAM_CHAT_ID (the group,
 * found with telegramFindChat), TELEGRAM_OFF (optional, comma list of kinds to silence: picklist, bulky, errors,
 * daily). Without a token or chat id nothing is sent. Run installTelegramTrigger once for the 9 pm daily report.
 * ===================================================================================== */
const TG_KINDS = ['picklist', 'bulky', 'errors', 'daily', 'tasks', 'requests'];
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
  // once the Tasks inbox runs (tgPoll), it reads the bot's messages first and keeps the groups it saw
  try { const g = JSON.parse(P.getProperty('TG_SEEN_GROUPS') || '{}'); Object.keys(g).forEach(function (id) { chats[id] = g[id] || id; }); } catch (e) {}
  const ids = Object.keys(chats);
  if (!ids.length) { Logger.log('No group found. Add the bot to the group, write any message in the group, then run this again.'); return; }
  ids.forEach(function (id) { Logger.log('Group: ' + chats[id] + '  id: ' + id); });
  if (ids.length === 1) {
    P.setProperty('TELEGRAM_CHAT_ID', ids[0]);
    Logger.log('Saved TELEGRAM_CHAT_ID. Sending a test message...');
    Logger.log(tgSend_('✅ بتفريند: الإشعارات تعمل في هذه المجموعة.') ? 'Test message sent.' : 'Test message failed: see the log above.');
  } else Logger.log('More than one group: copy the right id into TELEGRAM_CHAT_ID yourself.');
}
/** Editor: sends a test message to the group. */
function testTelegram() { Logger.log(tgSend_('✅ بتفريند: رسالة تجريبية.') ? 'Sent.' : 'Not sent: check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.'); }
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
  L.push('✅ طلبات تم تجهيزها: ' + d.fulfilled.count + ' (' + d.fulfilled.qty + ' قطعة)');
  if (d.openOrders != null) L.push('⏳ طلبات مفتوحة: ' + d.openOrders);
  L.push('↩️ مرتجعات: ' + d.returns.count + ' (' + d.returns.qty + ' قطعة)');
  L.push('📥 استلام من الموردين: ' + d.received.qty + ' قطعة' + (d.received.extra ? ' · زيادة: ' + d.received.extra : '') +
    (d.received.rejected ? ' · مرفوض: ' + d.received.rejected : ''));
  L.push('🧾 قوائم التجميع: ' + d.pickLists.count);
  L.push('📷 صور الشحنات: ' + d.photos.qty + (d.returnPhotos && d.returnPhotos.qty ? ' · صور المرتجعات: ' + d.returnPhotos.qty : ''));
  if (d.bulky && d.bulky.count) L.push('📦 شحنات كبيرة الحجم: ' + d.bulky.count);
  try {
    const ex = expiryReport_({}).items.filter(function (x) { return x.stock > 0 && x.daysLeft <= 7; });
    const past = ex.filter(function (x) { return x.daysLeft < 0; }), soon = ex.filter(function (x) { return x.daysLeft >= 0; });
    if (past.length) L.push('⛔ منتهي الصلاحية وموجود بالمخزون: ' + past.length + '\n' + past.slice(0, 5).map(function (x) { return '  • ' + x.title + ' (' + x.expiry + ')'; }).join('\n'));
    if (soon.length) L.push('⚠️ تنتهي صلاحيته خلال 7 أيام: ' + soon.length + '\n' + soon.slice(0, 5).map(function (x) { return '  • ' + x.title + ' (' + x.expiry + ')'; }).join('\n'));
  } catch (e) { L.push('⚠️ تعذر فحص الصلاحية'); }
  L.push(d.errors.count ? '❗ أخطاء اليوم: ' + d.errors.count : '👍 لا توجد أخطاء اليوم');
  return tgNotify_('daily', L.join('\n'));
}

/* =====================================================================================
 * Tasks: jobs for the staff, reminders and done buttons on Telegram
 *
 * Tab "Tasks" in the app. Login "Tasks pass": the manager's pass (MANAGER_PIN in Script Properties) sees and edits
 * everything; each employee has their own pass (set by the manager in the app, stored only as a hash) and sees only
 * their own tasks, and can mark them done.
 * Sheets: TaskStaff (employees), Tasks (every task), TaskRepeats (weekly / monthly tasks that are made on their day).
 * Telegram (same bot as the group notices): each employee opens the bot once from their link in the app
 * (t.me/<bot>?start=<code>); after that every new task comes to them with a "done" button, and every morning a summary.
 * tgPoll (every minute) reads the bot's messages and button taps. Run installTasksTriggers once (or the sheet menu).
 * ===================================================================================== */
const TASK_SHEETS = {
  TaskStaff: ['Id', 'Name', 'PassHash', 'ChatId', 'LinkCode', 'Active', 'CreatedAt'],
  Tasks: ['Id', 'Title', 'Notes', 'EmployeeId', 'Due', 'Status', 'CreatedAt', 'DoneAt', 'DoneVia', 'RepeatId'],
  TaskRepeats: ['Id', 'Title', 'Notes', 'EmployeeId', 'Freq', 'Day', 'DueDays', 'Active', 'LastMade', 'CreatedAt']
};
const TASK_ACTIONS = {
  tasksInit: function (r, who) { return tasksInit_(who); },
  taskSave: function (r, who) { return taskSave_(r, who); },
  taskDone: function (r, who) { return taskDone_(r, who); },
  taskDelete: function (r, who) { return taskDelete_(r, who); },
  staffSave: function (r, who) { return staffSave_(r, who); },
  staffDelete: function (r, who) { return staffDelete_(r, who); },
  staffRelink: function (r, who) { return staffRelink_(r, who); },
  repeatSave: function (r, who) { return repeatSave_(r, who); },
  repeatDelete: function (r, who) { return repeatDelete_(r, who); }
};
const WEEKDAYS_AR = ['', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'];

function tasksApi_(r) {
  try {
    const who = taskWho_(r.tpin);
    return TASK_ACTIONS[r.action](r, who);
  } catch (err) {
    if (!err.user) logError_('Tasks', r.action, err);         // typing mistakes are shown in the app, not logged
    return { ok: false, error: String(err.message || err) };
  }
}
/** A mistake in what was typed (shown in the app; not an app fault, so not logged / sent to Telegram). */
function uerr_(msg) { const e = new Error(msg); e.user = true; return e; }
function passHash_(pin) {
  let salt = P.getProperty('TASK_SALT');
  if (!salt) { salt = Utilities.getUuid(); P.setProperty('TASK_SALT', salt); }
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8));
}
/** The manager (MANAGER_PIN) or one employee (their own pass). */
function taskWho_(pin) {
  pin = String(pin || '').trim();
  const mgr = P.getProperty('MANAGER_PIN');
  if (!mgr) throw uerr_('Set MANAGER_PIN in Script Properties (the manager\'s Tasks pass)');
  if (!pin) throw uerr_('Wrong Tasks pass');
  if (pin === mgr) return { manager: true, name: 'Manager' };
  const h = passHash_(pin), e = tRows_('TaskStaff').filter(function (x) { return x.Active !== false && x.PassHash === h; })[0];
  if (!e) throw uerr_('Wrong Tasks pass');
  return { manager: false, id: e.Id, name: e.Name };
}
function needManager_(who) { if (!who.manager) throw uerr_('Only the manager can do this'); }

// ---- sheets as lists of objects (row numbers kept in _row)
function tSheet_(name) {
  const ss = SpreadsheetApp.getActive() || SpreadsheetApp.openById(P.getProperty('SHEET_ID') || P.getProperty('SPREADSHEET_ID'));
  let s = ss.getSheetByName(name);
  if (!s) { s = ss.insertSheet(name); s.appendRow(TASK_SHEETS[name]); s.setFrozenRows(1); }
  return s;
}
function tRows_(name) {
  const s = tSheet_(name), n = s.getLastRow(), head = TASK_SHEETS[name];
  if (n < 2) return [];
  return s.getRange(2, 1, n - 1, head.length).getValues().map(function (v, i) {
    const o = { _row: i + 2 };
    head.forEach(function (h, k) { o[h] = typeof v[k] === 'string' ? v[k].replace(/^'/, '') : v[k]; });
    return o;
  }).filter(function (o) { return o.Id; });
}
function tCell_(v) {
  if (v === true || v === false || typeof v === 'number' || v instanceof Date) return v;
  return v == null || v === '' ? '' : "'" + String(v);        // text stays text (dates, ids, chat ids)
}
function tPut_(name, o) {
  const s = tSheet_(name), head = TASK_SHEETS[name], row = head.map(function (h) { return tCell_(o[h]); });
  if (o._row) s.getRange(o._row, 1, 1, head.length).setValues([row]);
  else { s.getRange(s.getLastRow() + 1, 1, 1, head.length).setValues([row]); o._row = s.getLastRow(); }
  return o;
}
function tId_(prefix) { return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }
function withTaskLock_(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { throw uerr_('The app is busy right now. Try again in a minute.'); }
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---- dates (script time zone): "yyyy-MM-dd" and "yyyy-MM-dd HH:mm" texts
function taskToday_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function taskNow_() { return taskToday_() + ' ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm'); }
function dayInfo_(ymd) {   // weekday 1 = Monday .. 7 = Sunday, day of month, days in the month
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd), d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return { wd: d.getUTCDay() || 7, day: +m[3], last: new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate() };
}
function addDays_(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd), d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  return d.toISOString().slice(0, 10);
}
function cleanDue_(v) {
  v = String(v || '').trim().replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(v)) throw uerr_('Due date must be a date (and optional time)');
  return v;
}
function isLate_(due) { return !!due && (due.length > 10 ? due : due + ' 23:59') < taskNow_(); }

// ---- what the app shows
function staffOut_(e, bot) {
  return { id: e.Id, name: e.Name, active: e.Active !== false, linked: !!e.ChatId, link: bot && e.LinkCode ? 'https://t.me/' + bot + '?start=' + e.LinkCode : '' };
}
function taskOut_(t, names) {
  return { id: t.Id, title: t.Title, notes: t.Notes, employeeId: t.EmployeeId, employee: names[t.EmployeeId] || '', due: t.Due, status: t.Status,
    late: t.Status === 'open' && isLate_(t.Due), createdAt: t.CreatedAt ? new Date(t.CreatedAt).toISOString() : '',
    doneAt: t.DoneAt ? new Date(t.DoneAt).toISOString() : '', doneVia: t.DoneVia || '', repeatId: t.RepeatId || '' };
}
function tasksInit_(who) {
  const staff = tRows_('TaskStaff'), names = {};
  staff.forEach(function (e) { names[e.Id] = e.Name; });
  const since = Date.now() - (who.manager ? 30 : 7) * 864e5;
  const tasks = tRows_('Tasks').filter(function (t) {
    if (t.Status === 'cancelled') return false;
    if (!who.manager && t.EmployeeId !== who.id) return false;
    return t.Status === 'open' || (t.DoneAt && new Date(t.DoneAt).getTime() >= since);
  }).map(function (t) { return taskOut_(t, names); })
    .sort(function (a, b) { return (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || String(a.due).localeCompare(String(b.due)); });
  const out = { ok: true, role: who.manager ? 'manager' : 'employee', me: who.name, today: taskToday_(), tasks: tasks };
  if (who.manager) {
    let bot = '';
    try { bot = tgBotName_(); } catch (e) {}
    out.bot = bot;
    out.telegram = !!P.getProperty('TELEGRAM_BOT_TOKEN');
    out.staff = staff.map(function (e) { return staffOut_(e, bot); }).filter(function (e) { return e.active; });
    out.repeats = tRows_('TaskRepeats').filter(function (x) { return x.Active !== false; }).map(function (x) {
      return { id: x.Id, title: x.Title, notes: x.Notes, employeeId: x.EmployeeId, employee: names[x.EmployeeId] || '', freq: x.Freq, day: Number(x.Day), dueDays: Number(x.DueDays) || 0, lastMade: x.LastMade || '' };
    });
  }
  return out;
}

// ---- tasks
function taskSave_(r, who) {
  needManager_(who);
  const t = r.task || {}, title = String(t.title || '').trim().slice(0, 300);
  if (!title) throw uerr_('Write the task');
  const emp = tRows_('TaskStaff').filter(function (e) { return e.Id === t.employeeId && e.Active !== false; })[0];
  if (!emp) throw uerr_('Choose the employee');
  const due = cleanDue_(t.due);
  return withTaskLock_(function () {
    let row = t.id ? tRows_('Tasks').filter(function (x) { return x.Id === t.id; })[0] : null;
    if (t.id && !row) throw uerr_('Task not found');
    const isNew = !row, moved = row && (row.EmployeeId !== emp.Id || row.Due !== due || row.Title !== title);
    row = Object.assign(row || { Id: tId_('T'), Status: 'open', CreatedAt: new Date(), DoneAt: '', DoneVia: '', RepeatId: '' },
      { Title: title, Notes: String(t.notes || '').trim().slice(0, 1000), EmployeeId: emp.Id, Due: due });
    tPut_('Tasks', row);
    logActivity_('Tasks', isNew ? 'new' : 'edit', title, 0, { employee: emp.Name, due: due });
    let sent = false;
    if ((isNew || moved) && row.Status === 'open') sent = sendTask_(row, emp, isNew ? '' : '✏️ تعديل على مهمة');
    return { ok: true, id: row.Id, sent: sent, linked: !!emp.ChatId };
  });
}
function taskDone_(r, who) {
  return withTaskLock_(function () {
    const t = tRows_('Tasks').filter(function (x) { return x.Id === r.id; })[0];
    if (!t || t.Status === 'cancelled') throw uerr_('Task not found');
    if (!who.manager && t.EmployeeId !== who.id) throw uerr_('This is not your task');
    const done = r.done !== false;
    markTask_(t, done, who.manager ? 'manager' : 'app');
    return { ok: true, id: t.Id, status: t.Status };
  });
}
function markTask_(t, done, via) {
  t.Status = done ? 'done' : 'open'; t.DoneAt = done ? new Date() : ''; t.DoneVia = done ? via : '';
  tPut_('Tasks', t);
  const emp = tRows_('TaskStaff').filter(function (e) { return e.Id === t.EmployeeId; })[0] || {};
  logActivity_('Tasks', done ? 'done' : 'reopen', t.Title, 0, { employee: emp.Name || '', via: via });
  if (done) tgNotify_('tasks', '✅ أنجز ' + (emp.Name || '') + ' المهمة: ' + t.Title + (isLate_(t.Due) ? ' (متأخرة، كان موعدها ' + t.Due + ')' : ''));
}
function taskDelete_(r, who) {
  needManager_(who);
  return withTaskLock_(function () {
    const t = tRows_('Tasks').filter(function (x) { return x.Id === r.id; })[0];
    if (!t) throw uerr_('Task not found');
    t.Status = 'cancelled'; tPut_('Tasks', t);
    logActivity_('Tasks', 'delete', t.Title, 0);
    return { ok: true };
  });
}

// ---- employees
function staffSave_(r, who) {
  needManager_(who);
  const e = r.staff || {}, name = String(e.name || '').trim().slice(0, 60), pin = String(e.pin || '').trim();
  if (!name) throw uerr_('Write the employee\'s name');
  if (pin && pin.length < 4) throw uerr_('The pass must be at least 4 characters');
  return withTaskLock_(function () {
    const all = tRows_('TaskStaff');
    let row = e.id ? all.filter(function (x) { return x.Id === e.id; })[0] : null;
    if (e.id && !row) throw uerr_('Employee not found');
    if (!row && !pin) throw uerr_('Choose a pass for the employee');
    if (pin) {
      if (pin === P.getProperty('MANAGER_PIN')) throw uerr_('This pass is the manager\'s: choose another');
      const h = passHash_(pin);
      if (all.some(function (x) { return x.Active !== false && x.PassHash === h && x.Id !== (row && row.Id); })) throw uerr_('Another employee has this pass: choose another');
    }
    row = Object.assign(row || { Id: tId_('E'), ChatId: '', LinkCode: tLinkCode_(), Active: true, CreatedAt: new Date() }, { Name: name });
    if (pin) row.PassHash = passHash_(pin);
    tPut_('TaskStaff', row);
    logActivity_('Tasks', e.id ? 'edit employee' : 'new employee', name, 0);
    let bot = ''; try { bot = tgBotName_(); } catch (x) {}
    return { ok: true, staff: staffOut_(row, bot) };
  });
}
function tLinkCode_() { return Utilities.getUuid().replace(/[^a-z0-9]/gi, '').slice(0, 16); }
function staffDelete_(r, who) {
  needManager_(who);
  return withTaskLock_(function () {
    const e = tRows_('TaskStaff').filter(function (x) { return x.Id === r.id; })[0];
    if (!e) throw uerr_('Employee not found');
    e.Active = false; e.PassHash = ''; e.ChatId = ''; e.LinkCode = '';
    tPut_('TaskStaff', e);
    logActivity_('Tasks', 'remove employee', e.Name, 0);
    return { ok: true };
  });
}
/** A new Telegram link for an employee (e.g. new phone): the old chat stops getting tasks until the link is opened. */
function staffRelink_(r, who) {
  needManager_(who);
  return withTaskLock_(function () {
    const e = tRows_('TaskStaff').filter(function (x) { return x.Id === r.id && x.Active !== false; })[0];
    if (!e) throw uerr_('Employee not found');
    e.ChatId = ''; e.LinkCode = tLinkCode_(); tPut_('TaskStaff', e);
    let bot = ''; try { bot = tgBotName_(); } catch (x) {}
    return { ok: true, staff: staffOut_(e, bot) };
  });
}

// ---- weekly / monthly tasks
function repeatSave_(r, who) {
  needManager_(who);
  const x = r.repeat || {}, title = String(x.title || '').trim().slice(0, 300);
  if (!title) throw uerr_('Write the task');
  const emp = tRows_('TaskStaff').filter(function (e) { return e.Id === x.employeeId && e.Active !== false; })[0];
  if (!emp) throw uerr_('Choose the employee');
  const freq = x.freq === 'monthly' ? 'monthly' : 'weekly', day = Math.round(Number(x.day));
  if (freq === 'weekly' ? !(day >= 1 && day <= 7) : !(day >= 1 && day <= 31)) throw uerr_('Choose the day');
  const dueDays = Math.max(0, Math.min(60, Math.round(Number(x.dueDays) || 0)));
  const res = withTaskLock_(function () {
    let row = x.id ? tRows_('TaskRepeats').filter(function (y) { return y.Id === x.id; })[0] : null;
    if (x.id && !row) throw uerr_('Not found');
    row = Object.assign(row || { Id: tId_('R'), Active: true, LastMade: '', CreatedAt: new Date() },
      { Title: title, Notes: String(x.notes || '').trim().slice(0, 1000), EmployeeId: emp.Id, Freq: freq, Day: day, DueDays: dueDays });
    tPut_('TaskRepeats', row);
    logActivity_('Tasks', x.id ? 'edit repeat' : 'new repeat', title, 0, { employee: emp.Name, freq: freq, day: day });
    return row;
  });
  // its day is today: make today's task now (after the morning run it would wait a week / month)
  const made = makeRepeats_(taskToday_(), true, res.Id);
  return { ok: true, id: res.Id, madeToday: made };
}
function repeatDelete_(r, who) {
  needManager_(who);
  return withTaskLock_(function () {
    const x = tRows_('TaskRepeats').filter(function (y) { return y.Id === r.id; })[0];
    if (!x) throw uerr_('Not found');
    x.Active = false; tPut_('TaskRepeats', x);
    logActivity_('Tasks', 'delete repeat', x.Title, 0);
    return { ok: true };
  });
}
/** Makes today's tasks from the weekly / monthly list (each once a day). notify: send each to its employee now. */
function makeRepeats_(ymd, notify, onlyId) {
  const di = dayInfo_(ymd), staff = {};
  tRows_('TaskStaff').forEach(function (e) { staff[e.Id] = e; });
  let made = 0;
  withTaskLock_(function () {
    tRows_('TaskRepeats').forEach(function (x) {
      if (x.Active === false || (onlyId && x.Id !== onlyId) || x.LastMade === ymd) return;
      const day = Number(x.Day), due = x.Freq === 'monthly' ? (di.day === day || (day > di.last && di.day === di.last)) : di.wd === day;
      const emp = staff[x.EmployeeId];
      if (!due || !emp || emp.Active === false) return;
      const t = tPut_('Tasks', { Id: tId_('T'), Title: x.Title, Notes: x.Notes, EmployeeId: x.EmployeeId, Due: addDays_(ymd, Number(x.DueDays) || 0),
        Status: 'open', CreatedAt: new Date(), DoneAt: '', DoneVia: '', RepeatId: x.Id });
      x.LastMade = ymd; tPut_('TaskRepeats', x); made++;
      if (notify) sendTask_(t, emp, '🔁 مهمة دورية');
    });
  });
  return made;
}

// ---- Telegram: messages to one employee, the bot's inbox (every minute), the morning summary
function tgApi_(method, payload) {
  const token = P.getProperty('TELEGRAM_BOT_TOKEN');
  if (!token) return null;
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload || {}) });
  let j = null; try { j = JSON.parse(res.getContentText()); } catch (e) {}
  if (!j || !j.ok) { console.error('Telegram ' + method + ' ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300)); return null; }
  return j.result;
}
function tgBotName_() {
  const c = CacheService.getScriptCache(), hit = c.get('tg_bot_name');
  if (hit) return hit;
  const me = tgApi_('getMe');
  if (!me || !me.username) return '';
  c.put('tg_bot_name', me.username, 6 * 3600);
  return me.username;
}
function dueText_(due) {
  if (!due) return '';
  const di = dayInfo_(due), today = taskToday_();
  const when = due.slice(0, 10) === today ? 'اليوم' : due.slice(0, 10) === addDays_(today, 1) ? 'غدًا' : WEEKDAYS_AR[di.wd] + ' ' + due.slice(0, 10);
  return when + (due.length > 10 ? ' الساعة ' + due.slice(11) : '');
}
function taskLine_(t) {
  return (isLate_(t.Due) ? '⛔ ' : '▫️ ') + t.Title + '\n   ⏰ ' + dueText_(t.Due) + (isLate_(t.Due) ? ' (متأخرة)' : '');
}
function doneButton_(t) { return { text: '✅ أنجزت: ' + String(t.Title).slice(0, 40), callback_data: 'td:' + t.Id }; }
/** One task to its employee, with a "done" button. False when the employee has not linked Telegram (or no bot). */
function sendTask_(t, emp, head) {
  if (!emp) return false;
  // the group sees every task given out (also to employees who have not linked Telegram yet)
  tgNotify_('tasks', (head || '📌 مهمة جديدة') + ' — ' + emp.Name + '\n' + t.Title + '\n⏰ ' + dueText_(t.Due));
  if (!emp.ChatId) return false;
  const text = (head || '📌 مهمة جديدة') + '\n\n' + t.Title + (t.Notes ? '\n\n📝 ' + t.Notes : '') + '\n\n⏰ الموعد النهائي: ' + dueText_(t.Due);
  return !!tgApi_('sendMessage', { chat_id: emp.ChatId, text: text.slice(0, 4000), reply_markup: { inline_keyboard: [[{ text: '✅ أنجزت', callback_data: 'td:' + t.Id }]] } });
}
function sendOpenList_(emp, head) {
  const open = tRows_('Tasks').filter(function (t) { return t.EmployeeId === emp.Id && t.Status === 'open'; })
    .sort(function (a, b) { return String(a.Due).localeCompare(String(b.Due)); });
  if (!open.length) return tgApi_('sendMessage', { chat_id: emp.ChatId, text: (head ? head + '\n\n' : '') + 'لا توجد مهام مفتوحة 👍' });
  const shown = open.slice(0, 25);
  return tgApi_('sendMessage', { chat_id: emp.ChatId,
    text: ((head ? head + '\n\n' : '') + shown.map(taskLine_).join('\n') + (open.length > 25 ? '\n… و' + (open.length - 25) + ' مهام أخرى في التطبيق' : '')).slice(0, 4000),
    reply_markup: { inline_keyboard: shown.map(function (t) { return [doneButton_(t)]; }) } });
}
/** Time trigger, every minute: the bot's new messages (employees linking with /start <code>, /tasks) and "done" taps. */
function tgPoll() {
  if (!P.getProperty('TELEGRAM_BOT_TOKEN')) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return;                       // the previous run is still busy
  let ups;
  try {
    const offset = Number(P.getProperty('TG_OFFSET')) || 0;
    ups = tgApi_('getUpdates', { offset: offset, timeout: 0, allowed_updates: ['message', 'callback_query'] }) || [];
    if (ups.length) P.setProperty('TG_OFFSET', String(ups[ups.length - 1].update_id + 1));
  } finally { lock.releaseLock(); }
  ups.forEach(function (u) { try { tgHandle_(u); } catch (e) { console.error('tgHandle_', e.message); } });
}
function tgHandle_(u) {
  const staff = tRows_('TaskStaff').filter(function (e) { return e.Active !== false; });
  if (u.callback_query) {
    const qa = /^(ia|in):(\w+)$/.exec(u.callback_query.data || '');
    if (qa) { reqAnswer_(u.callback_query, qa); return; }        // inspection answer in the group
    const q = u.callback_query, m = /^td:(\w+)$/.exec(q.data || ''), chat = String(q.from && q.from.id);
    const emp = staff.filter(function (e) { return String(e.ChatId) === chat; })[0];
    let say = '';
    if (!m) say = '؟';
    else if (!emp) say = 'حسابك غير مرتبط: افتح رابط الربط الذي يرسله المدير';
    else withTaskLock_(function () {
      const t = tRows_('Tasks').filter(function (x) { return x.Id === m[1]; })[0];
      if (!t || t.Status === 'cancelled') say = 'تم إلغاء هذه المهمة';
      else if (t.EmployeeId !== emp.Id) say = 'هذه المهمة ليست لك';
      else if (t.Status === 'done') say = 'سُجِّلت منجزة من قبل ✅';
      else { markTask_(t, true, 'telegram'); say = 'تم التسجيل ✅'; }
    });
    tgApi_('answerCallbackQuery', { callback_query_id: q.id, text: say });
    if (q.message && /تم التسجيل|من قبل/.test(say) && q.message.reply_markup) {
      // take the tapped button off the message (others stay)
      const rows = (q.message.reply_markup.inline_keyboard || []).filter(function (row) { return !row.some(function (b) { return b.callback_data === q.data; }); });
      if (rows.length === (q.message.reply_markup.inline_keyboard || []).length - 1 && rows.length === 0)
        tgApi_('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: String(q.message.text || '').slice(0, 3900) + '\n\n✅ أُنجزت' });
      else tgApi_('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: rows } });
    }
    return;
  }
  const msg = u.message;
  if (!msg || !msg.chat) return;
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {   // for telegramFindChat: the bot reads its messages here now
    try { const g = JSON.parse(P.getProperty('TG_SEEN_GROUPS') || '{}'); g[msg.chat.id] = msg.chat.title || ''; P.setProperty('TG_SEEN_GROUPS', JSON.stringify(g)); } catch (e) {}
    return;
  }
  if (msg.chat.type !== 'private') return;
  const text = String(msg.text || '').trim(), chat = String(msg.chat.id);
  const start = /^\/start(?:\s+(\w+))?/.exec(text);
  if (start && start[1]) {
    const emp = staff.filter(function (e) { return e.LinkCode && e.LinkCode === start[1]; })[0];
    if (!emp) { tgApi_('sendMessage', { chat_id: chat, text: 'هذا الرابط قديم أو غير صحيح. اطلب رابطًا جديدًا من المدير.' }); return; }
    withTaskLock_(function () {
      // one chat = one employee: an older link of the same chat is removed
      staff.forEach(function (e) { if (String(e.ChatId) === chat && e.Id !== emp.Id) { e.ChatId = ''; tPut_('TaskStaff', e); } });
      emp.ChatId = chat; tPut_('TaskStaff', emp);
    });
    logActivity_('Tasks', 'telegram linked', emp.Name, 0);
    tgNotify_('tasks', '🔗 ربط ' + emp.Name + ' حسابه على تيليجرام بمهامه.');
    sendOpenList_(emp, 'أهلًا ' + emp.Name + ' 👋\nتم ربط حسابك بمهامك في بتفريند. ستصلك هنا كل مهمة جديدة، وملخص كل صباح.\nاكتب /tasks في أي وقت لعرض مهامك.');
    return;
  }
  const emp = staff.filter(function (e) { return String(e.ChatId) === chat; })[0];
  if (!emp) { tgApi_('sendMessage', { chat_id: chat, text: 'أهلًا 👋 افتح رابط الربط الذي سيرسله إليك المدير من تطبيق بتفريند.' }); return; }
  if (/^\/(tasks|start)\b|مهام/.test(text)) sendOpenList_(emp, '📋 مهامك المفتوحة');
}
/** Time trigger, every morning: makes today's weekly / monthly tasks, then sends each employee their open tasks. */
function tasksMorning() {
  const today = taskToday_();
  try { makeRepeats_(today, false); } catch (e) { logError_('Tasks', 'repeats', e); }
  try { evalReminder_(today); } catch (e) { logError_('Tasks', 'evaluation reminder', e); }
  // the group: one message with everyone's open tasks
  try {
    const open = tRows_('Tasks').filter(function (t) { return t.Status === 'open'; }), L = [];
    tRows_('TaskStaff').forEach(function (e) {
      if (e.Active === false) return;
      const mine = open.filter(function (t) { return t.EmployeeId === e.Id; }).sort(function (a, b) { return String(a.Due).localeCompare(String(b.Due)); });
      if (mine.length) L.push('👤 ' + e.Name + ' (' + mine.length + ')\n' + mine.slice(0, 10).map(taskLine_).join('\n'));
    });
    if (L.length) tgNotify_('tasks', ('☀️ مهام اليوم المفتوحة\n\n' + L.join('\n\n')).slice(0, 4000));
  } catch (e) { console.error('morning group', e.message); }
  tRows_('TaskStaff').forEach(function (e) {
    if (e.Active === false || !e.ChatId) return;
    try { sendOpenList_(e, '☀️ صباح الخير ' + e.Name + '\nمهامك اليوم:'); } catch (x) { console.error('morning', e.Name, x.message); }
  });
}
/** Editor or the sheet menu, once: the bot inbox (every minute) and the morning summary (around 9:00). */
function installTasksTriggers() {
  ScriptApp.getProjectTriggers().filter(function (t) { return ['tgPoll', 'tasksMorning'].indexOf(t.getHandlerFunction()) !== -1; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tgPoll').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('tasksMorning').timeBased().atHour(9).everyDays(1).create();
  Logger.log('Tasks: bot inbox every minute, morning summary around 9:00.');
  try { SpreadsheetApp.getUi().alert('✅ تم تشغيل نظام المهام: يقرأ البوت الرسائل كل دقيقة، ويُرسَل الملخص كل صباح نحو الساعة 9.'); } catch (e) {}
}

/* =====================================================================================
 * Customer service (tab "Customer service"): order cancel / change requests, delivery inspection requests and
 * customer complaints. Login: the Tasks pass (manager or employee), so each entry records who wrote it.
 * Every new entry and every change is announced in the Telegram group (kind "requests"). An inspection request
 * carries two buttons in the group (allow / do not allow); the answer and who gave it are saved and shown in the app.
 * Sheet "Requests" (one row per entry).
 * ===================================================================================== */
TASK_SHEETS.Requests = ['Id', 'Kind', 'Order', 'Customer', 'Phone', 'Channel', 'Category', 'Details', 'Status', 'CreatedAt', 'CreatedBy',
  'UpdatedAt', 'UpdatedBy', 'Note', 'OrderInfo'];
const REQ_KINDS = { cancel: 'إلغاء طلب', edit: 'تعديل طلب', inspect: 'معاينة', complaint: 'شكوى' };
const REQ_STATUS = {   // the statuses each kind can have; the first is the starting one
  cancel: ['open', 'done', 'rejected'], edit: ['open', 'done', 'rejected'],
  inspect: ['pending', 'allowed', 'denied'], complaint: ['open', 'working', 'resolved']
};
const REQ_STATUS_AR = { open: 'مفتوح', done: 'تم التنفيذ', rejected: 'مرفوض', pending: 'في انتظار الرد', allowed: 'مسموح بالمعاينة',
  denied: 'غير مسموح بالمعاينة', working: 'قيد المتابعة', resolved: 'تم الحل' };
const COMPLAINT_CATS = { quality: 'جودة المنتج', late: 'تأخر التوصيل', wrong: 'منتج خطأ أو ناقص', damaged: 'منتج تالف', staff: 'تعامل الموظفين',
  price: 'السعر', delivery: 'شركة الشحن', other: 'أخرى' };
const COMPLAINT_CHANNELS = { phone: 'مكالمة', whatsapp: 'واتساب', facebook: 'فيسبوك', instagram: 'إنستجرام', store: 'في المحل', other: 'أخرى' };
Object.assign(TASK_ACTIONS, {
  reqInit: function (r, who) { return reqInit_(r, who); },
  reqSave: function (r, who) { return reqSave_(r, who); },
  reqStatus: function (r, who) { return reqStatus_(r, who); }
});

function reqOut_(x) {
  let info = null; try { info = x.OrderInfo ? JSON.parse(x.OrderInfo) : null; } catch (e) {}
  return { id: x.Id, kind: x.Kind, order: x.Order, customer: x.Customer, phone: x.Phone, channel: x.Channel, category: x.Category,
    details: x.Details, status: x.Status, createdAt: x.CreatedAt ? new Date(x.CreatedAt).toISOString() : '', createdBy: x.CreatedBy,
    updatedAt: x.UpdatedAt ? new Date(x.UpdatedAt).toISOString() : '', updatedBy: x.UpdatedBy || '', note: x.Note || '', info: info };
}
/** Open entries, and closed ones of the last 30 days (90 for complaints), newest first. */
function reqInit_(r, who) {
  const since = Date.now() - 30 * 864e5, sinceC = Date.now() - 90 * 864e5;
  const list = tRows_('Requests').filter(function (x) {
    const first = (REQ_STATUS[x.Kind] || [])[0], t = new Date(x.UpdatedAt || x.CreatedAt).getTime();
    return x.Status === first || x.Status === 'working' || t >= (x.Kind === 'complaint' ? sinceC : since);
  }).sort(function (a, b) { return (new Date(b.CreatedAt) - new Date(a.CreatedAt)) || (b._row - a._row); })   // same time: the lower row is newer
    .map(reqOut_);
  return { ok: true, role: who.manager ? 'manager' : 'employee', me: who.name, items: list };
}
/** The Shopify order behind a request: checked so a mistyped number is caught, and shown in the group message. */
function reqOrder_(raw) {
  const num = String(raw || '').replace(/[^0-9a-z-]/gi, '');
  if (!num) throw uerr_('Write the order number');
  let o;
  try {
    o = shopify_('query($q: String!) { orders(first: 1, query: $q) { nodes { id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus ' +
      'totalPriceSet { shopMoney { amount currencyCode } } shippingAddress { name city } } } }', { q: 'name:#' + num + ' OR name:' + num }).orders.nodes[0];
  } catch (e) { return { name: '#' + num, unchecked: true }; }     // Shopify unreachable: keep the request anyway
  if (!o) throw uerr_('Order ' + num + ' not found in Shopify');
  return { name: o.name, customer: o.shippingAddress && o.shippingAddress.name || '', city: o.shippingAddress && o.shippingAddress.city || '',
    total: o.totalPriceSet ? o.totalPriceSet.shopMoney.amount + ' ' + o.totalPriceSet.shopMoney.currencyCode : '',
    paid: o.displayFinancialStatus, fulfillment: o.displayFulfillmentStatus, cancelled: !!o.cancelledAt, createdAt: o.createdAt };
}
const FUL_AR = { UNFULFILLED: 'لم يُجهَّز', PARTIALLY_FULFILLED: 'مُجهَّز جزئيًا', FULFILLED: 'تم تجهيزه', IN_PROGRESS: 'قيد التجهيز', ON_HOLD: 'معلّق' };
function reqText_(x, head) {
  let info = null; try { info = x.OrderInfo ? JSON.parse(x.OrderInfo) : null; } catch (e) {}
  const L = [head];
  if (x.Order) L.push('🧾 الطلب: ' + x.Order + (info && info.customer ? ' — ' + info.customer : '') + (info && info.city ? ' (' + info.city + ')' : ''));
  if (info && info.total) L.push('💰 ' + info.total + (info.fulfillment ? ' · ' + (FUL_AR[info.fulfillment] || info.fulfillment) : '') + (info.cancelled ? ' · ملغى بالفعل' : ''));
  if (info && /FULFILLED/.test(info.fulfillment || '') && (x.Kind === 'cancel' || x.Kind === 'edit')) L.push('⚠️ تنبيه: الطلب جُهِّز بالفعل');
  if (x.Customer) L.push('👤 ' + x.Customer + (x.Phone ? ' · ' + x.Phone : ''));
  if (x.Kind === 'complaint') L.push('🏷️ ' + (COMPLAINT_CATS[x.Category] || 'أخرى') + ' · ' + (COMPLAINT_CHANNELS[x.Channel] || ''));
  if (x.Details) L.push('📝 ' + x.Details);
  L.push('✍️ ' + x.CreatedBy);
  return L.join('\n').slice(0, 3800);
}
function reqSave_(r, who) {
  const x = r.req || {}, kind = x.kind;
  if (!REQ_KINDS[kind]) throw uerr_('Choose the type');
  const details = String(x.details || '').trim().slice(0, 1500);
  if ((kind === 'edit' || kind === 'complaint') && !details) throw uerr_('Write the details');
  let info = null, order = String(x.order || '').trim();
  if (kind !== 'complaint' || order) { info = reqOrder_(order); order = info.name; }
  const row = { Id: tId_('Q'), Kind: kind, Order: order, Customer: String(x.customer || (info && info.customer) || '').trim().slice(0, 80),
    Phone: String(x.phone || '').replace(/[^\d+]/g, '').slice(0, 20), Channel: kind === 'complaint' ? (COMPLAINT_CHANNELS[x.channel] ? x.channel : 'other') : '',
    Category: kind === 'complaint' ? (COMPLAINT_CATS[x.category] ? x.category : 'other') : '', Details: details, Status: REQ_STATUS[kind][0],
    CreatedAt: new Date(), CreatedBy: who.name, UpdatedAt: '', UpdatedBy: '', Note: '', OrderInfo: info ? JSON.stringify(info) : '' };
  withTaskLock_(function () { tPut_('Requests', row); });
  logActivity_('Customers', kind, order || row.Customer, 0, { by: who.name });
  const icon = { cancel: '🛑', edit: '✏️', inspect: '🔍', complaint: '📣' }[kind];
  const head = icon + ' ' + (kind === 'inspect' ? 'طلب معاينة — يُرجى الرد' : kind === 'complaint' ? 'شكوى عميل جديدة' : 'طلب ' + REQ_KINDS[kind].replace('طلب', '').trim() + ' جديد');
  let sent;
  if (kind === 'inspect') sent = tgGroup_(reqText_(row, head), { inline_keyboard: [[{ text: '✅ يُسمح بالمعاينة', callback_data: 'ia:' + row.Id }, { text: '❌ لا يُسمح', callback_data: 'in:' + row.Id }]] });
  else sent = tgNotify_('requests', reqText_(row, head));
  return { ok: true, item: reqOut_(row), sent: !!sent, warn: info && /FULFILLED/.test(info.fulfillment || '') && (kind === 'cancel' || kind === 'edit') ? 'fulfilled' : info && info.cancelled ? 'cancelled' : '' };
}
/** Change the status (and note) of an entry. Inspection answers: the manager only (or the group buttons). */
function reqStatus_(r, who) {
  const res = withTaskLock_(function () {
    const x = tRows_('Requests').filter(function (y) { return y.Id === r.id; })[0];
    if (!x) throw uerr_('Not found');
    if ((REQ_STATUS[x.Kind] || []).indexOf(r.status) === -1) throw uerr_('Choose the status');
    if (x.Kind === 'inspect' && !who.manager) throw uerr_('Only the manager can do this');
    const changed = x.Status !== r.status;
    x.Status = r.status; x.Note = String(r.note == null ? x.Note : r.note).trim().slice(0, 1000);
    x.UpdatedAt = new Date(); x.UpdatedBy = who.name;
    tPut_('Requests', x);
    return { x: x, changed: changed };
  });
  const x = res.x;
  logActivity_('Customers', x.Kind + ' ' + x.Status, x.Order || x.Customer, 0, { by: who.name });
  if (res.changed) tgNotify_('requests', (x.Status === 'rejected' || x.Status === 'denied' ? '❌ ' : x.Status === 'working' ? '⏳ ' : '✅ ') +
    REQ_KINDS[x.Kind] + (x.Order ? ' ' + x.Order : '') + ': ' + REQ_STATUS_AR[x.Status] + '\n✍️ ' + who.name + (x.Note ? '\n📝 ' + x.Note : ''));
  return { ok: true, item: reqOut_(x) };
}
/** An inspection button pressed in the group. Anyone in the store's group can answer; the name is saved. */
function reqAnswer_(q, m) {
  const name = [q.from && q.from.first_name, q.from && q.from.last_name].filter(Boolean).join(' ') || 'تيليجرام';
  let say = '', x;
  if (String(q.message && q.message.chat && q.message.chat.id) !== String(P.getProperty('TELEGRAM_CHAT_ID'))) say = 'يتم الرد من جروب المتجر فقط';
  else withTaskLock_(function () {
    x = tRows_('Requests').filter(function (y) { return y.Id === m[2]; })[0];
    if (!x) { say = 'الطلب غير موجود'; return; }
    if (x.Status !== 'pending') { say = 'تم الرد بالفعل: ' + REQ_STATUS_AR[x.Status]; return; }
    x.Status = m[1] === 'ia' ? 'allowed' : 'denied'; x.UpdatedAt = new Date(); x.UpdatedBy = name + ' (تيليجرام)';
    tPut_('Requests', x); say = 'تم: ' + REQ_STATUS_AR[x.Status];
  });
  tgApi_('answerCallbackQuery', { callback_query_id: q.id, text: say });
  if (x && /^تم:/.test(say)) {
    logActivity_('Customers', 'inspect ' + x.Status, x.Order, 0, { by: name });
    tgApi_('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id,
      text: String(q.message.text || '').slice(0, 3700) + '\n\n' + (x.Status === 'allowed' ? '✅ ' : '❌ ') + REQ_STATUS_AR[x.Status] + ' — ' + name });
  }
}
/** A message to the store's group (with optional buttons). */
function tgGroup_(text, markup) {
  const chat = P.getProperty('TELEGRAM_CHAT_ID');
  if (!chat) return null;
  const p = { chat_id: chat, text: String(text).slice(0, 4000), disable_web_page_preview: true };
  if (markup) p.reply_markup = markup;
  return tgApi_('sendMessage', p);
}

/* =====================================================================================
 * Monthly evaluation (Tasks tab, "Evaluation"): the social media employee fills her numbers every month (day 23 by
 * default). Each item is achieved when it reaches its target (higher is better, or lower for response time); an item
 * past its sanction limit is flagged. Result = achieved items / all items; target met at PASS % (default 66).
 * Settings (employee, day, pass %, items with targets and sanction limits) are edited by the manager in the app and
 * kept in the Script Property EVAL_CONFIG. Sheet "Evaluations": one row per month.
 * ===================================================================================== */
TASK_SHEETS.Evaluations = ['Id', 'Month', 'EmployeeId', 'Name', 'SubmittedAt', 'SubmittedBy', 'Values', 'Results', 'Pct', 'Met', 'Sanctions'];
const EVAL_DEFAULT = { employeeId: '', day: 23, pass: 66, items: [
  { key: 'conv', name: 'Conversations started', nameAr: 'المحادثات الجديدة', unit: 'count', better: 'higher', target: 70, sanction: 0 },
  { key: 'posts', name: 'Posts', nameAr: 'المنشورات', unit: 'count', better: 'higher', target: 8, sanction: 3 },
  { key: 'stories', name: 'Stories', nameAr: 'القصص (ستوري)', unit: 'count', better: 'higher', target: 8, sanction: 3 },
  { key: 'rate', name: 'Response rate', nameAr: 'معدل الرد', unit: 'percent', better: 'higher', target: 96.4, sanction: 95 },
  { key: 'time', name: 'Response time', nameAr: 'زمن الرد', unit: 'minutes', better: 'lower', target: 90, sanction: 100 },
  { key: 'follows', name: 'Net follows', nameAr: 'صافي المتابعين الجدد', unit: 'count', better: 'higher', target: 100, sanction: 0 }
] };
Object.assign(TASK_ACTIONS, {
  evalInit: function (r, who) { return evalInit_(who); },
  evalSave: function (r, who) { return evalSave_(r, who); },
  evalConfig: function (r, who) { return evalConfigSave_(r, who); }
});
function evalConfig_() {
  try { const c = JSON.parse(P.getProperty('EVAL_CONFIG') || 'null'); if (c && c.items && c.items.length) return c; } catch (e) {}
  return JSON.parse(JSON.stringify(EVAL_DEFAULT));
}
/** "75", "1:15", "1 hr 15m", "1h15", "90 min" -> minutes; "95.2%" -> 95.2 */
function evalNumber_(v, unit) {
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/,/g, '.');
  if (!s) return null;
  if (unit === 'minutes') {
    let m = /^(\d+):(\d{1,2})$/.exec(s);
    if (m) return +m[1] * 60 + +m[2];
    m = /^(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|ساعة|ساعات|س))?\s*(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes|د|دقيقة|دقائق)?)?$/.exec(s);
    if (m && (m[1] || m[2])) return Math.round((+(m[1] || 0)) * 60 + (+(m[2] || 0)));
    return NaN;
  }
  const n = Number(s.replace(/%$/, '').trim());
  return isFinite(n) ? n : NaN;
}
function evalScore_(cfg, values) {
  const results = cfg.items.map(function (it) {
    const v = values[it.key];
    const ok = it.better === 'lower' ? v <= it.target : v >= it.target;
    const sanction = it.sanction != null && it.sanction !== '' && (it.better === 'lower' ? v > Number(it.sanction) : v < Number(it.sanction));
    return { key: it.key, value: v, target: it.target, achieved: ok, sanction: !!sanction };
  });
  const got = results.filter(function (x) { return x.achieved; }).length;
  const pct = Math.round(got / results.length * 100);
  return { results: results, pct: pct, met: pct >= Number(cfg.pass || 66), sanctions: results.filter(function (x) { return x.sanction; }).map(function (x) { return x.key; }) };
}
function evalMonth_(ymd) { return String(ymd || taskToday_()).slice(0, 7); }
function evalOut_(x) {
  const j = function (v) { try { return JSON.parse(v || 'null'); } catch (e) { return null; } };
  return { id: x.Id, month: x.Month, employeeId: x.EmployeeId, name: x.Name, submittedAt: x.SubmittedAt ? new Date(x.SubmittedAt).toISOString() : '',
    submittedBy: x.SubmittedBy, values: j(x.Values) || {}, results: j(x.Results) || [], pct: Number(x.Pct), met: x.Met === true || x.Met === 'TRUE', sanctions: j(x.Sanctions) || [] };
}
function evalInit_(who) {
  const cfg = evalConfig_(), mine = who.manager || cfg.employeeId === who.id;
  if (!mine) return { ok: true, allowed: false };
  const rows = tRows_('Evaluations').map(evalOut_).sort(function (a, b) { return b.month.localeCompare(a.month); });
  const month = evalMonth_();
  return { ok: true, allowed: true, role: who.manager ? 'manager' : 'employee', config: cfg, month: month,
    current: rows.filter(function (x) { return x.month === month; })[0] || null, history: rows.slice(0, 24) };
}
function evalSave_(r, who) {
  const cfg = evalConfig_();
  if (!who.manager && cfg.employeeId !== who.id) throw uerr_('Only the manager can do this');
  if (!cfg.employeeId) throw uerr_('Choose who fills the evaluation first');
  const month = /^\d{4}-\d{2}$/.test(String(r.month || '')) ? r.month : evalMonth_();
  const values = {};
  cfg.items.forEach(function (it) {
    const n = evalNumber_((r.values || {})[it.key], it.unit);
    if (n == null) throw uerr_('Fill in every item');
    if (isNaN(n) || n < 0) throw uerr_('Not a number: ' + it.name);
    values[it.key] = n;
  });
  const sc = evalScore_(cfg, values);
  const emp = tRows_('TaskStaff').filter(function (e) { return e.Id === cfg.employeeId; })[0] || {};
  const row = withTaskLock_(function () {
    const old = tRows_('Evaluations').filter(function (x) { return x.Month === month; })[0];
    const x = Object.assign(old || { Id: tId_('V') }, { Month: month, EmployeeId: cfg.employeeId, Name: emp.Name || '', SubmittedAt: new Date(), SubmittedBy: who.name,
      Values: JSON.stringify(values), Results: JSON.stringify(sc.results), Pct: sc.pct, Met: sc.met, Sanctions: JSON.stringify(sc.sanctions) });
    tPut_('Evaluations', x);
    // the reminder task of this month is done now
    tRows_('Tasks').forEach(function (t) { if (t.RepeatId === 'EVAL-' + month && t.Status === 'open') { t.Status = 'done'; t.DoneAt = new Date(); t.DoneVia = 'evaluation'; tPut_('Tasks', t); } });
    return x;
  });
  logActivity_('Tasks', 'evaluation', month, sc.pct, { met: sc.met, by: who.name });
  const fmt = function (it, v) { return it.unit === 'percent' ? v + '%' : it.unit === 'minutes' ? v + ' دقيقة' : String(v); };
  const L = ['📊 تقييم السوشيال ميديا — ' + month + (emp.Name ? '\n👤 ' + emp.Name : ''), ''];
  cfg.items.forEach(function (it, i) {
    const x = sc.results[i];
    L.push((x.achieved ? '✅ ' : '❌ ') + it.nameAr + ': ' + fmt(it, x.value) + ' / المستهدف ' + fmt(it, it.target) + (x.sanction ? ' ⚠️ تجاوز حد العقوبة' : ''));
  });
  L.push('', 'النتيجة: ' + sc.pct + '% — ' + (sc.met ? '✅ حقّق المستهدف' : '❌ لم يحقّق المستهدف') + ' (الحد ' + (cfg.pass || 66) + '%)');
  if (sc.sanctions.length) L.push('⚠️ بنود تجاوزت حد العقوبة: ' + sc.sanctions.length);
  tgNotify_('tasks', L.join('\n'));
  return { ok: true, evaluation: evalOut_(row) };
}
function evalConfigSave_(r, who) {
  needManager_(who);
  const c = r.config || {}, cur = evalConfig_();
  const emp = c.employeeId ? tRows_('TaskStaff').filter(function (e) { return e.Id === c.employeeId && e.Active !== false; })[0] : null;
  if (c.employeeId && !emp) throw uerr_('Choose the employee');
  const day = Math.round(Number(c.day)), pass = Math.round(Number(c.pass));
  if (!(day >= 1 && day <= 31)) throw uerr_('Choose the day');
  if (!(pass >= 1 && pass <= 100)) throw uerr_('The pass mark must be between 1 and 100');
  const items = cur.items.map(function (it) {
    const n = (c.items || []).filter(function (x) { return x.key === it.key; })[0] || {};
    const t = evalNumber_(n.target, it.unit), s = n.sanction === '' || n.sanction == null ? null : evalNumber_(n.sanction, it.unit);
    if (t == null || isNaN(t)) throw uerr_('Not a number: ' + it.name);
    if (s != null && isNaN(s)) throw uerr_('Not a number: ' + it.name);
    return Object.assign({}, it, { target: t, sanction: s });
  });
  const cfg = { employeeId: emp ? emp.Id : '', day: day, pass: pass, items: items };
  P.setProperty('EVAL_CONFIG', JSON.stringify(cfg));
  logActivity_('Tasks', 'evaluation settings', emp ? emp.Name : '-', 0);
  return { ok: true, config: cfg };
}
/** Morning: on the evaluation day (the last day in shorter months), a task for the employee who fills it. */
function evalReminder_(ymd) {
  const cfg = evalConfig_();
  if (!cfg.employeeId) return false;
  const di = dayInfo_(ymd), day = Number(cfg.day) || 23;
  if (!(di.day === day || (day > di.last && di.day === di.last))) return false;
  const month = evalMonth_(ymd);
  if (tRows_('Evaluations').some(function (x) { return x.Month === month; })) return false;
  if (tRows_('Tasks').some(function (t) { return t.RepeatId === 'EVAL-' + month; })) return false;
  const emp = tRows_('TaskStaff').filter(function (e) { return e.Id === cfg.employeeId && e.Active !== false; })[0];
  if (!emp) return false;
  const t = withTaskLock_(function () {
    return tPut_('Tasks', { Id: tId_('T'), Title: 'تعبئة تقييم السوشيال ميديا لشهر ' + month, Notes: 'من تطبيق بتفريند: تبويب المهام ← التقييم الشهري.',
      EmployeeId: emp.Id, Due: ymd, Status: 'open', CreatedAt: new Date(), DoneAt: '', DoneVia: '', RepeatId: 'EVAL-' + month });
  });
  sendTask_(t, emp, '📊 موعد التقييم الشهري');
  return true;
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
        binVariant: binValue_(v.vBin), binProduct: binValue_(p.pBin),
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
    'FinalBostaFees', 'State', 'Items', 'PhotoLinks', 'DetectedAt', 'FinalizedAt', 'Status', 'ShipmentDate']
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
function importFromFees(pagesWanted) {
  const url = P.getProperty('BOSTA_FEES_URL'); if (!url) return { pages: 0, found: 0, added: 0, skipped: 'no BOSTA_FEES_URL' };
  const h = {}; h[P.getProperty('BOSTA_AUTH_HEADER_NAME') || 'Authorization'] = P.getProperty('BOSTA_API_KEY');
  const maxPages = /[?&]page=\d+/.test(url) ? Math.max(1, Number(pagesWanted) || Number(P.getProperty('BOSTA_FEES_PAGES')) || 5) : 1;
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
 *  last `days` days (7 by default; up to 10 pages of 100 orders). A number from another carrier is harmless: Bosta
 *  answers 404 and the row is marked NOT IN BOSTA. */
function importFromShopify_(days) {
  if (!P.getProperty('SHOPIFY_STORE')) return { found: 0, added: 0, skipped: 'no SHOPIFY_STORE' };
  const since = Utilities.formatDate(new Date(Date.now() - (Number(days) || 7) * 864e5), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  const found = [];
  let after = null, pages = 0;
  do {
    const d = shopify_('query($q: String!, $after: String) { orders(first: 100, after: $after, query: $q, sortKey: UPDATED_AT, reverse: true) { ' +
      'pageInfo { hasNextPage endCursor } nodes { name fulfillments(first: 5) { trackingInfo(first: 3) { number company url } } } } }',
      { q: "updated_at:>='" + since + "' fulfillment_status:shipped", after: after }).orders;
    d.nodes.forEach(o => (o.fulfillments || []).forEach(f => (f.trackingInfo || []).forEach(t => {
      const num = String(t.number || '').replace(/\D/g, ''), isBosta = /bosta/i.test((t.company || '') + ' ' + (t.url || ''));
      if (num.length >= 8 && (isBosta || (!t.company && num.length <= 10))) found.push(num.slice(-10));
    })));
    after = d.pageInfo && d.pageInfo.hasNextPage ? d.pageInfo.endCursor : null;
  } while (after && ++pages < 10);
  return { found: found.length, added: addTracking_(found) };
}
function syncBosta(only, opts) {
  if (typeof only !== 'string') only = '';        // a time trigger passes an event object here
  opts = opts && typeof opts === 'object' && !opts.triggerUid ? opts : {};
  // the hourly run: not while the 14-day job (or another run) is checking; the job holds the flag itself
  const own = !only && !opts.skipImport;
  if (own && !bostaBusy_(true)) return { skipped: 'busy' };
  try { return syncBostaRun_(only, opts); } finally { if (own) bostaBusy_(false); }
}
function syncBostaRun_(only, opts) {
  if (!only) watchSecrets_();
  const st = { at: new Date().toISOString(), fees: null, shopify: null, checked: 0, bulkyNew: 0, bulkyUpdated: 0, failed: 0, firstError: '' };
  if (!only && !opts.skipImport) {
    try { st.fees = importFromFees(opts.feePages); } catch (e) { st.fees = { error: e.message }; logError_('Shipments', 'Bosta fees import', e); }
    try { st.shopify = importFromShopify_(opts.days); } catch (e) { st.shopify = { error: e.message }; logError_('Shipments', 'Bosta numbers from Shopify', e); }
  }
  const t0 = Date.now(), limit = opts.limitMs || 300000, flag = new RegExp(P.getProperty('FLAG_REGEX') || 'bulky', 'i');
  const T = sh_('Tracking'), data = T.getDataRange().getValues();
  // newest first, so new shipments are checked even when an old backlog does not fit in one run
  let lastI = 0;
  const from = opts.from ? Math.min(data.length - 1, Number(opts.from)) : data.length - 1;   // a later round goes on where the last stopped
  for (let i = from; i >= 1; i--) {
    if (Date.now() - t0 >= limit) { lastI = i; break; }
    if (data[i][5] === true && !only) continue;
    const tn = String(data[i][0]);
    if (only && tn !== only) continue;
    try {
      st.checked++;
      const d = bosta_(tn), p = pricing_(d), old = (Date.now() - new Date(data[i][1])) > 60 * 864e5;
      T.getRange(i + 1, 4, 1, 3).setValues([[d.state && d.state.value, p.size, p.final !== '' || old]]);
      if (!flag.test(p.size || '')) continue;
      const B = sh_('Bulky'), r = findRow_('Bulky', tn), now = new Date();
      if (!B.getRange(1, 15).getValue()) B.getRange(1, 15).setValue('ShipmentDate');
      const links = rows_('Shipments').filter(x => String(x[1]) === tn).map(x => x[3]).join('\n');
      const row = [ "'" + tn, d.businessReference, p.size, p.vat, p.ship, p.sizeCost, p.material, p.final,
        d.state && d.state.value, items_(d), links, now, p.final !== '' ? now : '', p.final !== '' ? 'Charged' : 'Flagged', bostaDate_(d) ];
      if (r) { const cur = B.getRange(r, 1, 1, 15).getValues()[0]; row[11] = cur[11]; if (!row[12]) row[12] = cur[12]; if (!row[14]) row[14] = cur[14];
        B.getRange(r, 1, 1, 15).setValues([row]); st.bulkyUpdated++; }
      else { B.appendRow(row); st.bulkyNew++; logActivity_('Shipments', 'bulky', tn, 1, { size: p.size, order: d.businessReference });
        tgNotify_('bulky', '📦 شحنة كبيرة الحجم (Bulky)\nالبوليصة: ' + tn + '\nالطلب: ' + (d.businessReference || '-') + '\nالمقاس: ' + p.size +
          '\nالرسوم: ' + (p.final !== '' ? p.final + ' جنيه (خُصمت)' : (p.vat || '?') + ' جنيه (متوقعة)')); }
    } catch (e) {
      console.error(tn, e.message);
      if (/Bosta (400|404)/.test(e.message))             // not a Bosta shipment (misread): mark & stop retrying
        T.getRange(i + 1, 4, 1, 3).setValues([['NOT IN BOSTA', '', true]]);
      else { st.failed++; if (!st.firstError) st.firstError = tn + ': ' + e.message; }
    }
  }
  st.more = false; st.stoppedAt = lastI;
  for (let k = data.length - 1; k >= 1; k--) if (data[k][5] !== true && k <= lastI) { st.more = true; break; }   // time ran out first
  // e.g. an expired Bosta key fails every shipment: one line in Errors per run, not one per shipment
  if (st.failed) logError_('Shipments', 'Bosta sync', new Error(st.failed + ' shipment(s) failed. First: ' + st.firstError));
  if (!only && !opts.skipImport) try { P.setProperty('BOSTA_LAST_SYNC', JSON.stringify(st)); } catch (e) {}
  return st;
}
/** The day Bosta created the shipment (its own date), else ''. */
function bostaDate_(d) {
  const v = d && (d.createdAt || (d.creationTimestamp && new Date(d.creationTimestamp).toISOString()) || '');
  return v ? "'" + String(v).slice(0, 10) : '';
}
/** Bulky shipments of the last `days` days (by Bosta's shipment date, else the day it was found), newest first. */
function bulkyRecent_(days) {
  days = Math.max(1, Math.min(60, Number(days) || 14));
  const cutoff = Utilities.formatDate(new Date(Date.now() - days * 864e5), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const day = function (v) { return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v || '').replace(/^'/, '').slice(0, 10); };
  const list = rows_('Bulky').map(function (r) {
    return { tn: String(r[0]).replace(/^'/, ''), order: String(r[1] || ''), size: String(r[2] || ''), expected: r[3] === '' ? null : Number(r[3]),
      final: r[7] === '' || r[7] == null ? null : Number(r[7]), state: String(r[8] || ''), items: String(r[9] || ''), status: String(r[13] || ''),
      date: day(r[14]) || day(r[11]), found: day(r[11]) };
  }).filter(function (x) { return x.tn && x.date >= cutoff; })
    .sort(function (a, b) { return b.date.localeCompare(a.date); });
  const fees = list.reduce(function (t, x) { return t + (x.final != null ? x.final : x.expected || 0); }, 0);
  return { ok: true, days: days, since: cutoff, count: list.length, fees: Math.round(fees * 100) / 100, items: list };
}
/* Bulky shipments of the last N days, as a background job (the app's button and the sheet menu start it):
 * 1. brings in the Bosta numbers of those days from every source: Bosta's own shipment list (deliveries/search),
 *    the wallet feed (more pages) and Shopify fulfillments;
 * 2. checks every shipment not finished yet with Bosta (syncBosta), in rounds of 4.5 minutes: when time runs out the
 *    job starts itself again a minute later (Google stops any run after 6 minutes);
 * 3. at the end: the list of bulky shipments goes to the Telegram group, and the Today tab shows it.
 * State in Script Property BULKY_JOB (what each source brought, how many checked, done or not). */
const BULKY_JOB_MAX_ROUNDS = 8;
function bulkyJobState_() { try { return JSON.parse(P.getProperty('BULKY_JOB') || 'null'); } catch (e) { return null; } }
function bulkyBackfill_(days) {
  days = Math.max(1, Math.min(60, Number(days) || 14));
  const job = bulkyJobState_();
  if (job && job.state === 'running' && Date.now() - new Date(job.updatedAt || job.startedAt).getTime() < 15 * 60000)
    return Object.assign(bulkyRecent_(days), { job: job, already: true });
  const now = new Date().toISOString();
  const fresh = { state: 'running', days: days, startedAt: now, updatedAt: now, step: 'import', rounds: 0, checked: 0, failed: 0, sources: {} };
  P.setProperty('BULKY_JOB', JSON.stringify(fresh));
  bulkyJobTrigger_(1);
  logActivity_('Shipments', 'bulky check started', days + ' days', 0);
  return Object.assign(bulkyRecent_(days), { job: fresh, started: true });
}
function bulkyJobTrigger_(minutes) {
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'bulkyJob'; }).forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('bulkyJob').timeBased().after(Math.max(1, minutes) * 60000).create();
}
/** The long Bosta runs (hourly check, bulky job) never run together: a flag in the cache (6 min at most), set and
 *  checked under a short script lock. take = true: take the flag (false if already taken); false: give it back. */
function bostaBusy_(take) {
  const c = CacheService.getScriptCache();
  if (!take) { c.remove('bosta_busy'); return true; }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return false;
  try { if (c.get('bosta_busy')) return false; c.put('bosta_busy', String(Date.now()), 360); return true; }
  finally { lock.releaseLock(); }
}
/** Time trigger (one-off): one round of the bulky job. */
function bulkyJob() {
  const job = bulkyJobState_();
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'bulkyJob'; }).forEach(function (t) { ScriptApp.deleteTrigger(t); });
  if (!job || job.state !== 'running') return;
  // its own "busy" flag, NOT the script lock: a round takes minutes, and the script lock would block every other action
  if (!bostaBusy_(true)) { bulkyJobTrigger_(2); return; }      // the hourly check is busy: try again shortly
  const save = function () { job.updatedAt = new Date().toISOString(); P.setProperty('BULKY_JOB', JSON.stringify(job)); };
  let st;
  try {
    if (job.step === 'import') {
      const src = function (name, fn) { try { job.sources[name] = fn(); } catch (e) { job.sources[name] = { error: String(e.message || e).slice(0, 200) }; } };
      src('bosta', function () { return importFromBostaList_(job.days); });
      src('fees', function () { return importFromFees(Math.max(5, Math.ceil(job.days / 2) + 3)); });
      src('shopify', function () { return importFromShopify_(job.days); });
      job.step = 'check'; save();
    }
    st = syncBosta('', { skipImport: true, limitMs: 270000, from: job.from || 0 });
    job.from = st.stoppedAt || 0;
  } catch (e) {
    job.state = 'failed'; job.error = String(e.message || e).slice(0, 300); save();
    logError_('Shipments', 'bulky check', e);
    return;
  } finally { bostaBusy_(false); }
  job.rounds++; job.checked += st.checked; job.failed += st.failed;
  if (st.more && job.rounds < BULKY_JOB_MAX_ROUNDS) { save(); bulkyJobTrigger_(1); return; }
  job.state = 'done'; job.more = !!st.more; save();
  const r = bulkyRecent_(job.days), s = job.sources || {};
  const srcLine = function (name, label) {
    const x = s[name] || {};
    return '• ' + label + ': ' + (x.error ? 'خطأ (' + x.error.slice(0, 80) + ')' : x.skipped ? 'غير مُعدّ' : (x.found || 0) + ' رقمًا، منها ' + (x.added || 0) + ' جديدًا');
  };
  logActivity_('Shipments', 'bulky check ' + job.days + ' days', '', r.count, { checked: job.checked, rounds: job.rounds,
    bosta: s.bosta && (s.bosta.added != null ? s.bosta.added : s.bosta.error || s.bosta.skipped), fees: s.fees && (s.fees.added != null ? s.fees.added : s.fees.error || s.fees.skipped),
    shopify: s.shopify && (s.shopify.added != null ? s.shopify.added : s.shopify.error || s.shopify.skipped) });
  tgNotify_('bulky', ('📦 الشحنات كبيرة الحجم في آخر ' + job.days + ' يومًا: ' + r.count + (r.count ? ' شحنة · الرسوم ' + r.fees + ' جنيه' : '') +
    (r.items.length ? '\n' + r.items.slice(0, 20).map(function (x) { return '• ' + x.tn + ' · ' + (x.order || '-') + ' · ' + x.size + ' · ' + x.date; }).join('\n') : '') +
    '\n\nمصادر الشحنات:\n' + srcLine('bosta', 'قائمة شحنات بوسطة') + '\n' + srcLine('fees', 'سجل محفظة بوسطة') + '\n' + srcLine('shopify', 'شوبيفاي') +
    '\nتم فحص ' + job.checked + ' شحنة' + (job.failed ? '، وفشل ' + job.failed : '') + (job.more ? '\n⚠️ بقيت شحنات لم تُفحص: ستُفحص في الفحص التلقائي كل ساعة.' : '')).slice(0, 4000));
}
/** Bosta's own list of the business's shipments (newest first), kept to the last `days` days. The endpoint can be
 *  changed with BOSTA_SEARCH_URL. A shape that is not understood is reported, never guessed. */
function importFromBostaList_(days) {
  if (!P.getProperty('BOSTA_API_KEY')) return { skipped: 'no BOSTA_API_KEY' };
  const url = P.getProperty('BOSTA_SEARCH_URL') || 'https://app.bosta.co/api/v2/deliveries/search';
  const h = {}; h[P.getProperty('BOSTA_AUTH_HEADER_NAME') || 'Authorization'] = P.getProperty('BOSTA_API_KEY');
  const cutoff = Date.now() - (Number(days) || 14) * 864e5, found = {};
  let pages = 0, sawDates = false;
  for (let page = 1; page <= 40; page++) {
    const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', headers: h, muteHttpExceptions: true,
      payload: JSON.stringify({ pageNumber: page, pageLimit: 50, limit: 50, page: page }) });
    if (res.getResponseCode() !== 200) {
      if (page === 1) throw new Error('Bosta list HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 120));
      break;
    }
    let j; try { j = JSON.parse(res.getContentText()); } catch (e) { throw new Error('Bosta list: not JSON'); }
    const d = j && (j.data || j), list = (d && (d.deliveries || d.list || d.results || d.data)) || (Array.isArray(d) ? d : null);
    if (!Array.isArray(list)) { if (page === 1) throw new Error('Bosta list: unknown answer (' + Object.keys(d || {}).slice(0, 6).join(', ') + ')'); break; }
    pages++;
    if (!list.length) break;
    let recent = 0;
    list.forEach(function (x) {
      const tn = String(x.trackingNumber || x.tracking_number || '').replace(/\D/g, '');
      const t = x.createdAt ? new Date(x.createdAt).getTime() : NaN;
      if (!isNaN(t)) sawDates = true;
      if (tn && (isNaN(t) || t >= cutoff)) { found[tn.slice(-10)] = 1; if (!isNaN(t)) recent++; }
    });
    if (sawDates && !recent) break;                       // newest first: this page is older than the window
  }
  return { pages: pages, found: Object.keys(found).length, added: addTracking_(Object.keys(found)) };
}
/** Sheet menu / editor: starts the check of the last 14 days (result on Telegram and in the Today tab). */
function bulkyLast14Days() {
  const r = bulkyBackfill_(14);
  const msg = r.already ? 'يوجد فحص قيد التشغيل بالفعل. ستصل النتيجة إلى مجموعة تيليجرام وتظهر في تبويب اليوم.'
    : 'بدأ فحص الشحنات كبيرة الحجم لآخر 14 يومًا. قد يستغرق بضع دقائق، وستصل النتيجة إلى مجموعة تيليجرام وتظهر في تبويب اليوم.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return r;
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
  CacheService.getScriptCache().removeAll([tokKey_('orders'), tokKey_('pos'), 'pos_use_orders_app']);
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
