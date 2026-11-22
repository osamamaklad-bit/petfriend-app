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
  appendRow(r) { (ctx.__rawAppends = ctx.__rawAppends || []).push(r); this.rows.splice(this.getLastRow(), 0, r.map(v => typeof v === 'string' && v[0] === "'" ? v.slice(1) : v)); }, setFrozenRows() {}, getLastRow() { let n = this.rows.length; while (n && !this.rows[n - 1].some(v => v !== '' && v != null)) n--; return n; }, deleteRows(i, k) { if (this.rows.length - k < 2) throw new Error('Sorry, it is not possible to delete all non-frozen rows.'); this.rows.splice(i - 1, k); }, getLastColumn() { return this.rows.reduce((m, x) => Math.max(m, x.length), 0); }, deleteRow(i) { if (this.rows.length - 1 < 2) throw new Error('Sorry, it is not possible to delete all non-frozen rows.'); this.rows.splice(i - 1, 1); },
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => r.slice()) }; },
  getRange(r, c, nr = 1, nc = 1) { const s = this; return {
    getValue: () => (s.rows[r - 1] || [])[c - 1], setValue: v => { s.rows[r - 1][c - 1] = v; },
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.rows[r - 1 + i] || [])[c - 1 + j])),
    clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (s.rows[r - 1 + i]) s.rows[r - 1 + i][c - 1 + j] = ''; },
    setValues: vals => vals.forEach((row, i) => { s.rows[r - 1 + i] = s.rows[r - 1 + i] || []; row.forEach((v, j) => s.rows[r - 1 + i][c - 1 + j] = typeof v === 'string' && v[0] === "'" ? v.slice(1) : v); }) }; },
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
    ? { id: 'PO1', name: 'PO-1003', origin: { supplierName: 'Royal Canin' }, destination: { name: 'Main store', location: { id: 'LOC1' } }, transfers: { nodes: [{ id: 'T1', status: 'IN_PROGRESS', shipments: { nodes: [{ id: 'S1', status: (ctx.__s1draft ? 'DRAFT' : 'IN_TRANSIT') }, { id: 'S0', status: 'RECEIVED' }] } }] } }
    : { id: 'PO5', name: 'PO-1005', origin: { supplierName: 'Whiskas' }, destination: { name: 'Main store' }, transfers: { nodes: [{ id: 'T5', status: 'READY_TO_SHIP', shipments: { nodes: [] } }] } } } };
  if (/inventoryShipment\(id/.test(q)) return { data: { inventoryShipment: { lineItems: { nodes: [
    { id: 'SL1', unreceivedQuantity: 4, inventoryItem: { id: 'I1', sku: 'RC2', variants: { nodes: [{ displayName: 'Royal Canin Kitten 2kg', barcode: '111', sku: 'RC2', vBin: { value: 'A-12' }, media: { nodes: [] }, product: { pBin: { value: 'A-10' }, featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/p.jpg' } } } } }] } } },
    { id: 'SL2', unreceivedQuantity: 2, inventoryItem: { id: 'I2', sku: 'RC4', variants: { nodes: [{ displayName: 'Royal Canin Adult 4kg', barcode: '222', sku: 'RC4', vBin: null, product: { pBin: { value: '["B-3","B-4"]' } } }] } } },
    { id: 'SL3', unreceivedQuantity: 0, inventoryItem: { id: 'I3', sku: 'X', variants: { nodes: [] } } } ] } } } };
  if (/inventoryTransfer\(id/.test(q)) return { data: { inventoryTransfer: { lineItems: { nodes: [
    { shippableQuantity: 5, inventoryItem: { id: 'I9', sku: 'WK1', variants: { nodes: [{ displayName: 'Whiskas Tuna', barcode: '999', sku: 'WK1' }] } } } ] } } } };
  if (/inventoryShipmentCreateInTransit/.test(q)) return { data: { inventoryShipmentCreateInTransit: { inventoryShipment: { id: 'SNEW', lineItems: { nodes: body.variables.input.lineItems.map((l, i) => ({ id: 'SNL' + i, quantity: l.quantity, inventoryItem: { id: l.inventoryItemId } })) } }, userErrors: [] } } };
  if (/inventoryAdjustQuantities/.test(q)) { ctx.__adjust = body.variables; return { data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: 'G1' }, userErrors: [] } } }; }
  if (/fulfillmentOrders\(first: 10\)/.test(q)) {
    const li = (id, title, bc, vb, pb) => ({ node: { id, remainingQuantity: 1, lineItem: { title, variantTitle: null, sku: id, image: null,
      variant: { barcode: bc, vBin: vb ? { value: vb } : null, product: { pBin: pb ? { value: pb } : null, pExp: { value: '2027-01-01' } } } } } });
    return { data: { orders: { edges: [{ node: { id: 'gid://Order/7', name: '#1007', cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED',
      fulfillmentOrders: { edges: [{ node: { id: 'FO7', status: 'OPEN', assignedLocation: { name: 'Main' }, lineItems: { edges: [
        li('L1', 'No bin', '1', '', ''), li('L2', 'Shelf B-2', '2', '', 'B-2'), li('L3', 'Shelf A-10', '3', 'A-10', 'A-1'), li('L4', 'Shelf A-2', '4', 'A-2', '') ] } } }] } } }] } } };
  }
  if (/fulfillment \{ id status \}/.test(q)) { ctx.__ful = body.variables.f; }
  if (/fulfillment \{ id status \}/.test(q)) return { data: { fulfillmentCreate: { fulfillment: { id: 'F1', status: 'SUCCESS' }, userErrors: [] } } };
  if (/nodes\(ids: \$ids\) \{ \.\.\. on Order/.test(q)) return { data: { nodes: body.variables.ids.map((id, i) => ({ id, name: '#100' + (i + 1), cancelledAt: null, displayFulfillmentStatus: i === 0 ? 'FULFILLED' : 'UNFULFILLED' })) } };
  if (/inventoryShipmentMarkInTransit/.test(q)) { ctx.__marked = (ctx.__marked || []).concat([body.variables.id]); return { data: { inventoryShipmentMarkInTransit: { inventoryShipment: { id: body.variables.id, status: 'IN_TRANSIT' }, userErrors: [] } } }; }
  if (/draftOrderCreate/.test(q)) { ctx.__posOrders = (ctx.__posOrders || 0) + 1; return { data: { draftOrderCreate: { draftOrder: { id: 'D' + ctx.__posOrders }, userErrors: [] } } }; }
  if (/draftOrderComplete/.test(q)) return { data: { draftOrderComplete: { draftOrder: { order: { id: 'O', name: '#P' + ctx.__posOrders, totalPriceSet: { shopMoney: { amount: '100.0' } }, fulfillmentOrders: { nodes: [{ id: 'FO' }] } } }, userErrors: [] } } };
  if (/fulfillmentCreate\(fulfillment: \$f\)\{userErrors/.test(q) || /fulfillmentCreate\(fulfillment:\$f\)/.test(q)) return { data: { fulfillmentCreate: { userErrors: [] } } };
  if (/shop\{currencyCode\}/.test(q)) return { data: { shop: { currencyCode: 'EGP' }, nodes: body.variables.ids.map(id => ({ id, price: '100.00' })) } };
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
  if (/products\(first: 100, after: \$after, query: "status:active"\)/.test(q)) { ctx.__expPages = (ctx.__expPages || 0) + 1; const p2 = body.variables.after === 'e1';
    const P = (id, title, exp, inv, sku, vb, pb) => ({ id, title, totalInventory: inv, pExp: exp ? { value: exp } : null, pBin: pb ? { value: pb } : null, featuredMedia: null, variants: { nodes: [{ sku, barcode: '', vBin: vb ? { value: vb } : null }] } });
    return { data: { products: { nodes: p2 ? [P('p4', 'Far', '2027-12-01', 9, 'F'), P('p5', 'In 30', '2026-12-15', 4, 'T', '', '["C-1","C-2"]')]
      : [P('p1', 'Expired', '2026-11-01', 3, 'E', 'A-1'), P('p2', 'No date', null, 5, 'N'), P('p3', 'Today', '2026-11-15', 0, 'D')], pageInfo: { hasNextPage: !p2, endCursor: p2 ? null : 'e1' } } } }; }
  if (/fulfillment_status:shipped/.test(JSON.stringify(body.variables || {}))) return { data: { orders: { nodes: [
    { name: '#14341', fulfillments: [{ trackingInfo: [{ number: '6660000001', company: 'Bosta', url: null }] }] },
    { name: '#14339', fulfillments: [{ trackingInfo: [{ number: 'JD0141', company: 'Aramex', url: null }] }, { trackingInfo: [] }] },
    { name: '#14338', fulfillments: [] } ] } } };
  if (/returnableFulfillments/.test(q)) return { data: { returnableFulfillments: { nodes: [{ fulfillment: { location: { id: 'L1' } }, returnableFulfillmentLineItems: { nodes: [{ quantity: 2, fulfillmentLineItem: { id: 'FLI1', lineItem: { title: 'Food', sku: 'F1', image: null, variant: { barcode: '111', sku: 'F1' } } } }] } }] } } };
  if (/orders\(first: 1, query: \$q\) \{ nodes/.test(q)) return { data: { orders: { nodes: [{ id: 'gid://Order/1', name: '#1001' }] } } };
  if (/returnCreate/.test(q)) return { data: { returnCreate: { return: { id: 'R', name: '#1001-R1', reverseFulfillmentOrders: { nodes: [{ lineItems: { nodes: [{ id: 'RLI1', totalQuantity: 1, fulfillmentLineItem: { id: 'FLI1' } }] } }] } }, userErrors: [] } } };
  if (/reverseFulfillmentOrderDispose/.test(q)) return { data: { reverseFulfillmentOrderDispose: { userErrors: [] } } };
  if (/status:open/.test(q)) return { data: { orders: { edges: [{ node: { name: '#1002', createdAt: 'x', cancelledAt: null, displayFulfillmentStatus: 'UNFULFILLED', currentSubtotalLineItemsQuantity: 3, shippingAddress: { name: 'Mona', city: 'Cairo' } } }] } } };
  if (/barcodes\(first: 5\)/.test(q)) { ctx.__lookQ = (ctx.__lookQ || []).concat([body.variables.q]);
    const hit = /"012345678905"|"6723085"/.test(body.variables.q) || body.variables.q === 'royal kitten';
    return { data: { shop: { currencyCode: 'EGP' }, productVariants: { nodes: hit ? [{ id: 'V1', title: '2kg', displayName: 'Royal Canin Kitten - 2kg', sku: '6723085', barcode: '12345678905',
      barcodes: { nodes: [{ value: '12345678905' }, { value: '5000000000001' }] }, price: '850.00', compareAtPrice: '900.00', inventoryQuantity: 7, vBin: { value: 'A-10' }, media: { nodes: [] },
      product: { id: 'P1', title: 'Royal Canin Kitten', status: 'ACTIVE', variantsCount: { count: 2 }, pBin: { value: '["A-1"]' }, pExp: { value: '2027-01-31' }, featuredMedia: { preview: { image: { url: 'https://cdn/p.jpg' } } } },
      inventoryItem: { tracked: true, inventoryLevels: { nodes: [{ location: { name: 'Main store' }, quantities: [{ quantity: 5 }] }, { location: { name: 'Warehouse' }, quantities: [{ quantity: 2 }] }] } } }] : [] } } }; }
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
    if (url.includes('wallet/transactions')) { const pg = +(url.match(/page=(\d+)/) || [0, 1])[1]; ctx.__feedPages = (ctx.__feedPages || 0) + 1;
      ans = { data: { transactions: pg === 1 ? [{ type: 'cashout' }, { trackingNumber: '5550000001' }] : pg === 2 ? [{ trackingNumber: 5550000002 }, { delivery: { trackingNumber: '5550000001' } }] : [] } }; }
    else if (url.includes('bosta') && url.split('/').pop() === '7770000001') { code = 401; ans = {}; }
    else if (url.includes('bosta')) { const tn = url.split('/').pop(); if (tn === '1111111111') { code = 404; ans = {}; } else ans = { data: { state: { value: 'Delivered' }, log: [], wallet: { cashCycle: { size: 'Light Bulky', bosta_fees: 55 } }, businessReference: tn === '2222222222' ? 'petsfriend-5972:#1007' : '#1001' } }; }
    else ans = shopifyAnswer(url, body);
    return { getResponseCode: () => code, getContentText: () => JSON.stringify(ans) }; } },
  ContentService: { createTextOutput: t => ({ setMimeType() { return this; }, getContent: () => t }), MimeType: { JSON: 'json' } },
  SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => sheet(n) }) },
  DriveApp: { createFolder: () => ({ getId: () => 'F' }), getFolderById: () => ({ createFile: b => ({ getId: () => 'file1', getUrl: () => 'https://drive/file1' }) }), getFileById: () => ({ getBlob: () => ({ getBytes: () => [1] }) }) },
  Session: { getActiveUser: () => ({ getEmail: () => 'me@x' }), getScriptTimeZone: () => 'Africa/Cairo' },
  Utilities: { getUuid: () => 'uuid-' + Math.random().toString(36).slice(2), formatDate: (d, tz, f) => f === 'u' ? String(ctx.__day || 1) : f === 'H' ? String(ctx.__hour || 11) : f === 'yyyyMMdd-HHmm' ? '20261118-1000' : f === 'yyyy-MM-dd' ? '2026-11-15' : '20261115', newBlob: () => ({}), base64Decode: () => [], base64Encode: () => 'AA==', sleep: ms => { ctx.__slept = (ctx.__slept || 0) + ms; } },
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
check('Meta: only the expiry date is written', { r, sets: ctx.__sets }, r.ok && r.changed === 1 && ctx.__sets.length === 1 && ctx.__sets[0].key === 'expiry_date' && ctx.__sets[0].ownerId === 'P1' && r.values.expProduct === '2027-03-31');
check('Meta: bin locations are read-only (sent values ignored, unchanged in Shopify)', r.values, r.values.binVariant === 'A-12' && r.values.binProduct === 'B-3' && !ctx.__sets.some(m => m.key === 'bin_location'));
check('Meta: new expiry uses the store definition type (date)', ctx.__sets, ctx.__sets.find(m => m.key === 'expiry_date').type === 'date');
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


// ---- fixes from the code review
r = post({ action: 'listOrders', key: 'kkk' });
check('Orders use a supported API version (2026-10)', fetches.filter(f => /graphql/.test(f.url)).at(-1).ver, fetches.filter(f => /graphql/.test(f.url)).at(-1).ver === '2026-10');
ctx.__posOrders = 0;
const sale = { action: 'sale', pin: '1111', items: [{ id: 'gid://shopify/ProductVariant/1', qty: 1, price: 100 }], discountType: 'pct', discountValue: 0, saleId: 'abc12345-xyz' };
const s1 = post(sale), s2 = post(sale);
check('POS: same saleId sent twice -> one order, same answer', [s1, s2, ctx.__posOrders], s1.ok && s2.ok && ctx.__posOrders === 1 && s1.data.name === s2.data.name);
post(Object.assign({}, sale, { saleId: 'other-sale-123' }));
check('POS: a new saleId makes a new order', ctx.__posOrders, ctx.__posOrders === 2);
ctx.__s1draft = true; ctx.__marked = []; ctx.__received = [];
r = post({ action: 'getPO', key: 'kkk', query: '1003' });
check('Receive: DRAFT shipment lines are offered (no second shipment)', r.items && r.items[0], r.ok && r.items[0].shipmentId === 'S1' && r.items[0].draft === true);
r = post({ action: 'receivePO', key: 'kkk', requestId: 'r9', locationId: 'LOC1', items: [{ shipmentId: 'S1', sliId: 'SL1', inventoryItemId: 'I1', need: 4, qty: 2, draft: true }] });
check('Receive: draft shipment marked in transit, then received', [ctx.__marked, ctx.__received.length], r.ok && ctx.__marked.join() === 'S1' && ctx.__received[0].id === 'S1');
ctx.__s1draft = false;
ctx.__rawAppends = [];
sheets.PickLists && (sheets.PickLists.rows.length = 1);
post({ action: 'createPickList', key: 'kkk' });
const app = ctx.__rawAppends.find(x => String(x[0]).indexOf('PL-') === 0);
check('Pick list: data cells written as text (leading apostrophe)', app && app.slice(5).map(c => String(c)[0]), app && app.slice(5).every(c => String(c)[0] === "'"));
r = post({ action: 'getPickList', key: 'kkk', id: app && app[0] });
check('Pick list: reads back after the text marker', r.ok && r.pickList.items.length, r.ok && r.pickList.items.length === 3);
const bp = ctx.buildPickList_('status:open', 'CREATED_AT');
check('Pick list: tells when the 1000-order limit was not reached', bp.truncated, bp.truncated === false);


// ---- Today summary, logs, Fulfill bins, pick list order status
r = post({ action: 'getOrder', key: 'kkk', query: '1007' });
check('Fulfill: items carry bins and expiry', r.items && r.items[0], r.ok && r.items.find(i => i.title === 'Shelf A-10').binVariant === 'A-10' && r.items[0].expProduct === '2027-01-01');
check('Fulfill: items sorted by bin (A-2, A-10, B-2, no bin last)', r.items && r.items.map(i => i.title), r.items.map(i => i.title).join() === 'Shelf A-2,Shelf A-10,Shelf B-2,No bin');
r = post({ action: 'fulfill', key: 'kkk', orderName: '#1007', notify: false, items: [{ foId: 'FO7', foliId: 'L1', qty: 2 }, { foId: 'FO7', foliId: 'L2', qty: 1 }] });
const actRows = (sheets.Activity && sheets.Activity.rows) || [];
check('Activity: fulfill logged with order and units', actRows.at(-1), r.ok && actRows.at(-1)[1] === 'Orders' && actRows.at(-1)[2] === 'fulfill' && actRows.at(-1)[3] === '#1007' && actRows.at(-1)[4] === 3);
check('Activity: returns, receives, pick lists and photos were logged too', [...new Set(actRows.slice(1).map(x => x[1] + '/' + x[2]))],
  ['Orders/return', 'Orders/receive', 'Pick list/manual', 'Shipments/photo'].every(k => actRows.some(x => x[1] + '/' + x[2] === k)));
const errBefore = (sheets.Errors && sheets.Errors.rows.length) || 0;
post({ action: 'receivePO', key: 'kkk', items: [] });
post({ action: 'listOrders', key: 'wrong' }); post({ action: 'today', pin: 'wrong' }); post({ fn: 'checkPin', args: ['wrong'] });
const errRows = sheets.Errors.rows;
check('Errors: a real error is logged with part and action', errRows.at(-1), errRows.length === errBefore + 1 && errRows.at(-1)[1] === 'Orders' && errRows.at(-1)[2] === 'receivePO' && /Nothing to receive/.test(errRows.at(-1)[3]));
check('Errors: wrong PIN / app key are not logged', errRows.length - errBefore, errRows.length - errBefore === 1);
r = post({ action: 'dailySummary', key: 'kkk' });
check('Today: summary has every section', r, r.ok && r.fulfilled.count >= 1 && r.fulfilled.qty >= 3 && r.returns.count >= 1 && r.received.count >= 1 && 'extra' in r.received
  && r.pickLists.count >= 1 && r.photos.qty >= 1 && r.pos && typeof r.pos.count === 'number' && r.openOrders === 1 && r.errors.count >= 1 && r.errors.last[0].action === 'receivePO');
r = post({ action: 'dailySummary', key: 'nope' }); check('Today: wrong key refused', r, r.ok === false);
sheets.PickLists.rows.length = 1; post({ action: 'createPickList', key: 'kkk' });
const plId = sheets.PickLists.rows[1][0];
r = post({ action: 'getPickList', key: 'kkk', id: plId });
check('Pick list: shows each order\'s current fulfillment status', r.pickList && r.pickList.orderStatus, r.ok && r.pickList.orderStatus['#1001'] === 'FULFILLED' && r.pickList.orderStatus['#1002'] === 'UNFULFILLED');
sheets.Activity.rows.splice(1, 0, [new Date('2020-01-01'), 'Orders', 'fulfill', 'old', 1, '']);
ctx.__cache && delete ctx.__cache.logs_pruned; ctx.pruneLogs_();
check('Logs: rows older than 60 days removed', sheets.Activity.rows.some(x => x[3] === 'old'), !sheets.Activity.rows.some(x => x[3] === 'old') && sheets.Activity.rows.length > 2);

r = post({ action: 'expiryReport', key: 'kkk' });
check('Expiry: past and soon (<=90 days) only, soonest first, all pages', r.items && r.items.map(i => i.title + ':' + i.daysLeft),
  r.ok && r.items.map(i => i.title + ':' + i.daysLeft).join() === 'Expired:-14,Today:0,In 30:30' && r.scanned === 5 && r.withDate === 4 && !r.truncated);
check('Expiry: stock, SKU and bin (variant first, then product list)', r.items, r.items[0].stock === 3 && r.items[0].sku === 'E' && r.items[0].bin === 'A-1' && r.items[2].bin === 'C-1, C-2');
const pagesRead = ctx.__expPages; r = post({ action: 'expiryReport', key: 'kkk' });
check('Expiry: cached (no new Shopify reads)', ctx.__expPages - pagesRead, r.ok && r.cached && ctx.__expPages === pagesRead);
r = post({ action: 'expiryReport', key: 'kkk', refresh: true });
check('Expiry: refresh reads again', ctx.__expPages - pagesRead, r.ok && !r.cached && ctx.__expPages === pagesRead + 2);

let thr = 2; const origF = ctx.UrlFetchApp.fetch;
ctx.UrlFetchApp.fetch = (url, o) => (thr && url.includes('/graphql.json')) ? (thr--, { getResponseCode: () => 200, getContentText: () => JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }) }) : origF(url, o);
r = post({ action: 'expiryReport', key: 'kkk', refresh: true }); ctx.UrlFetchApp.fetch = origF;
check('Shopify THROTTLED: waits and retries', ctx.__slept, r.ok && r.items.length === 3 && ctx.__slept === 6000);

// Google Sheets cannot delete every row under the header: cleanup must still work when ALL rows are old
sheets.Errors.rows.length = 1; sheets.Errors.rows.push([new Date('2020-01-01'), 'Orders', 'x', 'old1'], [new Date('2020-01-02'), 'Orders', 'x', 'old2']);
ctx.__cache && delete ctx.__cache.logs_pruned; ctx.pruneLogs_();
check('Logs: all rows old -> emptied without an error', sheets.Errors.rows, sheets.Errors.getLastRow() === 1);
post({ action: 'receivePO', key: 'kkk', items: [] });
check('Logs: next error is written right under the header', sheets.Errors.rows[1], sheets.Errors.getLastRow() === 2 && /Nothing to receive/.test(sheets.Errors.rows[1][3]));
sheets.PickLists.rows.length = 1; sheets.PickLists.rows.push(['PL-old', new Date('2020-01-01'), 'auto', 1, 1, 'gid://Order/9']);
r = post({ action: 'createPickList', key: 'kkk' });
check('Pick list: created even when every saved list is old (month without lists)', r, r.ok && r.created && sheets.PickLists.getLastRow() === 2 && sheets.PickLists.rows[1][0] !== 'PL-old');

const realNow = ctx.Date.now; let fakeT = 0; ctx.Date.now = () => (fakeT += 200000);
r = post({ action: 'expiryReport', key: 'kkk', refresh: true }); ctx.Date.now = realNow;
check('Expiry: stops before Google\'s 6-minute limit and says the list is cut short', r, r.ok && r.truncated === true && r.scanned === 3);

r = post({ action: 'lookupProduct', key: 'kkk', code: '12345678905' });
check('Check product: UPC-A without its leading 0 also searches the 12-digit code', ctx.__lookQ.at(-1), r.ok && r.items.length === 1 && /barcode:"012345678905"/.test(ctx.__lookQ.at(-1)) && r.by === 'code');
const it0 = r.items[0];
check('Check product: price, stock per location, bins, expiry, all barcodes, picture', it0, it0.price === '850.00' && it0.compareAtPrice === '900.00' && it0.stock === 7
  && it0.locations.map(l => l.name + ':' + l.available).join() === 'Main store:5,Warehouse:2' && it0.binVariant === 'A-10' && it0.binProduct === 'A-1'
  && it0.expProduct === '2027-01-31' && it0.barcodes.length === 2 && it0.image === 'https://cdn/p.jpg' && it0.variantTitle === '2kg' && r.currency === 'EGP');
r = post({ action: 'lookupProduct', key: 'kkk', code: 'royal kitten' });
check('Check product: no code match -> searches by name', ctx.__lookQ.slice(-2), r.ok && r.by === 'name' && r.items.length === 1 && ctx.__lookQ.at(-1) === 'royal kitten');
r = post({ action: 'lookupProduct', key: 'kkk', code: '999' });
check('Check product: unknown number -> empty list, no name search', r, r.ok && r.items.length === 0 && r.by === 'code');
r = post({ action: 'lookupProduct', key: 'kkk', code: 'a"b OR sku:*' });
check('Check product: quotes in the search are removed', ctx.__lookQ.at(-2), r.ok && !/a"b/.test(ctx.__lookQ.at(-2)));
r = post({ action: 'lookupProduct', key: 'bad', code: '6723085' }); check('Check product: wrong key refused', r, r.ok === false);

// ---- Bosta: several wallet pages + Shopify numbers, newest first, status for Today, errors logged once
props.BOSTA_FEES_URL = 'https://app.bosta.co/api/v2/wallet/transactions?page=1&pageSize=50';
sheets.Tracking.rows.push(["7770000001", new Date(), 0, '', '', false]);
const errN = sheets.Errors.getLastRow();
let st = ctx.syncBosta({ triggerUid: '1' });
const trk = sheets.Tracking.rows.map(x => String(x[0]));
check('Bosta: numbers from wallet pages 1 and 2 (number or text) imported once', st.fees, st.fees.pages === 3 && ['5550000001', '5550000002'].every(t => trk.filter(x => x === t).length === 1));
check('Bosta: Bosta numbers on Shopify fulfillments imported, other carriers skipped', st.shopify, st.shopify.found === 1 && trk.filter(x => x === '6660000001').length === 1 && !trk.some(x => /0141/.test(x)));
check('Bosta: a failing shipment (401) -> one line in Errors with the count', sheets.Errors.rows.slice(1, errN + 1), st.failed === 1 && sheets.Errors.getLastRow() === errN + 1 && /1 shipment\(s\) failed.*7770000001.*401/.test(sheets.Errors.rows[errN][3]));
check('Bosta: newly found bulky shipment logged to Activity', st.bulkyNew, st.bulkyNew >= 1 && sheets.Activity.rows.some(x => x[1] === 'Shipments' && x[2] === 'bulky'));
r = post({ action: 'dailySummary', key: 'kkk' });
check('Today: Bosta sync status (last run, open shipments, bulky today)', r.bosta, r.ok && r.bosta.last && r.bosta.last.checked === st.checked && r.bosta.open >= 1 && typeof r.bosta.trigger === 'boolean' && r.bulky.count >= 1);
st = ctx.syncBosta({ triggerUid: '1' });
check('Bosta: second run adds nothing twice', st.fees, st.fees.added === 0 && st.shopify.added === 0);

// ---- pick list finished mark (hidden in the app, same for every phone)
r = post({ action: 'listPickLists', key: 'kkk' });
const plid = r.pickLists[0].id;
check('Pick list: not finished at first', r.pickLists[0], r.ok && r.pickLists[0].done === false);
r = post({ action: 'setPickListDone', key: 'kkk', id: plid, done: true });
let l2 = post({ action: 'listPickLists', key: 'kkk' });
check('Pick list: marked finished, shows in the list with done', l2.pickLists.find(x => x.id === plid), r.ok && l2.pickLists.find(x => x.id === plid).done === true && !!l2.pickLists.find(x => x.id === plid).doneAt);
post({ action: 'setPickListDone', key: 'kkk', id: plid, done: true });
check('Pick list: marking twice keeps one row', sheets.PickListsDone.rows, sheets.PickListsDone.getLastRow() === 2);
r = post({ action: 'getPickList', key: 'kkk', id: plid }); check('Pick list: open list knows it is finished', r.pickList && r.pickList.done, r.ok && r.pickList.done === true);
r = post({ action: 'setPickListDone', key: 'kkk', id: plid, done: false });
l2 = post({ action: 'listPickLists', key: 'kkk' });
check('Pick list: opened again', l2.pickLists.find(x => x.id === plid), r.ok && l2.pickLists.find(x => x.id === plid).done === false && sheets.PickListsDone.getLastRow() === 1);
r = post({ action: 'setPickListDone', key: 'kkk', id: 'PL-nope', done: true }); check('Pick list: unknown id refused', r, r.ok === false);
check('Pick list: finish / reopen logged, not counted as new lists', sheets.Activity.rows.filter(x => x[1] === 'Pick list' && /done|reopen/.test(x[2])).length, sheets.Activity.rows.filter(x => x[1] === 'Pick list' && /done|reopen/.test(x[2])).length === 3);

// ---- return shipments
r = post({ fn: 'saveReturn', args: ['2222', 'abc 4444444444', ['data:image/jpeg;base64,AA', 'data:image/jpeg;base64,AA'], 'torn box', false] });
check('Return shipment: photos saved as "Bosta return"', sheets.Shipments.rows.slice(-2).map(x => x[6]), r.result && r.result.saved === 2 && sheets.Shipments.rows.slice(-2).every(x => x[6] === 'Bosta return' && x[1] === '4444444444'));
check('Return shipment: Tracking (outgoing) not touched', sheets.Tracking.rows.some(x => String(x[0]) === '4444444444'), !sheets.Tracking.rows.some(x => String(x[0]) === '4444444444'));
r = post({ fn: 'saveReturn', args: ['2222', '4444444444', ['data:image/jpeg;base64,AA'], '', false] });
check('Return shipment: second save is a duplicate unless forced', r.result, r.result && r.result.duplicate === true);
r = post({ fn: 'saveReturn', args: ['2222', '4444444444', ['data:image/jpeg;base64,AA'], '', true] }); check('Return shipment: forced adds', r.result, r.result && r.result.saved === 1);
r = post({ fn: 'saveReturn', args: ['2222', '1111111111', ['data:image/jpeg;base64,AA'], '', false] }); check('Return shipment: misread (not in Bosta) refused', r, /not found in Bosta/.test(r.error || ''));
r = post({ fn: 'saveReturn', args: ['9999', '4444444444', ['data:image/jpeg;base64,AA'], '', false] }); check('Return shipment: wrong PIN refused', r, /PIN/.test(r.error || ''));
r = post({ fn: 'saveOther', args: ['2222', 'Aramex', 'AR1', ['data:image/jpeg;base64,AA'], '', true] });
check('Return shipment: other carrier marked as return', sheets.Shipments.rows.at(-1)[6], r.result && sheets.Shipments.rows.at(-1)[6] === 'Aramex return');
post({ fn: 'saveShipment', args: ['2222', '4444444444', ['data:image/jpeg;base64,AA'], 'out', true] });
r = post({ fn: 'getShipment', args: ['2222', '4444444444'] });
check('Search: return photos flagged, carrier stays Bosta', r.result, r.result.returned === true && r.result.carrier === 'Bosta' && r.result.photos.filter(p => p.ret).length === 3 && r.result.photos.filter(p => !p.ret).length === 1);
r = post({ action: 'dailySummary', key: 'kkk' });
check('Today: return photos counted apart', r.returnPhotos, r.ok && r.returnPhotos.count === 3 && r.returnPhotos.qty === 4);

// ---- Fulfill with a Bosta waybill
r = post({ action: 'checkWaybill', key: 'kkk', code: '2222222222', orderName: '#1007' });
check('Waybill: Bosta number for this order', r, r.ok && r.bosta && r.matches && r.tn === '2222222222' && r.refOrder === '#1007');
r = post({ action: 'checkWaybill', key: 'kkk', code: '3333333333', orderName: '#1007' });
check('Waybill: Bosta number of another order is flagged', r, r.ok && r.bosta && r.matches === false && r.refOrder === '#1001');
r = post({ action: 'checkWaybill', key: 'kkk', code: '1111111111', orderName: '#1007' });
check('Waybill: number not in Bosta -> not Bosta', r, r.ok && r.bosta === false);
r = post({ action: 'checkWaybill', key: 'kkk', code: '5000159484695', orderName: '#1007' });
check('Waybill: a product barcode (13 digits) is looked up by its last 10 digits only', r, r.ok && r.tn === '0159484695');
r = post({ action: 'checkWaybill', key: 'kkk', code: 'ABC12', orderName: '#1007' });
check('Waybill: short or non-number codes are not Bosta (no Bosta call)', r, r.ok && r.bosta === false && !r.tn);
props.BOSTA_TRACK_URL = 'https://track.example/?n={tn}';
r = post({ action: 'fulfill', key: 'kkk', orderName: '#1007', notify: true, tracking: '2222222222', items: [{ foId: 'FO7', foliId: 'L1', qty: 1 }] });
check('Fulfill: Bosta tracking saved on the fulfillment', ctx.__ful.trackingInfo, r.ok && r.tracking === '2222222222' && ctx.__ful.trackingInfo.company === 'Bosta'
  && ctx.__ful.trackingInfo.number === '2222222222' && ctx.__ful.trackingInfo.url === 'https://track.example/?n=2222222222' && ctx.__ful.notifyCustomer === true);
check('Fulfill: the waybill is followed by the bulky check (Tracking)', sheets.Tracking.rows.some(x => String(x[0]) === '2222222222'), sheets.Tracking.rows.some(x => String(x[0]) === '2222222222'));
check('Fulfill: tracking in the Activity log', sheets.Activity.rows.at(-1), /2222222222/.test(sheets.Activity.rows.at(-1)[5]));
delete props.BOSTA_TRACK_URL; ctx.__ful = null;
r = post({ action: 'fulfill', key: 'kkk', orderName: '#1007', notify: false, tracking: '3333333333', items: [{ foId: 'FO7', foliId: 'L1', qty: 1 }] });
check('Fulfill: waybill of another order refused, nothing fulfilled', r, r.ok === false && /for order #1001/.test(r.error) && ctx.__ful === null);
r = post({ action: 'fulfill', key: 'kkk', orderName: '#1007', notify: false, items: [{ foId: 'FO7', foliId: 'L1', qty: 1 }] });
check('Fulfill: without a waybill still works (no tracking sent)', ctx.__ful, r.ok && !('trackingInfo' in ctx.__ful));

console.log('\n--- testAll() output:'); ctx.testAll();
// access denied once (stale token) -> fresh token + retry
let denied = 1; const orig = ctx.UrlFetchApp.fetch;
ctx.UrlFetchApp.fetch = (url, o) => { if (denied && url.includes('/graphql.json') && /returnableFulfillments/.test((o && o.payload) || '')) { denied--; return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ errors: [{ message: 'Access denied for returnableFulfillments field.' }] }) }; } return orig(url, o); };
ctx.__cache.shopify_token = 'old';
r = post({ action: 'getReturnable', key: 'kkk', query: '14211' }); check('Access denied -> fresh token + retry', r, r.ok && ctx.__cache.shopify_token !== 'old');
ctx.UrlFetchApp.fetch = (url, o) => (url.includes('/graphql.json') && /returnableFulfillments/.test((o && o.payload) || '')) ? { getResponseCode: () => 200, getContentText: () => JSON.stringify({ errors: [{ message: 'Access denied for returnableFulfillments field.' }] }) } : orig(url, o);
r = post({ action: 'getReturnable', key: 'kkk', query: '14211' }); check('Still denied -> clear error, no endless retry', r, r.ok === false && /Access denied/.test(r.error));
ctx.resetTokens(); check('resetTokens clears both', ctx.__cache, !ctx.__cache.shopify_token && !ctx.__cache.tok);

console.log('\n' + (failed ? failed + ' check(s) FAILED' : 'All checks passed'));
process.exit(failed ? 1 : 0);
