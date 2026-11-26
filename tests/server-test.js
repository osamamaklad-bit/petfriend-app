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
  if (/fulfillmentOrders\(first: 10\)/.test(q) && /1008/.test(JSON.stringify(body.variables))) return { data: { orders: { edges: [{ node: { id: 'gid://Order/8', name: '#1008', cancelledAt: null,
    displayFulfillmentStatus: 'FULFILLED', fulfillmentOrders: { edges: [{ node: { id: 'FO8', status: 'CLOSED', assignedLocation: { name: 'Main' }, lineItems: { edges: [] } } }] } } }] } } };
  if (/fulfillments\(first: 20\)/.test(q)) { const done = /1008/.test(JSON.stringify(body.variables));
    return { data: { orders: { nodes: [{ id: 'gid://Order/' + (done ? 8 : 9), name: done ? '#1008' : '#1009', cancelledAt: null, fulfillments: done ? [
      { id: 'FUL0', status: 'CANCELLED', createdAt: '2026-11-21T10:00:00Z', trackingInfo: [] },
      { id: 'FUL1', status: 'SUCCESS', createdAt: '2026-11-20T10:00:00Z', trackingInfo: (ctx.__trk || []).map(n => ({ number: n, company: 'Bosta', url: null })) } ] : [] }] } } }; }
  if (/fulfillmentTrackingInfoUpdate/.test(q)) { ctx.__trkUpd = body.variables; ctx.__trk = body.variables.t.numbers || [body.variables.t.number];
    return { data: { fulfillmentTrackingInfoUpdate: { fulfillment: { id: body.variables.id }, userErrors: [] } } }; }
  if (/nodes\(ids: \$ids\) \{ \.\.\. on ProductVariant \{ id barcode barcodes/.test(q)) {
    if (ctx.__bcFail) return { errors: [{ message: 'boom' }] };
    return { data: { nodes: body.variables.ids.map(id => ({ id, barcode: id === 'VL3' ? '3' : 'x', barcodes: { nodes: id === 'VL3' ? [{ value: '3' }, { value: '6221234567890' }, { value: '3' }] : [] } })) } }; }
  if (/fulfillmentOrders\(first: 10\)/.test(q)) {
    const li = (id, title, bc, vb, pb) => ({ node: { id, remainingQuantity: 1, lineItem: { title, variantTitle: null, sku: id, image: null,
      variant: { id: 'V' + id, barcode: bc, vBin: vb ? { value: vb } : null, product: { pBin: pb ? { value: pb } : null, pExp: { value: '2027-01-01' } } } } } });
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
    return { data: { productVariant: { id: 'V1', vBin: st.vBin, product: { id: 'P1', pBin: st.pBin, pExp: st.pExp, pExpPrev: st.pExpPrev || null } } } }; }
  if (/metafieldDefinitions/.test(q)) { ctx.__defAsked = (ctx.__defAsked || []).concat([body.variables]); return { data: { metafieldDefinitions: { nodes: body.variables.key === 'expiry_date' ? [{ type: { name: 'date' } }] : [] } } }; }
  if (/metafieldsSet/.test(q)) { ctx.__sets = body.variables.m; body.variables.m.forEach(m => { const al = m.ownerId === 'V1' ? 'vBin' : (m.key === 'expiry_date' ? 'pExp' : m.key === 'expiry_date_of_previous_batch' ? 'pExpPrev' : 'pBin'); ctx.__meta[al] = { value: m.value, type: m.type }; }); return { data: { metafieldsSet: { metafields: [], userErrors: [] } } }; }
  if (/metafieldsDelete/.test(q)) { ctx.__dels = body.variables.m; body.variables.m.forEach(m => { const al = m.ownerId === 'V1' ? 'vBin' : (m.key === 'expiry_date' ? 'pExp' : m.key === 'expiry_date_of_previous_batch' ? 'pExpPrev' : 'pBin'); ctx.__meta[al] = null; }); return { data: { metafieldsDelete: { userErrors: [] } } }; }
  if (/orders\(first: 10, after: \$cursor, query: \$q, sortKey: \$sort\)/.test(q)) {
    ctx.__pickQ = (ctx.__pickQ || []).concat([body.variables]);
    const V = (id, sku, name, vb, pb, img) => ({ id, sku, title: name, media: { nodes: img ? [{ preview: { image: { url: img } } }] : [] }, metafield: vb ? { value: vb } : null,
      product: { id: 'P' + id, title: 'Prod ' + id, featuredMedia: { preview: { image: { url: 'https://cdn/p-' + id + '.jpg' } } }, metafield: pb ? { value: pb } : null,
        pExp: id === 'v1' ? { value: '2027-05-01' } : null, pExpPrev: id === 'v1' ? { value: '2026-12-15' } : null } });
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
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => props[k] = v, setProperties: o => Object.assign(props, o) }) },
  CacheService: { getScriptCache: () => { const c = ctx.__cache || (ctx.__cache = {}); return { get: k => c[k] || null, put: (k, v) => c[k] = v, remove: k => { delete c[k]; }, removeAll: ks => ks.forEach(k => delete c[k]) }; } },
  UrlFetchApp: { fetch(url, o = {}) { const body = o.payload && typeof o.payload === 'string' ? JSON.parse(o.payload) : (o.payload || {});
    fetches.push({ ver: (url.match(/api\/([\d-]+)\//) || [])[1], url, token: (o.headers || {})['X-Shopify-Access-Token'], q: (body.query || '') });
    let ans, code = 200;
    if (url.includes('api.telegram.org') && url.endsWith('/getMe')) ans = { ok: true, result: { username: 'PetFriend002bot' } };
    else if (url.includes('api.telegram.org') && url.endsWith('/getUpdates') && ctx.__tgUpdates) { ctx.__tgOffsets = (ctx.__tgOffsets || []).concat([body.offset]); ans = { ok: true, result: ctx.__tgUpdates }; ctx.__tgUpdates = []; }
    else if (url.includes('api.telegram.org')) { if (url.endsWith('/getUpdates')) ans = { ok: true, result: [{ message: { chat: { id: -100777, type: 'supergroup', title: 'PetFriend staff' } } }, { message: { chat: { id: 5, type: 'private' } } }] };
      else { ctx.__tg = (ctx.__tg || []).concat([{ url, body }]); ans = { ok: true, result: { message_id: 1 } }; } }
    else if (url.includes('deliveries/search')) { const pg = body.pageNumber; ans = { data: { deliveries: pg === 1 ? [{ trackingNumber: '4440000001', createdAt: new Date(Date.now() - 2 * 864e5).toISOString() },
      { trackingNumber: '4440000002', createdAt: new Date(Date.now() - 5 * 864e5).toISOString() }] : [{ trackingNumber: '4440000009', createdAt: new Date(Date.now() - 40 * 864e5).toISOString() }] } }; }
    else if (url.includes('wallet/transactions')) { const pg = +(url.match(/page=(\d+)/) || [0, 1])[1]; ctx.__feedPages = (ctx.__feedPages || 0) + 1;
      ans = { data: { transactions: pg === 1 ? [{ type: 'cashout' }, { trackingNumber: '5550000001' }] : pg === 2 ? [{ trackingNumber: 5550000002 }, { delivery: { trackingNumber: '5550000001' } }] : [] } }; }
    else if (url.includes('bosta') && url.split('/').pop() === '7770000001') { code = 401; ans = {}; }
    else if (url.includes('bosta')) { const tn = url.split('/').pop(); if (tn === '1111111111') { code = 404; ans = {}; } else ans = { data: { createdAt: tn === '5550000002' ? '2026-10-01T09:00:00.000Z' : undefined, state: { value: 'Delivered' }, log: [], wallet: { cashCycle: { size: 'Light Bulky', bosta_fees: 55 } }, businessReference: tn === '2222222222' ? 'petsfriend-5972:#1007' : tn === '8888888888' || tn === '8888888889' ? 'petsfriend-5972:#1008' : '#1001' } }; }
    else ans = shopifyAnswer(url, body);
    return { getResponseCode: () => code, getContentText: () => JSON.stringify(ans) }; } },
  ContentService: { createTextOutput: t => ({ setMimeType() { return this; }, getContent: () => t }), MimeType: { JSON: 'json' } },
  SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => sheet(n) }) },
  DriveApp: { createFolder: (n) => { ctx.__folders = (ctx.__folders || []).concat([n]); return { getId: () => 'F', getUrl: () => 'https://drive/folder/F', createFile: b => { ctx.__files = (ctx.__files || []).concat([b]); return { getId: () => 'file1', getUrl: () => 'https://drive/file1' }; } }; },
    getFolderById: () => ({ getUrl: () => 'https://drive/folder/F', createFile: b => { ctx.__files = (ctx.__files || []).concat([b]); return { getId: () => 'file1', getUrl: () => 'https://drive/file1' }; } }), getFileById: (id) => { if (id === 'gone') throw new Error('not found'); return { getUrl: () => 'https://drive/' + id, getThumbnail: () => ({ getBytes: () => [1, 2, 3, 4, 5, 6], getContentType: () => 'image/png' }), getBlob: () => ({ getBytes: () => [1], getContentType: () => 'image/jpeg' }) }; } },
  Session: { getActiveUser: () => ({ getEmail: () => 'me@x' }), getScriptTimeZone: () => 'Africa/Cairo' },
  Utilities: { getUuid: () => 'uuid-' + Math.random().toString(36).slice(2), formatDate: (d, tz, f) => f === 'u' ? String(ctx.__day || 1) : f === 'H' ? String(ctx.__hour || 11) : f === 'yyyyMMdd-HHmm' ? '20261118-1000' : f === 'yyyy-MM-dd' ? (ctx.__today || '2026-11-15') : f === 'HH:mm' ? (ctx.__hm || '11:00') : '20261115', newBlob: (bytes, type, name) => ({ type, name }), base64Decode: () => [], base64Encode: b => Array.isArray(b) && b.length > 4 ? Buffer.from(b).toString('base64') : 'AA==',
    computeDigest: (alg, s) => Array.from(require('crypto').createHash('sha256').update(String(s)).digest()), DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, sleep: ms => { ctx.__slept = (ctx.__slept || 0) + ms; } },
  LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
  ScriptApp: { getProjectTriggers: () => (ctx.__triggers || []).map(h => ({ getHandlerFunction: () => h })), deleteTrigger(t) { ctx.__triggers = (ctx.__triggers || []).filter(h => h !== t.getHandlerFunction()); },
    newTrigger: h => { const tb = { create() { ctx.__triggers = (ctx.__triggers || []).concat([h]); } }; ['everyHours', 'everyMinutes', 'atHour', 'everyDays', 'after'].forEach(m => { tb[m] = () => tb; }); return { timeBased: () => tb }; } },
  Logger: { log: (...a) => console.log('   LOG', ...a) },
  HtmlService: {}
};
vm.createContext(ctx); vm.runInContext(code, ctx);
const clearTok = () => Object.keys(ctx.__cache || {}).filter(k => /^(tok|shopify_token)/.test(k)).forEach(k => delete ctx.__cache[k]);
const post = b => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(b) } }).getContent());
const PH = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';   // a shipment photo
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
r = post({ action: 'processReturn', key: 'kkk', orderId: 'gid://Order/1', orderName: '#1001', restock: true, reason: 'DEFECTIVE', shipment: '2222222222', photo: PH, items: [{ fliId: 'FLI1', qty: 1, locationId: 'L1' }] });
check('Returns: create + restock', r, r.ok && r.returnName === '#1001-R1' && fetches.some(f => f.q.includes('reverseFulfillmentOrderDispose')));
check('Returns: the return shipment photo is saved as a return photo (not followed in Tracking)', sheets.Shipments && sheets.Shipments.rows.at(-1),
  r.photo === true && sheets.Shipments.rows.at(-1)[6] === 'Bosta return' && String(sheets.Shipments.rows.at(-1)[1]) === '2222222222' && !(sheets.Tracking && sheets.Tracking.rows.some(x => String(x[0]) === '2222222222' && x[2] > 0 && false)));
r = post({ action: 'processReturn', key: 'kkk', orderId: 'gid://Order/1', restock: true, reason: 'DEFECTIVE', photo: PH, items: [{ fliId: 'FLI1', qty: 1, locationId: 'L1' }] });
check('Returns: refused without the return shipment barcode', r, r.ok === false && /Step 1/.test(r.error));
r = post({ action: 'processReturn', key: 'kkk', orderId: 'gid://Order/1', restock: true, reason: 'DEFECTIVE', shipment: '2222222222', items: [{ fliId: 'FLI1', qty: 1, locationId: 'L1' }] });
check('Returns: refused without the photo', r, r.ok === false && /Step 2/.test(r.error));
r = post({ action: 'processReturn', key: 'kkk', orderId: 'gid://Order/1', restock: false, reason: 'OTHER', shipment: 'RET-77', carrier: 'Customer', photo: PH, items: [{ fliId: 'FLI1', qty: 1, locationId: 'L1' }] });
check('Returns: another carrier (e.g. brought by the customer) kept as typed', sheets.Shipments.rows.at(-1), r.ok && sheets.Shipments.rows.at(-1)[6] === 'Customer return' && String(sheets.Shipments.rows.at(-1)[1]) === 'RET-77');
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
check('Pick list: items carry the expiry date and the previous batch expiry', r.pickList.items.find(i => i.sku === '6723085'),
  r.pickList.items.find(i => i.sku === '6723085').expiry === '2027-05-01' && r.pickList.items.find(i => i.sku === '6723085').expPrev === '2026-12-15' && r.pickList.items.find(i => i.sku === 'TOY').expPrev === '');
const SV = /SERVER_VERSION = '([^']+)'/.exec(code)[1];
check('Every reply says the server version (app warns when it is older)', [r.sv, post({ action: 'x' }).sv, post({ action: 'today', pin: 'bad' }).sv, post({ fn: 'checkPin', args: ['bad'] }).sv],
  [r.sv, post({ action: 'x' }).sv, post({ action: 'today', pin: 'bad' }).sv, post({ fn: 'checkPin', args: ['bad'] }).sv].every(v => v === SV));
check('Pick list: reads back after the text marker', r.ok && r.pickList.items.length, r.ok && r.pickList.items.length === 3);
const bp = ctx.buildPickList_('status:open', 'CREATED_AT');
check('Pick list: tells when the 1000-order limit was not reached', bp.truncated, bp.truncated === false);


// ---- Today summary, logs, Fulfill bins, pick list order status
r = post({ action: 'getOrder', key: 'kkk', query: '1007' });
check('Fulfill: items carry bins and expiry', r.items && r.items[0], r.ok && r.items.find(i => i.title === 'Shelf A-10').binVariant === 'A-10' && r.items[0].expProduct === '2027-01-01');
check('Fulfill: every barcode of a variant is sent (first one first, no repeats)', r.items.find(i => i.title === 'Shelf A-10').barcodes, JSON.stringify(r.items.find(i => i.title === 'Shelf A-10').barcodes) === '["3","6221234567890"]');
ctx.__bcFail = true; const rbf = post({ action: 'getOrder', key: 'kkk', query: '1007' }); ctx.__bcFail = false;
check('Fulfill: barcode list failing -> order still opens with the first barcode', rbf, rbf.ok && JSON.stringify(rbf.items.find(i => i.title === 'Shelf A-10').barcodes) === '["3"]');
check('Fulfill: items sorted by bin (A-2, A-10, B-2, no bin last)', r.items && r.items.map(i => i.title), r.items.map(i => i.title).join() === 'Shelf A-2,Shelf A-10,Shelf B-2,No bin');
r = post({ action: 'fulfill', key: 'kkk', orderName: '#1007', notify: false, tracking: '2222222222', photo: PH, items: [{ foId: 'FO7', foliId: 'L1', qty: 2 }, { foId: 'FO7', foliId: 'L2', qty: 1 }] });
const actRows = (sheets.Activity && sheets.Activity.rows) || [];
const fulRow = actRows.filter(x => x[2] === 'fulfill').at(-1) || [];
check('Activity: fulfill logged with order and units', fulRow, r.ok && fulRow[1] === 'Orders' && fulRow[3] === '#1007' && fulRow[4] === 3);
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
check('Expiry: stock, SKU and bin (variant first, then product list)', r.items, r.items[0].stock === 3 && r.items[0].sku === 'E' && r.items[0].bin === 'A-1' && r.items[2].bin === 'C-1, C-2' && r.items[0].binVariant === 'A-1' && r.items[2].binProduct === 'C-1, C-2' && r.items[2].binVariant === '');
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
check('Today: return photos counted apart (incl. the 2 from Returns above)', r.returnPhotos, r.ok && r.returnPhotos.count === 5 && r.returnPhotos.qty === 6);

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
r = post({ action: 'fulfill', key: 'kkk', orderName: '#1007', notify: true, tracking: '2222222222', photo: PH, items: [{ foId: 'FO7', foliId: 'L1', qty: 1 }] });
check('Fulfill: Bosta tracking saved on the fulfillment', ctx.__ful.trackingInfo, r.ok && r.tracking === '2222222222' && ctx.__ful.trackingInfo.company === 'Bosta'
  && ctx.__ful.trackingInfo.number === '2222222222' && ctx.__ful.trackingInfo.url === 'https://track.example/?n=2222222222' && ctx.__ful.notifyCustomer === true);
check('Fulfill: the waybill is followed by the bulky check (Tracking)', sheets.Tracking.rows.some(x => String(x[0]) === '2222222222'), sheets.Tracking.rows.some(x => String(x[0]) === '2222222222'));
check('Fulfill: tracking in the Activity log', sheets.Activity.rows.filter(x => x[2] === 'fulfill').at(-1), /2222222222/.test(sheets.Activity.rows.filter(x => x[2] === 'fulfill').at(-1)[5]));
delete props.BOSTA_TRACK_URL; ctx.__ful = null;
r = post({ action: 'fulfill', key: 'kkk', orderName: '#1007', notify: false, tracking: '3333333333', photo: PH, items: [{ foId: 'FO7', foliId: 'L1', qty: 1 }] });
check('Fulfill: waybill of another order refused, nothing fulfilled', r, r.ok === false && /for order #1001/.test(r.error) && ctx.__ful === null);
r = post({ action: 'fulfill', key: 'kkk', orderName: '#1007', notify: false, photo: PH, items: [{ foId: 'FO7', foliId: 'L1', qty: 1 }] });
check('Fulfill: refused without the shipment barcode (step 1), nothing fulfilled', r, r.ok === false && /Step 1/.test(r.error) && ctx.__ful === null);
r = post({ action: 'fulfill', key: 'kkk', orderName: '#1007', notify: false, tracking: '2222222222', items: [{ foId: 'FO7', foliId: 'L1', qty: 1 }] });
check('Fulfill: refused without the shipment photo (step 2), not logged as an error', r, r.ok === false && /Step 2/.test(r.error) && ctx.__ful === null && !sheets.Errors.rows.some(x => /Step 2/.test(x[3])));
const shBefore = (sheets.Shipments ? sheets.Shipments.rows.length : 0);
r = post({ action: 'fulfill', key: 'kkk', orderName: '#1007', notify: false, tracking: '2222222222', photo: PH, items: [{ foId: 'FO7', foliId: 'L1', qty: 1 }] });
const phRow = sheets.Shipments.rows.at(-1);
check('Fulfill: the photo is saved with the shipment photos (Drive + Shipments, carrier Bosta, order in the note)', phRow,
  r.ok && r.photo === true && sheets.Shipments.rows.length === shBefore + 1 && String(phRow[1]) === '2222222222' && phRow[4] === 'Order #1007' && phRow[6] === 'Bosta');
ctx.__ful = null;
r = post({ action: 'fulfill', key: 'kkk', orderName: '#1007', notify: false, tracking: 'JD014600003', carrier: 'Aramex', photo: PH, items: [{ foId: 'FO7', foliId: 'L1', qty: 1 }] });
check('Fulfill: another carrier is kept as typed (no Bosta check), photo saved with that carrier, not in Tracking', [ctx.__ful && ctx.__ful.trackingInfo, sheets.Shipments.rows.at(-1)],
  r.ok && ctx.__ful.trackingInfo.company === 'Aramex' && ctx.__ful.trackingInfo.number === 'JD014600003' && sheets.Shipments.rows.at(-1)[6] === 'Aramex' && !sheets.Tracking.rows.some(x => String(x[0]) === 'JD014600003'));

// ---- Bosta tracking on an order that is already fulfilled
r = post({ action: 'getOrder', key: 'kkk', query: '1008' });
check('Fulfilled order: refused without allowDone (unchanged)', r, r.ok === false && /nothing left to fulfill/.test(r.error));
r = post({ action: 'getOrder', key: 'kkk', query: '1008', allowDone: true });
check('Fulfilled order: opens as done with its tracking numbers', r, r.ok && r.done === true && r.items.length === 0 && r.order.name === '#1008' && Array.isArray(r.tracking));
r = post({ action: 'addOrderTracking', key: 'kkk', orderName: '#1008', photo: PH, tracking: '8888888888', notify: true });
check('Fulfilled order: Bosta number added to the newest live shipment', ctx.__trkUpd, r.ok && ctx.__trkUpd.id === 'FUL1' && ctx.__trkUpd.t.company === 'Bosta' && ctx.__trkUpd.t.number === '8888888888' && ctx.__trkUpd.n === true);
check('Fulfilled order: logged, photo saved and followed by the bulky check', sheets.Activity.rows.slice(-2), sheets.Activity.rows.slice(-2).map(x => x[2]).join() === 'tracking,photo' && sheets.Tracking.rows.some(x => String(x[0]) === '8888888888' && x[2] >= 1));
r = post({ action: 'addOrderTracking', key: 'kkk', orderName: '#1008', tracking: '8888888888' });
check('Fulfilled order: refused without the photo', r, r.ok === false && /Step 2/.test(r.error));
r = post({ action: 'addOrderTracking', key: 'kkk', orderName: '#1008', photo: PH, tracking: '8888888888' });
check('Fulfilled order: same number again -> already there, nothing sent', r, r.ok && r.already === true);
ctx.__trkUpd = null;
r = post({ action: 'addOrderTracking', key: 'kkk', orderName: '#1008', photo: PH, tracking: '8888888889' });
check('Fulfilled order: a second number is added next to the first (never replaced)', ctx.__trkUpd && ctx.__trkUpd.t, r.ok && ctx.__trkUpd.t.numbers.join() === '8888888888,8888888889');
r = post({ action: 'addOrderTracking', key: 'kkk', orderName: '#1008', photo: PH, tracking: '3333333333' });
check('Fulfilled order: waybill of another order refused', r, r.ok === false && /for order #1001/.test(r.error));
r = post({ action: 'addOrderTracking', key: 'kkk', orderName: '#1008', photo: PH, tracking: '1111111111' });
check('Fulfilled order: number not in Bosta refused', r, r.ok === false && /not a Bosta waybill/.test(r.error));

// ---- purchase orders removed from the app (hidden; Shopify has no delete)
r = post({ action: 'listPOs', key: 'kkk' });
check('PO list: nothing hidden at first', r.orders.map(o => o.hidden), r.ok && r.orders.every(o => o.hidden === false));
r = post({ action: 'setPOHidden', key: 'kkk', id: 'gid://shopify/InventoryPurchaseOrder/PO1', name: 'PO-1003', hidden: true });
check('PO: a bad id is refused', r, r.ok === false);
r = post({ action: 'setPOHidden', key: 'kkk', id: 'gid://shopify/InventoryPurchaseOrder/77', name: 'PO-77', hidden: true });
post({ action: 'setPOHidden', key: 'kkk', id: 'gid://shopify/InventoryPurchaseOrder/77', name: 'PO-77', hidden: true });
check('PO: removed (hidden) once, even when tapped twice', sheets.HiddenPOs.rows, r.ok && r.hidden === true && sheets.HiddenPOs.getLastRow() === 2 && sheets.HiddenPOs.rows[1][1] === 'PO-77');
r = post({ action: 'setPOHidden', key: 'kkk', id: 'gid://shopify/InventoryPurchaseOrder/77', name: 'PO-77', hidden: false });
check('PO: shown again', sheets.HiddenPOs.getLastRow(), r.ok && r.hidden === false && sheets.HiddenPOs.getLastRow() === 1);
check('PO: remove / show logged', sheets.Activity.rows.slice(-3).map(x => x[2]).join(), sheets.Activity.rows.slice(-3).map(x => x[2]).join() === 'remove PO,remove PO,show PO');
sheets.HiddenPOs.rows.push(['PO1', 'PO-1003', new Date()]);
r = post({ action: 'listPOs', key: 'kkk' });
check('PO list: a hidden PO is marked hidden (the app leaves it out)', r.orders.map(o => o.name + ':' + o.hidden), r.ok && r.orders.find(o => o.id === 'PO1').hidden === true && r.orders.filter(o => o.hidden).length === 1);
sheets.HiddenPOs.rows.length = 1;

// ---- bin locations editable from Receive (Purchase orders) only, and every edit logged in "Edits"
ctx.__meta = { vBin: { value: 'A-12', type: 'single_line_text_field' }, pBin: { value: '["B-3"]', type: 'list.single_line_text_field' }, pExp: { value: '2027-01-01', type: 'date' } };
const editsBefore = sheets.Edits ? sheets.Edits.getLastRow() : 1;
r = post({ action: 'setItemMeta', key: 'kkk', variantId: 'V1', where: 'check', title: 'Kitten 2kg', sku: 'RC2', values: { binVariant: 'Z-1', expProduct: '2027-02-02' } });
check('Edit from Check: expiry saved, bin ignored', ctx.__meta, r.ok && r.changed === 1 && ctx.__meta.vBin.value === 'A-12' && ctx.__meta.pExp.value === '2027-02-02');
r = post({ action: 'setItemMeta', key: 'kkk', variantId: 'V1', where: 'receive', po: 'PO-1003', title: 'Kitten 2kg', sku: 'RC2', values: { binVariant: 'C-7', binProduct: 'B-3, B-9', expProduct: '2027-02-02' } });
check('Edit from Purchase orders: variant and product bins saved (list kept as a list)', ctx.__meta, r.ok && r.changed === 2 && ctx.__meta.vBin.value === 'C-7' && ctx.__meta.pBin.value === JSON.stringify(['B-3', 'B-9']));
const ed = sheets.Edits.rows.slice(editsBefore);
check('Edits log: one row per changed value, with where, product, SKU, old and new', ed.map(x => x.slice(1).join('|')),
  ed.length === 3 && ed[0].join('|').includes('Check|Kitten 2kg|RC2|Expiry date|2027-01-01|2027-02-02')
  && ed[1].slice(1).join('|') === 'Purchase orders PO-1003|Kitten 2kg|RC2|Variant bin|A-12|C-7' && ed[2].slice(4).join('|') === 'Product bin|B-3|B-3, B-9');
r = post({ action: 'setItemMeta', key: 'kkk', variantId: 'V1', where: 'receive', title: 'Kitten 2kg', values: { binVariant: 'C-7' } });
check('Edits log: nothing logged when nothing changed', sheets.Edits.getLastRow() - editsBefore, r.ok && r.changed === 0 && sheets.Edits.getLastRow() === editsBefore + 3);
r = post({ action: 'setItemMeta', key: 'kkk', variantId: 'V1', where: 'receive', title: 'Kitten 2kg', values: { expProduct: 'soon' } });
check('Edits log: a refused value is not logged', sheets.Edits.getLastRow() - editsBefore, r.ok === false && sheets.Edits.getLastRow() === editsBefore + 3);

// ---- expiry date of the previous batch (product metafield custom.expiry_date_of_previous_batch)
const eb = sheets.Edits.getLastRow();
r = post({ action: 'setItemMeta', key: 'kkk', variantId: 'V1', where: 'check', title: 'Kitten 2kg', sku: 'RC2', values: { expPrevProduct: '2026-12-15' } });
check('Previous batch expiry: saved as a date on the product (from Check too)', ctx.__sets, r.ok && r.changed === 1 && r.values.expPrevProduct === '2026-12-15'
  && ctx.__sets.some(m => m.ownerId === 'P1' && m.namespace === 'custom' && m.key === 'expiry_date_of_previous_batch' && m.type === 'date' && m.value === '2026-12-15'));
check('Previous batch expiry: logged in Edits', sheets.Edits.rows[eb], sheets.Edits.getLastRow() === eb + 1 && sheets.Edits.rows[eb].slice(4).join('|') === 'Expiry date of previous batch||2026-12-15');
r = post({ action: 'setItemMeta', key: 'kkk', variantId: 'V1', where: 'receive', values: { expPrevProduct: 'last month' } });
check('Previous batch expiry: must be a date', r, r.ok === false && /Expiry date of previous batch must be a date/.test(r.error));
r = post({ action: 'setItemMeta', key: 'kkk', variantId: 'V1', where: 'receive', title: 'Kitten 2kg', values: { expPrevProduct: '' } });
check('Previous batch expiry: emptied = removed', ctx.__dels, r.ok && r.values.expPrevProduct === '' && ctx.__dels.some(m => m.key === 'expiry_date_of_previous_batch'));
r = post({ action: 'getOrder', key: 'kkk', query: '1007' });
check('Fulfill / Receive / Check items carry expPrevProduct', r.items && Object.keys(r.items[0]), r.ok && 'expPrevProduct' in r.items[0]);

// ---- Telegram group notifications
ctx.__tg = [];
post({ action: 'createPickList', key: 'kkk' });
check('Telegram: nothing sent without a token / chat id', ctx.__tg.length, ctx.__tg.length === 0);
props.TELEGRAM_BOT_TOKEN = '123:abc';
ctx.telegramFindChat();
check('Telegram: telegramFindChat saves the only group and sends a test', props.TELEGRAM_CHAT_ID, props.TELEGRAM_CHAT_ID === '-100777' && ctx.__tg.length === 1 && /bot123:abc\/sendMessage/.test(ctx.__tg[0].url));
ctx.__tg = []; sheets.PickLists.rows.length = 1; if (sheets.PickListsDone) sheets.PickListsDone.rows.length = 1;
r = post({ action: 'createPickList', key: 'kkk' });
check('Telegram: new pick list -> message with orders and products', ctx.__tg.map(x => x.body.text), r.created && ctx.__tg.length === 1 && ctx.__tg[0].body.chat_id === '-100777' && /قائمة تجميع جديدة \(يدوية\)/.test(ctx.__tg[0].body.text) && /طلب · \d+ منتج/.test(ctx.__tg[0].body.text));
ctx.__tg = []; ctx.__cache && Object.keys(ctx.__cache).filter(k => /^tg_err_/.test(k)).forEach(k => delete ctx.__cache[k]);
post({ action: 'receivePO', key: 'kkk', items: [] }); post({ action: 'receivePO', key: 'kkk', items: [] });
check('Telegram: an error -> one message, the same error again within 30 min -> none', ctx.__tg.map(x => x.body.text), ctx.__tg.length === 1 && /خطأ في التطبيق[\s\S]*Orders \/ receivePO/.test(ctx.__tg[0].body.text));
ctx.__tg = []; post({ action: 'listOrders', key: 'wrong' });
check('Telegram: a wrong pass is not reported', ctx.__tg.length, ctx.__tg.length === 0);
ctx.__tg = []; props.TELEGRAM_OFF = 'picklist, errors'; sheets.PickLists.rows.length = 1;
post({ action: 'createPickList', key: 'kkk' });
check('Telegram: TELEGRAM_OFF silences chosen kinds', ctx.__tg.length, ctx.__tg.length === 0);
delete props.TELEGRAM_OFF; ctx.__tg = [];
check('Telegram: daily report sent', ctx.dailyTelegramReport(), ctx.__tg.length === 1 && /ملخص اليوم/.test(ctx.__tg[0].body.text) && /طلبات تم تجهيزها/.test(ctx.__tg[0].body.text));
check('Telegram: daily report lists stock expired or expiring within 7 days', ctx.__tg[0].body.text, /منتهي الصلاحية وموجود بالمخزون: 1[\s\S]*Expired/.test(ctx.__tg[0].body.text));
ctx.__tg = []; props.TELEGRAM_CHAT_ID = '-1'; const realF = ctx.UrlFetchApp.fetch;
ctx.UrlFetchApp.fetch = (url, o) => url.includes('api.telegram.org') ? { getResponseCode: () => 403, getContentText: () => '{"ok":false,"description":"bot was kicked"}' } : realF(url, o);
check('Telegram: a refused message does not break the action', post({ action: 'createPickList', key: 'kkk' }).ok, true);
ctx.UrlFetchApp.fetch = realF; delete props.TELEGRAM_BOT_TOKEN; delete props.TELEGRAM_CHAT_ID;

// ---- POS store name in any form; a web page from Shopify gives a clear error
for (const shop of ['pf', 'pf.myshopify.com', 'https://pf.myshopify.com/admin', ' PF.myshopify.com ']) {
  props.SHOP = shop; clearTok(); fetches.length = 0;
  r = post({ action: 'search', pin: '1111', q: 'food' });
  check('POS: SHOP "' + shop + '" -> the right store', fetches.map(f => f.url), r.ok && fetches.every(f => /^https:\/\/(pf|PF)\.myshopify\.com\/admin\//.test(f.url)));
}
props.SHOP = 'pf';
const realF2 = ctx.UrlFetchApp.fetch;
ctx.UrlFetchApp.fetch = (url, o) => /\/admin\/api\/.*graphql/.test(url) && url.startsWith('https://pf.') ? { getResponseCode: () => 404, getContentText: () => '<!DOCTYPE html><html>Not found</html>' } : realF2(url, o);
r = post({ action: 'search', pin: '1111', q: '6723085' });
check('POS: Shopify web page -> clear message (no "Unexpected token")', r.error, r.ok === false && /answered HTTP 404 with a web page/.test(r.error) && /SHOP \(pf\.myshopify\.com\)/.test(r.error) && !/Unexpected token/.test(r.error));
const posLogin = (url, o) => /oauth\/access_token/.test(url) && /client_id=c\b|"client_id":"c"/.test(JSON.stringify(o.payload)) ? { getResponseCode: () => 400, getContentText: () => '<!DOCTYPE html><html>Oauth error invalid_request</html>' } : realF2(url, o);
ctx.UrlFetchApp.fetch = posLogin; clearTok(); ['pos_use_orders_app', 'pos_fallback_noted'].forEach(k => ctx.__cache && delete ctx.__cache[k]);
const errB = sheets.Errors.getLastRow(); fetches.length = 0;
r = post({ action: 'search', pin: '1111', q: 'food' });
check('POS: its own login refused -> uses the Orders app login, the search works', r, r.ok === true && Array.isArray(r.data));
check('POS: one Errors line says the POS app login is refused', sheets.Errors.rows.slice(errB).map(x => x[3]), sheets.Errors.getLastRow() === errB + 1 && /POS app login refused, the POS uses the Orders app login/.test(sheets.Errors.rows[errB][3]));
r = post({ action: 'search', pin: '1111', q: 'food' });
check('POS: next searches use the Orders app straight away, no new Errors line', sheets.Errors.getLastRow() - errB, r.ok && sheets.Errors.getLastRow() === errB + 1);
clearTok(); ['pos_use_orders_app', 'pos_fallback_noted'].forEach(k => delete ctx.__cache[k]);
const keepStore = props.SHOPIFY_STORE; props.SHOPIFY_STORE = 'other-store';
r = post({ action: 'search', pin: '1111', q: 'x' });
check('POS: login refused and no Orders app for this store -> clear error', r.error, r.ok === false && /POS login\) answered HTTP 400 with a web page/.test(r.error));
props.SHOPIFY_STORE = keepStore;
ctx.UrlFetchApp.fetch = realF2; clearTok(); ['pos_use_orders_app', 'pos_fallback_noted'].forEach(k => ctx.__cache && delete ctx.__cache[k]);

// ---- Shopify logins set from the sheet menu (checked first) and watched for changes
const realF3 = ctx.UrlFetchApp.fetch;
ctx.UrlFetchApp.fetch = (url, o) => /oauth\/access_token/.test(url) && o && o.payload && o.payload.client_secret === 'WRONG' ? { getResponseCode: () => 400, getContentText: () => '<!DOCTYPE html>oauth error' } : realF3(url, o);
const secretBefore = props.CLIENT_SECRET;
r = ctx.setShopifyLogin_('pos', 'c', 'WRONG');
check('Login menu: a secret Shopify refuses is NOT saved', r, r.ok === false && /refused/.test(r.error) && props.CLIENT_SECRET === secretBefore);
r = ctx.setShopifyLogin_('pos', '', 'NEW-SECRET');
check('Login menu: an accepted secret is saved (empty Client ID keeps the current one)', [props.CLIENT_ID, props.CLIENT_SECRET], r.ok && props.CLIENT_SECRET === 'NEW-SECRET' && props.CLIENT_ID === 'c' && !ctx.__cache.pos_use_orders_app);
check('Login menu: the save is noted in Activity, not as an error', sheets.Activity.rows.at(-1).slice(1, 4), sheets.Activity.rows.at(-1)[2] === 'login saved' && /CLIENT_SECRET changed/.test(sheets.Activity.rows.at(-1)[3]));
check('Secret watch: stores fingerprints, never the secret', props.SECRET_WATCH, !/NEW-SECRET|kkk|1111/.test(props.SECRET_WATCH) && JSON.parse(props.SECRET_WATCH).CLIENT_SECRET.length >= 1);
ctx.UrlFetchApp.fetch = realF3;
let eb2 = sheets.Errors.getLastRow();
props.CLIENT_SECRET = secretBefore; ctx.watchSecrets_();
check('Secret watch: going back to an older value is reported', sheets.Errors.rows[eb2] && sheets.Errors.rows[eb2][3], sheets.Errors.getLastRow() === eb2 + 1 && /CLIENT_SECRET went BACK to an older value/.test(sheets.Errors.rows[eb2][3]) && !/NEW-SECRET/.test(sheets.Errors.rows[eb2][3]));
eb2 = sheets.Errors.getLastRow(); ctx.watchSecrets_();
check('Secret watch: nothing new when nothing changed', sheets.Errors.getLastRow() - eb2, sheets.Errors.getLastRow() === eb2);
props.APP_KEY = 'kkk2'; ctx.watchSecrets_();
const lastErr = () => sheets.Errors.rows[sheets.Errors.getLastRow() - 1][3];
check('Secret watch: any watched pass that changes is reported', lastErr(), /APP_KEY changed/.test(lastErr()) && !/kkk2/.test(lastErr()));
props.APP_KEY = 'kkk'; ctx.watchSecrets_();

// ---- a changed secret never reuses the token made from the old one
clearTok(); props.CLIENT_SECRET = 'SECRET-A';
let tokFetches = () => fetches.filter(f => /oauth\/access_token/.test(f.url)).length;
fetches.length = 0; post({ action: 'search', pin: '1111', q: 'a' }); post({ action: 'search', pin: '1111', q: 'b' });
check('Token: fetched once, then reused while the secret is the same', tokFetches(), tokFetches() === 1);
props.CLIENT_SECRET = 'SECRET-B'; fetches.length = 0; post({ action: 'search', pin: '1111', q: 'c' });
check('Token: secret changed in Script Properties -> a new token at once', tokFetches(), tokFetches() === 1);
props.SHOPIFY_CLIENT_SECRET = 'os2'; fetches.length = 0; post({ action: 'listOrders', key: 'kkk' });
check('Token: Orders secret changed -> a new Orders token at once', tokFetches(), tokFetches() === 1);
props.SHOPIFY_CLIENT_SECRET = 'os'; props.CLIENT_SECRET = 's'; clearTok();

// ---- after the POS secret is fixed, the POS goes back to its own login at once
const realF4 = ctx.UrlFetchApp.fetch;
ctx.UrlFetchApp.fetch = (url, o) => /oauth\/access_token/.test(url) && o && o.payload && o.payload.client_secret === 'BAD' ? { getResponseCode: () => 400, getContentText: () => '<!DOCTYPE html>' } : realF4(url, o);
clearTok(); ['pos_use_orders_app', 'pos_fallback_noted'].forEach(k => delete ctx.__cache[k]);
props.CLIENT_SECRET = 'BAD'; post({ action: 'search', pin: '1111', q: 'a' });
check('POS fallback: refused secret -> Orders app login', !!ctx.__cache.pos_use_orders_app, !!ctx.__cache.pos_use_orders_app);
props.CLIENT_SECRET = 'GOOD'; fetches.length = 0; post({ action: 'search', pin: '1111', q: 'b' });
check('POS fallback: secret fixed -> its own login straight away (no 1-hour wait)', fetches.filter(f => /oauth/.test(f.url)).length, fetches.some(f => /oauth\/access_token/.test(f.url)) && !!ctx.__cache[ctx.tokKey_('pos')]);
ctx.UrlFetchApp.fetch = realF4; props.CLIENT_SECRET = 's'; clearTok(); ['pos_use_orders_app', 'pos_fallback_noted'].forEach(k => delete ctx.__cache[k]);

// ---- label PDFs saved to Google Drive
delete props.LABELS_FOLDER_ID; ctx.__folders = []; ctx.__files = [];
r = post({ action: 'saveLabels', key: 'kkk', pdf: 'JVBERi0xLjMK', name: 'Labels PO-1003 2026-11-23 14-05 (6).pdf', count: 6, where: 'receive' });
check('Labels: PDF saved in the "PetFriend Labels" Drive folder, link returned', [r, ctx.__folders, ctx.__files], r.ok && r.url === 'https://drive/file1' && ctx.__folders[0] === 'PetFriend Labels' && props.LABELS_FOLDER_ID === 'F'
  && ctx.__files[0].type === 'application/pdf' && ctx.__files[0].name === 'Labels PO-1003 2026-11-23 14-05 (6).pdf');
r = post({ action: 'saveLabels', key: 'kkk', pdf: 'JVBERi0xLjMK', name: 'x', count: 1 });
check('Labels: the folder is made once, then reused', ctx.__folders, ctx.__folders.length === 1 && r.name === 'x.pdf');
r = post({ action: 'saveLabels', key: 'kkk', pdf: 'PGh0bWw+', name: 'x.pdf' }); check('Labels: only a PDF is accepted', r, r.ok === false && /Not a PDF/.test(r.error));
r = post({ action: 'saveLabels', key: 'kkk', pdf: 'JVBERi0xLjMK', name: '../../evil<>.pdf' }); check('Labels: file name cleaned', r.name, r.ok && !/[\/<>]/.test(r.name));
check('Labels: logged', sheets.Activity.rows.filter(x => x[1] === 'Labels').length, sheets.Activity.rows.filter(x => x[1] === 'Labels').length >= 3);
r = post({ action: 'saveLabels', key: 'bad', pdf: 'JVBERi0xLjMK' }); check('Labels: wrong key refused', r, r.ok === false);

console.log('\n--- testAll() output:'); ctx.testAll();
// access denied once (stale token) -> fresh token + retry
let denied = 1; const orig = ctx.UrlFetchApp.fetch;
ctx.UrlFetchApp.fetch = (url, o) => { if (denied && url.includes('/graphql.json') && /returnableFulfillments/.test((o && o.payload) || '')) { denied--; return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ errors: [{ message: 'Access denied for returnableFulfillments field.' }] }) }; } return orig(url, o); };
ctx.__cache[ctx.tokKey_('orders')] = 'old';
r = post({ action: 'getReturnable', key: 'kkk', query: '14211' }); check('Access denied -> fresh token + retry', r, r.ok && ctx.__cache[ctx.tokKey_('orders')] !== 'old');
ctx.UrlFetchApp.fetch = (url, o) => (url.includes('/graphql.json') && /returnableFulfillments/.test((o && o.payload) || '')) ? { getResponseCode: () => 200, getContentText: () => JSON.stringify({ errors: [{ message: 'Access denied for returnableFulfillments field.' }] }) } : orig(url, o);
r = post({ action: 'getReturnable', key: 'kkk', query: '14211' }); check('Still denied -> clear error, no endless retry', r, r.ok === false && /Access denied/.test(r.error));
ctx.__cache[ctx.tokKey_('pos')] = 'p'; ctx.__cache[ctx.tokKey_('orders')] = 'o';
ctx.resetTokens(); check('resetTokens clears both', ctx.__cache, !ctx.__cache[ctx.tokKey_('orders')] && !ctx.__cache[ctx.tokKey_('pos')]);

// ---- Tasks: staff, tasks, weekly / monthly tasks, Telegram links and done buttons
{
  const tp = b => post(Object.assign({ tpin: 'boss1' }, b));
  const dm = () => ctx.__tg.filter(x => x.body.chat_id !== '-100777'), grp = () => ctx.__tg.filter(x => x.body.chat_id === '-100777');
  r = tp({ action: 'tasksInit' });
  check('Tasks: no MANAGER_PIN -> clear error', r, r.ok === false && /MANAGER_PIN/.test(r.error));
  props.MANAGER_PIN = 'boss1'; props.TELEGRAM_BOT_TOKEN = '123:abc'; props.TELEGRAM_CHAT_ID = '-100777'; ctx.__tg = [];
  r = post({ action: 'tasksInit', tpin: 'nope' });
  check('Tasks: wrong pass refused, not logged as an error', r, r.ok === false && r.error === 'Wrong Tasks pass' && !((sheets.Errors || { rows: [] }).rows.some(x => /Wrong Tasks pass/.test(x[3]))));
  r = tp({ action: 'staffSave', staff: { name: 'Mona', pin: '1234' } });
  const mona = r.staff;
  check('Tasks: manager adds an employee with a Telegram link', r, r.ok && /^https:\/\/t\.me\/PetFriend002bot\?start=\w{8,}$/.test(mona.link) && !mona.linked);
  check('Tasks: the pass is stored only as a hash', sheets.TaskStaff.rows[1], !sheets.TaskStaff.rows[1].includes('1234') && String(sheets.TaskStaff.rows[1][2]).length > 20);
  r = tp({ action: 'staffSave', staff: { name: 'Ali', pin: '1234' } });
  check('Tasks: two employees cannot share a pass', r, r.ok === false && /Another employee/.test(r.error));
  r = tp({ action: 'staffSave', staff: { name: 'Ali', pin: 'boss1' } });
  check('Tasks: an employee cannot get the manager pass', r, r.ok === false && /manager/.test(r.error));
  const ali = tp({ action: 'staffSave', staff: { name: 'Ali', pin: '5678' } }).staff;
  r = post({ action: 'staffSave', tpin: '1234', staff: { name: 'X', pin: '9999' } });
  check('Tasks: an employee cannot add employees', r, r.ok === false && /Only the manager/.test(r.error));
  r = tp({ action: 'taskSave', task: { title: 'Post 3 reels', employeeId: mona.id, due: '2026-11-15 18:00', notes: 'Royal Canin offer' } });
  check('Tasks: task saved; not sent to the employee before she links Telegram, but the group is told', ctx.__tg.map(x => x.body.text), r.ok && r.sent === false && r.linked === false && dm().length === 0 && grp().length === 1 && /مهمة جديدة — Mona/.test(grp()[0].body.text));
  ctx.__tg = [];
  const t1 = r.id;
  r = tp({ action: 'taskSave', task: { title: 'x', employeeId: mona.id, due: 'tomorrow' } });
  check('Tasks: bad due date refused, not logged or sent to the group', r, r.ok === false && /Due date/.test(r.error) && ctx.__tg.length === 0 && !(sheets.Errors || { rows: [] }).rows.some(x => /Due date/.test(x[3])));
  // Mona opens her link: /start <code>
  const code = mona.link.split('start=')[1];
  ctx.__tgUpdates = [{ update_id: 10, message: { chat: { id: 555, type: 'private' }, from: { id: 555 }, text: '/start ' + code } },
                     { update_id: 11, message: { chat: { id: -100777, type: 'supergroup', title: 'PetFriend staff' }, text: 'hi' } }];
  ctx.tgPoll();
  check('Tasks: /start <code> links the employee and sends her open tasks with done buttons; the group is told', ctx.__tg.map(x => x.body.text),
    sheets.TaskStaff.rows[1][3] === '555' && dm().length === 1 && dm()[0].body.chat_id === '555' && /أهلًا Mona/.test(dm()[0].body.text) && /Post 3 reels/.test(dm()[0].body.text)
    && dm()[0].body.reply_markup.inline_keyboard[0][0].callback_data === 'td:' + t1 && grp().length === 1 && /ربط Mona/.test(grp()[0].body.text));
  check('Tasks: the next poll starts after the last update; groups seen are kept for telegramFindChat', [props.TG_OFFSET, props.TG_SEEN_GROUPS], props.TG_OFFSET === '12' && /PetFriend staff/.test(props.TG_SEEN_GROUPS));
  ctx.__tg = [];
  r = tp({ action: 'taskSave', task: { title: 'Answer comments', employeeId: mona.id, due: '2026-11-15' } });
  const t2 = r.id;
  check('Tasks: a new task goes to the linked employee with a done button and the due date (and to the group)', ctx.__tg.map(x => x.body.text),
    r.sent === true && /مهمة جديدة/.test(dm()[0].body.text) && /الموعد النهائي: اليوم/.test(dm()[0].body.text) && dm()[0].body.reply_markup.inline_keyboard[0][0].callback_data === 'td:' + t2 && grp().length === 1);
  // Ali (not linked) taps nothing; someone else's chat taps Mona's button
  ctx.__tg = [];
  ctx.__tgUpdates = [{ update_id: 12, callback_query: { id: 'cq1', from: { id: 999 }, data: 'td:' + t2, message: { chat: { id: 999 }, message_id: 5, text: 'x' } } }];
  ctx.tgPoll();
  check('Tasks: a chat that is not linked cannot mark tasks done', ctx.__tg.map(x => x.body.text), /غير مرتبط/.test(ctx.__tg[0].body.text) && sheets.Tasks.rows.find(x => x[0] === t2)[5] === 'open');
  ctx.__tg = [];
  ctx.__tgUpdates = [{ update_id: 13, callback_query: { id: 'cq2', from: { id: 555 }, data: 'td:' + t2,
    message: { chat: { id: 555 }, message_id: 6, text: 'مهمة جديدة', reply_markup: { inline_keyboard: [[{ text: '✅ خلصت', callback_data: 'td:' + t2 }]] } } } }];
  ctx.tgPoll();
  const row2 = sheets.Tasks.rows.find(x => x[0] === t2);
  check('Tasks: Mona taps done -> task done (via telegram), button answered, message updated, group told', ctx.__tg.map(x => x.url.split('/').pop() + ':' + (x.body.text || '')),
    row2[5] === 'done' && row2[8] === 'telegram' && ctx.__tg.some(x => /answerCallbackQuery/.test(x.url) && /تم التسجيل/.test(x.body.text))
    && ctx.__tg.some(x => /editMessageText/.test(x.url)) && ctx.__tg.some(x => x.body.chat_id === '-100777' && /أنجز Mona المهمة: Answer comments/.test(x.body.text)));
  r = post({ action: 'tasksInit', tpin: '1234' });
  check('Tasks: employee sees only her own tasks, no staff list', r, r.ok && r.role === 'employee' && r.me === 'Mona' && r.tasks.length === 2 && r.tasks.every(t => t.employeeId === mona.id) && !r.staff);
  r = post({ action: 'taskDone', tpin: '5678', id: t1 });
  check('Tasks: an employee cannot finish someone else\'s task', r, r.ok === false && /not your task/.test(r.error));
  ctx.__hm = '19:00';
  r = tp({ action: 'tasksInit' });
  check('Tasks: manager sees everything; a task past its time is late', r, r.ok && r.role === 'manager' && r.staff.length === 2 && r.staff[0].linked === true && r.tasks.find(t => t.id === t1).late === true);
  ctx.__hm = '11:00';
  // weekly / monthly: 2026-11-15 is a Sunday (7)
  ctx.__tg = [];
  r = tp({ action: 'repeatSave', repeat: { title: 'Weekly report', employeeId: mona.id, freq: 'weekly', day: 7, dueDays: 2 } });
  check('Tasks: a weekly task whose day is today is made at once and sent', [r, ctx.__tg.map(x => x.body.text)],
    r.ok && r.madeToday === 1 && sheets.Tasks.rows.some(x => x[1] === 'Weekly report' && x[4] === '2026-11-17') && /مهمة دورية/.test(dm()[0].body.text));
  tp({ action: 'repeatSave', repeat: { title: 'Monthly stock count', employeeId: ali.id, freq: 'monthly', day: 31, dueDays: 0 } });
  tp({ action: 'repeatSave', repeat: { title: 'Monday meeting', employeeId: ali.id, freq: 'weekly', day: 1 } });
  const before = sheets.Tasks.rows.length;
  ctx.tasksMorning();
  check('Tasks: the morning run does not make a weekly task twice the same day', sheets.Tasks.rows.length, sheets.Tasks.rows.length === before);
  ctx.__today = '2026-11-30'; ctx.__tg = [];
  ctx.tasksMorning();
  const made = sheets.Tasks.rows.slice(before).map(x => x[1]);
  check('Tasks: monthly day 31 -> made on the 30th of November; Monday task made on Monday', made, made.includes('Monthly stock count') && made.includes('Monday meeting') && !made.includes('Weekly report'));
  check('Tasks: morning summary to linked employees with done buttons, and one list of everyone\'s tasks in the group', ctx.__tg.map(x => x.body.chat_id + ':' + x.body.text.slice(0, 20)),
    dm().length === 1 && dm()[0].body.chat_id === '555' && /صباح الخير Mona/.test(dm()[0].body.text) && dm()[0].body.reply_markup.inline_keyboard.length >= 2
    && grp().length === 1 && /مهام اليوم المفتوحة[\s\S]*Mona[\s\S]*Ali/.test(grp()[0].body.text));
  ctx.__today = undefined;
  r = tp({ action: 'staffRelink', id: mona.id });
  check('Tasks: a new link unlinks the old chat', r, r.ok && !r.staff.linked && r.staff.link !== mona.link);
  r = tp({ action: 'taskDelete', id: t1 });
  check('Tasks: deleted task disappears from the lists', tp({ action: 'tasksInit' }).tasks.map(t => t.id), r.ok && !tp({ action: 'tasksInit' }).tasks.some(t => t.id === t1));
  tp({ action: 'staffDelete', id: ali.id });
  r = post({ action: 'tasksInit', tpin: '5678' });
  check('Tasks: a removed employee\'s pass stops working', r, r.ok === false && r.error === 'Wrong Tasks pass');

  // ---- Customer service: cancel / edit requests, inspection (answered in the group), complaints
  ctx.__tg = [];
  r = post({ action: 'reqSave', tpin: '1234', req: { kind: 'cancel', order: '1001', details: 'Customer changed her mind' } });
  check('Requests: cancel request saved with the Shopify order, written by the employee, told in the group', [r, grp().map(x => x.body.text)],
    r.ok && r.item.order === '#1001' && r.item.createdBy === 'Mona' && r.item.status === 'open' && grp().length === 1 && /طلب إلغاء جديد[\s\S]*#1001[\s\S]*Mona/.test(grp()[0].body.text));
  const cq = r.item.id;
  r = post({ action: 'reqSave', tpin: '1234', req: { kind: 'edit', order: '1001', details: '' } });
  check('Requests: a change request needs details', r, r.ok === false && /details/.test(r.error));
  r = post({ action: 'reqSave', tpin: '1234', req: { kind: 'cancel', order: '' } });
  check('Requests: the order number is needed', r, r.ok === false && /order number/.test(r.error));
  ctx.__tg = [];
  r = post({ action: 'reqSave', tpin: '1234', req: { kind: 'complaint', customer: 'Hoda', phone: '010 1234 5678', channel: 'whatsapp', category: 'late', details: 'Arrived 3 days late' } });
  check('Requests: a complaint without an order is fine; category and channel shown in the group', [r.item, grp().map(x => x.body.text)],
    r.ok && r.item.order === '' && r.item.phone === '01012345678' && /شكوى عميل جديدة[\s\S]*تأخر التوصيل · واتساب/.test(grp()[0].body.text));
  const comp = r.item.id;
  ctx.__tg = [];
  r = post({ action: 'reqSave', tpin: '1234', req: { kind: 'inspect', order: '1001', details: 'Customer wants to open the box' } });
  const iq = r.item.id, msg = grp()[0];
  check('Requests: inspection request -> group message with allow / do not allow buttons', msg && msg.body,
    r.ok && r.item.status === 'pending' && /طلب معاينة/.test(msg.body.text) && msg.body.reply_markup.inline_keyboard[0].map(b => b.callback_data).join() === 'ia:' + iq + ',in:' + iq);
  r = post({ action: 'reqStatus', tpin: '1234', id: iq, status: 'allowed' });
  check('Requests: an employee cannot answer an inspection in the app', r, r.ok === false && /Only the manager/.test(r.error));
  ctx.__tg = [];
  ctx.__tgUpdates = [{ update_id: 30, callback_query: { id: 'c9', from: { id: 1, first_name: 'Osama' }, data: 'ia:' + iq, message: { chat: { id: 555 }, message_id: 3, text: 'x' } } }];
  ctx.tgPoll();
  check('Requests: the buttons only work in the store group', ctx.__tg.map(x => x.body.text), /جروب المتجر فقط/.test(ctx.__tg[0].body.text) && sheets.Requests.rows.find(x => x[0] === iq)[8] === 'pending');
  ctx.__tg = [];
  ctx.__tgUpdates = [{ update_id: 31, callback_query: { id: 'c10', from: { id: 1, first_name: 'Osama' }, data: 'ia:' + iq, message: { chat: { id: -100777 }, message_id: 4, text: 'طلب معاينة' } } },
                     { update_id: 32, callback_query: { id: 'c11', from: { id: 2, first_name: 'Ali' }, data: 'in:' + iq, message: { chat: { id: -100777 }, message_id: 4, text: 'طلب معاينة' } } }];
  ctx.tgPoll();
  const irow = sheets.Requests.rows.find(x => x[0] === iq);
  check('Requests: "allow" in the group saves the answer and who gave it; a second answer is refused', ctx.__tg.map(x => x.url.split('/').pop() + ':' + x.body.text),
    irow[8] === 'allowed' && /Osama/.test(irow[12]) && ctx.__tg.some(x => /editMessageText/.test(x.url) && /مسموح بالمعاينة — Osama/.test(x.body.text))
    && ctx.__tg.some(x => /answerCallbackQuery/.test(x.url) && /تم الرد بالفعل/.test(x.body.text)));
  ctx.__tg = [];
  r = post({ action: 'reqStatus', tpin: '1234', id: cq, status: 'done', note: 'Cancelled in Shopify' });
  check('Requests: status change saved and told in the group', [r.item, grp().map(x => x.body.text)], r.ok && r.item.status === 'done' && r.item.updatedBy === 'Mona' && /إلغاء طلب #1001: تم التنفيذ[\s\S]*Cancelled in Shopify/.test(grp()[0].body.text));
  r = post({ action: 'reqStatus', tpin: '1234', id: comp, status: 'done' });
  check('Requests: a status of another kind is refused', r, r.ok === false);

  // ---- Complaint photos
  props.TELEGRAM_BOT_TOKEN = '123:abc'; props.TELEGRAM_CHAT_ID = '-100777';
  ctx.__tg = []; ctx.__files = [];
  r = post({ action: 'reqSave', tpin: '1234', req: { kind: 'complaint', customer: 'Nour', channel: 'whatsapp', category: 'damaged', details: 'Bag torn', photos: [PH, PH] } });
  const cph = r.item;
  check('Complaint photos: saved in Drive with the complaint, count shown, sent to the group as an album', [r.item && r.item.photos, ctx.__files.length, ctx.__tg.map(x => x.url.split('/').pop())],
    r.ok && r.item.photos === 2 && ctx.__files.length === 2 && /Complaint_Nour/.test(ctx.__files[0].name) && ctx.__tg.some(x => /sendMediaGroup/.test(x.url) && JSON.parse(x.body.media).length === 2)
    && ctx.__tg.some(x => /sendMessage/.test(x.url) && /📷 2 صورة/.test(x.body.text)));
  r = post({ action: 'reqSave', tpin: '1234', req: { kind: 'complaint', customer: 'Nour', details: 'x', photos: [PH, PH, PH, PH, PH, PH] } });
  check('Complaint photos: at most 5 at a time', r, r.ok === false && /At most 5/.test(r.error));
  r = post({ action: 'reqSave', tpin: '1234', req: { kind: 'complaint', customer: 'Nour', details: 'x', photos: ['data:text/html;base64,AAA'] } });
  check('Complaint photos: only pictures', r, r.ok === false && /Not a photo/.test(r.error));
  ctx.__tg = [];
  r = post({ action: 'reqAddPhotos', tpin: '1234', id: cph.id, photos: [PH] });
  check('Complaint photos: more can be added later (one photo -> sendPhoto)', [r.item && r.item.photos, ctx.__tg.map(x => x.url.split('/').pop())],
    r.ok && r.item.photos === 3 && ctx.__tg.some(x => /sendPhoto/.test(x.url) && /صور مضافة إلى شكوى Nour/.test(x.body.caption)));
  r = post({ action: 'reqAddPhotos', tpin: '1234', id: cq, photos: [PH] });
  check('Complaint photos: not for other kinds of requests', r, r.ok === false && /complaints, returns and exchanges only/.test(r.error));
  r = post({ action: 'reqPhotos', tpin: '1234', id: cph.id });
  check('Complaint photos: thumbnails read through the server, with a Drive link', r.photos, r.ok && r.photos.length === 3 && /^data:image\/png;base64,/.test(r.photos[0].thumb) && /^https:\/\/drive\//.test(r.photos[0].url));
  r = post({ action: 'reqInit', tpin: '1234' });
  check('Complaint photos: the list shows the photo count', r.items.find(x => x.id === cph.id).photos, r.items.find(x => x.id === cph.id).photos === 3);

  // ---- Return and exchange requests
  ctx.__tg = []; ctx.__files = [];
  r = post({ action: 'reqSave', tpin: '1234', req: { kind: 'ret', order: '1001', details: 'Wrong size', photos: [PH] } });
  check('Return request: saved for the Shopify order, with its photo, told in the group', [r.item, ctx.__tg.map(x => x.url.split('/').pop() + ':' + (x.body.text || x.body.caption || ''))],
    r.ok && r.item.kind === 'ret' && r.item.order === '#1001' && r.item.status === 'pending' && r.item.photos === 1 && ctx.__tg.some(x => /طلب إرجاع جديد — يُرجى الموافقة/.test(x.body.text || ''))
    && ctx.__tg.some(x => /sendPhoto/.test(x.url) && /طلب إرجاع/.test(x.body.caption)));
  const apMsg = ctx.__tg.find(x => /يُرجى الموافقة/.test(x.body.text || ''));
  check('Return request: the group gets 3 buttons (free / customer pays / refuse)', apMsg && apMsg.body.reply_markup,
    apMsg && JSON.stringify(apMsg.body.reply_markup.inline_keyboard.flat().map(b => b.callback_data.split(':')[0])) === '["rf","rp","rr"]');
  const retId = r.item.id;
  r = post({ action: 'reqSave', tpin: '1234', req: { kind: 'exchange', order: '1001', details: '' } });
  check('Exchange request: needs the details (what to exchange)', r, r.ok === false && /details/.test(r.error));
  r = post({ action: 'reqSave', tpin: '1234', req: { kind: 'exchange', order: '1001', details: '2kg instead of 4kg' } });
  check('Exchange request: saved', r, r.ok && r.item.kind === 'exchange' && r.item.photos === 0);
  r = post({ action: 'reqStatus', tpin: '1234', id: retId, status: 'done' });
  check('Return request: cannot be carried out before it is approved', r, r.ok === false && /Approve it first/.test(r.error));
  r = post({ action: 'reqStatus', tpin: '1234', id: retId, status: 'free' });
  check('Return request: an employee cannot approve it', r, r.ok === false && /Only the manager/.test(r.error));
  r = post({ action: 'reqInit', tpin: '1234' });
  check('Return request: listed as waiting for approval', r.items.find(x => x.id === retId).status, r.items.find(x => x.id === retId).status === 'pending');
  ctx.__tg = [];
  ctx.__tgUpdates = [{ update_id: 60, callback_query: { id: 'c60', from: { id: 1, first_name: 'Osama' }, data: 'rp:' + retId, message: { chat: { id: -100777 }, message_id: 9, text: 'طلب إرجاع' } } }];
  ctx.tgPoll();
  const retRow = sheets.Requests.rows.find(x => x[0] === retId);
  check('Return request: approved in the group "customer pays", with the name; message updated', [retRow[8], retRow[12], ctx.__tg.map(x => x.url.split('/').pop() + ':' + x.body.text)],
    retRow[8] === 'paid' && /Osama/.test(retRow[12]) && ctx.__tg.some(x => /editMessageText/.test(x.url) && /موافَق عليه — على حساب العميل — Osama/.test(x.body.text)));
  ctx.__tg = [];
  r = post({ action: 'reqStatus', tpin: '1234', id: retId, status: 'done', note: 'Return created in Shopify' });
  check('Return request: then carried out by the employee, told in the group', ctx.__tg.map(x => x.body.text), r.ok && ctx.__tg.some(x => /إرجاع #1001: تم التنفيذ/.test(x.body.text)));
  r = post({ action: 'reqSave', tpin: '1234', req: { kind: 'exchange', order: '1001', details: 'Blue instead of red' } });
  const exId = r.item.id;
  r = tp({ action: 'reqStatus', id: exId, status: 'free', note: 'Our mistake' });
  check('Exchange request: the manager approves it in the app as free', r, r.ok && r.item.status === 'free' && r.item.note === 'Our mistake');
  r = post({ action: 'reqSave', tpin: '1234', req: { kind: 'cancel', order: '1001', photos: [PH] } });
  check('Cancel request: photos are not kept (not a photo kind)', r, r.ok && r.item.photos === 0);
  r = tp({ action: 'reqInit' });
  check('Requests: the list shows every entry, newest first', r.items.map(x => x.kind + ':' + x.status), r.ok && r.items.length === 8 && r.items[0].kind === 'cancel' && r.items[1].kind === 'exchange');

  // ---- Monthly evaluation (social media): the owner's sheet, Aya's numbers
  r = post({ action: 'evalInit', tpin: '1234' });
  check('Evaluation: hidden from employees who do not fill it', r, r.ok && r.allowed === false);
  r = post({ action: 'evalConfig', tpin: '1234', config: { employeeId: mona.id, day: 23, pass: 66 } });
  check('Evaluation: only the manager sets it up', r, r.ok === false && /Only the manager/.test(r.error));
  r = tp({ action: 'evalInit' });
  check('Evaluation: default items from the owner\'s sheet (targets + sanction limits)', r.config.items.map(i => i.key + ':' + i.target + '/' + i.sanction).join(),
    r.config.items.map(i => i.key + ':' + i.target + '/' + i.sanction).join() === 'conv:70/0,posts:8/3,stories:8/3,rate:96.4/95,time:90/100,follows:100/0' && r.config.pass === 66);
  r = tp({ action: 'evalConfig', config: { employeeId: mona.id, day: 23, pass: 66, items: r.config.items.map(i => ({ key: i.key, target: String(i.target), sanction: i.sanction })) } });
  check('Evaluation: manager chooses who fills it', r, r.ok && r.config.employeeId === mona.id);
  // day 23: the reminder task
  ctx.__today = '2026-11-23'; ctx.__tg = [];
  ctx.tasksMorning();
  const evTask = sheets.Tasks.rows.find(x => x[9] === 'EVAL-2026-11');
  check('Evaluation: on day 23 a task is made for her and announced (she re-linked earlier, so only the group gets it now)', [evTask && evTask[1], ctx.__tg.map(x => x.body.text.slice(0, 40))], evTask && evTask[5] === 'open' && grp().some(x => /موعد التقييم الشهري — Mona/.test(x.body.text)));
  ctx.tasksMorning();
  check('Evaluation: the reminder is made once', sheets.Tasks.rows.filter(x => x[9] === 'EVAL-2026-11').length, sheets.Tasks.rows.filter(x => x[9] === 'EVAL-2026-11').length === 1);
  r = post({ action: 'evalSave', tpin: '1234', month: '2026-11', values: { conv: '58', posts: '4', stories: '4', rate: '95.20%', time: '1 hr 15m' } });
  check('Evaluation: every item must be filled', r, r.ok === false && /every item/.test(r.error));
  r = post({ action: 'evalSave', tpin: '5678', month: '2026-11', values: {} });
  check('Evaluation: another employee cannot fill it', r, r.ok === false);
  ctx.__tg = [];
  r = post({ action: 'evalSave', tpin: '1234', month: '2026-11', values: { conv: '58', posts: '4', stories: '4', rate: '95.20%', time: '1 hr 15m', follows: '48' } });
  const ev = r.evaluation;
  check('Evaluation: Aya\'s month -> 1 hr 15m = 75 min achieved, 95.2% < 96.4% not achieved -> 1 of 6 = 17%, target not met, no sanction',
    ev, r.ok && ev.values.time === 75 && ev.results.map(x => x.achieved ? 1 : 0).join('') === '000010' && ev.pct === 17 && ev.met === false && ev.sanctions.length === 0);
  check('Evaluation: the result goes to the group with every item', grp().map(x => x.body.text), grp().length === 1 && /تقييم السوشيال ميديا — 2026-11/.test(grp()[0].body.text) && /❌ معدل الرد: 95.2% \/ المستهدف 96.4%/.test(grp()[0].body.text) && /✅ زمن الرد: 75 دقيقة/.test(grp()[0].body.text) && /17% — ❌ لم يحقّق المستهدف/.test(grp()[0].body.text));
  check('Evaluation: the reminder task is closed when she submits', sheets.Tasks.rows.find(x => x[9] === 'EVAL-2026-11')[5], sheets.Tasks.rows.find(x => x[9] === 'EVAL-2026-11')[5] === 'done');
  r = post({ action: 'evalSave', tpin: '1234', month: '2026-11', values: { conv: '80', posts: '2', stories: '9', rate: '97', time: '120', follows: '120' } });
  check('Evaluation: a second save of the same month replaces it; 4 of 6 = 67% met; posts < 3 and time > 100 flagged',
    r.evaluation, r.ok && r.evaluation.pct === 67 && r.evaluation.met === true && r.evaluation.sanctions.join() === 'posts,time' && sheets.Evaluations.rows.length === 2);
  r = post({ action: 'evalInit', tpin: '1234' });
  check('Evaluation: she sees this month and her history', r, r.ok && r.allowed && r.current && r.current.pct === 67 && r.history.length === 1);
  ctx.__today = undefined;
  delete props.TELEGRAM_BOT_TOKEN; delete props.TELEGRAM_CHAT_ID; ctx.__tg = [];
}

// ---- Bulky shipments of the last 14 days (Today button / sheet menu): a background job
{
  fetches.length = 0; ctx.__triggers = [];
  let r = post({ action: 'bulkyCheck', key: 'kkk', days: 14 });
  check('Bulky 14 days: the button starts a background job (Google stops a request after 6 minutes)', [r.started, r.job && r.job.state, ctx.__triggers],
    r.ok && r.started && r.job.state === 'running' && ctx.__triggers.includes('bulkyJob'));
  r = post({ action: 'bulkyCheck', key: 'kkk', days: 14 });
  check('Bulky 14 days: a second press while it runs does not start another', r, r.ok && r.already && !r.started);
  ctx.bulkyJob();
  let job = JSON.parse(props.BULKY_JOB);
  const shopQ = fetches.find(f => /fulfillments\(first: 5\)/.test(f.q));
  check('Bulky 14 days: the job brings in numbers from Bosta\'s list, the wallet feed and Shopify (paged), checks them and finishes',
    [job.state, job.sources, job.checked], job.state === 'done' && job.sources.bosta && job.sources.bosta.added === 2 && job.sources.fees && job.sources.shopify && !!shopQ && /after: \$after/.test(shopQ.q) && job.checked > 0
    && sheets.Tracking.rows.some(x => String(x[0]) === '4440000001') && !sheets.Tracking.rows.some(x => String(x[0]) === '4440000009'));
  r = post({ action: 'bulkyList', key: 'kkk', days: 14 });
  check('Bulky 14 days: lists the bulky ones; a shipment Bosta dated 2026-10-01 is left out; its date is saved', [r.count, r.items.map(x => x.tn), r.job && r.job.state],
    r.ok && r.count >= 1 && r.items.every(x => /Bulky/.test(x.size)) && !r.items.some(x => x.tn === '5550000002') && r.job.state === 'done'
    && String((sheets.Bulky.rows.find(x => String(x[0]) === '5550000002') || [])[14]) === '2026-10-01' && sheets.Bulky.rows[0][14] === 'ShipmentDate');
  check('Bulky 14 days: total fees', r.fees, r.fees === r.count * 55);
  r = post({ action: 'bulkyList', key: 'wrong' });
  check('Bulky 14 days: needs the Orders pass', r, r.ok === false);
}

// ---- The long Bosta runs never block other actions
{
  ctx.__cache = ctx.__cache || {}; ctx.__cache.bosta_busy = '1';
  const st = ctx.syncBosta();
  check('Bosta: the hourly check skips while the 14-day job is running (no overlap)', st, st && st.skipped === 'busy');
  delete ctx.__cache.bosta_busy;
  const realLock = ctx.LockService;
  ctx.LockService = { getScriptLock: () => ({ waitLock() { throw new Error('Lock timeout: another process was holding the lock for too long.'); }, tryLock: () => false, releaseLock() {} }) };
  const r = post({ action: 'tasksInit', tpin: 'x' });
  ctx.LockService = realLock;
  props.MANAGER_PIN = 'boss9';
  ctx.LockService = { getScriptLock: () => ({ waitLock() { throw new Error('Lock timeout: another process was holding the lock for too long.'); }, tryLock: () => false, releaseLock() {} }) };
  const r2 = post({ action: 'staffSave', tpin: 'boss9', staff: { name: 'Sara', pin: '7777' } });
  ctx.LockService = realLock;
  check('Tasks: when the app is busy, a clear "try again" message (not "Lock timeout"), not logged', r2, r2.ok === false && /busy right now/.test(r2.error) && !((sheets.Errors || { rows: [] }).rows.some(x => /Lock timeout/.test(x[3]))));
  ctx.__cache.bosta_busy = '1';
  const r3 = post({ action: 'staffSave', tpin: 'boss9', staff: { name: 'Sara', pin: '7777' } });
  check('Tasks: adding an employee works while the Bosta job runs', r3, r3.ok && r3.staff.name === 'Sara');
  delete ctx.__cache.bosta_busy;
}

console.log('\n' + (failed ? failed + ' check(s) FAILED' : 'All checks passed'));
process.exit(failed ? 1 : 0);
