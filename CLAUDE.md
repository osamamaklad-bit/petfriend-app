# PetFriend app: notes for Claude

Installable web app (PWA) for the Pet Friend store, hosted on GitHub Pages from `main`.
The owner writes in Arabic (Egyptian); answer in the language they use.

## Layout

- `index.html`: main page with the tab bar. Each tab is its own page in an iframe:
  `pos/`, `check` (= `orders/index.html?only=check`: Check mode only), `orders/` (Fulfill · Returns · Check),
  `receive` (= `orders/index.html?only=receive`: purchase orders),
  `picklist/`, `shipments/` (outgoing: Save + Search), `returns` (= `shipments/index.html?only=returns`: Save return +
  Search), `today/`.
  The main page passes messages between tabs: `pf-hide` (camera off), `pf-show` (refresh) and `pf-open-order`
  (from the Pick list, opens an order in Fulfill).
- Pages put `[hidden] { display: none !important; }` first in their CSS, so `hidden` beats classes that set display.
- `i18n.js`: English → Arabic dictionary (`EXACT`, `PATTERNS`). Screens are written in English and translated
  live. Data (product names, customers, codes, bins, dates) must carry `data-no-i18n` and `dir="ltr"`.
- `config.js`: the server URL (`PF_API_URL`), used by every tab. Don't copy the URL into pages.
- `settings.js`: the Settings window (PIN / app key, and the English / Arabic choice), shared by every tab, and the
  branded `pfConfirm` / `pfAlert` windows. Never use the browser's `confirm()` / `alert()` / `prompt()`. The tab bar
  has no language button; Today is the HOME screen with no tab button: the app opens on it, Android Back returns to it
  (one history entry above home), and a tab's header logo, the desktop side-bar logo or tapping the open tab again go
  home. Tab bar: POS · Check · Orders · Purchase orders · Pick list · Shipments · Return shipments (all fit at once on
  phones with smaller icons and wrapping names, checked from 320px; the owner prefers this to a carousel). Arabic brand name: بتفريند.
- `labels.js`: barcode label printing (Code 128 of the SKU, else the barcode), used by Receive and Today.
  Printed barcodes are checked by decoding them with html5-qrcode in a test.
- `sw.js`: offline cache. **Bump `CACHE` on every release.**
- `apps-script/Code.gs`: the ONE Google Apps Script server for every tab. Bump `SERVER_VERSION` on every change.
- `tests/server-test.js`: runs `Code.gs` in Node with fake Google, Shopify and Bosta services:
  `node tests/server-test.js apps-script/Code.gs`. Add a check for every server change.

## Deploying

- App: push to `main`, and GitHub Pages publishes it. Bump `CACHE` in `sw.js` and the `app YYYY-MM-DD.N` label in `orders/index.html`.
- Server: pushing a change to `apps-script/**` runs `.github/workflows/deploy-apps-script.yml`. It runs the tests,
  pushes `Code.gs` with clasp to the live project (Script ID and Deployment ID are repo variables, the login is the
  `CLASPRC_JSON` secret), publishes a new version on the same web-app URL, and checks the URL reports the new
  `SERVER_VERSION`. Never paste secrets into code: the repository is public.

## Rules agreed with the owner

- Logins: each tab has its own pass, entered in Settings and named after its section: "POS pass" (`POS_PIN`),
  "Orders pass" (`APP_KEY`: Orders, Check, Purchase orders, Pick list, Today), "Shipments pass" (`APP_PIN`: Shipments,
  Return shipments). Every tab header has a language button (English / العربية) next to Settings (added by settings.js).
- Scanning (Fulfill, Returns, Receive): an item's + / − buttons stay locked until **that item's own code** is
  scanned (camera or USB/Bluetooth scanner). A code matches the item's barcode **or SKU** (store labels carry
  the SKU). Matching is exact (ignoring spaces, dashes, case and leading zeros); real GTINs (valid check digit) also
  match across EAN-13 / UPC-A / UPC-E / ITF-14 / GS1 (01). Different codes must never match.
- Receive (supplier purchase orders, Admin API 2026-10):
  - POs are listed newest first. No visible remove button: a long press on a PO selects it and shows Remove /
    Cancel. "Remove" only hides a PO in the app (`setPOHidden`, sheet `HiddenPOs`): Shopify's API
    cannot delete or cancel a purchase order. "Show removed purchase orders" brings it back.
  - Over-receiving is allowed: the extra is added with `inventoryAdjustQuantities`, reason `received`.
  - Rejected and Cancelled counts per item; Rejected needs the item scanned.
  - Draft shipments are marked in transit, then received.
  - Every inventory mutation sends an `@idempotent` key.
- Bin locations (`custom.bin_location` on the variant and on the product) can be edited **only in Receive** (Purchase
  orders tab: "Edit bin / expiry"; the server only accepts bins with `where: 'receive'`). The product expiry date
  (`custom.expiry_date`) can be edited in Receive and Check. Every edit is logged in the `Edits` sheet (time, where,
  product, SKU, field, old value, new value; kept 60 days). Bins are shown in Fulfill, Receive and the Pick list, and
  Fulfill and the Pick list sort by bin.
- Pick list: **no email**.
  - It is published in the app only, saved in the `PickLists` sheet.
  - Automatic: 10:00–14:00, not on Fridays. The 10:00 list collects everything waiting, then a new list whenever
    new orders qualify. A manual "Create pick list now" button also exists.
  - Eligible order: open, not cancelled, unfulfilled, and either paid, or tagged `confirmed` without `not confirmed yet`.
- POS: every sale carries a `saleId`, so a retried sale never creates a second order.
- Check (Orders tab): `lookupProduct` finds variants by barcode or SKU (numeric codes also with 12/13/14-digit
  zero padding), then by name; read-only except the expiry date. Shopify 2026 variants can have several
  barcodes (`barcodes`); `barcode` is deprecated but still returns the first one.
- Expiry report (Today): active products with `custom.expiry_date` past or within 90 days, cached 1 hour.
- Bosta bulky check (`syncBosta`, hourly trigger from `installTrigger`): new shipments come into `Tracking` from
  shipment photos, the Bosta wallet feed (`BOSTA_FEES_URL`, up to `BOSTA_FEES_PAGES` pages, default 5) and Bosta
  numbers on Shopify fulfillments (last 7 days). Checked newest first; sizes matching `FLAG_REGEX` (default
  `bulky`) go to `Bulky`. Each run saves `BOSTA_LAST_SYNC` (shown in Today); failures give one Errors line per run.
- Fulfill + Bosta waybill: a scanned code that is not an item and looks like a waybill (9-10 digits, or longer and not a
  GTIN) is checked with `checkWaybill` (exists in Bosta, and its businessReference order matches). It is sent with
  `fulfill` (checked again on the server) as trackingInfo company `Bosta` (+ `BOSTA_TRACK_URL` if set) and added
  to `Tracking` for the bulky check. An order already fulfilled opens in Fulfill (`getOrder` with `allowDone`) to add a
  Bosta number to its newest live shipment (`addOrderTracking`, `fulfillmentTrackingInfoUpdate`; existing numbers kept).
- Pick list finished mark: `setPickListDone` (sheet `PickListsDone`); finished lists are hidden in the app.
- Return shipments (own tab): `saveReturn` saves photos with carrier `Bosta return` (other carriers: `<carrier> return`),
  never touches `Tracking`; logged as `return photo`.
- Returns don't refund money; refunds are done in Shopify admin.
- Logs: the `Activity` sheet records fulfill / return / receive / pick list / photo actions, and the `Errors`
  sheet records server errors (wrong PIN or app key excluded). Both are kept for 60 days and summed up in the Today tab.

## Checking UI changes

Use Playwright with the routes mocked (see the existing tests), in English and Arabic, at phone width (390px)
and desktop width. For camera changes, test with the real html5-qrcode library and a fake camera
(`--use-file-for-fake-video-capture`).
