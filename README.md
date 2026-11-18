# PetFriend

One installable phone app for the store, with three tools in a bottom tab bar:

| Tab | What it does | Came from |
|---|---|---|
| **POS** | Scan or search products, cash sales, discount, printed receipt, today's sales | `POS-002` |
| **Orders** | **Fulfill**: scan an order's items, then fulfill it in Shopify · **Returns**: scan returned items, create the Shopify return, restock · **Receive**: scan stock arriving from a supplier against its Shopify purchase order and add it to inventory; per item you can also set **Rejected** (damaged or wrong units; needs the item scanned) and **Cancelled** (not coming), and receive **more** than ordered (the extra is added to stock at the PO's location), showing each item's variant and product bin location (`custom.bin_location`) and the product's expiry date (`custom.expiry_date`, red when past). All three can be edited from the item's **Edit** button (other keys: `BIN_VARIANT_METAFIELD`, `BIN_PRODUCT_METAFIELD`, `EXPIRY_METAFIELD` Script Properties) | `scan-fulfill` |
| **Pick list** | Products of the orders ready to pick (unfulfilled and paid, or tagged `confirmed` without `not confirmed yet`), combined per variant, sorted by bin location, with picture, SKU, quantity, bins and order numbers. Tick lines as they are picked, print it, or email it as a PDF | the pick list Apps Script project |
| **Shipments** | Photograph packages per Bosta tracking number (or another carrier), search photos, Bosta bulky-fee tracking | `Shipments-Pics` |

Each tool keeps **its own login**, entered with the **Settings** button in that tab's header: the PIN for POS, the app key for Orders, and the PIN for Shipments. Each one is remembered on the phone, so it's entered only once. The Settings window (`settings.js`) is shared by all three tabs.

**Language:** English by default. The globe button in the tab bar switches every tab between English and Arabic (right-to-left), and the phone remembers the choice. The translations are in `i18n.js`: add new on-screen text to `EXACT`, or to `PATTERNS` if it contains a name or number.

**Scanning rule (Fulfill, Returns, Receive):** each item's + / − buttons stay locked until that item's own code is scanned (camera or barcode scanner): its barcode or its SKU, since many labels carry the SKU. A wrong code unlocks nothing, and only scanned items can be fulfilled, returned or received. Items with neither a barcode nor a SKU are flagged.

A tab you leave keeps its state (for example, a POS cart survives while you check a shipment), and its camera switches off.

## Layout

```
index.html               main page: tab bar that loads each tool
manifest.webmanifest     install info (name, icons, shortcuts to each tab)
settings.js              the Settings window (PIN / key) used by every tab
i18n.js                  English / Arabic translations (shared by all tabs)
sw.js                    offline cache for all tools (bump CACHE on each release)
picklist/index.html      Pick list
pos/index.html           POS
orders/index.html        Fulfill + Returns
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
4. In Shopify, give the **Orders** app the extra scopes `read_returns`, `write_returns` and `read_locations` for Returns, plus `read_inventory_purchase_orders`, `read_inventory_transfers`, `read_inventory`, `write_inventory_shipments_received_items`, `write_inventory_shipments`, `write_inventory` (extra units beyond the PO) and `write_products` (to edit bin locations and expiry dates) for Receive. Then release the new version and approve it in the Shopify admin.
5. In the editor, run **`testAll`**, allow the permissions it asks for, and check that the log shows `OK` everywhere.
6. Run **`installTrigger`** once. This also fixes the hourly Bosta sync, which never synced anything with the old code.
7. **Deploy → Manage deployments →** the pencil icon on the web app **→ Version: New version → Deploy**. The URL stays the same.
8. Point the POS and Orders tabs to that URL (`API_URL` in `pos/index.html` and `orders/index.html`). **Done**: all three tabs use the Shipments project's URL.

The old POS and Orders scripts can stay as a backup until everything works, and then be deleted.

### Pick list email (moved from the separate pick list project)

- Script Properties: `PICKLIST_EMAILS` = the recipients, comma-separated (kept out of the code because this repository is public). `SPREADSHEET_ID` is only needed if the script is not opened from the sheet; the list is written to a sheet named `Picklist`.
- Run `createPicklistTrigger` once: every 10 minutes, 10:00 to 14:00, not on Fridays, new eligible orders are emailed as a PDF (orders already sent are skipped; that memory is kept for 30 days).
- `sendPicklistManually` emails all eligible open orders; the app's **Email PDF** button does the same.
- After switching over, remove the trigger from the old pick list project so the email isn't sent twice.

## Hosting

The app is static files, so any https host works (GitHub Pages included). Camera scanning needs https.
After you deploy changes, bump `CACHE` in `sw.js` so phones pick up the new version.
