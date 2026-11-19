// Tests for apps-script/Code.gs: runs the script in Node with fake Google, Shopify and Bosta services
// and checks every action (POS, Orders, Returns, Receive, Pick list, Shipments). Used by the deploy
// workflow: nothing is deployed when a check fails.   Run: node tests/server-test.js apps-script/Code.gs
// Runs apps-script/Code.gs in Node with fake Google services, to check routing and logic.
const fs = require('fs'), vm = require('vm');
const code = fs.readFileSync(process.argv[2], 'utf8');
const props = { POS_PIN: '1111', APP_KEY: 'kkk', APP_PIN: '2222', SHOP: 'pf', CLIENT_ID: 'c', CLIENT_SECRET: 's',
  SHOPIFY_STORE: 'pf.myshopify.com', SHOPIFY_CLIENT_ID: 'oc', SHOPIFY_CLIENT_SECRET: 'os', SHOPIFY_TOKEN: 'shpat_ship_only', BOSTA_API_KEY: 'b' };
const fetches = [];
const sheets = {};
function sheet(name) { return sheets[name] || (sheets[name] = { rows: [], name,
  appendRow(r) { this.rows.push(r.map(v => typeof v === 'string' && v[0] === "'" ? v.slice(1) : v)); }, setFrozenRows() {}, getLastRow() { return this.rows.length; }, getLastColumn() { return this.rows.reduce((m, x) => Math.max(m, x.length), 0); }, deleteRow(i) { this.rows.splice(i - 1, 1); },
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => r.slice()) }; },
  getRange(r, c, nr = 1, nc = 1) { const s = this; return {
    getValue: () => (s.rows[r - 1] || [])[c - 1], setValue: v => { s.rows[r - 1][c - 1] = v; },
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.rows[r - 1 + i] || [])[c - 1 + j])),
    setValues: vals => vals.forEach((row, i) => { s.rows[r - 1 + i] = s.rows[r - 1 + i] || []; row.forEach((v, j) => s.rows[r - 1 + i][c - 1 + j] = v); }) }; },
  getParent: () => ({ getName: () => 'Test sheet' }) }); }
function shopifyAnswer(url, body, headers) {
  const q = body.query;
  if (/\blast:\s*\d+/.test(q || '') && !/\bbefore:/.test(q || '')) return { errors: [{ message: 'using last without before is not supported' }] };
  if (/oauth\/access_token/.test(url)) return { access_token: url.includes('pf.myshopify.com/admin/oauth') && !url.includes('/admin/api') ? (url.startsWith('https://pf.myshopify') ? 'tok' : 'tok') : 'x' };
  if (/inventoryPurchaseOrders\(first: 100, after: \$after/.test(q)) { const all = [
    { id: 'PO1', name: 'PO-1003', orderedAt: '2026-11-10T09:00:00Z', origin: { supplierName: 'Royal Canin' }, destination: { name: 'Main store' }, transfers: { nodes: [{ totalQuantity: 10, receivedQuantity: 4 }] } },
    { id: 'PO3', name: 'PO-1010', orderedAt: null, dateCreated: '2026-11-16T08:00:00Z', origin: { supplierName: 'Brit' }, destination: { name: 'Main store' }, transfers: { nodes: [{ totalQuantity: 5, receivedQuantity: 0 }] } },
    { id: 'PO4', name: 'PO-1001', orderedAt: '2026-10-01T08:00:00Z', origin: { supplierName: 'Old' }, destination: { name: 'Main store' }, transfers: { nodes: [{ totalQuantity: 2, receivedQuantity: 0 }] } },
    { id: 'PO2', name: 'PO-1004', orderedAt: null, origin: { supplierName: 'Whiskas' }, destination: { name: 'Main store' }, transfers: { nodes: [{ totalQuantity: 3, receivedQuantity: 3 }] } } ]; const p2 = body.variables.after === 'c1';
    return { data: { inventoryPurchaseOrders: { nodes: p2 ? all.slice(2) : all.slice(0, 2), pageInfo: { hasNextPage: !p2, endCursor: p2 ? null : 'c1' } } } }; }
  if (/inventoryPurchaseOrders\(first: 250, after: \$after/.test(q)) { const p2 = body.variables.after === 'd1';
    return { data: { inventoryPurchaseOrders: { nodes: p2 ? [{ id: 'PO5', name: 'PO-1005' }] : [{ id: 'PO1', name: 'PO-1003' }], pageInfo: { hasNextPage: !p2, endCursor: p2 ? null : 'd1' } } } }; }
  if (/inventoryPurchaseOrder\(id/.test(q)) return { data: { inventoryPurchaseOrder: body.variables.id === 'PO1'
    ? { id: 'PO1', name: 'PO-1003', origin: { supplierName: 'Royal Canin' }, destination: { name: 'Main store', location: { id: 'LOC1' } }, transfers: { nodes: [{ id: 'T1', status: 'IN_PROGRESS', shipments: { nodes: [{ id: 'S1', status: 'IN_TRANSIT' }, { id: 'S0', status: 'RECEIVED' }] } }] } }
    : { id: 'PO5', name: 'PO-1005', origin: { supplierName: 'Whiskas' }, destination: { name: 'Main store' }, transfers: { nodes: [{ id: 'T5', status: 'READY_TO_SHIP', shipments: { nodes: [] } }] } } } };
  if (/inventoryShipment\(id/.test(q)) return { data: { inventoryShipment: { lineItems: { nodes: [
    { id: 'SL1', unreceivedQuantity: 4, inventoryItem: { id: 'I1', sku: 'RC2', variants: { nodes: [{ displayName: 'Royal Canin Kitten 2kg', barcode: '111', sku: 'RC2', vBin: { value: 'A-12' }, media: { nodes: [] }, product: { pBin: { value: 'A-10' }, featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/p.jpg' } } } } }] } } },
    { id: 'SL2', unreceivedQuantity: 2, inventoryItem: { id: 'I2', sku: 'RC4', variants: { nodes: [{ displayName: 'Royal Canin Adult 4kg', barcode: '222', sku: 'RC4', vBin: null, product: { pBin: { value: '["B-3","B-4"]' } } }] } } },
    { id: 'SL3', unreceivedQuantity: 0, inventoryItem: { id: 'I3', sku: 'X', variants: { nodes: [] } } } ] } } } };
  if (/inventoryTransfer\(id/.test(q)) return { data: { inventoryTransfer: { lineItems: { nodes: [
    { shippableQuantity: 5, inventoryItem: { id: 'I9', sku: 'WK1', variants: { nodes: [{ displayName: 'Whiskas Tuna', barcode: '999', sku: 'WK1' }] } } } ] } } } };
  if (/inventoryShipmentCreateInTransit/.test(q)) return { data: { inventoryShipmentCreateInTransit: { inventoryShipment: { id: 'SNEW', lineItems: { nodes: body.variables.input.lineItems.map((l, i) => ({ id: 'SNL' + i, quantity: l.quantity, inventoryItem: { id: l.inventoryItemId } })) } }, userErrors: [] } } };
  if (/inventoryAdjustQuantities/.test(q)) { ctx.__adjust = body.variables; return { data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: 'G1' }, userErrors: [] } } }; }
  if (/inventoryShipmentReceive/.test(q)) { ctx.__received = (ctx.__received || []).concat([{ id: body.variables.id, li: body.variables.li, key: body.variables.key, idem: /@idempotent\(key: \$key\)/.test(q) }]); return { data: { inventoryShipmentReceive: { inventoryShipment: { id: body.variables.id, status: 'PARTIALLY_RECEIVED' }, userErrors: [] } } }; }
  if (/productVariant\(id/.test(q)) { const st = ctx.__meta || (ctx.__meta = { vBin: { value: 'A-12', type: 'single_line_text_field' }, pBin: { value: '["B-3"]', type: 'list.single_line_text_field' }, pExp: null });
    return { data: { productVariant: { id: 'V1', vBin: st.vBin, product: { id: 'P1', pBin: st.pBin, pExp: st.pExp } } } }; }
  if (/metafieldDefinitions/.test(q)) { ctx.__defAsked = (ctx.__defAsked || []).concat([body.variables]); return { data: { metafieldDefinitions: { nodes: body.variables.key === 'expiry_date' ? [{ type: { name: 'date' } }] : [] } } }; }
  if (/metafieldsSet/.test(q)) { ctx.__sets = body.variables.m; body.variables.m.forEach(m => { const al = m.ownerId === 'V1' ? 'vBin' : (m.key === 'expiry_date' ? 'pExp' : 'pBin'); ctx.__meta[al] = { value: m.value, type: m.type }; }); return { data: { metafieldsSet: { metafields: [], userErrors: [] } } }; }
  if (/metafieldsDelete/.test(q)) { ctx.__dels = body.variables.m; body.variables.m.forEach(m => { const al = m.ownerId === 'V1' ? 'vBin' : (m.key === 'expiry_date' ? 'pExp' : 'pBin'); ctx.__meta[al] = null; }); return { data: { metafieldsDelete: { userErrors: [] } } }; }
  if (/orders\(first: 10, after: \$cursor, query: \$q, sortKey: \$sort\)/.test(q)) {
    ctx.__pickQ = (ctx.__pickQ || []).concat([body.variables]);
    const V = (id, sku, name, vb, pb, img) => ({ id, sku, title: name, media: { nodes: img ? [{ preview: { image: { url: img } } }] : [] }, metafield: vb ? { value: vb } : null,
      product: { id: 'P' + id, title: 'Prod ' + id, featuredMedia: { preview: { image: { url: 'https://cdn/p-' + id + '.jpg' } } }, metafield: pb ? { value: pb } : null } });
    const O = (id, name, extra, items) => Object.assign({ id, name, cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED', displayFinancialStatus: 'PENDING', tags: [] }, extra,
      { lineItems: { nodes: items } });
    const LI = (q, title, vt, v) => ({ quantity: q, title, variantTitle: vt, variant: v });
    const kitten = V('v1', '6723085', 'Kitten 2kg', 'A-10', 'A-1', 'https://cdn/v1.jpg'), toy = V('v2', 'TOY', 'Default Title', '', 'B-2', ''), food = V('v3', 'FD', '12kg', 'A-2', '', '');
    const page1 = [ O('o1', '#1001', { displayFinancialStatus: 'PAID' }, [LI(2, 'Kitten', '2kg', kitten), LI(1, 'Toy', 'Default Title', toy)]),
                    O('o2', '#1002', { tags: ['Confirmed'] }, [LI(1, 'Kitten', '2kg', kitten)]),
                    O('o3', '#1003', { tags: ['confirmed', 'Not confirmed yet'] }, [LI(9, 'Kitten', '2kg', kitten)]) ];
    const page2 = [ O('o4', '#1004', { displayFinancialStatus: 'PAID', cancelledAt: '2026-11-01' }, [LI(9, 'Toy', '', toy)]),
                    O('o5', '#1005', { displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'PARTIALLY_FULFILLED' }, [LI(9, 'Toy', '', toy)]),
                    O('o6', '#1006', { tags: ['confirmed'] }, [LI(3, 'Food', '12kg', food)]) ];
    const p2 = body.variables.cursor === 'k1';
    return { data: { orders: { nodes: p2 ? page2 : page1, pageInfo: { hasNextPage: !p2, endCursor: p2 ? null : 'k1' } } } };
  }
  if (/returnableFulfillments/.test(q)) return { data: { returnableFulfillments: { nodes: [{ fulfillment: { location: { id: 'L1' } }, returnableFulfillmentLineItems: { nodes: [{ quantity: 2, fulfillmentLineItem: { id: 'FLI1', lineItem: { title: 'Food', sku: 'F1', image: null, variant: { barcode: '111', sku: 'F1' } } } }] } }] } } };
  if (/orders\(first: 1, query: \$q\) \{ nodes/.test(q)) return { data: { orders: { nodes: [{ id: 'gid://Order/1', name: '#1001' }] } } };
  if (/returnCreate/.test(q)) return { data: { returnCreate: { return: { id: 'R', name: '#1001-R1', reverseFulfillmentOrders: { nodes: [{ lineItems: { nodes: [{ id: 'RLI1', totalQuantity: 1, fulfillmentLineItem: { id: 'FLI1' } }] } }] } }, userErrors: [] } } };
  if (/reverseFulfillmentOrderDispose/.test(q)) return { data: { reverseFulfillmentOrderDispose: { userErrors: [] } } };
  if (/status:open/.test(q)) return { data: { orders: { edges: [{ node: { name: '#1002', createdAt: 'x', cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED', currentSubtotalLineItemsQuantity: 3, shippingAddress: { name: 'Mona', city: 'Cairo' } } }] } } };
  if (/productVariants/.test(q)) return { data: { productVariants: { nodes: [{ id: 'v1', displayName: 'Food', price: '100' }] } } };
  if (/tag:POS/.test(JSON.stringify(body.variables))) return { data: { orders: { nodes: [] } } };
  if (/shop \{ name/.test(q)) return { data: { shop: { name: 'Pet Friend' } } };
  return { data: {} };
}
const ctx = {
  console, JSON, Date, Math, Number, String, Object, Array, RegExp, Error,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => props[k] = v }) },
  CacheService: { getScriptCache: () => { const c = ctx.__cache || (ctx.__cache = {}); return { get: k => c[k] || null, put: (k, v) => c[k] = v, remove: k => { delete c[k]; }, removeAll: ks => ks.forEach(k => delete c[k]) }; } },
  UrlFetchApp: { fetch(url, o = {}) { const body = o.payload && typeof o.payload === 'string' ? JSON.parse(o.payload) : (o.payload || {});
    fetches.push({ ver: (url.match(/api\/([\d-]+)\//) || [])[1], url, token: (o.headers || {})['X-Shopify-Access-Token'], q: (body.query || '') });
    let ans, code = 200;
    if (url.includes('bosta')) { const tn = url.split('/').pop(); if (tn === '1111111111') { code = 404; ans = {}; } else ans = { data: { state: { value: 'Delivered' }, log: [], wallet: { cashCycle: { size: 'Light Bulky', bosta_fees: 55 } }, businessReference: '#1001' } }; }
    else ans = shopifyAnswer(url, body);
    return { getResponseCode: () => code, getContentText: () => JSON.stringify(ans) }; } },
  ContentService: { createTextOutput: t => ({ setMimeType() { return this; }, getContent: () => t }), MimeType: { JSON: 'json' } },
  SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => sheet(n) }) },
  DriveApp: { createFolder: () => ({ getId: () => 'F' }), getFolderById: () => ({ createFile: b => ({ getId: () => 'file1', getUrl: () => 'https://drive/file1' }) }), getFileById: () => ({ getBlob: () => ({ getBytes: () => [1] }) }) },
  Session: { getActiveUser: () => ({ getEmail: () => 'me@x' }), getScriptTimeZone: () => 'Africa/Cairo' },
  Utilities: { getUuid: () => 'uuid-' + Math.random().toString(36).slice(2), formatDate: (d, tz, f) => f === 'u' ? String(ctx.__day || 1) : f === 'H' ? String(ctx.__hour || 11) : f === 'yyyyMMdd-HHmm' ? '20261118-1000' : '20261115', newBlob: () => ({}), base64Decode: () => [], base64Encode: () => 'AA==' },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create() {} }) }) }) },
  Logger: { log: (...a) => console.log('   LOG', ...a) },
  HtmlService: {}
};
vm.createContext(ctx); vm.runInContext(code, ctx);
const post = b => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(b) } }).getContent());
let failed = 0;
const check = (label, got, ok) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + label, ok ? '' : JSON.stringify(got)); };
let r;
r = post({ action: 'search', pin: '1111', q: '123' }); check('POS search', r, r.ok && r.data[0].id === 'v1');
check('POS uses POS app token + 2026-10', fetches.at(-1), fetches.at(-1).url.includes('pf.myshopify.com/admin/api/2026-10'));
r = post({ action: 'today', pin: 'bad' }); check('POS wrong PIN', r, r.ok === false && r.error === 'Wrong PIN');
r = post({ action: 'listOrders', key: 'kkk' }); check('Orders list', r, r.ok && r.orders[0].name === '#1002');
check('Orders uses client-credential token, not SHOPIFY_TOKEN', fetches.at(-1), fetches.at(-1).token !== 'shpat_ship_only');
r = post({ action: 'listOrders', key: 'nope' }); check('Orders wrong key', r, r.ok === false && r.error === 'Wrong app key');
r = post({ action: 'getReturnable', key: 'kkk', query: '1001' }); check('Returns: returnable items', r, r.ok && r.items[0].fliId === 'FLI1' && r.items[0].need === 2);
r = post({ action: 'processReturn', key: 'kkk', orderId: 'gid://Order/1', restock: true, reason: 'DEFECTIVE', items: [{ fliId: 'FLI1', qty: 1, locationId: 'L1' }] });
check('Returns: create + restock', r, r.ok && r.returnName === '#1001-R1' && fetches.some(f => f.q.includes('reverseFulfillmentOrderDispose')));
r = post({ fn: 'checkPin', args: ['2222'] }); check('Shipments PIN ok', r, r.result === true);
r = post({ fn: 'checkPin', args: ['0'] }); check('Shipments wrong PIN', r, r.error === 'Wrong PIN');
r = post({ fn: 'saveShipment', args: ['2222', '9022895919', ['data:image/jpeg;base64,AA'], 'note', false] }); check('Shipments save photo', r, r.result && r.result.saved === 1);
r = post({ fn: 'saveShipment', args: ['2222', '1111111111', ['data:image/jpeg;base64,AA'], '', false] }); check('Shipments misread blocked', r, /not found in Bosta/.test(r.error));
r = post({ fn: 'getShipment', args: ['2222', '9022895919'] }); check('Shipments search', r, r.result && r.result.photos.length === 1);
r = post({ fn: 'eval', args: [] }); check('Shipments unknown fn refused', r, r.error === 'Bad request');
r = post({ action: 'deleteEverything' }); check('Unknown action refused', r, r.ok === false);
r = JSON.parse(ctx.doPost({ postData: { contents: 'not json' } }).getContent()); check('Bad JSON refused', r, r.ok === false);
// hourly trigger passes an event object: the sync must still run
ctx.syncBosta({ triggerUid: '1', authMode: 'FULL' });
const tr = sheets.Tracking.rows[1];
check('Hourly trigger actually syncs (event object)', tr, tr[3] === 'Delivered' && tr[4] === 'Light Bulky');
check('Bulky row written', sheets.Bulky && sheets.Bulky.rows[1], sheets.Bulky && sheets.Bulky.rows[1][7] === 55);

// ---- receiving from suppliers
r = post({ action: 'listPOs', key: 'kkk' }); check('Receive: list open POs, newest first, fully received hidden', r.orders.map(o => o.name), r.ok && r.orders.map(o => o.name).join() === 'PO-1010,PO-1003,PO-1001' && r.orders[1].qty === 6 && r.orders[1].customer === 'Royal Canin');
check('Receive: reads every page (no last: query)', fetches.slice(-2).map(f => f.q.includes('after: $after') && !/last:/.test(f.q)), fetches.slice(-2).every(f => f.q.includes('after: $after') && !/last:/.test(f.q)));
check('Receive uses API 2026-10', fetches.at(-1), fetches.at(-1).ver === '2026-10');
r = post({ action: 'listPOs', key: 'bad' }); check('Receive: wrong key refused', r, r.ok === false && r.error === 'Wrong app key');
r = post({ action: 'getPO', key: 'kkk', query: '1003' }); check('Receive: load PO by number (open shipment lines only)', r, r.ok && r.order.name === 'PO-1003' && r.items.length === 2 && r.items[0].sliId === 'SL1' && r.items[0].need === 4 && r.items[0].barcode === '111');
r = post({ action: 'getPO', key: 'kkk', query: 'po-1003' }); check('Receive: load PO by name', r, r.ok && r.order.id === 'PO1');
r = post({ action: 'getPO', key: 'kkk', query: '7777' }); check('Receive: unknown PO -> clear error', r, r.ok === false && /not found/.test(r.error));
r = post({ action: 'receivePO', key: 'kkk', requestId: 'req1', items: [{ shipmentId: 'S1', sliId: 'SL1', qty: 3, need: 4 }, { shipmentId: 'S1', sliId: 'SL2', qty: 0, need: 2 }] });
check('Receive: receives scanned qty as ACCEPTED, skips 0', { r, rec: ctx.__received }, r.ok && r.received === 3 && ctx.__received.length === 1 && ctx.__received[0].li.length === 1 && ctx.__received[0].li[0].reason === 'ACCEPTED' && ctx.__received[0].li[0].quantity === 3);
check('Receive: idempotency key sent', ctx.__received[0], ctx.__received[0].idem && ctx.__received[0].key === 'req1-s0');
r = post({ action: 'getPO', key: 'kkk', query: 'PO-1005' }); check('Receive: PO without shipment offers transfer lines', r, r.ok && r.items[0].transferId === 'T5' && r.items[0].need === 5);
ctx.__received = [];
r = post({ action: 'receivePO', key: 'kkk', requestId: 'req2', items: [{ transferId: 'T5', inventoryItemId: 'I9', qty: 2, need: 5 }] });
check('Receive: creates shipment for scanned qty, then receives it', { r, rec: ctx.__received }, r.ok && r.received === 2 && ctx.__received[0].id === 'SNEW' && ctx.__received[0].li[0].quantity === 2);
r = post({ action: 'receivePO', key: 'kkk', items: [] }); check('Receive: nothing scanned refused', r, r.ok === false);


r = post({ action: 'getPO', key: 'kkk', query: '1003' });
check('Bins: variant + product bin returned', r.items, r.items[0].binVariant === 'A-12' && r.items[0].binProduct === 'A-10');
check('Bins: list metafield shown comma-separated, missing variant bin empty', r.items[1], r.items[1].binVariant === '' && r.items[1].binProduct === 'B-3, B-4');
const lastQ = fetches.filter(f => /inventoryShipment\(id/.test(f.q)).at(-1).q;
check('Bins: asks for custom.bin_location by default', lastQ, /vBin: metafield\(namespace: "custom", key: "bin_location"\)/.test(lastQ) && /pBin: metafield\(namespace: "custom", key: "bin_location"\)/.test(lastQ));
props.BIN_VARIANT_METAFIELD = 'custom.variant_bin'; post({ action: 'getPO', key: 'kkk', query: '1003' });
const q2 = fetches.filter(f => /inventoryShipment\(id/.test(f.q)).at(-1).q;
check('Bins: key can be changed in Script Properties', q2, /key: "variant_bin"/.test(q2));
props.BIN_VARIANT_METAFIELD = 'bad key"}'; r = post({ action: 'getPO', key: 'kkk', query: '1003' });
check('Bins: malformed key refused (no query injection)', r, r.ok === false && /must look like/.test(r.error));
delete props.BIN_VARIANT_METAFIELD;


// ---- editing bin locations / expiry date
const lastPOq = fetches.filter(f => /inventoryShipment\(id/.test(f.q)).at(-1).q;
check('Meta: asks for product expiry, not a variant expiry', lastPOq, /pExp: metafield\(namespace: "custom", key: "expiry_date"\)/.test(lastPOq) && !/vExp/.test(lastPOq));
r = post({ action: 'setItemMeta', key: 'kkk', variantId: 'V1', values: { binVariant: 'C-7', binProduct: 'B-3, B-9', expProduct: '2027-03-31' } });
check('Meta: saves all three', { r, sets: ctx.__sets }, r.ok && r.changed === 3 && r.values.binVariant === 'C-7' && r.values.expProduct === '2027-03-31');
check('Meta: list metafield written as JSON list', ctx.__sets, ctx.__sets.find(m => m.ownerId === 'P1' && m.key === 'bin_location').value === '["B-3","B-9"]');
check('Meta: new expiry uses the store definition type (date)', ctx.__sets, ctx.__sets.find(m => m.key === 'expiry_date').type === 'date');
check('Meta: owners are variant and product', ctx.__sets, ctx.__sets.find(m => m.ownerId === 'V1') && ctx.__sets.filter(m => m.ownerId === 'P1').length === 2);
ctx.__sets = null;
r = post({ action: 'setItemMeta', key: 'kkk', variantId: 'V1', values: { binVariant: 'C-7', binProduct: 'B-3, B-9', expProduct: '2027-03-31' } });
check('Meta: unchanged values -> nothing written', r, r.ok && r.changed === 0 && ctx.__sets === null);
r = post({ action: 'setItemMeta', key: 'kkk', variantId: 'V1', values: { expProduct: '' } });
check('Meta: empty value deletes the metafield', { r, d: ctx.__dels }, r.ok && ctx.__dels[0].key === 'expiry_date' && ctx.__dels[0].ownerId === 'P1' && r.values.expProduct === '');
r = post({ action: 'setItemMeta', key: 'kkk', variantId: 'V1', values: { expProduct: '31/03/2027' } });
check('Meta: bad date refused', r, r.ok === false && /YYYY-MM-DD/.test(r.error));
r = post({ action: 'setItemMeta', key: 'bad', variantId: 'V1', values: { binVariant: 'X' } });
check('Meta: wrong key refused', r, r.ok === false && r.error === 'Wrong app key');

r = post({ action: 'getPO', key: 'kkk', query: '1003' });
check('Image: product picture used when the variant has none', r.items[0].image, r.items[0].image === 'https://cdn.shopify.com/p.jpg');
check('Image: missing picture -> empty, no crash', r.items[1].image, r.items[1].image === '');
const iq = fetches.filter(f => /inventoryShipment\(id/.test(f.q)).at(-1).q;
check('Image: asks for variant media and product featuredMedia', iq, /media\(first: 1\)/.test(iq) && /featuredMedia/.test(iq));


// ---- rejected / cancelled / extra
ctx.__received = []; ctx.__adjust = null;
r = post({ action: 'getPO', key: 'kkk', query: '1003' });
check('Receive: PO gives its location id and item inventory ids', r, r.order.locationId === 'LOC1' && r.items[0].inventoryItemId === 'I1');
r = post({ action: 'receivePO', key: 'kkk', requestId: 'r3', locationId: 'LOC1', poName: 'PO-1003', items: [
  { shipmentId: 'S1', sliId: 'SL1', inventoryItemId: 'I1', need: 4, qty: 2, rejected: 1, canceled: 1 },
  { shipmentId: 'S1', sliId: 'SL2', inventoryItemId: 'I2', need: 2, qty: 5 } ] });
const li = ctx.__received[0] && ctx.__received[0].li;
check('Receive: accepted / rejected / cancelled sent per line', li, JSON.stringify(li) === JSON.stringify([
  { shipmentLineItemId: 'SL1', quantity: 2, reason: 'ACCEPTED' }, { shipmentLineItemId: 'SL1', quantity: 1, reason: 'REJECTED' },
  { shipmentLineItemId: 'SL1', quantity: 1, reason: 'CANCELED' }, { shipmentLineItemId: 'SL2', quantity: 2, reason: 'ACCEPTED' }]));
check('Receive: 3 extra units added to stock at the PO location', ctx.__adjust, ctx.__adjust && ctx.__adjust.input.reason === 'received' && ctx.__adjust.input.name === 'available'
  && ctx.__adjust.input.changes.length === 1 && ctx.__adjust.input.changes[0].delta === 3 && ctx.__adjust.input.changes[0].locationId === 'LOC1'
  && ctx.__adjust.input.changes[0].inventoryItemId === 'I2' && ctx.__adjust.input.changes[0].changeFromQuantity === null && ctx.__adjust.key === 'r3-x');
check('Receive: totals returned', r, r.ok && r.accepted === 4 && r.extra === 3 && r.received === 7 && r.rejected === 1 && r.canceled === 1);
r = post({ action: 'receivePO', key: 'kkk', locationId: 'LOC1', items: [{ shipmentId: 'S1', sliId: 'SL1', need: 4, qty: 0, rejected: 3, canceled: 2 }] });
check('Receive: rejected + cancelled above expected is refused', r, r.ok === false && /Too many rejected/.test(r.error));
ctx.__received = []; ctx.__adjust = null;
r = post({ action: 'receivePO', key: 'kkk', requestId: 'r4', locationId: 'LOC1', items: [{ shipmentId: 'S1', sliId: 'SL1', inventoryItemId: 'I1', need: 4, qty: 3, rejected: 1, canceled: 1 }] });
check('Receive: rejected/cancelled first, 2 on the line, 1 extra', { li: ctx.__received[0] && ctx.__received[0].li, adj: ctx.__adjust },
  r.ok && r.accepted === 2 && r.extra === 1 && ctx.__adjust.input.changes[0].delta === 1);
r = post({ action: 'receivePO', key: 'kkk', items: [{ shipmentId: 'S1', sliId: 'SL1', inventoryItemId: 'I1', need: 1, qty: 3 }] });
check('Receive: extra units without a PO location -> clear error', r, r.ok === false && /no location/.test(r.error));
ctx.__received = [];
r = post({ action: 'receivePO', key: 'kkk', locationId: 'LOC1', items: [{ shipmentId: 'S1', sliId: 'SL1', need: 4, qty: 0, canceled: 4 }] });
check('Receive: cancel only (nothing arrived) works', ctx.__received[0], r.ok && r.canceled === 4 && ctx.__received[0].li[0].reason === 'CANCELED');
ctx.__received = [];
r = post({ action: 'receivePO', key: 'kkk', requestId: 'r5', locationId: 'LOC1', items: [{ transferId: 'T5', inventoryItemId: 'I9', need: 5, qty: 2, rejected: 1 }] });
check('Receive: no-shipment transfer -> shipment for 3, receive 2 accepted + 1 rejected', ctx.__received[0], r.ok && ctx.__received[0].li.length === 2 && ctx.__received[0].li[1].reason === 'REJECTED');


// ---- pick list (in the app, no email)
r = post({ action: 'listPickLists', key: 'kkk' });
check('Pick: no pick lists yet', r, r.ok && r.pickLists.length === 0);
r = post({ action: 'createPickList', key: 'kkk' });
check('Pick: manual list = eligible orders (paid / confirmed, not "not confirmed yet", not cancelled, unfulfilled)', r, r.ok && r.created && r.pickList.orders === 3 && r.pickList.kind === 'manual');
const id1 = r.pickList.id;
r = post({ action: 'getPickList', key: 'kkk', id: id1 }); const it = r.pickList.items;
check('Pick: combined per variant, sorted by bin', it.map(p => p.sku + 'x' + p.quantity), it.map(p => p.sku + 'x' + p.quantity).join() === 'FDx3,6723085x3,TOYx1');
check('Pick: order numbers kept', it[1].orders, it[1].orders.join() === '#1001,#1002');
r = post({ action: 'createPickList', key: 'kkk' });
check('Pick: same orders are not listed twice', r, r.ok && r.created === false);
// a big list is split over several cells and read back whole
props.__big = 1;
const big = ctx.buildPickList_; ctx.buildPickList_ = () => ({ orderIds: ['o9'], products: Array.from({ length: 300 }, (_, i) => ({ key: 'k' + i, title: 'Product number ' + i + ' '.repeat(200), sku: 'S' + i, quantity: 1, orders: ['#9'] })) });
r = post({ action: 'createPickList', key: 'kkk' }); const bigId = r.pickList && r.pickList.id;
r = post({ action: 'getPickList', key: 'kkk', id: bigId });
check('Pick: long list split over cells and read back (300 products)', r.pickList && r.pickList.items.length, r.ok && r.pickList.items.length === 300 && sheets.PickLists.rows.find(x => x[0] === bigId).length > 7);
check('Pick: same minute -> unique id', [id1, bigId], bigId && bigId !== id1);
ctx.buildPickList_ = big;
r = post({ action: 'listPickLists', key: 'kkk' });
check('Pick: list newest first, summaries only', r.pickLists.map(x => x.id), r.ok && r.pickLists.length === 2 && !r.pickLists[0].items);
r = post({ action: 'listPickLists', key: 'nope' }); check('Pick: wrong key refused', r, r.ok === false);
// automatic: hours and Friday
sheets.PickLists.rows.length = 1;
ctx.__hour = 9; ctx.scheduledPicklistCheck(); check('Pick auto: nothing before 10:00', sheets.PickLists.rows.length, sheets.PickLists.rows.length === 1);
ctx.__hour = 14; ctx.scheduledPicklistCheck(); check('Pick auto: nothing from 14:00', sheets.PickLists.rows.length, sheets.PickLists.rows.length === 1);
ctx.__hour = 10; ctx.__day = 5; ctx.scheduledPicklistCheck(); check('Pick auto: nothing on Friday', sheets.PickLists.rows.length, sheets.PickLists.rows.length === 1);
ctx.__day = 1; ctx.scheduledPicklistCheck(); check('Pick auto: 10:00 publishes everything waiting', sheets.PickLists.rows[1], sheets.PickLists.rows.length === 2 && sheets.PickLists.rows[1][2] === 'auto' && sheets.PickLists.rows[1][3] === 3);
ctx.__hour = 11; ctx.scheduledPicklistCheck(); check('Pick auto: later run with no new orders adds nothing', sheets.PickLists.rows.length, sheets.PickLists.rows.length === 2);
// old lists pruned after 30 days
sheets.PickLists.rows.push(['PL-old', new Date('2020-01-01'), 'auto', 1, 1, 'oX', '[]']);
post({ action: 'createPickList', key: 'kkk' });
check('Pick: lists older than 30 days removed', sheets.PickLists.rows.map(x => x[0]), !sheets.PickLists.rows.some(x => x[0] === 'PL-old'));
check('Pick: no email code left', ctx.MailApp, typeof ctx.emailPickList_ === 'undefined' && typeof ctx.sendPickListEmail_ === 'undefined');

// ---- store name in any form
for (const form of ['pf', 'pf.myshopify.com', 'https://pf.myshopify.com/admin', ' PF.myshopify.com ']) {
  props.SHOPIFY_STORE = form; const before = fetches.length;
  r = post({ action: 'listOrders', key: 'kkk' });
  const u = fetches.slice(before).map(f => f.url).find(x => x.includes('graphql.json'));
  check('Store name "' + form + '" -> ' + (u || '').split('/admin')[0], u, r.ok && /^https:\/\/(pf|PF)\.myshopify\.com\/admin\/api\//.test(u));
}
props.SHOPIFY_STORE = 'pf.myshopify.com';

console.log('\n--- testAll() output:'); ctx.testAll();
// access denied once (stale token) -> fresh token + retry
let denied = 1; const orig = ctx.UrlFetchApp.fetch;
ctx.UrlFetchApp.fetch = (url, o) => { if (denied && url.includes('/graphql.json') && !url.includes('pf.myshopify.com/admin/api/2026')) { denied--; return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ errors: [{ message: 'Access denied for returnableFulfillments field.' }] }) }; } return orig(url, o); };
ctx.__cache.shopify_token = 'old';
r = post({ action: 'getReturnable', key: 'kkk', query: '14211' }); check('Access denied -> fresh token + retry', r, r.ok && ctx.__cache.shopify_token !== 'old');
ctx.UrlFetchApp.fetch = (url, o) => (url.includes('/graphql.json') && !url.includes('/2026')) ? { getResponseCode: () => 200, getContentText: () => JSON.stringify({ errors: [{ message: 'Access denied for returnableFulfillments field.' }] }) } : orig(url, o);
r = post({ action: 'getReturnable', key: 'kkk', query: '14211' }); check('Still denied -> clear error, no endless retry', r, r.ok === false && /Access denied/.test(r.error));
ctx.resetTokens(); check('resetTokens clears both', ctx.__cache, !ctx.__cache.shopify_token && !ctx.__cache.tok);

console.log('\n' + (failed ? failed + ' check(s) FAILED' : 'All checks passed'));
process.exit(failed ? 1 : 0);
