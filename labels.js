/* Pet Friend: barcode labels (Code 128), shared by the tabs. Labels are 50 mm wide x 25 mm tall.
 *
 *   pfLabels.open([{ title, barcode, sku, binVariant, binProduct, expiry, copies }], { name: 'PO-1003', save: fn })
 *
 * Each label (values only, no captions): product / variant name on one line (start ... end when too long), SKU and
 * expiry date, the item's barcode (bars + number) and both bin locations. Every item must have a barcode AND both bins
 * (otherwise the items missing one are listed and nothing is printed). "Save PDF to Drive" makes a PDF
 * (one 50 x 25 mm page per label) and hands it to opts.save, which uploads it; "Print here" uses the browser.
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

  // ---------- labels: 50 mm wide x 25 mm tall ----------
  // Each label: SKU and expiry date on top, the item's barcode (bars + number), then both bin locations
  // (variant / product). The expiry date of the previous batch is NOT printed. Every item must have a barcode.
  var W = 50, H = 25;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function T(s) { return window.pfT ? window.pfT(s) : s; }
  // both bins, values only: "variant bin | product bin" (once when they are the same)
  function binsText(it) {
    var v = String(it.binVariant || '').trim(), p = String(it.binProduct || '').trim();
    return v && p && v !== p ? v + '  |  ' + p : v || p;
  }
  // the product / variant name on ONE line: when too long, its start ... its end (the end keeps the variant, e.g. 100 ml)
  // bins for the Arabic drawing: variant bin on the left, product bin on the right, each in its own direction
  function binsIso(it) {
    var v = String(it.binVariant || '').trim(), p = String(it.binProduct || '').trim();
    return v && p && v !== p ? iso(v) + '  |  ' + iso(p) : iso(v || p);
  }
  function shortTitle(title, fits) {
    title = String(title || '').replace(/\s+/g, ' ').trim();
    if (fits(title)) return title;
    var cut = title.lastIndexOf(' - '), tail = cut > 0 ? title.slice(cut + 3) : title.split(' ').slice(-2).join(' ');
    if (!fits('... ' + tail)) { while (tail.length > 1 && !fits('...' + tail)) tail = tail.slice(1); return '...' + tail; }
    var head = cut > 0 ? title.slice(0, cut) : title.slice(0, title.length - tail.length).trim();
    while (head.length > 1 && !fits(head + '... ' + tail)) head = head.slice(0, -1).trim();
    return head + '... ' + tail;
  }
  function codeOf(it) { return String(it.barcode || '').trim(); }

  var css =
    '.pflab{border:0;border-radius:14px;padding:0;width:min(520px,calc(100vw - 24px));max-height:calc(100dvh - 40px);color:#2a1417;background:#fff;box-shadow:0 12px 40px #0004}' +
    '.pflab::backdrop{background:#0006}' +
    '.pflab form{padding:16px;margin:0;font:16px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.pflab h2{margin:0 0 4px;font-size:19px}.pflab .size{color:#6b5f62;font-size:13px;margin-bottom:10px}' +
    '.pflab .rows{max-height:46dvh;overflow:auto;border:1px solid #b9ecf1;border-radius:10px}' +
    '.pflab .r{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #b9ecf1}' +
    '.pflab .r:last-child{border-bottom:0}' +
    '.pflab .r .t{flex:1;min-width:0}.pflab .r .t b{display:block;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.pflab .r .t small{color:#6b5f62;font-size:12px;display:block}' +
    '.pflab .r input{width:64px;font:inherit;font-size:17px;text-align:center;padding:8px 4px;border:2px solid #b9ecf1;border-radius:10px;background:#fff;color:inherit}' +
    '.pflab .sum{color:#6b5f62;font-size:13px;margin-top:8px}' +
    '.pflab .fixed{color:#6b5f62;font-size:12px;margin:-4px 0 8px}' +
    '.pflab .b{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px}' +
    '.pflab .b button{font:inherit;font-weight:600;padding:11px 14px;border-radius:10px;cursor:pointer}' +
    '.pflab .c{background:#fff;color:inherit;border:2px solid #b9ecf1}.pflab .ok{background:#e3031b;color:#fff;border:2px solid #e3031b}' +
    '.pflab .pr{background:#fff;color:inherit;border:2px solid #b9ecf1}' +
    '.pflab button:disabled{opacity:.5}' +
    '@media (prefers-color-scheme:dark){.pflab{background:#17282b;color:#eaf7f8}.pflab .r .t small,.pflab .sum,.pflab .size{color:#8fb0b3}' +
    '.pflab .r input,.pflab .c,.pflab .pr{background:#0f1c1e;border-color:#27403f}.pflab .rows,.pflab .r{border-color:#27403f}' +
    '.pflab .ok{background:#ff4a5c;border-color:#ff4a5c;color:#1a0508}}' +
    '#pflabPrint{display:none}' +
    '@media print{body>*:not(#pflabPrint){display:none!important}#pflabPrint{display:block}' +
    '#pflabPrint .lb{box-sizing:border-box;width:50mm;height:25mm;overflow:hidden;display:flex;flex-direction:column;padding:1.2mm 2mm 1mm;' +
    'font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff;page-break-after:always;break-after:page}' +
    '#pflabPrint .lb .nm{font-size:6.5pt;font-weight:700;line-height:1.1;white-space:nowrap;overflow:hidden}' +
    '#pflabPrint .lb .top{display:flex;justify-content:space-between;gap:2mm;font-size:6.5pt;line-height:1.1;white-space:nowrap}' +
    '#pflabPrint .lb .top span{overflow:hidden;text-overflow:clip}' +
    '#pflabPrint .lb svg{display:block;width:100%;height:9.3mm;margin-top:.4mm;fill:#000}' +
    '#pflabPrint .lb .cd{font-size:7.5pt;text-align:center;letter-spacing:.4px;line-height:1.1}' +
    '#pflabPrint .lb .bin{font-size:6.5pt;font-weight:700;text-align:center;line-height:1.1;white-space:nowrap;overflow:hidden}}' +
    '@media print{@page{size:50mm 25mm;margin:0}html,body{margin:0!important;padding:0!important;background:#fff!important}}';

  function addStyle() {
    if (document.getElementById('pflab-css')) return;
    var s = document.createElement('style'); s.id = 'pflab-css'; s.textContent = css; document.head.appendChild(s);
  }

  // print on this device (the browser's print window, 50 x 25 mm pages)
  function printLabels(list) {
    var box = document.getElementById('pflabPrint');
    if (!box) { box = document.createElement('div'); box.id = 'pflabPrint'; box.setAttribute('data-no-i18n', ''); document.body.appendChild(box); }
    var html = '', meas = document.createElement('canvas').getContext('2d');
    meas.font = 'bold 6.5pt Arial';   // 46 mm of text at 96 dpi = 174 px
    list = list.map(function (it) { return Object.assign({}, it, { short: shortTitle(it.title || '', function (t) { return meas.measureText(t).width <= 172; }) }); });
    list.forEach(function (it) {
      var one = '<div class="lb"><div class="nm">' + esc(it.short || it.title || '') + '</div><div class="top"><span>' + esc(it.sku || '') + '</span><span>' + esc(it.expiry || '') + '</span></div>' +
        svgFor(codeOf(it)) + '<div class="cd">' + esc(codeOf(it)) + '</div><div class="bin">' + esc(binsText(it)) + '</div></div>';
      for (var i = 0; i < it.copies; i++) html += one;
    });
    box.innerHTML = html;
    window.print();
  }

  // ---------- PDF for Google Drive (jsPDF, vector bars, one 50 x 25 mm page per label) ----------
  var JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  function loadJsPdf() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    return new Promise(function (ok, bad) {
      var s = document.createElement('script'); s.src = JSPDF;
      s.onload = function () { window.jspdf && window.jspdf.jsPDF ? ok(window.jspdf.jsPDF) : bad(new Error('PDF maker did not load')); };
      s.onerror = function () { bad(new Error("Can't load the PDF maker. Check the internet and try again.")); };
      document.head.appendChild(s);
    });
  }
  function latin(s) { return String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '?'); }   // Helvetica has no Arabic
  // Arabic text (product names, bins): drawn by the browser (it joins the letters and orders mixed Arabic / English
  // text correctly) with the Cairo font shipped with the app (fonts/Cairo-Bold.ttf), at ~400 dpi, and put in the PDF
  // as a picture. Latin text stays real PDF text. The font is loaded only when a label needs it.
  var AR = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/;
  var BASE = (document.currentScript && document.currentScript.src) || location.href, arFont = null;
  var PXMM = 16, FAM = 'PFCairo';
  function loadArabicFont() {
    if (arFont) return arFont;
    if (!window.FontFace || !document.fonts) return Promise.resolve(false);           // very old browser: system font
    var f = new FontFace(FAM, 'url("' + new URL('fonts/Cairo-Bold.ttf', BASE).href + '")', { weight: '700' });
    arFont = f.load().then(function (x) { document.fonts.add(x); return true; })
      .catch(function () { arFont = null; return false; });                          // offline: the phone's own Arabic font
    return arFont;
  }
  var meas = null;
  function arCtx(pt) {
    meas = meas || document.createElement('canvas').getContext('2d');
    meas.font = '700 ' + (pt * 0.3528 * PXMM).toFixed(1) + 'px ' + FAM + ', "Noto Sans Arabic", Tahoma, sans-serif';
    return meas;
  }
  function arWidth(text, pt) { return arCtx(pt).measureText(text).width / PXMM; }      // in mm
  // the first strong letter decides the direction (an Arabic name reads from the right)
  function isRtl(text) { var m = /[A-Za-z\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/.exec(text); return !!m && AR.test(m[0]); }
  // each piece keeps its own direction: "start... end" / "name - variant" / "bin | bin" (Unicode first-strong isolates)
  function iso(t) { return '\u2068' + t + '\u2069'; }
  function isoName(t) {
    var k = t.lastIndexOf('... '), sep = '... ';
    if (k < 0) { k = t.lastIndexOf(' - '); sep = ' - '; }
    return k > 0 ? iso(t.slice(0, k)) + sep + iso(t.slice(k + sep.length)) : t;
  }
  /** Draws one line of text into the PDF as a picture: box x..x+w (mm), baseline y, align left / center / right. */
  function arText(doc, text, pt, x, y, w, align, dir) {
    var top = y - pt * 0.3528 * 1.25, h = pt * 0.3528 * 1.75;                       // room for Arabic ascenders / descenders
    var c = document.createElement('canvas'); c.width = Math.round(w * PXMM); c.height = Math.round(h * PXMM);
    var g = c.getContext('2d'); g.font = arCtx(pt).font; g.fillStyle = '#000'; g.textBaseline = 'alphabetic';
    g.direction = dir || (isRtl(text) ? 'rtl' : 'ltr');
    g.textAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
    var tx = align === 'center' ? c.width / 2 : align === 'right' ? c.width : 0;
    g.fillText(text, tx, (y - top) * PXMM);
    doc.addImage(c.toDataURL('image/png'), 'PNG', x, top, w, h, 'ar:' + pt + ':' + align + ':' + text, 'FAST');
  }
  function fitText(doc, text, maxW, size, min) {
    doc.setFontSize(size);
    while (size > min && doc.getTextWidth(text) > maxW) { size -= 0.25; doc.setFontSize(size); }
    return text;
  }
  function drawLabel(doc, it) {
    var m = 2, code = codeOf(it), widths = code128(code), wmax = W - 2 * m;
    doc.setTextColor(0); doc.setFillColor(0, 0, 0);
    // 1: product / variant name, one line
    var title = String(it.title || it.sku || '');
    if (AR.test(title)) {
      var arName = shortTitle(title, function (t) { return arWidth(t, 6.5) <= wmax; });
      arText(doc, isoName(arName), 6.5, m, 2.9, wmax, isRtl(arName) ? 'right' : 'left');
    } else {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5);
      doc.text(shortTitle(latin(title), function (t) { return doc.getTextWidth(t) <= wmax; }), m, 2.9);
    }
    // 2: SKU (left) and expiry date (right), values only
    var exp = latin(it.expiry || ''); doc.setFont('helvetica', 'normal');
    fitText(doc, exp, 18, 6.5, 5); var ew = exp ? doc.getTextWidth(exp) : 0;
    if (exp) doc.text(exp, W - m, 5.6, { align: 'right' });
    var sku = latin(it.sku || ''); fitText(doc, sku, wmax - ew - 2, 6.5, 4.5); if (sku) doc.text(sku, m, 5.6);
    // 3: bars (quiet zone of 10 modules on both sides) and the barcode number
    var n = 20; for (var i = 0; i < widths.length; i++) n += +widths[i];
    var mod = wmax / n, x = m + 10 * mod, y = 6.6, bh = 9.6;
    for (var j = 0; j < widths.length; j++) { var w = +widths[j] * mod; if (j % 2 === 0) doc.rect(x, y, w, bh, 'F'); x += w; }
    doc.setFont('helvetica', 'normal'); fitText(doc, latin(code), wmax, 7.5, 5);
    doc.text(latin(code), W / 2, 19.1, { align: 'center' });
    // 4: both bins, values only
    var b = binsText(it);
    if (AR.test(b)) { var bp = 7.5; while (bp > 4.5 && arWidth(b, bp) > wmax) bp -= 0.25; arText(doc, binsIso(it), bp, m, 23, wmax, 'center', 'ltr'); return; }
    doc.setFont('helvetica', 'bold'); b = latin(b); fitText(doc, b, wmax, 7.5, 4.5);
    doc.text(b, W / 2, 23, { align: 'center' });
  }
  function makePdf(list) {
    var needAr = list.some(function (it) { return AR.test(String(it.title || '') + binsText(it)); });
    return Promise.all([loadJsPdf(), needAr ? loadArabicFont() : null]).then(function (got) {
      var JsPDF = got[0], doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: [H, W], compress: true }), first = true;
      list.forEach(function (it) {
        for (var i = 0; i < it.copies; i++) { if (!first) doc.addPage([H, W], 'landscape'); first = false; drawLabel(doc, it); }
      });
      return doc.output('datauristring').split(',')[1];
    });
  }

  /** items: [{ title, barcode, sku, binVariant, binProduct, expiry, copies }]
   *  opts: { name: 'PO-1003' (used in the file name), save: function (base64Pdf, fileName, labelCount) -> Promise({ url }) }
   *  Every item must have a barcode: otherwise nothing is printed and the items without one are listed. */
  function open(items, opts) {
    opts = opts || {};
    addStyle();
    // every item must have a barcode AND both bin locations (variant and product)
    var missing = items.map(function (it) {
      var why = [];
      if (!codeOf(it) || !code128(codeOf(it))) why.push(T('barcode'));
      if (!String(it.binVariant || '').trim()) why.push(T('variant bin'));
      if (!String(it.binProduct || '').trim()) why.push(T('product bin'));
      return why.length ? '• ' + (it.title || it.sku || '?') + ' (' + T('missing') + ': ' + why.join(', ') + ')' : '';
    }).filter(Boolean);
    if (missing.length) {
      var msg = T('Every item needs a barcode, a variant bin and a product bin in Shopify before labels can be printed:') + '\n' +
        missing.slice(0, 12).join('\n') + (missing.length > 12 ? '\n• +' + (missing.length - 12) : '');
      return (window.pfAlert ? window.pfAlert(msg, { title: 'Print labels' }) : Promise.resolve(alert(msg))).then(function () { return false; });
    }
    return new Promise(function (resolve) {
      var d = document.createElement('dialog'); d.className = 'pflab';
      var f = document.createElement('form');
      var h = document.createElement('h2'); h.textContent = 'Print labels'; f.appendChild(h);
      var sz = document.createElement('div'); sz.className = 'size'; sz.textContent = 'Label 50 × 25 mm · name, SKU, expiry date, barcode and bins'; f.appendChild(sz);
      if (opts.fixedCopies) { var fx = document.createElement('div'); fx.className = 'fixed'; fx.textContent = opts.fixedCopies; f.appendChild(fx); }
      var rows = document.createElement('div'); rows.className = 'rows'; f.appendChild(rows);
      var inputs = [];
      items.forEach(function (it) {
        var r = document.createElement('div'); r.className = 'r';
        var t = document.createElement('div'); t.className = 't';
        var b = document.createElement('b'); b.textContent = it.title || it.sku; b.setAttribute('data-no-i18n', ''); t.appendChild(b);
        var sm = document.createElement('small'); sm.dir = 'ltr'; sm.setAttribute('data-no-i18n', '');
        sm.textContent = codeOf(it) + (it.sku ? '  ·  SKU ' + it.sku : ''); t.appendChild(sm);
        r.appendChild(t);
        var n = document.createElement('input'); n.type = 'number'; n.min = 0; n.max = 500; n.inputMode = 'numeric';
        n.value = Math.max(0, Math.min(500, it.copies | 0)); n.setAttribute('aria-label', 'Copies');
        if (opts.fixedCopies) { n.readOnly = true; n.tabIndex = -1; n.style.opacity = '.75'; }
        r.appendChild(n); rows.appendChild(r); inputs.push({ it: it, n: n });
      });
      var sum = document.createElement('div'); sum.className = 'sum'; f.appendChild(sum);
      var bb = document.createElement('div'); bb.className = 'b';
      var c = document.createElement('button'); c.type = 'button'; c.className = 'c'; c.textContent = 'Cancel';
      var pr = document.createElement('button'); pr.type = 'button'; pr.className = 'pr'; pr.textContent = 'Print here';
      var sv = document.createElement('button'); sv.type = 'submit'; sv.className = 'ok'; sv.textContent = 'Save PDF to Drive';
      bb.appendChild(c); bb.appendChild(pr); if (opts.save) bb.appendChild(sv); f.appendChild(bb);
      function list() { return inputs.filter(function (x) { return (x.n.value | 0) > 0; }).map(function (x) { return Object.assign({}, x.it, { copies: Math.min(500, x.n.value | 0) }); }); }
      function count() { return list().reduce(function (t, x) { return t + x.copies; }, 0); }
      function upd() { var n = count(); sum.textContent = n + (n === 1 ? ' label' : ' labels'); pr.disabled = sv.disabled = !n; }
      rows.addEventListener('input', upd); upd();
      var result = false;
      function done() { d.close(); d.remove(); resolve(result); }
      c.addEventListener('click', done);
      d.addEventListener('cancel', function (e) { e.preventDefault(); done(); });
      pr.addEventListener('click', function () { var l = list(); result = 'printed'; done(); setTimeout(function () { printLabels(l); }, 50); });
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var l = list(), n = count();
        sv.disabled = pr.disabled = true; sv.textContent = 'Saving...';
        var stamp = new Date(), pad = function (x) { return ('0' + x).slice(-2); };
        var fname = 'Labels ' + String(opts.name || 'items').replace(/[^\w\- ]/g, '') + ' ' + stamp.getFullYear() + '-' + pad(stamp.getMonth() + 1) + '-' + pad(stamp.getDate()) +
          ' ' + pad(stamp.getHours()) + '-' + pad(stamp.getMinutes()) + ' (' + n + ').pdf';
        makePdf(l).then(function (b64) { return opts.save(b64, fname, n); }).then(function (r) {
          result = r || true; done();
        }).catch(function (err) {
          sv.disabled = pr.disabled = false; sv.textContent = 'Save PDF to Drive';
          sum.textContent = err.message || String(err);
        });
      });
      d.appendChild(f); document.body.appendChild(d); d.showModal();
    });
  }

  window.pfLabels = { open: open, svg: svgFor, code128: code128, makePdf: makePdf, shortTitle: shortTitle };
})();
