# PetFriend app: notes for Claude

Installable web app (PWA) for the Pet Friend store, hosted on GitHub Pages from `main`.
The owner writes in Arabic (Egyptian); answer in the language they use. **All Arabic in the app and in Telegram
messages is Modern Standard Arabic (فصحى), never colloquial** (owner's rule): e.g. كلمة المرور not باسورد, الخادم not السيرفر.

## Layout

- `index.html`: main page with the tab bar. Each tab is its own page in an iframe:
  `pos/`, `tasks/` (staff tasks), `customers/` (customer service), `check` (= `orders/index.html?only=check`: Check mode only), `orders/` (Fulfill · Returns · Check),
  `receive` (= `orders/index.html?only=receive`: purchase orders),
  `picklist/`, `shipments/` (outgoing: Save + Search), `returns` (= `shipments/index.html?only=returns`: Save return +
  Search), `today/`.
  The main page passes messages between tabs: `pf-hide` (camera off), `pf-show` (refresh) and `pf-open-order`
  (from the Pick list, opens an order in Fulfill).
- Pages put `[hidden] { display: none !important; }` first in their CSS, so `hidden` beats classes that set display.
- `i18n.js`: English → Arabic dictionary (`EXACT`, `PATTERNS`). Screens are written in English and translated
  live. Data (product names, customers, codes, bins, dates) must carry `data-no-i18n` and `dir="ltr"`.
- `config.js`: the server URL (`PF_API_URL`), used by every tab. Don't copy the URL into pages. Every server reply
  carries `sv` (SERVER_VERSION); `PF_MIN_SERVER` is the oldest server the app works with: when the live server is older
  (or sends no `sv`), every tab shows a warning bar. **Raise `PF_MIN_SERVER` whenever the app needs a new server change.**
- `settings.js`: the Settings window (PIN / app key, and the English / Arabic choice), shared by every tab, and the
  branded `pfConfirm` / `pfAlert` windows. Never use the browser's `confirm()` / `alert()` / `prompt()`. The tab bar
  has no language button; Today is the HOME screen with no tab button: the app opens on it, Android Back returns to it
  (one history entry above home; Back from ANY page, the Dashboard too, goes to the big-buttons home, never closes the
  app: Android Chrome ignores a history step pushed without a real tap (swipes, taps inside a page frame), so `go` pushes
  only while `navigator.userActivation.isActive`, else `ensureStep` adds it at the next tap: pages send `pf-act` on
  pointerup, see settings.js; settings.js also sets `html{touch-action:pan-y pinch-zoom}` so a sideways swipe is not a
  browser scroll and counts as a real touch), and a tab's header logo, the desktop side-bar logo or tapping the open tab again go
  home. Tab bar: POS · Check · Orders · Purchase orders · Pick list · Shipments · Return shipments (7, a bit larger;
  Customers and Tasks moved to big home buttons at the owner's request; all fit from 320px). Swipe left / right on any page moves to the next / previous page (mirrored in Arabic): `settings.js` sends
  `pf-swipe` (quick, mostly sideways, not from text boxes / sideways-scrolling lists / the camera / open windows), the main
  page follows `ORDER` = home, then the tab bar's own order (read from `#tabs`: pos, check, orders, receive, picklist,
  shipments, returns), then customers, tasks, dashboard; a swipe goes to the neighbour on the bar's side (mirrored in Arabic), with a
  slide-in. Home buttons: the one pressed LAST stays red (`.last`, remembered in `pf_home_last`), the others plain. Arabic brand name: بتفريند. Page headers show only the section name (e.g. "الطلبات"); the brand ("بتفريند") is only in the home header (owner's rule).
- `labels.js`: barcode labels, always 50 mm wide x 25 mm tall (owner's paper), used by Purchase orders, Check and Today.
  Each label shows values only, no captions (no "SKU", "EXP", "V:", "P:"): the product / variant name on ONE line (when
  too long: its start + "... " + its end, the end being the variant part after " - ", e.g. "... 100 ml"), SKU and expiry
  date (`custom.expiry_date`, never the previous batch's), the item's **barcode** as Code 128 bars + number, and
  "variant bin | product bin". Every item must have a barcode AND both bins, otherwise nothing is printed and what is
  missing is listed. Arabic text (names, bins) is drawn by the browser with the Cairo font shipped in `fonts/Cairo-Bold.ttf` (OFL)
  and put in the PDF as a ~400 dpi picture (jsPDF's own Arabic shaping breaks words and mixed text); Latin text stays real
  PDF text. Purchase orders: one label per unit, exactly the PO quantity of each variant (lines of the same
  variant added up), not editable. "Save PDF to Drive" builds the PDF in the browser (jsPDF from cdnjs,
  one 50x25 mm page per label) and `saveLabels` stores it in the Drive folder "PetFriend Labels" (`LABELS_FOLDER_ID`);
  "Print here" uses the browser. Tests decode the printed barcodes with html5-qrcode.
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
- Edits made in the Apps Script editor are overwritten by the next deploy unless saved to GitHub first:
  `sync` / `tools\pull-apps-script.cmd` (Windows: clasp pull, copy to apps-script/Code.gs, run the tests, commit, push).

## Rules agreed with the owner

- Logins: each tab has its own pass, entered in Settings and named after its section: "POS pass" (`POS_PIN`),
  "Orders pass" (`APP_KEY`: Orders, Check, Purchase orders, Pick list, Today), "Shipments pass" (`APP_PIN`: Shipments,
  Return shipments). Every tab header has a language button (English / العربية) next to Settings (added by settings.js).
- Scanning (Fulfill, Returns, Receive): an item's + / − buttons stay locked until **that item's own code** is
  scanned (camera or USB/Bluetooth scanner). A code matches the item's barcode **or SKU** (store labels carry
  the SKU). Matching is exact (ignoring spaces, dashes, case and leading zeros); real GTINs (valid check digit) also
  match across EAN-13 / UPC-A / UPC-E / ITF-14 / GS1 (01). Different codes must never match.
  A variant can have several barcodes (Shopify 2026 `barcodes`): every one of them matches. `getOrder`, `getReturnable`
  and `getPO` add them with `addBarcodes_` (a separate light query, so the big queries stay under the cost limit; if it
  fails, the first barcode still works).
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
  (`custom.expiry_date`) and the expiry date of the previous batch (`custom.expiry_date_of_previous_batch`, product
  metafield, `EXPIRY_PREV_METAFIELD`) can be edited in Receive and Check. When the previous batch date is set (and differs
  from the current one), Fulfill and the Pick list show "Old batch first" (red "do not send it" when it has expired);
  clear the field once the old batch is gone. Every edit is logged in the `Edits` sheet (time, where,
  product, SKU, field, old value, new value; kept 60 days). Bins are shown in Fulfill, Receive and the Pick list, and
  Fulfill and the Pick list sort by bin.
- Pick list: **no email**.
  - It is published in the app only, saved in the `PickLists` sheet.
  - Automatic: 10:00–14:00, not on Fridays. The 10:00 list collects everything waiting, then a new list whenever
    new orders qualify. A manual "Create pick list now" button also exists.
  - Eligible order: open, not cancelled, unfulfilled, and either paid, or tagged `confirmed` without `not confirmed yet`.
- POS: every sale carries a `saleId`, so a retried sale never creates a second order. The POS logs in with its own app
  (`SHOP`, `CLIENT_ID`, `CLIENT_SECRET`; SHOP in any form); if Shopify refuses that login it uses the Orders app login for
  the same store (one Errors line, retried after an hour). Shopify web pages give a clear error, never "Unexpected token".
- Check (Orders tab): `lookupProduct` finds variants by barcode or SKU (numeric codes also with 12/13/14-digit
  zero padding), then by name; read-only except the expiry date. Shopify 2026 variants can have several
  barcodes (`barcodes`); `barcode` is deprecated but still returns the first one.
- Expiry report (Today): active products with `custom.expiry_date` past or within 90 days, cached 1 hour.
- Bosta bulky check (`syncBosta`, hourly trigger from `installTrigger`): new shipments come into `Tracking` from
  shipment photos, the Bosta wallet feed (`BOSTA_FEES_URL`, up to `BOSTA_FEES_PAGES` pages, default 5) and Bosta
  numbers on Shopify fulfillments (last 7 days). Checked newest first; sizes matching `FLAG_REGEX` (default
  `bulky`) go to `Bulky`. Each run saves `BOSTA_LAST_SYNC` (shown in Today); failures give one Errors line per run.
  Bulky shipments of the last 14 days: Today section (`bulkyList`, read-only, + job status) and "Check with Bosta now" /
  sheet menu `bulkyLast14Days` (`bulkyCheck` → `bulkyBackfill_` starts a BACKGROUND job `bulkyJob` (one-off triggers;
  a web request is stopped after 6 min): imports from Bosta's own list (`importFromBostaList_`, deliveries/search,
  newest first, `BOSTA_SEARCH_URL` to change it; the endpoint is not in Bosta's public docs, so a failure is reported,
  not guessed), the wallet feed (more pages) and Shopify fulfillments (paged), then checks in rounds of 4.5 min that go
  on where the last stopped (`from`), up to 8 rounds; state in `BULKY_JOB`; the result with what each source brought
  goes to the group). The long Bosta runs use their own cache flag `bosta_busy` (`bostaBusy_`), never the script lock for
  minutes (that blocked adding an employee: "Lock timeout"); the hourly run skips while the job runs. Found 2026-11-25: Tracking only got photographed shipments after 11/11 (wallet feed added nothing). Dated by Bosta's
  shipment date (`ShipmentDate`, column 15 of `Bulky`), else the day it was found.
- Fulfill, Returns and "Save tracking" (order already fulfilled) REQUIRE two steps (owner's rule), shown as a 2-step panel
  (`#trackLine.steps`): 1. scan the shipment barcode (Bosta waybill; in Returns the return shipment's barcode, any order;
  another carrier's label → "Other carrier" asks the carrier name and keeps the code as typed), 2. take its photo
  (`#photoIn`, camera, shrunk to 1600 px JPEG). The action button stays disabled until both are done, and the server
  refuses without them (`needShipmentPhoto_`, "Step 1/2" messages, not logged). After Shopify accepts, `saveOrderPhoto_`
  saves the photo like a Shipments photo (Drive + `Shipments` sheet, note "Order #…"; carrier `Bosta` / `<carrier>` /
  `… return`; a Bosta fulfill photo also counts in `Tracking`). A photo that fails to save never fails the action.
- Today (home) shows ONLY big buttons: Orders, Pick list, Shipments, POS, Purchase orders, Return shipments, Customer
  service, Tasks, and a
  full-width Dashboard (`pf-go` message to the main page). The Dashboard is the same page with `?view=dashboard`
  (tab `dashboard`, no tab-bar button, Back returns home): today's tiles, errors, bulky shipments, expiry dates. Home
  makes no server calls.
- Fulfill + Bosta waybill: a scanned code that is not an item and looks like a waybill (9-10 digits, or longer and not a
  GTIN) is checked with `checkWaybill` (exists in Bosta, and its businessReference order matches). It is sent with
  `fulfill` (checked again on the server) as trackingInfo company `Bosta` (+ `BOSTA_TRACK_URL` if set) and added
  to `Tracking` for the bulky check. An order already fulfilled opens in Fulfill (`getOrder` with `allowDone`) to add a
  Bosta number to its newest live shipment (`addOrderTracking`, `fulfillmentTrackingInfoUpdate`; existing numbers kept).
- Pick list finished mark: `setPickListDone` (sheet `PickListsDone`); finished lists are hidden in the app.
- Return shipments (own tab): `saveReturn` saves photos with carrier `Bosta return` (other carriers: `<carrier> return`),
  never touches `Tracking`; logged as `return photo`.
- Photo log ("Log" in Shipments and Return shipments): `getShipmentLog(pin, period, kind, text)` reads the `Shipments`
  sheet: one entry per tracking number in the period (today / yesterday / 7 / 30 days; outgoing or returns), newest
  first, with first / last photo time (Cairo), carrier, notes ("Order #…"), photo count; search by number or note.
  Opening an entry loads small thumbnails (`getShipmentThumbs`, ≤12, Drive links).
- Telegram group notifications (server only): `tgNotify_` sends to `TELEGRAM_CHAT_ID` with `TELEGRAM_BOT_TOKEN` (Script
  Properties, never in code): new pick list, new bulky shipment, errors (once per part/action per 30 min; wrong passes
  excluded) and the 21:00 daily report (`dailyTelegramReport`, trigger from `installTelegramTrigger`). Setup helpers:
  `telegramFindChat`, `testTelegram`. `TELEGRAM_OFF` silences kinds (picklist, bulky, errors, daily). A failed send
  never breaks an action and is never logged to Errors (it would notify again).
- Secrets: the Apps Script Project Settings page saves ALL Script Properties at once, so a stale page / second tab puts
  old secrets back (seen with CLIENT_SECRET, also in the owner's other projects; the live project only has Code.js and
  appsscript.json, and the code never writes secrets). The spreadsheet menu "بتفريند" (`onOpen`, `menuSetPosLogin`,
  `menuSetOrdersLogin`) checks a Client ID / secret with Shopify (`setShopifyLogin_`) and saves only if accepted.
  `watchSecrets_` (hourly in `syncBosta`, and when the POS login is refused) keeps fingerprints (never values) in
  `SECRET_WATCH` and logs to Errors (+ Telegram) when a watched secret changes or goes back to an older value.
  Secrets are always read fresh from Script Properties; saved Shopify tokens are keyed by a fingerprint of their
  Client ID + secret (`tokKey_`), so a changed secret never reuses a token made from the old one, and the POS leaves
  the Orders app fallback as soon as its own secret changes.
- Tasks (own tab, `tasks/index.html`; server `TASK_ACTIONS`, body `{action, tpin}`): staff tasks with Telegram.
  - "Tasks pass": the manager's (`MANAGER_PIN`, set from the sheet menu) sees and edits everything; each employee has
    their own pass, set by the manager in the app and stored only as a salted SHA-256 hash (`TASK_SALT`), and sees only
    their own tasks. Typing mistakes (`uerr_`) are shown in the app, never logged to Errors / Telegram.
  - Sheets `TaskStaff`, `Tasks`, `TaskRepeats`. One-time tasks have a due date (+ optional time); recurring tasks are
    weekly (weekday 1 = Monday .. 7 = Sunday) or monthly (day 29-31 = last day in shorter months), made by
    `tasksMorning` (09:00) once a day each (`LastMade`), or at once when saved on their day.
  - Telegram: each employee links by opening `t.me/<bot>?start=<LinkCode>` (Staff: Send link). New / changed tasks
    are sent to them with a "✅ خلصت" button; every morning a summary of their open tasks with buttons. `tgPoll`
    (every minute, `getUpdates` with `TG_OFFSET`) handles /start, /tasks and the buttons (only the task's own employee
    can finish it); a finished task is announced in the group (kind `tasks`). Triggers: `installTasksTriggers`
    (sheet menu). `tgPoll` reads the bot's messages, so group ids seen are kept in `TG_SEEN_GROUPS` for `telegramFindChat`.
- Customer service (own tab, `customers/index.html`; actions `reqInit`, `reqSave`, `reqStatus`, same Tasks pass so each
  entry records who wrote it; sheet `Requests`): order cancel / change requests (open → done / rejected), inspection
  requests (pending → allowed / denied: two buttons in the Telegram group, `ia:` / `in:` callbacks handled by `tgPoll`,
  only from the store group, the first answer wins and the answerer's name is saved; in the app only the manager can
  answer) and customer complaints (open → working → resolved with a note; category + channel). The order number is
  checked in Shopify (`reqOrder_`) and its total / fulfillment status shown; a cancel / change on a fulfilled order is
  flagged. Every new entry and status change goes to the group (kind `requests`).
  Order requests also include RETURN (`ret`) and EXCHANGE (`exchange`) requests: pending → approval by the manager (app)
  or the group (Telegram buttons `rf:` free / `rp:` customer pays / `rr:` refuse, first answer wins, name saved) →
  `free` / `paid` / `rejected`; only an approved one can be marked `done` (anyone). An exchange needs details; a return /
  exchange on an order not fulfilled yet is flagged. The app has a "Waiting for approval" filter. Photos (camera or
  gallery, ≤5 per save, ≤10 per request, shrunk to 1600 px) for complaints, returns and exchanges: Drive folder
  "Customer Service Photos" (`COMPLAINT_FOLDER_ID`), ids in the `Photos` column, thumbnails read through the server
  (`reqPhotos`), more added later (`reqAddPhotos`), sent to the group as an album (`tgGroupPhotos_`).
- Monthly evaluation (Tasks tab, "Evaluation"; actions `evalInit`, `evalSave`, `evalConfig`; sheet `Evaluations`, one
  row per month; settings in Script Property `EVAL_CONFIG`): the owner's social media sheet: conversations started
  (target 70), posts (8, sanction below 3), stories (8, below 3), response rate % (96.4, below 95), response time in
  minutes (90, lower is better, sanction above 100; "1 hr 15m" / "1:15" accepted), net follows (100). An item is
  achieved when it reaches its target (the owner's sheet marked 95.2% vs 96.4% as achieved; the app does not: told
  the owner). Result = achieved / all, rounded; target met at `pass` % (66). Only the chosen employee (and the manager)
  sees and fills it. On `day` (23; last day in shorter months) `tasksMorning` makes her a task (`RepeatId` EVAL-yyyy-MM),
  closed when she submits; the result goes to the group.
- Every employee notice also goes to the group: each new task (also before the employee links Telegram), linking,
  finished tasks, and one morning list of everyone's open tasks.
- Returns don't refund money; refunds are done in Shopify admin.
- Logs: the `Activity` sheet records fulfill / return / receive / pick list / photo actions, and the `Errors`
  sheet records server errors (wrong PIN or app key excluded). Both are kept for 60 days and summed up in the Today tab.

## Checking UI changes

Use Playwright with the routes mocked (see the existing tests), in English and Arabic, at phone width (390px)
and desktop width. For camera changes, test with the real html5-qrcode library and a fake camera
(`--use-file-for-fake-video-capture`).
