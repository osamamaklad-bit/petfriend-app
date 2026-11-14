/* Pet Friend: the Settings window, shared by the POS, Orders and Shipments tabs.
 *
 *   pfSettings({ title: 'Settings', fields: [
 *     { key: 'pin', label: 'PIN', secret: true, numeric: true, value: '1234' }
 *   ]}).then(values => { ... })   // values = { pin: '...' }, or null if cancelled
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
    '@media (prefers-color-scheme:dark){' +
    '.pfset{background:#17282b;color:#eaf7f8}.pfset label{color:#8fb0b3}' +
    '.pfset input,.pfset .eye,.pfset .c{background:#0f1c1e;border-color:#27403f}' +
    '.pfset input:focus{border-color:#ff4a5c}.pfset .ok{background:#ff4a5c;border-color:#ff4a5c;color:#1a0508}}';

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
        inp.type = f.secret ? 'password' : 'text';
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
        form.appendChild(lab);
        inputs[f.key] = inp;
      });

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

  window.pfSettings = pfSettings;
})();
