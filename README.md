# Sky's Expenses

A personal expense tracker for iPhone. It reads SBI and ICICI bank SMS through an iOS Shortcuts automation and shows spending, income, budgets and charts in an app you add to your Home Screen.

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

1. **Your sheet.** Open the template sheet link you were given and tap **File → Make a copy**. In the copy, open **Extensions → Apps Script**, choose `setup` and click **Run**, then approve the permissions. (It's your own copy of the script, running only in your account.)
2. **Your link.** In Apps Script: **Deploy → New deployment → Web app**, set *Execute as* **Me** and *Who has access* **Anyone**, then **Deploy**. Copy the Web app URL. This is your *receive link*.
3. **Your keys.** The **Setup** tab of your sheet now shows a **Secret key** (for the shortcut, which can only add transactions) and a **View key** (for the app, which can read them).
4. **The shortcut.** Add the *Log Bank SMS* shortcut from the iCloud link you were given. Put your receive link in **Get contents of** and your Secret key in the `key` field. Then create the message automations: **Automation → + → Message**, *Message Contains* `debit`, then `spent`, `withdrawn` and `credited` (one automation each), **Run Immediately**, **Run Shortcut → Log Bank SMS**, input **Shortcut Input**.
5. **The app.** Open the app link in **Safari**, tap **Share → Add to Home Screen**, then open **Expenses** from your Home Screen and paste your receive link and View key.

Delete the **Setup** tab once both keys are copied.

## Privacy

- Each transaction row stores date, bank, amount, merchant, category, last 4 digits and payment mode. The SMS text itself is never stored.
- One-time passwords, reminders, offers and failed transactions are ignored.
- The secret key can only add rows. The view key can read and edit your rows, so keep it on your own phone.
