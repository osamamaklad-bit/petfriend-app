/* Pet Friend: settings shared by every tab.
 * API_URL: the web-app URL of the ONE Apps Script server (apps-script/Code.gs).
 * The automatic deploy keeps the same URL, so this changes only if a brand-new deployment is made. */
window.PF_API_URL = 'https://script.google.com/macros/s/AKfycbxCt3AtTpBYGvVmicXQqvrPXNKkVCU82GdjSPIo5SWBfdD5N9b7wbByvUmCwR_fF6rv/exec';

/* Clear messages instead of the browser's "Failed to fetch" when the server can't be reached, and instead of
 * "Unexpected token <" when Google answers with a web page (sign-in, quota, error page) instead of data. */
(function () {
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
          try { return JSON.parse(t); } catch (e) {
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
