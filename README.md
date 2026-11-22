# PetFriend

One installable phone app for the store, with its tools in a bottom tab bar (a side bar on a computer):

| Tab | What it does | Came from |
|---|---|---|
| **POS** | Scan or search products, cash sales, discount, printed receipt, today's sales | `POS-002` |
| **Orders** | **Fulfill**: scan an order's items, then fulfill it in Shopify (scan the Bosta waybill too, and its tracking number is saved on the fulfillment when Bosta confirms it is for this order); items are sorted by bin location and show the variant / product bin · **Returns**: scan returned items, create the Shopify return, restock · **Receive** (its own **Purchase orders** tab): scan stock arriving from a supplier against its Shopify purchase order and add it to inventory; per item you can also set **Rejected** (damaged or wrong units; needs the item scanned) and **Cancelled** (not coming), and receive **more** than ordered; **Remove** hides a purchase order from the list on every phone (it stays in Shopify; **Show removed purchase orders** brings it back) (the extra is added to stock at the PO's location), showing each item's variant and product bin location (`custom.bin_location`) and the product's expiry date (`custom.expiry_date`, red when past). The bin locations are shown only (read-only); the expiry date can be edited from the item's **Edit expiry** button. **Print labels** prints a barcode label (Code 128 of the SKU, else the barcode, with bin and expiry) per unit received, on a label printer (50×25, 40×30, 58×40 mm) or an A4 sheet of 3×7 stickers (other keys: `BIN_VARIANT_METAFIELD`, `BIN_PRODUCT_METAFIELD`, `EXPIRY_METAFIELD` Script Properties) | `scan-fulfill` |
| **Check** (own tab, also in Orders) | Scan a barcode (camera or scanner) or type a SKU or name: shows the product's picture, price (and the old price), SKU and all its barcodes, stock per location, bin locations and expiry date (red when past, orange within 30 days). From the card you can edit the expiry date or print a label. Read-only otherwise | new |
| **Pick list** | Products of the orders ready to pick (unfulfilled and paid, or tagged `confirmed` without `not confirmed yet`), combined per variant, sorted by bin location, with picture, SKU, quantity, bins and order numbers. Lists are published automatically from 10:00 to 14:00 when new orders qualify, or with **Create pick list now**. Tick lines as they are picked, or print a list. **✓ Finished** hides a pick list on every phone (**Show finished pick lists** shows them again, and **Open again** undoes it). Each order number is a button: tap it to open that order in **Fulfill**; fulfilled orders are shown green with ✓, and the line *Orders fulfilled: X of Y* shows the progress | the pick list Apps Script project |
| **Today** | The day in one screen: POS sales, orders fulfilled, open orders, returns, stock received (extra / rejected / cancelled), pick lists, shipment photos, today's server errors and the Bosta bulky check (last run, shipments checked, bulky found; orange when the hourly check is off or late), plus **Expiry dates**: products whose `custom.expiry_date` is past or within 30 / 60 / 90 days (in stock only, or all), with SKU, bin and stock, and labels can be printed from the list. The expiry check reads every active product and is cached for an hour (**Check again** reads now). Refreshes every 2 minutes and whenever the tab is opened. Uses the Orders app key | new |
| **Shipments** | Photograph packages per Bosta tracking number (or another carrier); search photos.
| **Return shipments** | Its own tab: scan and photograph shipments that came back (saved as returns, apart from outgoing photos); search photos; Bosta bulky-fee tracking | `Shipments-Pics` |

Each tool keeps **its own login**, entered with the **Settings** button in that tab's header: the PIN for POS, the app key for Orders, and the PIN for Shipments. Each one is remembered on the phone, so it's entered only once. The Settings window (`settings.js`) is shared by all three tabs.

**Language:** English by default. The **Settings** window of any tab has a Language choice (English / العربية); it switches every tab at once (Arabic is right-to-left), and the phone remembers the choice. The translations are in `i18n.js`: add new on-screen text to `EXACT`, or to `PATTERNS` if it contains a name or number.

**Scanning rule (Fulfill, Returns, Receive):** each item's + / − buttons stay locked until that item's own code is scanned (camera or barcode scanner): its barcode or its SKU, since many labels carry the SKU. A wrong code unlocks nothing, and only scanned items can be fulfilled, returned or received. Items with neither a barcode nor a SKU are flagged.

A tab you leave keeps its state (for example, a POS cart survives while you check a shipment), and its camera switches off.

## Layout

```
index.html               main page: tab bar that loads each tool
manifest.webmanifest     install info (name, icons, shortcuts to each tab)
config.js                the server URL, shared by every tab
settings.js              the Settings window (PIN / key) used by every tab
i18n.js                  English / Arabic translations (shared by all tabs)
sw.js                    offline cache for all tools (bump CACHE on each release)
picklist/index.html      Pick list
today/index.html         Today (daily summary + expiry dates)
labels.js                barcode label printing (Code 128), used by Receive and Today
pos/index.html           POS
orders/index.html        Fulfill + Returns + Receive
shipments/index.html     Shipment photos
apps-script/Code.gs      the ONE Apps Script server for POS, Orders (fulfill + returns) and Shipments
```

## Server (Google Apps Script)

`apps-script/Code.gs` is one script for all three tabs. It recognises which tab a request comes from and answers in the same format each tab already expects. Each tab keeps its own login: POS checks `POS_PIN`, Orders checks `APP_KEY`, and Shipments checks `APP_PIN`. The full list of Script Properties is in the comment at the top of the file.

### Moving to the single script (one time)

The easiest home for it is the **existing Shipments project**, because it's already attached to the sheet and already has the Bosta settings, the photo folder and the trigger. Its web-app URL also stays the same.

1. Open the Shipments Apps Script project (from the sheet: **Extensions → Apps Script**).
2. Replace everything in `Code.gs` with `apps-script/Code.gs` from this repo, then save. The old `Index` HTML file can stay; nothing uses it.
3. **Project Settings → Script properties**: add the properties of the other two projects, with the same names and values:
   - from the **POS** project: `POS_PIN`, `SHOP`, `CLIENT_ID`, `CLIENT_SECRET`
   - from the **Orders** project: `APP_KEY`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, and `SHOPIFY_STORE` (`xxx.myshopify.com`) if it isn't there yet
4. In Shopify, give the **Orders** app the extra scopes `read_returns`, `write_returns` and `read_locations` for Returns, plus `read_inventory_purchase_orders`, `read_inventory_transfers`, `read_inventory`, `write_inventory_shipments_received_items`, `write_inventory_shipments`, `write_inventory` (extra units beyond the PO) and `write_products` (to edit the expiry date) for Receive. Then release the new version and approve it in the Shopify admin.
5. In the editor, run **`testAll`**, allow the permissions it asks for, and check that the log shows `OK` everywhere.
6. Run **`installTrigger`** once. This also fixes the hourly Bosta sync, which never synced anything with the old code.
7. **Deploy → Manage deployments →** the pencil icon on the web app **→ Version: New version → Deploy**. The URL stays the same.
8. Every tab reads the server URL from one place: `PF_API_URL` in `config.js`. **Done**: all tabs use the Shipments project's URL.

The old POS and Orders scripts can stay as a backup until everything works, and then be deleted.

### Pick list (moved from the separate pick list project, no email any more)

- Pick lists are published **in the app only**. Each one holds the qualifying orders that were not on an earlier pick list, and is saved in the `PickLists` sheet of the script's spreadsheet (or `SHEET_ID`). Lists older than 30 days are removed.
- Run `createPicklistTrigger` once. From 10:00 to 14:00, not on Fridays, a check runs every 10 minutes. The 10:00 check collects every order waiting since the last list, and later checks make a new list whenever new orders qualify.
- The app's **Create pick list now** button, or `createPickListNow` in the editor, makes one at any time.
- Remove the trigger from the old pick list project, which still emails.

### Logs (`Activity` and `Errors` sheets)

- `Activity`: one row per fulfilled order, return, purchase-order receipt, pick list and shipment photo (time, tab, action, reference, quantity, details).
- `Errors`: one row per server error (time, tab, action, message). Wrong PIN / app key attempts are not logged.
- Both sheets are created automatically and rows older than 60 days are removed once a day by the pick list trigger. The **Today** tab sums them up.

## Linking GitHub to the Apps Script project (automatic deploy)

`.github/workflows/deploy-apps-script.yml` deploys `apps-script/Code.gs` whenever it changes on `main`, or from **Actions → Deploy Apps Script → Run workflow**:

1. It runs `tests/server-test.js`. If any check fails, nothing is deployed.
2. It pulls the live project and replaces only `Code`. Other files (like `Index`) and the project settings stay as they are.
3. It publishes a new version on the **existing** web app, so the URL doesn't change.
4. It opens the web-app URL and checks it shows the new `SERVER_VERSION`.

One-time setup:

1. **Turn on the Apps Script API:** https://script.google.com/home/usersettings → *Google Apps Script API* → On.
2. **Log clasp in with your Google account.** On a computer with Node.js, or in Google Cloud Shell (shell.cloud.google.com, nothing to install), run:
   `npx @google/clasp@2.4.2 login` (in Cloud Shell add `--no-localhost`).
   This creates the file `~/.clasprc.json`. Show it with `cat ~/.clasprc.json` and copy all of it.
3. In GitHub, go to the repo's **Settings → Secrets and variables → Actions**:
   - **Secrets → New repository secret:** `CLASPRC_JSON` = the copied contents. Treat it like a password: it lets the workflow edit your Apps Script projects.
   - **Variables → New repository variable:** `SCRIPT_ID` = Apps Script → ⚙ Project Settings → IDs → *Script ID*.
   - **Variables → New repository variable:** `DEPLOYMENT_ID` = Apps Script → Deploy → Manage deployments → the web app's *Deployment ID*. Use the one the app's URL belongs to, not a new deployment.
4. Go to **Actions → Deploy Apps Script → Run workflow** and check that it ends green.

Until the secret and variables exist, the workflow only runs the tests.

## Hosting

The app is static files, so any https host works (GitHub Pages included). Camera scanning needs https.
After you deploy changes, bump `CACHE` in `sw.js` so phones pick up the new version.
