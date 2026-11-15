# PetFriend

One installable phone app for the store, with three tools in a bottom tab bar:

| Tab | What it does | Came from |
|---|---|---|
| **POS** | Scan or search products, cash sales, discount, printed receipt, today's sales | `POS-002` |
| **Orders** | **Fulfill**: scan an order's items, then fulfill it in Shopify · **Returns**: scan returned items, create the Shopify return, restock | `scan-fulfill` |
| **Shipments** | Photograph packages per Bosta tracking number (or another carrier), search photos, Bosta bulky-fee tracking | `Shipments-Pics` |

Each tool keeps **its own login**, entered with the **Settings** button in that tab's header: the PIN for POS, the app key for Orders, and the PIN for Shipments. Each one is remembered on the phone, so it's entered only once. The Settings window (`settings.js`) is shared by all three tabs.

**Language:** English by default. The globe button in the tab bar switches every tab between English and Arabic (right-to-left), and the phone remembers the choice. The translations are in `i18n.js`: add new on-screen text to `EXACT`, or to `PATTERNS` if it contains a name or number.

A tab you leave keeps its state (for example, a POS cart survives while you check a shipment), and its camera switches off.

## Layout

```
index.html               main page: tab bar that loads each tool
manifest.webmanifest     install info (name, icons, shortcuts to each tab)
settings.js              the Settings window (PIN / key) used by every tab
i18n.js                  English / Arabic translations (shared by all tabs)
sw.js                    offline cache for all tools (bump CACHE on each release)
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
4. In Shopify, give the **Orders** app the extra scopes `read_returns`, `write_returns` and `read_locations` for Returns, and release the new version.
5. In the editor, run **`testAll`**, allow the permissions it asks for, and check that the log shows `OK` everywhere.
6. Run **`installTrigger`** once. This also fixes the hourly Bosta sync, which never synced anything with the old code.
7. **Deploy → Manage deployments →** the pencil icon on the web app **→ Version: New version → Deploy**. The URL stays the same.
8. Point the POS and Orders tabs to that URL (`API_URL` in `pos/index.html` and `orders/index.html`). **Done**: all three tabs use the Shipments project's URL.

The old POS and Orders scripts can stay as a backup until everything works, and then be deleted.

## Hosting

The app is static files, so any https host works (GitHub Pages included). Camera scanning needs https.
After you deploy changes, bump `CACHE` in `sw.js` so phones pick up the new version.
