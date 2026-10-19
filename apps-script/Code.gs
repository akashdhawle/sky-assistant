/**
 * Sky's Expense Tracker — Google Apps Script backend.
 *
 * doPost: receives a bank SMS from the iPhone Shortcuts automation, checks the
 *         secret key, parses it, and appends one row. The raw text is never stored.
 *         Replies with a one-line `notify` text the shortcut shows as a notification.
 *         With an `action` and the view key, it also answers the Expenses app (app/index.html).
 * doGet:  serves the chart dashboard, only to the owner of this script.
 *
 * One-time: run setup() from the editor, then deploy twice (see SETUP.md).
 * After pasting a new version: run setup() again, then deploy a New version.
 */

const SHEET_TX = 'Transactions';
const SHEET_RULES = 'Rules';
const SHEET_BUDGETS = 'Budgets';
const HEADERS = ['Date', 'Bank', 'Amount', 'Merchant', 'Category', 'Account', 'Mode', 'Id', 'Type'];

const DEFAULT_RULES = [
  ['swiggy', 'Food'], ['zomato', 'Food'], ['domino', 'Food'], ['mcdonald', 'Food'],
  ['kfc', 'Food'], ['starbucks', 'Food'], ['restaurant', 'Food'], ['cafe', 'Food'],
  ['blinkit', 'Groceries'], ['zepto', 'Groceries'], ['bigbasket', 'Groceries'],
  ['instamart', 'Groceries'], ['dmart', 'Groceries'], ['grofers', 'Groceries'],
  ['amazon', 'Shopping'], ['flipkart', 'Shopping'], ['myntra', 'Shopping'],
  ['ajio', 'Shopping'], ['nykaa', 'Shopping'], ['meesho', 'Shopping'],
  ['uber', 'Transport'], ['ola', 'Transport'], ['rapido', 'Transport'],
  ['irctc', 'Transport'], ['metro', 'Transport'], ['fastag', 'Transport'],
  ['petrol', 'Fuel'], ['fuel', 'Fuel'], ['hpcl', 'Fuel'], ['bpcl', 'Fuel'],
  ['iocl', 'Fuel'], ['indian oil', 'Fuel'],
  ['airtel', 'Bills'], ['jio', 'Bills'], ['vodafone', 'Bills'], ['bsnl', 'Bills'],
  ['electricity', 'Bills'], ['bescom', 'Bills'], ['msedcl', 'Bills'],
  ['broadband', 'Bills'], ['recharge', 'Bills'], ['gas', 'Bills'],
  ['netflix', 'Entertainment'], ['spotify', 'Entertainment'], ['hotstar', 'Entertainment'],
  ['bookmyshow', 'Entertainment'], ['prime video', 'Entertainment'], ['youtube', 'Entertainment'],
  ['apollo', 'Health'], ['pharm', 'Health'], ['medplus', 'Health'],
  ['hospital', 'Health'], ['clinic', 'Health'], ['1mg', 'Health'],
  ['atm', 'Cash'],
];

const CATEGORIES = ['Food', 'Groceries', 'Shopping', 'Transport', 'Fuel', 'Bills',
  'Entertainment', 'Health', 'Cash', 'Transfers', 'Other'];
const INCOME_CATEGORIES = ['Salary', 'Refund', 'Interest', 'Cashback', 'Received'];

// ---------- one-time setup (safe to run again) ----------

function setup() {
  const ss = SpreadsheetApp.getActive();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SHEET_ID', ss.getId());

  let tx = ss.getSheetByName(SHEET_TX);
  if (!tx) tx = ss.insertSheet(SHEET_TX);
  if (tx.getLastRow() === 0) {
    tx.appendRow(HEADERS);
    tx.setFrozenRows(1);
  } else {
    tx.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);  // adds the Type column
  }

  let rules = ss.getSheetByName(SHEET_RULES);
  if (!rules) {
    rules = ss.insertSheet(SHEET_RULES);
    rules.appendRow(['Keyword (lowercase)', 'Category']);
    rules.getRange(2, 1, DEFAULT_RULES.length, 2).setValues(DEFAULT_RULES);
    rules.setFrozenRows(1);
  }

  let budgets = ss.getSheetByName(SHEET_BUDGETS);
  if (!budgets) {
    budgets = ss.insertSheet(SHEET_BUDGETS);
    budgets.appendRow(['Category', 'Monthly limit (₹, blank = none)']);
    budgets.getRange(2, 1, CATEGORIES.length, 1).setValues(CATEGORIES.map(c => [c]));
    budgets.setFrozenRows(1);
  }

  let key = props.getProperty('SECRET_KEY');
  let viewKey = props.getProperty('VIEW_KEY');
  if (!key || !viewKey) {
    if (!key) {
      key = newKey_();
      props.setProperty('SECRET_KEY', key);
    }
    if (!viewKey) {
      viewKey = newKey_();
      props.setProperty('VIEW_KEY', viewKey);
    }
    // Shown in a 'Setup' tab so you can copy them on the iPhone. Delete that tab afterwards.
    let info = ss.getSheetByName('Setup');
    if (!info) info = ss.insertSheet('Setup');
    info.getRange('A1:B3').setValues([
      ['What', 'Copy this (delete this tab once done)'],
      ['Secret key (for the Log Bank SMS shortcut, can only add)', key],
      ['View key (for the Expenses app, can read your data)', viewKey]]);
  }
  Logger.log('Setup done.\nSecret key (shortcut): ' + key + '\nView key (app): ' + viewKey);
}

// ---------- receiving messages ----------

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad request', notify: 'Expense tracker: bad request' });
  }
  if (body.action && body.action !== 'add') return json_(appRequest_(body));

  const key = PropertiesService.getScriptProperties().getProperty('SECRET_KEY');
  if (!key || body.key !== key) {
    return json_({ ok: false, error: 'unauthorized', notify: 'Expense tracker: wrong secret key' });
  }

  const text = String(body.text || '').slice(0, 1000);
  const tx = parseSms(text);
  if (!tx) return json_({ ok: true, saved: false, reason: 'not a transaction', notify: 'Skipped: not a bank transaction' });
  return json_(saveTx_(tx, hash_(text)));
}

/**
 * Turns an SBI or ICICI transaction SMS into
 * {type: 'Debit'|'Credit', bank, amount, merchant, account, mode, category?},
 * or null for anything else (OTPs, reminders, offers, failed transactions).
 */
function parseSms(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const lower = t.toLowerCase();

  if (/\botp\b|one time password|verification code/.test(lower)) return null;
  if (/will be (debited|credited)|to be (debited|credited)|is due|due on|due date|requested (money|rs|inr)|has requested|declined|failed|unsuccessful/.test(lower)) return null;
  if (/\boffer\b|t&c|\bwin\b|apply now|pre-approved|pre approved|eligible/.test(lower)) return null;

  let bank = null;
  if (/icici/.test(lower)) bank = 'ICICI';
  else if (/\bsbi\b|state bank|sbicard|sbi card/.test(lower)) bank = 'SBI';
  if (!bank) return null;

  const isRefund = /refund|reversed|reversal|credited back/.test(lower);
  const isDebit = /\bdebited\b|has a debit|\bdebit of\b|\bspent\b|withdrawn|\bpaid\b|sent (rs|inr)/.test(lower);
  const isCredit = /\bcredited\b|deposited|has been received|received (rs|inr|₹)/.test(lower);
  let type = null;
  if (isRefund && (isCredit || /processed|initiated/.test(lower))) type = 'Credit';
  else if (isDebit) type = 'Debit';
  else if (isCredit) type = 'Credit';
  if (!type) return null;

  const m = t.match(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i) ||
            t.match(/(?:debited|credited) (?:by|for|with)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!m) return null;
  const amount = parseFloat(m[1].replace(/,/g, ''));
  if (!(amount > 0)) return null;

  const acct = t.match(/(?:a\/c|acct|acc|account|card)(?: no\.?)?\s*(?:ending\s*(?:with\s*)?)?[x*]*\s*(\d{3,})\b/i) ||
               t.match(/ending\s*(?:with\s*)?(\d{4})/i) ||
               t.match(/[x*]{2,}(\d{3,})\b/i);
  const account = acct ? acct[1].slice(-4) : '';

  let mode = 'Other';
  if (/withdrawn|\batm\b/.test(lower)) mode = 'ATM';
  else if (/upi|vpa/.test(lower)) mode = 'UPI';
  else if (/card/.test(lower)) mode = 'Card';
  else if (/neft|imps|rtgs/.test(lower)) mode = 'Bank transfer';

  const debitPatterns = [
    /(?:trf|transfer(?:red)?) to (.+?)(?: refno| ref no| ref\b|\.|$)/i,  // SBI UPI
    /[&;]\s*((?:a\/c|acct|acc)\s*[x*]*\d+) credited/i,               // ICICI transfer to another account
    /;\s*(.+?) credited/i,                                           // ICICI UPI
    /\bto vpa\s+([\w.\-@]+)/i,
    /\bto ([A-Za-z0-9 .&'\-@]+?) on \d/i,
    /\bat ([A-Za-z0-9 .&'*\-_/]+?) on \d/i,                          // "spent ... at AMAZON on 18/10/26"
    /\bon \d{1,2}[-\/ ]?\w{2,3}[-\/ ]?\d{2,4} (?:on|at) ([A-Za-z0-9 .&'*\-_/]+?)(?:\.|$)/i, // ICICI card
    /\bat ([A-Za-z0-9 .&'*\-_/]+?)(?:\.| avl| txn|$)/i,
    /info[:\s]+([A-Za-z0-9 .&'*\-_/]+?)(?:\.|$)/i,
    /\bfor (?!rs\b|inr\b)([A-Za-z][A-Za-z0-9 .&'*\-_/]+?)(?:\.|$| -)/i, // "... for NETFLIX."
  ];
  const creditPatterns = [
    /(?:refund|reversal).*?\b(?:at|from|for) (?:your )?(?:txn at |transaction at )?([A-Za-z][A-Za-z0-9 .&'*\-_/]+?)(?: has| on \d| is|\.|$)/i,
    /\bvpa\s+([\w.\-]+@[\w.\-]+)/i,
    /\bfrom (?:vpa )?([A-Za-z0-9 .&'@\-_]+?)(?: ref| refno| on \d|\.| upi|\(|$)/i,
    /info[:\s-]+(?:neft|imps|rtgs)?-?(?:[A-Z]{4}\d+-)?([A-Za-z][A-Za-z0-9 .&'*\-_/]+?)(?:\.|$)/i,
    /\bby ((?!rs\b|inr\b)[A-Za-z][A-Za-z0-9 .&'@\-_]+?)(?: ref| on \d|\.|$)/i,
  ];
  let merchant = '';
  for (const p of (type === 'Debit' ? debitPatterns : creditPatterns)) {
    const mm = t.match(p);
    if (mm && mm[1] && !/^\d+$/.test(mm[1].trim())) { merchant = mm[1].trim(); break; }
  }
  if (type === 'Debit' && mode === 'ATM') merchant = 'ATM withdrawal';
  merchant = merchant.replace(/\s+/g, ' ').slice(0, 60) || 'Unknown';

  const tx = { type: type, bank: bank, amount: amount, merchant: merchant, account: account, mode: mode };
  if (type === 'Credit') {
    if (isRefund) tx.category = 'Refund';
    else if (/salary|\bsal\b/.test(lower)) tx.category = 'Salary';
    else if (/interest|int\.? ?pd/.test(lower)) tx.category = 'Interest';
    else if (/cashback/.test(lower)) tx.category = 'Cashback';
    else tx.category = 'Received';
  }
  return tx;
}

/** Appends one transaction (deduplicated by id) and returns the reply for the phone. */
function saveTx_(tx, id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = ss_().getSheetByName(SHEET_TX);
    const last = sheet.getLastRow();
    if (id && last > 1) {
      const from = Math.max(2, last - 300);
      const ids = sheet.getRange(from, 8, last - from + 1, 1).getValues().flat();
      if (ids.indexOf(id) !== -1) {
        return { ok: true, saved: false, reason: 'duplicate', notify: 'Already saved' };
      }
    }
    if (!tx.category) tx.category = categorize_(tx.merchant, tx.mode, getRules_());
    const date = tx.date || new Date();
    sheet.appendRow([date, tx.bank || '', tx.amount, tx.merchant, tx.category,
      tx.account || '', tx.mode || '', id || ('manual-' + Utilities.getUuid().slice(0, 8)), tx.type]);
    return { ok: true, saved: true, amount: tx.amount, merchant: tx.merchant, notify: notifyText_(tx, date) };
  } finally {
    lock.releaseLock();
  }
}

/** One line for the phone notification, with a budget warning when a limit is crossed. */
function notifyText_(tx, date) {
  if (tx.type === 'Credit') {
    return '+' + inr_(tx.amount) + ' ' + (tx.category === 'Refund' ? 'refund' : 'received') +
      ' · ' + tx.merchant + ' (' + tx.category + ')';
  }
  let line = inr_(tx.amount) + ' · ' + tx.merchant + ' (' + tx.category + ')';
  const limit = getBudgets_()[tx.category];
  if (!limit) return line;
  const spent = monthSpend_(tx.category, date);
  const before = spent - tx.amount;
  const pct = Math.round(spent / limit * 100);
  const status = tx.category + ' ' + inr_(spent) + ' of ' + inr_(limit) + ' (' + pct + '%)';
  if (before < limit && spent >= limit) return '⚠️ Over budget! ' + status + ' · ' + line;
  if (before < 0.8 * limit && spent >= 0.8 * limit) return '⚠️ 80% of budget used · ' + status + ' · ' + line;
  return line + ' · ' + status;
}

/** Net spending in one category for the month of `date` (debits minus nothing; refunds are tracked separately). */
function monthSpend_(category, date) {
  const sheet = ss_().getSheetByName(SHEET_TX);
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const y = date.getFullYear(), mo = date.getMonth();
  return sheet.getRange(2, 1, last - 1, 9).getValues().reduce((sum, r) => {
    const d = r[0] instanceof Date ? r[0] : new Date(r[0]);
    const type = r[8] || 'Debit';
    if (type === 'Debit' && r[4] === category && d.getFullYear() === y && d.getMonth() === mo) {
      return sum + (Number(r[2]) || 0);
    }
    return sum;
  }, 0);
}

function categorize_(merchant, mode, rules) {
  const m = String(merchant).toLowerCase();
  for (const r of rules) {
    if (!r[0]) continue;
    const kw = r[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('(^|[^a-z0-9])' + kw).test(m)) return r[1];
  }
  if (mode === 'ATM') return 'Cash';
  if (mode === 'UPI' && /@/.test(m)) return 'Transfers';
  if (mode === 'Bank transfer') return 'Transfers';
  return 'Other';
}

function getRules_() {
  const sheet = ss_().getSheetByName(SHEET_RULES);
  if (!sheet || sheet.getLastRow() < 2) return DEFAULT_RULES;
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues()
    .map(r => [String(r[0]).toLowerCase().trim(), String(r[1]).trim()])
    .filter(r => r[0] && r[1] && CATEGORIES.indexOf(r[1]) !== -1);
}

function getBudgets_() {
  const sheet = ss_().getSheetByName(SHEET_BUDGETS);
  const out = {};
  if (!sheet || sheet.getLastRow() < 2) return out;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(r => {
    const n = Number(r[1]);
    if (r[0] && n > 0) out[String(r[0]).trim()] = n;
  });
  return out;
}

// ---------- the Expenses app (calls doPost with the view key) ----------

function appRequest_(body) {
  const viewKey = PropertiesService.getScriptProperties().getProperty('VIEW_KEY');
  if (!viewKey || body.viewKey !== viewKey) return { ok: false, error: 'Wrong view key' };
  try {
    switch (body.action) {
      case 'data': return { ok: true, result: getData_() };
      case 'setCategory': return { ok: true, result: setCategory_(body.row, body.category) };
      case 'setBudgets': return { ok: true, result: setBudgets_(body.budgets || {}) };
      case 'addSms': return { ok: true, result: addFromSms_(body.text) };
      case 'addManual': return { ok: true, result: addManual_(body.entry || {}) };
      default: return { ok: false, error: 'Unknown action' };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- dashboard ----------

function doGet() {
  if (!isOwner_()) {
    return HtmlService.createHtmlOutput('Not available.');
  }
  return HtmlService.createTemplateFromFile('Dashboard').evaluate()
    .setTitle("Sky's Expenses")
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Called from the dashboard. Returns every transaction and the budgets. */
function getData() {
  if (!isOwner_()) throw new Error('Not allowed');
  return getData_();
}

function getData_() {
  const sheet = ss_().getSheetByName(SHEET_TX);
  const last = sheet.getLastRow();
  const rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, 9).getValues();
  return {
    categories: CATEGORIES,
    incomeCategories: INCOME_CATEGORIES,
    budgets: getBudgets_(),
    tx: rows.map((r, i) => ({
      row: i + 2,
      date: r[0] instanceof Date ? r[0].toISOString() : String(r[0]),
      bank: r[1], amount: Number(r[2]) || 0, merchant: String(r[3]),
      category: r[4], account: String(r[5]), mode: r[6], type: r[8] || 'Debit',
    })).filter(t => t.amount > 0),
  };
}

/** Called from the dashboard when you change a category. Also learns a rule for spending. */
function setCategory(row, category) {
  if (!isOwner_()) throw new Error('Not allowed');
  return setCategory_(row, category);
}

function setCategory_(row, category) {
  row = Number(row);
  if (!(row >= 2)) throw new Error('Bad row');
  if (CATEGORIES.indexOf(category) === -1 && INCOME_CATEGORIES.indexOf(category) === -1) {
    throw new Error('Unknown category');
  }
  const ss = ss_();
  const sheet = ss.getSheetByName(SHEET_TX);
  sheet.getRange(row, 5).setValue(category);
  const merchant = String(sheet.getRange(row, 4).getValue()).toLowerCase().trim();
  if (merchant && merchant !== 'unknown' && CATEGORIES.indexOf(category) !== -1) {
    const rules = ss.getSheetByName(SHEET_RULES);
    const existing = rules.getLastRow() < 2 ? [] :
      rules.getRange(2, 1, rules.getLastRow() - 1, 1).getValues().flat().map(String);
    const i = existing.indexOf(merchant);
    if (i === -1) {
      rules.insertRowBefore(2);
      rules.getRange(2, 1, 1, 2).setValues([[merchant, category]]);
    } else {
      rules.getRange(i + 2, 2).setValue(category);
    }
  }
  return true;
}

/** Called from the dashboard. budgets: {Category: amount or 0}. */
function setBudgets(budgets) {
  if (!isOwner_()) throw new Error('Not allowed');
  return setBudgets_(budgets);
}

function setBudgets_(budgets) {
  const sheet = ss_().getSheetByName(SHEET_BUDGETS);
  const values = CATEGORIES.map(c => {
    const n = Number(budgets[c]);
    return [c, n > 0 ? n : ''];
  });
  sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 2).clearContent();
  sheet.getRange(2, 1, values.length, 2).setValues(values);
  return getBudgets_();
}

/** Called from the dashboard: paste a bank SMS that the phone missed. */
function addFromSms(text) {
  if (!isOwner_()) throw new Error('Not allowed');
  return addFromSms_(text);
}

function addFromSms_(text) {
  const clean = String(text || '').slice(0, 1000);
  const tx = parseSms(clean);
  if (!tx) throw new Error("That doesn't look like an SBI or ICICI transaction message.");
  return saveTx_(tx, hash_(clean));
}

/** Called from the dashboard: add a cash spend or anything without an SMS. */
function addManual(entry) {
  if (!isOwner_()) throw new Error('Not allowed');
  return addManual_(entry);
}

function addManual_(entry) {
  const type = entry.type === 'Credit' ? 'Credit' : 'Debit';
  const amount = Number(entry.amount);
  if (!(amount > 0)) throw new Error('Enter an amount');
  const list = type === 'Credit' ? INCOME_CATEGORIES : CATEGORIES;
  const category = list.indexOf(entry.category) !== -1 ? entry.category : list[list.length - 1];
  const date = entry.date ? new Date(entry.date + 'T12:00:00') : new Date();
  return saveTx_({
    type: type, amount: amount, category: category, date: date,
    merchant: String(entry.merchant || (type === 'Credit' ? 'Received' : 'Cash')).slice(0, 60),
    bank: String(entry.bank || 'Cash'), mode: 'Manual', account: '',
  }, null);
}

// ---------- helpers ----------

/** Opens the sheet by its saved ID, which works for requests from the phone too. */
function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}

function isOwner_() {
  const me = Session.getEffectiveUser().getEmail();
  const viewer = Session.getActiveUser().getEmail();
  return !!viewer && viewer === me;
}

/** ₹ with Indian digit grouping (1,20,000), without relying on locale support. */
function newKey_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function inr_(n) {
  const s = String(Math.round(Math.abs(n)));
  const head = s.slice(0, -3), tail = s.slice(-3);
  return (n < 0 ? '-₹' : '₹') + (head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : '') + tail;
}

function hash_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('').slice(0, 24);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
