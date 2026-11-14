# PetFriend

One installable phone app for the store, with three tools in a bottom tab bar:

| Tab | What it does | Came from |
|---|---|---|
| **POS** | Scan or search products, cash sales, discount, printed receipt, today's sales | `POS-002` |
| **Orders** | **Fulfill**: scan an order's items, then fulfill it in Shopify · **Returns**: scan returned items, create the Shopify return, restock | `scan-fulfill` |
| **Shipments** | Photograph packages per Bosta tracking number (or another carrier), search photos, Bosta bulky-fee tracking | `Shipments-Pics` |

Each tool keeps **its own login**, the same as before: POS asks for its PIN, Orders for its API URL and app key (Settings), and Shipments for its PIN. Each one remembers its login on the phone.

A tab you leave keeps its state (for example, a POS cart survives while you check a shipment), and its camera switches off.

## Layout

```
index.html               main page: tab bar that loads each tool
manifest.webmanifest     install info (name, icons, shortcuts to each tab)
sw.js                    offline cache for all tools (bump CACHE on each release)
pos/index.html           POS
orders/index.html        Fulfill + Returns
shipments/index.html     Shipment photos
apps-script/orders/returns.gs     server code to ADD to the Orders Apps Script (returns)
apps-script/shipments/Code.gs     the Shipments Apps Script server
```

## Servers (Google Apps Script)

Each tool still talks to its own Apps Script web app, unchanged:

- **POS**: the URL is set in `pos/index.html` (`API_URL`). The server code is not in this repo.
- **Orders**: the URL and app key are entered in the app (Settings). The server code is not in this repo, apart from `apps-script/orders/returns.gs`, which adds returns. See the comment at the top of that file for setup.
- **Shipments**: the URL is set in `shipments/index.html` (`API_URL`). The server code is `apps-script/shipments/Code.gs`. Its `doGet` also serves an `Index` HTML file. That's only needed if you open the script URL directly, and the app doesn't use it.

## Hosting

The app is static files, so any https host works (GitHub Pages included). Camera scanning needs https.
After you deploy changes, bump `CACHE` in `sw.js` so phones pick up the new version.
