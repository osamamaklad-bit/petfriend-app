/* Pet Friend: the Settings window, shared by the POS, Orders and Shipments tabs.
 *
 *   pfSettings({ title: 'Settings', fields: [
 *     { key: 'pin', label: 'PIN', secret: true, numeric: true, value: '1234' }
 *   ]}).then(values => { ... })   // values = { pin: '...' }, or null if cancelled
 *
 * Also pfConfirm(message, { ok, cancel, title, danger }) -> Promise<boolean> and pfAlert(message): branded
 * replacements for the browser's confirm() / alert().
 *
 * Secret fields show as dots with a Show/Hide button. Text is in English and is
 * translated by i18n.js like the rest of the page.
 */
(function () {
  'use strict';
  var BASE = (document.currentScript && document.currentScript.src) || location.href; // to find the logo
  var css =
    '.pfset{border:0;border-radius:14px;padding:0;width:min(420px,calc(100vw - 32px));color:#2a1417;background:#fff;box-shadow:0 12px 40px #0004}' +
    '.pfset::backdrop{background:#0006}' +
    '.pfset form{padding:18px;margin:0;font:16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.pfset h2{margin:0 0 14px;font-size:19px;display:flex;align-items:center;gap:10px}' +
    '.pfset h2 img{width:32px;height:32px;border-radius:9px}' +
    '.pfset label{display:block;font-size:14px;font-weight:600;color:#6b5f62;margin:0 0 12px}' +
    '.pfset .in{display:flex;gap:6px;margin-top:5px}' +
    '.pfset input{flex:1;min-width:0;font:inherit;font-size:18px;padding:11px 12px;border:2px solid #b9ecf1;border-radius:10px;background:#fff;color:inherit}' +
    '.pfset input:focus{outline:none;border-color:#e3031b}' +
    '.pfset .eye{font:inherit;font-size:13px;padding:0 12px;border:2px solid #b9ecf1;border-radius:10px;background:#fff;color:inherit;cursor:pointer}' +
    '.pfset .b{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}' +
    '.pfset .b button{font:inherit;font-weight:600;padding:11px 18px;border-radius:10px;cursor:pointer}' +
    '.pfset .c{background:#fff;color:inherit;border:2px solid #b9ecf1}' +
    '.pfset .ok{background:#e3031b;color:#fff;border:2px solid #e3031b}' +
    '.pfset .lang{display:flex;gap:6px;margin-top:5px}' +
    '.pfset .hint{display:block;font-weight:400;font-size:12px;color:#6b5f62;margin-top:4px}' +
    '.pflangbtn{font-weight:700!important}' +
    '.pfconf .msg{margin:0 0 4px;font-size:17px;line-height:1.45;white-space:pre-line;color:inherit}' +
    '.pfconf h2{color:#e3031b}.pfconf .b button{min-width:110px}' +
    '.pfconf.danger .ok{background:#c2410c;border-color:#c2410c}' +
    '.pfset .lang button{flex:1;font:inherit;font-size:16px;font-weight:600;padding:10px;border:2px solid #b9ecf1;border-radius:10px;background:#fff;color:inherit;cursor:pointer}' +
    '.pfset .lang button.on{background:#e3031b;border-color:#e3031b;color:#fff}' +
    '@media (prefers-color-scheme:dark){.pfconf h2{color:#ff4a5c}' +
    '.pfset{background:#17282b;color:#eaf7f8}.pfset label{color:#8fb0b3}' +
    '.pfset input,.pfset .eye,.pfset .c{background:#0f1c1e;border-color:#27403f}' +
    '.pfset input:focus{border-color:#ff4a5c}.pfset .ok{background:#ff4a5c;border-color:#ff4a5c;color:#1a0508}' +
    '.pfset .hint{color:#8fb0b3}.pfset .lang button{background:#0f1c1e;border-color:#27403f}.pfset .lang button.on{background:#ff4a5c;border-color:#ff4a5c;color:#1a0508}}';

  function addStyle() {
    if (document.getElementById('pfset-css')) return;
    var s = document.createElement('style');
    s.id = 'pfset-css';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function pfSettings(opts) {
    addStyle();
    return new Promise(function (resolve) {
      var d = document.createElement('dialog');
      d.className = 'pfset';
      var form = document.createElement('form');
      var h = document.createElement('h2');
      var logo = document.createElement('img');
      logo.src = new URL('icon-192.png', BASE).href;
      logo.alt = '';
      h.appendChild(logo);
      h.appendChild(document.createTextNode(opts.title || 'Settings'));
      form.appendChild(h);

      var inputs = {};
      (opts.fields || []).forEach(function (f) {
        var lab = document.createElement('label');
        lab.appendChild(document.createTextNode(f.label));
        var row = document.createElement('div');
        row.className = 'in';
        var inp = document.createElement('input');
        inp.type = f.secret ? 'password' : (f.type || 'text'); // e.g. 'date' shows a date picker
        inp.value = f.value || '';
        inp.autocomplete = 'off';
        inp.spellcheck = false;
        inp.setAttribute('autocapitalize', 'off');
        if (f.numeric) inp.inputMode = 'numeric';
        inp.dir = 'ltr';
        row.appendChild(inp);
        if (f.secret) {
          var eye = document.createElement('button');
          eye.type = 'button';
          eye.className = 'eye';
          eye.textContent = 'Show';
          eye.addEventListener('click', function () {
            var show = inp.type === 'password';
            inp.type = show ? 'text' : 'password';
            eye.textContent = show ? 'Hide' : 'Show';
            inp.focus();
          });
          row.appendChild(eye);
        }
        lab.appendChild(row);
        if (f.hint) {                                   // e.g. which tabs share this pass
          var hint = document.createElement('small');
          hint.className = 'hint';
          hint.textContent = f.hint;
          lab.appendChild(hint);
        }
        form.appendChild(lab);
        inputs[f.key] = inp;
      });

      // The Settings window of every tab also holds the language (English / Arabic). It applies at once,
      // and the other tabs follow (they share the saved choice). Not shown in other windows (e.g. Edit expiry).
      if (window.pfLang && (opts.language || opts.title === 'Settings')) {
        var ll = document.createElement('label');
        ll.appendChild(document.createTextNode('Language'));
        var lr = document.createElement('div');
        lr.className = 'lang';
        [['en', 'English'], ['ar', 'العربية']].forEach(function (x) {
          var b = document.createElement('button');
          b.type = 'button';
          b.textContent = x[1];
          b.setAttribute('data-no-i18n', '');
          b.dataset.lang = x[0];
          if (window.pfLang.get() === x[0]) b.className = 'on';
          b.addEventListener('click', function () {
            window.pfLang.set(x[0]);
            lr.querySelectorAll('button').forEach(function (y) { y.className = y.dataset.lang === x[0] ? 'on' : ''; });
          });
          lr.appendChild(b);
        });
        ll.appendChild(lr);
        form.appendChild(ll);
      }

      var bar = document.createElement('div');
      bar.className = 'b';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'c';
      cancel.textContent = 'Cancel';
      var ok = document.createElement('button');
      ok.type = 'submit';
      ok.className = 'ok';
      ok.textContent = 'Save';
      bar.appendChild(cancel);
      bar.appendChild(ok);
      form.appendChild(bar);
      d.appendChild(form);

      var result = null;
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        result = {};
        Object.keys(inputs).forEach(function (k) { result[k] = inputs[k].value.trim(); });
        d.close();
      });
      cancel.addEventListener('click', function () { d.close(); });
      d.addEventListener('close', function () { d.remove(); resolve(result); }); // Esc also lands here (cancel)

      document.body.appendChild(d);
      d.showModal();
      var first = Object.keys(inputs).map(function (k) { return inputs[k]; }).filter(function (i) { return !i.value; })[0];
      (first || inputs[Object.keys(inputs)[0]] || ok).focus();
    });
  }

  /* Branded yes / no window instead of the browser's confirm() (which shows the site address and can't be styled).
   *   if (await pfConfirm('Receive 4 items?', { ok: 'Receive', title: 'Receive' })) { ... }
   * Resolves true for the OK button, false for Cancel / Esc / a tap outside. The text is translated by i18n.js
   * (pass it already translated with pfT when it is built from pieces). */
  function pfConfirm(message, o) {
    o = o || {};
    addStyle();
    return new Promise(function (resolve) {
      var d = document.createElement('dialog');
      d.className = 'pfset pfconf' + (o.danger ? ' danger' : '');
      var form = document.createElement('form');
      var h = document.createElement('h2');
      var logo = document.createElement('img');
      logo.src = new URL('icon-192.png', BASE).href;
      logo.alt = '';
      h.appendChild(logo);
      h.appendChild(document.createTextNode(o.title || 'Pet Friend'));
      form.appendChild(h);
      var m = document.createElement('p');
      m.className = 'msg';
      m.textContent = message;
      form.appendChild(m);
      var bar = document.createElement('div');
      bar.className = 'b';
      var no = document.createElement('button');
      no.type = 'button'; no.className = 'c'; no.textContent = o.cancel || 'Cancel';
      var yes = document.createElement('button');
      yes.type = 'submit'; yes.className = 'ok'; yes.textContent = o.ok || 'OK';
      if (o.alert) no.hidden = true;                      // pfAlert: one button
      bar.appendChild(no); bar.appendChild(yes);
      form.appendChild(bar);
      d.appendChild(form);
      var answer = false;
      form.addEventListener('submit', function (e) { e.preventDefault(); answer = true; d.close(); });
      no.addEventListener('click', function () { d.close(); });
      d.addEventListener('click', function (e) { if (e.target === d) d.close(); });   // tap on the dark backdrop
      d.addEventListener('close', function () { d.remove(); resolve(answer); });
      document.body.appendChild(d);
      d.showModal();
      yes.focus();
    });
  }
  function pfAlert(message, o) { return pfConfirm(message, Object.assign({ alert: true, ok: 'OK' }, o || {})).then(function () {}); }

  /* Language button in every tab's header, next to the Settings button (English <-> العربية). It names the language
   * you switch TO, and all tabs follow (they share the saved choice). */
  function addLangButton() {
    if (!window.pfLang || document.querySelector('.pflangbtn')) return;
    var set = document.querySelector('#settingsBtn, #setBtn, button[onclick="settings()"]');
    if (!set) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = (set.className ? set.className + ' ' : '') + 'pflangbtn';
    b.setAttribute('data-no-i18n', '');
    b.setAttribute('aria-label', 'Language');
    var st = set.getAttribute('style') || '';
    if (/margin-left:\s*auto/.test(st)) {           // Shipments: the gap moves to the first of the two buttons
      b.setAttribute('style', st);
      set.setAttribute('style', st.replace(/margin-left:\s*auto;?/, 'margin-left:6px;'));
    } else if (st) b.setAttribute('style', st);
    function label() { b.textContent = window.pfLang.get() === 'ar' ? 'English' : 'العربية'; }
    label();
    b.addEventListener('click', function () { window.pfLang.set(window.pfLang.get() === 'ar' ? 'en' : 'ar'); });
    document.addEventListener('pf-lang', label);
    set.parentNode.insertBefore(b, set);
  }
  // Inside the app: the logo in a tab's header goes to the home screen (Today)
  function homeLogo() {
    if (window.parent === window) return;
    var logo = document.querySelector('header .logo, h1 .logo, .hd .logo');
    if (!logo || logo.dataset.home) return;
    logo.dataset.home = '1';
    logo.style.cursor = 'pointer';
    logo.setAttribute('role', 'button');
    logo.setAttribute('aria-label', 'Home');
    logo.addEventListener('click', function () { try { window.parent.postMessage('pf-home', location.origin); } catch (e) {} });
  }
  function onReady() { addLangButton(); homeLogo(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady); else onReady();

  window.pfSettings = pfSettings;
  window.pfConfirm = pfConfirm;
  window.pfAlert = pfAlert;

  // ---------- every real tap is reported to the main page, so its Back step (back to home) is saved then ----------
  if (window.parent !== window) {
    // a little after the tap, so a button that opens another page (its click comes right after) is handled first
    document.addEventListener('pointerup', function () {
      setTimeout(function () { try { window.parent.postMessage('pf-act', location.origin); } catch (x) {} }, 30);
    }, { capture: true, passive: true });
  }

  // ---------- swipe left / right to move between the app's pages (the main page decides where) ----------
  // Only a quick, mostly sideways swipe counts. Not while a window is open, and not when it starts on something that
  // moves sideways itself (a text box, a list that scrolls sideways, the camera, a slider).
  (function () {
    if (window.parent === window || !('ontouchstart' in window)) return;
    var x0 = 0, y0 = 0, t0 = 0, ok = false;
    function blocked(el) {
      for (var n = el; n && n !== document.body; n = n.parentElement) {
        if (/^(INPUT|TEXTAREA|SELECT|VIDEO|CANVAS)$/.test(n.tagName) || n.isContentEditable || n.id === 'reader') return true;
        if (n.scrollWidth > n.clientWidth + 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true;
      }
      return !!document.querySelector('dialog[open]');
    }
    document.addEventListener('touchstart', function (e) {
      ok = e.touches.length === 1 && !blocked(e.target);
      if (!ok) return;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
      if (!ok) return; ok = false;
      var t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
      if (Date.now() - t0 > 700 || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.55) return;
      if (window.getSelection && String(window.getSelection()).length) return;   // selecting text, not swiping
      try { window.parent.postMessage({ type: 'pf-swipe', dir: dx < 0 ? 'left' : 'right' }, location.origin); } catch (x) {}
    }, { passive: true });
  })();
})();
