# Sky's Expenses

A personal expense tracker for iPhone. It reads bank SMS from SBI, ICICI, HDFC, Axis and Kotak (accounts and credit cards) through an iOS Shortcuts automation and shows spending, income, budgets and charts in an app you add to your Home Screen.

Every person who uses it keeps their data in **their own Google Sheet**. This repository holds only code: no data, no keys and no links to anyone's sheet.

## How it fits together

```
Bank SMS ──▶ iPhone Shortcuts automation ──▶ your Google Apps Script ──▶ your Google Sheet
                                                    ▲
                    Expenses app (this site) ───────┘  reads with your view key
```

- `docs/` holds the installable app (GitHub Pages serves this folder).
- `apps-script/Code.gs` and `apps-script/Dashboard.html` go into each person's own Google Sheet.
- `build_app.py` rebuilds `docs/index.html` from `apps-script/Dashboard.html`.

## Set it up for yourself (about 15 minutes)

You need three links from the person who shared this with you: the **template sheet** link, the **Log Bank SMS** shortcut link and the **Spending Summary** shortcut link.

1. **Your sheet.** Open the template sheet link and tap **Make a copy**. In your copy, open **Extensions → Apps Script**, choose `setup` and click **Run**, then approve the permissions. (It's your own copy of the script, running only in your account, with its own new keys.)
2. **Your link.** In Apps Script: **Deploy → New deployment → Web app**, set *Execute as* **Me** and *Who has access* **Anyone**, then **Deploy**. Copy the Web app URL. This is your *receive link*.
3. **Your keys.** The **Setup** tab of your sheet now shows a **Secret key** (for the Log Bank SMS shortcut, which can only add transactions) and a **View key** (for the app and the summary, which can read them).
4. **The shortcuts.** Add both shortcuts from their links. In each one, replace `PASTE-YOUR-RECEIVE-LINK` with your receive link. Put your Secret key in Log Bank SMS and your View key in Spending Summary, where it says `PASTE-YOUR-…-KEY`.
5. **The automations.** In Shortcuts, **Automation → + → Message**, *Message Contains* `debit`, **Run Immediately**, **Run Shortcut → Log Bank SMS**, input **Shortcut Input**. Repeat for `spent`, `withdrawn`, `credited`, `Sent Rs`, `Received Rs`, `deposited` and `Txn`. Then **Automation → + → Time of Day**, 9:00 PM daily, **Run Immediately**, **Run Shortcut → Spending Summary**.
6. **The app.** Open the app link in **Safari**, tap **Share → Add to Home Screen**, then open **Expenses** from your Home Screen and paste your receive link and View key.

Delete the **Setup** tab once both keys are copied.

## Sharing it with a friend (for the owner, once)

1. **Template sheet.** Create a new blank Google Sheet named *Sky Expenses*. Open **Extensions → Apps Script** and paste `apps-script/Code.gs` into `Code.gs` and `apps-script/Dashboard.html` into a new HTML file named `Dashboard`. Save, but **don't run setup**, so it holds no keys and no data. Click **Share**, set *General access* to **Anyone with the link** as **Viewer**, and copy the link. Change the end of the link from `/edit…` to `/copy`. That's the template link.
2. **Shortcut links.** In Shortcuts, long-press **Log Bank SMS → Duplicate**. In the copy, replace your receive link with `PASTE-YOUR-RECEIVE-LINK` and your secret key with `PASTE-YOUR-SECRET-KEY`, then **Share → Copy iCloud Link**. Do the same for **Spending Summary**, using `PASTE-YOUR-VIEW-KEY`. Never share the originals: they contain your link and keys.
3. Send your friend the template link, both shortcut links, the app link and this page.

## Privacy

- Each transaction row stores date, bank, amount, merchant, category, last 4 digits and payment mode. The SMS text itself is never stored.
- One-time passwords, reminders, offers, failed transactions and credit card bill payments are ignored.
- If the network is down, the shortcut keeps the message in a file on the phone until it's delivered, then empties the file.
- The secret key can only add rows. The view key can read and edit your rows, so keep it on your own phone. A copied sheet always gets new keys when `setup` runs.
