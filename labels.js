/* Pet Friend: print barcode labels (Code 128), shared by the tabs.
 *
 *   pfLabels.open([{ title: 'Royal Canin Kitten 2kg', code: '6723085', sub: 'A-10 · exp 2027-01-31', copies: 4 }])
 *
 * Opens a window to choose the label size and the number of copies per item, then prints with the
 * browser's print window (works with label printers and with A4 sticker sheets). The barcode holds
 * the item's SKU (or barcode), so the printed label scans in Fulfill, Returns, Receive and POS.
 * Text is in English and is translated by i18n.js like the rest of the page.
 */
(function () {
  'use strict';

  // ---------- Code 128 ----------
  var P = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212',
    '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222',
    '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113',
    '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131',
    '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
    '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114',
    '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131',
    '211412', '211214', '211232', '2331112'];

  /** Bar / space widths for text, or null if it has characters Code 128 B cannot hold. */
  function code128(text) {
    var vals;
    if (/^\d+$/.test(text) && text.length % 2 === 0 && text.length >= 4) {   // all digits: set C, two digits per symbol
      vals = [105];
      for (var i = 0; i < text.length; i += 2) vals.push(+text.substr(i, 2));
    } else {
      vals = [104];
      for (var j = 0; j < text.length; j++) {
        var c = text.charCodeAt(j);
        if (c < 32 || c > 126) return null;
        vals.push(c - 32);
      }
    }
    var sum = vals[0];
    for (var k = 1; k < vals.length; k++) sum += vals[k] * k;
    vals.push(sum % 103, 106);
    return vals.map(function (v) { return P[v]; }).join('');
  }

  /** SVG of the barcode, sized by the CSS around it. */
  function svgFor(text) {
    var w = code128(text);
    if (!w) return '';
    var q = 10, x = q, bars = '';
    for (var i = 0; i < w.length; i++) {
      var n = +w[i];
      if (i % 2 === 0) bars += '<rect x="' + x + '" y="0" width="' + n + '" height="50"/>';
      x += n;
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (x + q) + ' 50" preserveAspectRatio="none" shape-rendering="crispEdges">' + bars + '</svg>';
  }

  var SIZES = {
    '50x25': { w: 50, h: 25, label: 'Label 50 × 25 mm' },
    '40x30': { w: 40, h: 30, label: 'Label 40 × 30 mm' },
    '58x40': { w: 58, h: 40, label: 'Label 58 × 40 mm' },
    'a4': { w: 63.5, h: 38.1, sheet: true, label: 'A4 sheet (3 × 7)' }
  };
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k) || ''; localStorage.setItem(k, v); } catch (e) { return ''; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var css =
    '.pflab{border:0;border-radius:14px;padding:0;width:min(520px,calc(100vw - 24px));max-height:calc(100dvh - 40px);color:#2a1417;background:#fff;box-shadow:0 12px 40px #0004}' +
    '.pflab::backdrop{background:#0006}' +
    '.pflab form{padding:16px;margin:0;font:16px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.pflab h2{margin:0 0 10px;font-size:19px}' +
    '.pflab select{width:100%;font:inherit;padding:10px;border:2px solid #b9ecf1;border-radius:10px;background:#fff;color:inherit;margin-bottom:10px}' +
    '.pflab .rows{max-height:50dvh;overflow:auto;border:1px solid #b9ecf1;border-radius:10px}' +
    '.pflab .r{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #b9ecf1}' +
    '.pflab .r:last-child{border-bottom:0}' +
    '.pflab .r .t{flex:1;min-width:0}.pflab .r .t b{display:block;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.pflab .r .t small{color:#6b5f62;font-size:12px}' +
    '.pflab .r input{width:64px;font:inherit;font-size:17px;text-align:center;padding:8px 4px;border:2px solid #b9ecf1;border-radius:10px;background:#fff;color:inherit}' +
    '.pflab .r.no{opacity:.6}.pflab .r.no small{color:#c00018}' +
    '.pflab .sum{color:#6b5f62;font-size:13px;margin-top:8px}' +
    '.pflab .b{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}' +
    '.pflab .b button{font:inherit;font-weight:600;padding:11px 18px;border-radius:10px;cursor:pointer}' +
    '.pflab .c{background:#fff;color:inherit;border:2px solid #b9ecf1}.pflab .ok{background:#e3031b;color:#fff;border:2px solid #e3031b}' +
    '.pflab .ok:disabled{opacity:.5}' +
    '@media (prefers-color-scheme:dark){.pflab{background:#17282b;color:#eaf7f8}.pflab .r .t small,.pflab .sum{color:#8fb0b3}' +
    '.pflab select,.pflab .r input,.pflab .c{background:#0f1c1e;border-color:#27403f}.pflab .rows,.pflab .r{border-color:#27403f}' +
    '.pflab .ok{background:#ff4a5c;border-color:#ff4a5c;color:#1a0508}}' +
    '#pflabPrint{display:none}' +
    '@media print{body>*:not(#pflabPrint){display:none!important}#pflabPrint{display:block}' +
    '#pflabPrint .lb{box-sizing:border-box;overflow:hidden;display:flex;flex-direction:column;justify-content:space-between;padding:1.2mm 2mm;' +
    'font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff;page-break-inside:avoid;break-inside:avoid}' +
    '#pflabPrint .lb .n{font-size:7pt;font-weight:700;line-height:1.15;max-height:2.3em;overflow:hidden}' +
    '#pflabPrint .lb svg{display:block;width:100%;flex:1;min-height:6mm;fill:#000}' +
    '#pflabPrint .lb .cd{font-size:8pt;text-align:center;letter-spacing:.5px;line-height:1.1}' +
    '#pflabPrint .lb .s{font-size:6.5pt;text-align:center;line-height:1.1}' +
    '#pflabPrint.roll .lb{page-break-after:always;break-after:page}' +
    '#pflabPrint.sheet{display:grid;grid-template-columns:repeat(3,63.5mm);grid-auto-rows:38.1mm;column-gap:2.5mm}}';

  function addStyle() {
    if (document.getElementById('pflab-css')) return;
    var s = document.createElement('style'); s.id = 'pflab-css'; s.textContent = css; document.head.appendChild(s);
  }

  function printLabels(items, sizeKey) {
    var size = SIZES[sizeKey] || SIZES['50x25'];
    var box = document.getElementById('pflabPrint');
    if (!box) { box = document.createElement('div'); box.id = 'pflabPrint'; box.setAttribute('data-no-i18n', ''); document.body.appendChild(box); }
    box.className = size.sheet ? 'sheet' : 'roll';
    var page = document.getElementById('pflab-page');
    if (!page) { page = document.createElement('style'); page.id = 'pflab-page'; document.head.appendChild(page); }
    page.textContent = size.sheet ? '@media print{@page{size:A4;margin:12mm 7mm}}'
      : '@media print{@page{size:' + size.w + 'mm ' + size.h + 'mm;margin:0}html,body{margin:0!important;padding:0!important;background:#fff!important}}';
    var html = '';
    items.forEach(function (it) {
      var one = '<div class="lb" style="width:' + size.w + 'mm;height:' + size.h + 'mm">' +
        '<div class="n">' + esc(it.title) + '</div>' + svgFor(it.code) +
        '<div class="cd">' + esc(it.code) + '</div>' + (it.sub ? '<div class="s">' + esc(it.sub) + '</div>' : '') + '</div>';
      for (var i = 0; i < it.copies; i++) html += one;
    });
    box.innerHTML = html;
    window.print();
  }

  /** items: [{ title, code, sub, copies }]. Resolves true when printed, false when cancelled. */
  function open(items) {
    addStyle();
    return new Promise(function (resolve) {
      var d = document.createElement('dialog'); d.className = 'pflab';
      var f = document.createElement('form');
      var h = document.createElement('h2'); h.textContent = 'Print labels'; f.appendChild(h);
      var sel = document.createElement('select'); sel.setAttribute('aria-label', 'Label size');
      Object.keys(SIZES).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = SIZES[k].label; sel.appendChild(o); });
      sel.value = SIZES[store('pf_label_size')] ? store('pf_label_size') : '50x25';
      f.appendChild(sel);
      var rows = document.createElement('div'); rows.className = 'rows'; f.appendChild(rows);
      var inputs = [];
      items.forEach(function (it) {
        var r = document.createElement('div'); r.className = 'r';
        var t = document.createElement('div'); t.className = 't';
        var b = document.createElement('b'); b.textContent = it.title; b.setAttribute('data-no-i18n', ''); t.appendChild(b);
        var sm = document.createElement('small');
        var ok = it.code && code128(String(it.code));
        if (ok) { sm.textContent = it.code; sm.dir = 'ltr'; sm.setAttribute('data-no-i18n', ''); }
        else sm.textContent = 'No SKU or barcode: add one in Shopify';
        t.appendChild(sm); r.appendChild(t);
        var n = document.createElement('input'); n.type = 'number'; n.min = 0; n.max = 500; n.inputMode = 'numeric';
        n.value = ok ? Math.max(0, Math.min(500, it.copies | 0)) : 0; n.disabled = !ok; n.setAttribute('aria-label', 'Copies');
        if (!ok) r.className = 'r no';
        r.appendChild(n); rows.appendChild(r);
        inputs.push({ it: it, n: n, ok: ok });
      });
      var sum = document.createElement('div'); sum.className = 'sum'; f.appendChild(sum);
      var bb = document.createElement('div'); bb.className = 'b';
      var c = document.createElement('button'); c.type = 'button'; c.className = 'c'; c.textContent = 'Cancel';
      var p = document.createElement('button'); p.type = 'submit'; p.className = 'ok'; p.textContent = 'Print';
      bb.appendChild(c); bb.appendChild(p); f.appendChild(bb);
      function count() { return inputs.reduce(function (t, x) { return t + (x.ok ? Math.max(0, Math.min(500, x.n.value | 0)) : 0); }, 0); }
      function upd() { var n = count(); sum.textContent = n + (n === 1 ? ' label' : ' labels'); p.disabled = !n; }
      rows.addEventListener('input', upd); upd();
      function done(v) { d.close(); d.remove(); resolve(v); }
      c.addEventListener('click', function () { done(false); });
      d.addEventListener('cancel', function (e) { e.preventDefault(); done(false); });
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var list = inputs.filter(function (x) { return x.ok && (x.n.value | 0) > 0; })
          .map(function (x) { return { title: x.it.title, code: String(x.it.code), sub: x.it.sub || '', copies: Math.min(500, x.n.value | 0) }; });
        store('pf_label_size', sel.value);
        done(true);
        setTimeout(function () { printLabels(list, sel.value); }, 50);   // after the window has closed
      });
      d.appendChild(f); document.body.appendChild(d); d.showModal();
    });
  }

  window.pfLabels = { open: open, svg: svgFor, code128: code128 };
})();
