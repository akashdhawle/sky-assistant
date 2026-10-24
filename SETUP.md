# Sky's Expense Tracker: one-time setup

You do this once. Part A is easiest on a computer (Windows is fine). Parts B and C are on your iPhone.

Files:
- `Code.gs` is the script that reads bank messages (SBI, ICICI, HDFC, Axis, Kotak) and serves the dashboard.
- `Dashboard.html` is the chart dashboard.

---

## A. Google Sheet and script (computer, about 10 minutes)

1. Go to sheets.google.com and create a blank spreadsheet named **Sky Expenses**.
2. In the spreadsheet menu, choose **Extensions → Apps Script**.
3. Delete everything in `Code.gs` and paste in the contents of this folder's `Code.gs`.
4. Click **+** next to Files, choose **HTML**, and name it `Dashboard` (exactly that, without `.html`). Replace its contents with this folder's `Dashboard.html`.
5. Click **Save**. In the function dropdown at the top, choose `setup`, then click **Run**.
   - Google asks for permission. Choose your account, then **Advanced → Go to … (unsafe)**, then **Allow**. The warning appears because you wrote this script yourself and Google hasn't reviewed it. It runs only in your account.
   - Three tabs appear in your sheet: **Transactions**, **Rules** and **Setup**. The **Setup** tab holds your secret key.
6. **Deploy the link the iPhone sends messages to:**
   **Deploy → New deployment → ⚙ → Web app**
   - Description: `receive`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy** and copy the **Web app URL**. This is your *receive link*.
   - The link is safe to leave open. Anything sent without your secret key is ignored, and it can't be used to read your data.
7. **Deploy the dashboard:**
   **Deploy → New deployment → ⚙ → Web app**
   - Description: `dashboard`
   - Execute as: **Me**
   - Who has access: **Only myself**
   - Click **Deploy** and copy this URL. This is your *dashboard link*.

Send both links to yourself, for example in an email or a note on your iPhone. You'll need them in Part B.

---

## B. iPhone: send bank messages automatically (about 5 minutes)

### B1. Create the shortcut that sends one message
1. Open the **Shortcuts** app, go to the **Shortcuts** tab and tap **+**. Name it **Log Bank SMS**.
2. (No settings needed here. When you use **Shortcut Input** in the next step, a "Receive … input" line appears at the top on its own, and you can leave it as it is.)
3. Add the action **If**:
   - *If* **Shortcut Input** **contains** `OTP` → inside the If block, add **Stop This Shortcut**.
   - (The script also rejects one-time passwords, so this is a second safety layer that keeps codes on your phone.)
4. After *End If*, add the action **Get Contents of URL**:
   - URL: your **receive link**
   - Tap **Show More** and set **Method** to **POST**.
   - Request Body: **JSON**. Add two **Text** fields:
     - `key` → your secret key. Open the **Google Sheets** app on your iPhone, open *Sky Expenses*, go to the **Setup** tab, copy cell A2 and paste it here.
     - `text` → **Shortcut Input** (choose it from the variables bar).
5. Tap **Done**.

### B2. Make it run whenever a bank text arrives
Go to the **Automation** tab, tap **+**, then **Message**:
- Sender: leave as **Any Sender**.
- Message Contains: `debit`
- Select **Run Immediately**. Turn off *Notify When Run* if you want.
- Tap **Next**, then **New Blank Automation**. Add the action **Run Shortcut**, choose **Log Bank SMS**, then tap the arrow and set its input to **Message**.

Repeat this two more times with **Message Contains** set to `spent` and then `withdrawn`. That gives you three automations in total, which together cover UPI, card and ATM messages from SBI and ICICI. If a message matches more than one, it's still saved only once.

### B3. Test it
From another phone, or by messaging yourself on iMessage, send:
`Dear UPI user A/C X1234 debited by 10.0 on date 18Oct26 trf to TEST SHOP Refno 1. -SBI`
A new row should appear in the **Transactions** tab within a few seconds. Delete that row once you've seen it.

When everything works, delete the **Setup** tab in the sheet so your secret key isn't sitting there.

---

## C. iPhone: put the dashboard on your Home Screen (1 minute)
1. Open your **dashboard link** in **Safari** and sign in to Google if it asks.
2. Tap **Share → Add to Home Screen** and name it **Expenses**.

You get spending for each month with a change-against-last-month figure, a category donut, day-by-day bars, a six-month trend, SBI against ICICI, top places, and every transaction. Use **‹ ›** to switch months.

**Fixing categories:** Change a transaction's category with the dropdown under it. The tracker remembers the place, so future payments there get that category automatically. You can also edit the **Rules** tab directly, with a keyword in lowercase and its category.

---

## What is stored, and where
- Everything lives only in your own Google Sheet.
- Each row holds the date, bank, amount, merchant, category, last 4 digits and payment mode. The full message text is never saved.
- Messages with OTPs, upcoming debits and autopay reminders, collect requests, offers and failed transactions are ignored. Credits (salary, money received, refunds) are saved as income.
- Keep two-step verification turned on for your Google account.

## If you change the script later
Go to **Deploy → Manage deployments**, edit each deployment, choose **Version: New version**, and click **Deploy**. Your links stay the same.

## Troubleshooting
- **No doPost row in Apps Script → Executions:** the shortcut has the wrong link, or **Get Contents of URL** is indented inside the If block. It must sit below **End If**.
- **"You do not have permission to access the requested document":** your Google storage is full (check one.google.com/storage). Free some space and run `setup` again.
- **Changed the script but nothing changes:** go to Deploy → Manage deployments, then ✏️ → **New version** for both deployments.

---

## Update 2: budgets, income and adding missed transactions (about 10 minutes)

### On your computer
1. In Apps Script, replace **all** of `Code.gs` with the new `Code.gs`, and **all** of `Dashboard` with the new `Dashboard.html`. Press **Ctrl+S**.
2. Choose **setup** and click **Run**. This adds a **Type** column and a **Budgets** tab to your sheet. Your data and secret key stay the same.
3. Go to **Deploy → Manage deployments**. For **receive**: ✏️ → Version **New version** → **Deploy**. Do the same for **dashboard**.

### On your iPhone
4. **Notification after each transaction.** Open **Log Bank SMS**. Delete **Show Content** if it's still there. Below **Get contents of**, add:
   - **Get Dictionary Value**: set it to *Get* **Value** *for* `notify` *in* **Contents of URL**.
   - **Show Notification**: tap its text and choose **Dictionary Value**.

   From now on, every saved transaction pops up a notification like `₹250 · SWIGGY (Food) · Food ₹6,200 of ₹8,000 (78%)`, with a ⚠️ when a budget passes 80% or 100%. **If a bank SMS arrives and you get no notification, it didn't reach the sheet.** Add it with the + button (see below).
5. **Income.** Add one more automation: **Automation → + → Message**, Message Contains `credited`, **Run Immediately**, then **Run Shortcut → Log Bank SMS** with input **Shortcut Input**.

### Using the new features
- **Budgets:** on the dashboard, tap **Edit** on the Budgets card, enter a monthly limit for the categories you care about, and tap **Save**.
- **Income and savings:** the top card now shows **Received** and **Saved** (received minus spent). Refunds are taken off your spending.
- **Missed a message?** Tap the round **+** button. Under **Paste bank SMS**, paste the message copied from Messages and tap Save. It's read just like the automatic ones, and the same message is never saved twice.
- **Cash or anything without an SMS:** tap **+ → Add manually**.

---

## Update 3: the full-screen Expenses app

1. Paste the new `Code.gs` into Apps Script (replace everything), press **Ctrl+S**, and **Run** `setup`. It creates a **View key** and shows it in the **Setup** tab. Your secret key doesn't change.
2. **Deploy → Manage deployments → receive → ✏️ → New version → Deploy.**
3. On your iPhone, open the app link in **Safari**, tap **Share → Add to Home Screen**, and name it **Expenses**.
4. Open **Expenses** from the Home Screen. Paste your **receive link** (the same one as in the shortcut) and the **View key**, then tap **Connect**. You only do this once.

The old Google-hosted dashboard link still works. You can delete its Home Screen icon once the new app is set up.

---

## Update 4: more banks, no lost messages, daily summary (about 15 minutes)

### On your computer
1. In Apps Script, select everything in `Code.gs` (**Ctrl+A**), delete it, paste the new `Code.gs` once, and press **Ctrl+S**. Do the same for `Dashboard`.
2. Run `setup`. Your keys stay the same.
3. **Deploy → Manage deployments**, pick the deployment whose URL is in your shortcut and app, ✏️ → **New version** → **Deploy**.

### On your iPhone: more banks
HDFC, Axis and Kotak accounts and SBI, ICICI, HDFC and Axis credit cards are now understood. Some of them word their messages differently, so add four more message automations, exactly like the `debit` one (**Run Immediately**, **Run Shortcut → Log Bank SMS**, input **Shortcut Input**):
`Sent Rs`, `Received Rs`, `deposited`, `Txn`

Credit card bill payments are ignored on purpose, because the money leaving your bank account is already counted.

### On your iPhone: never lose a message on a weak network
The shortcut now keeps each message in a small file on your phone until Google confirms it. If the network is down, it stays in the file and goes out with the next bank message. Open **Log Bank SMS** and make it look like this, top to bottom:

1. **If** Shortcut Input contains `OTP` → **Stop This Shortcut** → **End If** (as before).
2. **Append to Text File**: tap *Text* and choose **Shortcut Input**, press return, then type `#####`. Set the file path to `sky-pending.txt`. Leave **Make New Line** on.
3. **Get File from Folder**: folder **Shortcuts**, path `sky-pending.txt`.
4. **Get contents of URL** (as before), but change the `text` field from *Shortcut Input* to **File**.
5. **Get Dictionary Value**: *Value* for `notify` in **Contents of URL** (as before).
6. **Text**: type `#####`.
7. **Save File**: save the **Text** to **Shortcuts**, turn **Ask Where to Save** off, path `sky-pending.txt`, turn **Overwrite If File Exists** on.
8. **Show Notification**: **Dictionary Value** (as before).

The file only ever holds messages that haven't reached your sheet yet. Sending the same message twice is harmless; it's saved once. To push anything stuck without waiting for the next message, open the Shortcuts app and tap **Log Bank SMS**.

### On your iPhone: daily and weekly summary
1. **Shortcuts tab → +**, name it **Spending Summary**.
2. **Get contents of URL**: your receive link, **Method POST**, **Request Body JSON** with three Text fields: `viewKey` → your View key, `action` → `summary`, `period` → `day`.
3. **Get Dictionary Value**: *Value* for `notify` in **Contents of URL**.
4. **Show Notification**: **Dictionary Value**.
5. **Automation → + → Time of Day**, choose 9:00 PM, **Daily**, **Run Immediately**, then **Run Shortcut → Spending Summary**.

Each night you get something like `Today: ₹1,549 on 2 payments (Shopping ₹1,299, Food ₹250). October so far ₹18,200. ⚠️ Budget: Food 83%.`

For a weekly one, duplicate the shortcut as **Weekly Summary**, change `period` to `week`, and add a **Time of Day** automation set to **Weekly**, Sunday evening.

---

## Update 5: EMIs (about 5 minutes)

### On your computer
1. In Apps Script, clear `Code.gs` (**Ctrl+A**, Delete), paste the new one once, and press **Ctrl+S**. Do the same for `Dashboard`.
2. Run `setup`. It adds an **EMIs** tab. Your keys stay the same.
3. **Deploy → Manage deployments**, pick the deployment your shortcut and app use, ✏️ → **New version** → **Deploy**.

### In the app
Open **Expenses**, find the **EMIs** card, tap **Edit**, and add each loan with its monthly amount and the day of the month it's deducted. Tap **Save**.

### How it works
- Bank messages that mention EMI, loan, NACH, ACH or ECS are put in the **EMI** category on their own.
- EMIs are kept out of **Spent** and **Per day**, so a big EMI doesn't make your daily spending look huge. They still count against **Saved**, and show as their own bar in the 6-month chart.
- The EMIs card shows each loan as **Paid**, **Due** or **Not seen**. A payment is matched to a loan when the amount is within 2%. If two loans have the same amount, put a word from the bank message (for example `bajaj`) in the **Match word** column of the EMIs tab.
- The 9 PM **Spending Summary** (Update 4) reminds you the evening before an EMI is due, and tells you if one hasn't shown up after its date.
- An SIP or insurance auto-debit can also land in EMI. Change its category in the transaction list and the app remembers it for next time.

---

## Update 6: Ask Sky, the voice assistant (about 15 minutes)

Ask about your spending out loud, and fix categories by voice: "Hey Siri, Ask Sky… how much did I spend on food this month?" or "the Swiggy one on 21 October was a gift". Sky uses an AI model to understand you and answers through Siri.

Sky works with **Google Gemini**, which is free, or **Claude**, which costs about ₹40 a month. Start with Gemini; you can switch any time (see *Switching to Claude* below).

### A free Gemini API key (once)
1. Go to **aistudio.google.com**, sign in with your Google account, and click **Get API key → Create API key**.
2. Copy the key. No card is needed, and you stay on the free tier as long as you don't turn on billing.

On the free tier, Google may use what Sky sends (your question and the transactions it looks up) to improve its products. There's also a daily limit; if you reach it, Sky says so and works again the next day.

### On your computer
1. In Apps Script, clear `Code.gs` and `Dashboard` and paste the new ones, as before. Then click **+ → Script**, name it `Assistant`, and paste `apps-script/Assistant.gs` into it. (If you already have `Assistant`, clear it and paste the new one.) Press **Ctrl+S**.
2. **⚙ Project Settings → Script properties → Add script property**: name `GEMINI_API_KEY`, value your key. **Save**. The key stays in your script and is never in the app, the shortcut or GitHub.
3. **Deploy → Manage deployments**, pick the deployment your shortcut and app use, ✏️ → **New version** → **Deploy**. Approve the new permission if Google asks: the script now connects to the AI's servers.

### On your iPhone: the Ask Sky shortcut
1. **Shortcuts tab → +**, name it **Ask Sky**. Siri will run it when you say "Hey Siri, Ask Sky".
2. **Dictate Text**. Set *Stop Listening* to **After Pause**.
3. **Get contents of URL**: your receive link, **Method POST**, **Request Body JSON** with three Text fields: `viewKey` → your View key, `action` → `ask`, `text` → **Dictated Text**.
4. **Get Dictionary Value**: *Value* for `notify` in **Contents of URL**.
5. **Speak Text**: **Dictionary Value**. Add **Show Result** with **Dictionary Value** too if you'd like to see it on screen.

If it doesn't work:
- **Sky answers about "Dictated Text":** the `text` field holds the typed words instead of the variable. Clear it and tap **Dictated Text** in the bar above the keyboard, so it shows as a blue bubble.
- **"Cannot process dictated text":** replace **Dictate Text** with **Ask for Input** (Input: Text), and set `text` to **Provided Input**.
- **It answers but doesn't speak:** in **Settings → Siri → Siri Responses**, choose **Automatic** or **Prefer Spoken Responses** instead of Prefer Silent Responses. Check the silent switch and volume too.

### In the app
After you paste the new `Dashboard` too and deploy, the **Ask Sky** box sits at the top of the Expenses app. Type a question, or tap the microphone on your keyboard to speak it. It's the same assistant as the shortcut, so it works on Android phones as well. If you use the installed app, open it once after deploying so it picks up the new version.

Try: "How much did I spend this week?", "What did I pay Amazon this month?", "The Swiggy one on 21 October was a gift", "Check my categories for this month", "Undo that".

### How it works
- Sky only reads your sheet through a few actions: spending totals, searching transactions, changing a category, reviewing categories, and undo. It can't add, delete or edit amounts.
- Every category change is logged in a new **ChangeLog** tab with the old and new category, so "undo that" (or you, in the sheet) can put it back. Sky changes at most 3 transactions at a time without asking you first.
- A follow-up within 30 minutes continues the same conversation, so "move it to Gifts" knows what "it" is.
- When you ask, Sky sends the AI your question and the transactions it looks up (date, merchant, amount, category).

### Switching to Claude
Claude keeps your data private (Anthropic doesn't train on API data by default) and uses Claude Sonnet for "review my categories". It costs well under ₹1 a question, about ₹40 a month.
1. Go to **console.anthropic.com**, open **Billing** and add a small amount of credit, for example $5. On the limits page, set a monthly spend limit, for example $10, so it never charges more.
2. Open **API keys → Create key**, name it `Sky`, and copy it.
3. In **Script properties**, add `CLAUDE_API_KEY` with your key, and add `AI_PROVIDER` with the value `claude`. No new deployment is needed. To go back to Gemini, delete `AI_PROVIDER`.

To change models, add the script properties `GEMINI_MODEL` (default `gemini-3.5-flash-lite`), `CLAUDE_MODEL` (everyday, default `claude-haiku-5-5`) or `CLAUDE_REVIEW_MODEL` (reviews, default `claude-sonnet-5-5`).

## Update 7: Lists, quotes and journal (about 5 minutes)

Sky now keeps your reading list, watchlist, places to visit, favourite quotes and a journal, by voice, in the Ask Sky box, or on the app's new **Lists** screen.

### On your computer
1. In Apps Script, clear `Code.gs`, `Dashboard` and `Assistant` and paste the new ones (`apps-script/Code.gs`, `apps-script/Dashboard.html`, `apps-script/Assistant.gs`). Press **Ctrl+S**.
2. **Deploy → Manage deployments**, ✏️ → **New version** → **Deploy**.

Nothing changes in the Ask Sky shortcut. The installed app picks up the new Lists screen by itself; close and reopen it once.

### In the app
Tap **Lists** at the top. Each tab (Books, Movies, Places, Quotes, Journal) has a box to add to it. Change an item's status with its menu, and tap the stars on finished books, watched movies and visited places to rate them. Quotes shows a random one each time; tap **Another** for a new one. Sky creates the **Books**, **Movies**, **Places**, **Quotes** and **Journal** tabs the first time you use each one, and you can edit them in the sheet any time.

### Try
- "Add Atomic Habits to my TBR", "What's on my reading list?", "I finished Deep Work, 4 stars", "What should I read next?"
- "Add Dune to my watchlist", "I watched Dune", "Remove Tenet from my watchlist"
- "Add Hampi to places to visit", "Which places haven't I been to yet?"
- "Save this quote: You do not rise to the level of your goals, from Atomic Habits", "Read me a quote", "A quote from Deep Work"
- "Journal: long walk by the sea today, felt calm", "What did I write in my journal last week?"

### Good to know
- Statuses: books are *To read*, *Reading* or *Read*; movies *To watch* or *Watched*; places *Want to go* or *Visited*. Ratings are out of 5.
- "Remove" doesn't delete a row; it sets the status to *Removed*, so nothing is lost. Delete the row in the sheet if you want it gone.
- Your journal goes to the AI when you save or read it. On Gemini's free tier, Google may use it to improve its products; switch to Claude (see Update 6) if you'd rather it stayed private.
