/* Pet Friend: settings shared by every tab.
 * API_URL: the web-app URL of the ONE Apps Script server (apps-script/Code.gs).
 * The automatic deploy keeps the same URL, so this changes only if a brand-new deployment is made. */
window.PF_API_URL = 'https://script.google.com/macros/s/AKfycbxCt3AtTpBYGvVmicXQqvrPXNKkVCU82GdjSPIo5SWBfdD5N9b7wbByvUmCwR_fF6rv/exec';
/* The oldest server (SERVER_VERSION in apps-script/Code.gs) this app works with. Raise it when the app starts using
 * something new on the server: if the live server is older (deploy failed or not finished), every tab shows a warning
 * instead of edits silently not being saved. */
window.PF_MIN_SERVER = '2026-11-27.2';

/* Clear messages instead of the browser's "Failed to fetch" when the server can't be reached, and instead of
 * "Unexpected token <" when Google answers with a web page (sign-in, quota, error page) instead of data. */
(function () {
  // "2026-11-25.10" > "2026-11-25.9": compare the date, then the number after the dot
  function older(a, b) {
    var x = String(a || '').split('.'), y = String(b || '').split('.');
    return x[0] !== y[0] ? x[0] < y[0] : (Number(x[1]) || 0) < (Number(y[1]) || 0);
  }
  var warned = false;
  function checkServer(j) {
    if (warned || !j || typeof j !== 'object' || !window.PF_MIN_SERVER) return;
    if (j.sv && !older(j.sv, window.PF_MIN_SERVER)) return;
    warned = true;
    var show = function () {
      var bar = document.createElement('div');
      bar.id = 'pfStale';
      bar.setAttribute('role', 'alert');
      bar.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:99999;background:#fff4e5;color:#7a2e00;border:2px solid #c2410c;' +
        'border-radius:12px;padding:10px 40px 10px 12px;font:600 14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 6px 20px #0003';
      var msg = document.createElement('span');
      msg.textContent = 'The server is older than this app (server ' + (j.sv || 'old') + ', app needs ' + window.PF_MIN_SERVER +
        '). Changes may not be saved. Wait a few minutes and reopen the app; if it stays, check the server deploy on GitHub.';
      var x = document.createElement('button');
      x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Close');
      x.style.cssText = 'position:absolute;top:4px;right:6px;border:0;background:none;color:inherit;font:700 22px/1 system-ui;padding:6px;cursor:pointer';
      x.addEventListener('click', function () { bar.remove(); });
      bar.appendChild(msg); bar.appendChild(x);
      document.body.appendChild(bar);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }
  var realFetch = window.fetch;
  if (!realFetch) return;
  window.fetch = function (url, opts) {
    var ours = String(url && url.url || url).indexOf(window.PF_API_URL) === 0;
    var p = realFetch.apply(this, arguments);
    if (!ours) return p;
    return p.then(function (res) {
      var json = res.json.bind(res);
      res.json = function () {
        return res.clone().text().then(function (t) {
          try { var j = JSON.parse(t); checkServer(j); return j; } catch (e) {
            throw new Error('The server sent an unexpected reply. Try again in a minute.');
          }
        }, function () { return json(); });
      };
      return res;
    }, function (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new Error("Can't reach the server. Check the internet, or try another network (for example mobile data).");
    });
  };
})();
