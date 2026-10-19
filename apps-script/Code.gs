/**
 * Sky's Expense Tracker — Google Apps Script backend.
 *
 * doPost: receives bank SMS from the iPhone Shortcuts automation, checks the
 *         secret key, parses each message, and appends one row per transaction.
 *         The raw text is never stored. Several messages separated by ##### lines
 *         can arrive at once (the shortcut's queue for when the network was down).
 *         Replies with a `notify` text the shortcut shows as a notification.
 *         With an `action` and the view key, it also answers the Expenses app
 *         (docs/index.html) and the daily or weekly summary shortcut.
 * doGet:  serves the chart dashboard, only to the owner of this script.
 *
 * One-time: run setup() from the editor, then deploy twice (see SETUP.md).
 * After pasting a new version: run setup() again, then deploy a New version.
 */

const SHEET_TX = 'Transactions';
const SHEET_RULES = 'Rules';
const SHEET_BUDGETS = 'Budgets';
const SHEET_EMIS = 'EMIs';
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
  'Entertainment', 'Health', 'Cash', 'EMI', 'Transfers', 'Other'];
const INCOME_CATEGORIES = ['Salary', 'Refund', 'Interest', 'Cashback', 'Received'];

// [name, any mention, a sure sign it's the sender ("HDFC Bank", "SBI Card", "-SBI" at the end)]
const BANKS = [
  ['SBI', /\bsbi\b|state bank|sbicard/, /\bsbi (bank|card|credit card)|state bank|sbicard|-\s*sbi\s*$/],
  ['ICICI', /icici/, /icici bank|-\s*icici( bank)?\s*$/],
  ['HDFC', /hdfc/, /hdfc bank|-\s*hdfc( bank)?\s*$/],
  ['Axis', /\baxis\b/, /axis bank|-\s*axis( bank)?\s*$/],
  ['Kotak', /kotak/, /kotak (mahindra )?bank|-\s*kotak( bank)?\s*$/],
];
const QUEUE_SEPARATOR = /\n?\s*#{5,}\s*\n?/;

// ---------- one-time setup (safe to run again) ----------

function setup() {
  const ss = SpreadsheetApp.getActive();
  const props = PropertiesService.getScriptProperties();
  // A copied sheet (someone else's, or the template) must never reuse the original's keys.
  const previous = props.getProperty('SHEET_ID');
  if (previous && previous !== ss.getId()) {
    props.deleteProperty('SECRET_KEY');
    props.deleteProperty('VIEW_KEY');
  }
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

  if (!ss.getSheetByName(SHEET_EMIS)) {
    const emis = ss.insertSheet(SHEET_EMIS);
    emis.appendRow(['EMI name', 'Amount (₹)', 'Day of month', 'Match word (optional, from the bank message)']);
    emis.setFrozenRows(1);
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
  if (body.action && body.action !== 'add') {
    const reply = appRequest_(body);
    if (!reply.notify) reply.notify = reply.ok ? '' : 'Expense tracker: ' + reply.error;
    return json_(reply);
  }

  const key = PropertiesService.getScriptProperties().getProperty('SECRET_KEY');
  if (!key || body.key !== key) {
    return json_({ ok: false, error: 'unauthorized', notify: 'Expense tracker: wrong secret key' });
  }
  return json_(receiveMessages_(String(body.text || '')));
}

/** Saves every transaction in one or more messages (split by ##### lines) and sums up the result. */
function receiveMessages_(text) {
  const messages = text.split(QUEUE_SEPARATOR).map(m => m.trim()).filter(Boolean).slice(-30);
  const results = messages.map(m => {
    const clean = m.slice(0, 1000);
    const tx = parseSms(clean);
    return tx ? saveTx_(tx, hash_(clean))
      : { ok: true, saved: false, reason: 'not a transaction', notify: 'Skipped: not a bank transaction' };
  });
  if (results.length === 0) return { ok: true, saved: false, reason: 'empty', notify: 'Nothing to send' };
  if (results.length === 1) return results[0];
  const saved = results.filter(r => r.saved);
  if (saved.length === 0) {
    return { ok: true, saved: false, reason: 'nothing new',
      notify: results.some(r => r.reason === 'duplicate') ? 'Already saved' : 'Skipped: not a bank transaction' };
  }
  return { ok: true, saved: true, count: saved.length,
    notify: (saved.length > 1 ? saved.length + ' transactions saved\n' : '') + saved.map(r => r.notify).join('\n') };
}

/**
 * Turns an SBI, ICICI, HDFC, Axis or Kotak transaction SMS (bank account or card) into
 * {type: 'Debit'|'Credit', bank, amount, merchant, account, mode, category?},
 * or null for anything else (OTPs, reminders, offers, failed transactions).
 */
function parseSms(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const lower = t.toLowerCase();

  if (/\botp\b|one time password|verification code/.test(lower)) return null;
  if (/will be (debited|credited)|to be (debited|credited)|is due|due on|due date|requested (money|rs|inr)|has requested|declined|failed|unsuccessful/.test(lower)) return null;
  if (/\boffer\b|t&c|\bwin\b|apply now|pre-approved|pre approved|eligible/.test(lower)) return null;
  // A credit card bill payment only moves your own money; the bank debit is already counted.
  if (/payment\b.*\breceived\b.*\b(credit )?card|received\b.*\bpayment\b.*\bcard|thank you for (the |your )?payment|received towards your/.test(lower)) return null;

  const bank = bankOf_(lower);
  if (!bank) return null;

  const isRefund = /refund|reversed|reversal|credited back/.test(lower);
  const isDebit = /\bdebited\b|has a debit|\bdebit of\b|\bspent\b|withdrawn|\bpaid\b|sent (rs|inr|₹)|\btxn (of )?(rs|inr|₹)/.test(lower);
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

  const acct = t.match(/(?:a\/c|acct|acc|\bac\b|account|card)(?: no\.?)?\s*(?:ending\s*(?:with\s*)?)?[x*]*\s*(\d{3,})\b/i) ||
               t.match(/ending\s*(?:with\s*)?(\d{4})/i) ||
               t.match(/[x*]{2,}(\d{3,})\b/i);
  const account = acct ? acct[1].slice(-4) : '';

  let mode = 'Other';
  if (/withdrawn|\batm\b/.test(lower)) mode = 'ATM';
  else if (/\bn?ach\b|\becs\b|standing instruction/.test(lower)) mode = 'Auto debit';
  else if (/upi|vpa/.test(lower)) mode = 'UPI';
  else if (/card/.test(lower)) mode = 'Card';
  else if (/neft|imps|rtgs/.test(lower)) mode = 'Bank transfer';

  const debitPatterns = [
    /\b(?:n?ach|ecs)(?:\s*dr?)?[\s:-]+([A-Za-z][A-Za-z .&']*?)(?:\s*-|\s*\d|\.|$)/i, // "ACH D- BAJAJ FINANCE LTD-123"
    /[&;]\s*(loan a\/c\s*[x*]*\d+) credited/i,                         // ICICI loan
    /towards (?:your )?(?:emi (?:of|for) )?([A-Za-z][A-Za-z0-9 .&'\/\-]+?)(?:\.|$| on \d)/i,
    /upi\/p2[am]\/\d+\/([A-Za-z0-9 .&'@\-_]+?)(?: not you|\/|\.|$)/i,     // Axis UPI
    /(?:trf|transfer(?:red)?) to (.+?)(?: refno| ref no| ref\b|\.|$)/i,  // SBI UPI
    /[&;]\s*((?:a\/c|acct|acc)\s*[x*]*\d+) credited/i,               // ICICI transfer to another account
    /;\s*(.+?) credited/i,                                           // ICICI UPI
    /\bto vpa\s+([\w.\-@]+)/i,
    /\bto ([A-Za-z0-9 .&'\-@]+?) on \d/i,
    /\bat ([A-Za-z0-9 .&'*\-_/]+?) on \d/i,                          // "spent ... at AMAZON on 18/10/26"
    /\bon \d{1,2}[-\/ ]?\w{2,3}[-\/ ]?\d{2,4} (?:on|at) ([A-Za-z0-9 .&'*\-_/]+?)(?:\.|$)/i, // ICICI card
    /\bat ([A-Za-z0-9 .&'*\-_/]+?)(?:\.| avl| txn| by upi| on |$)/i,
    /\d{1,2}:\d{2}(?::\d{2})?(?: ist)? ([A-Za-z][A-Za-z0-9 .&'*\-_/]+?) avl/i, // Axis card
    /info[:\s]+([A-Za-z0-9 .&'*\-_/]+?)(?:\.|$)/i,
    /\bfor (?!rs\b|inr\b)([A-Za-z][A-Za-z0-9 .&'*\-_/]+?)(?:\.|$| -)/i, // "... for NETFLIX."
  ];
  const creditPatterns = [
    /upi\/p2[am]\/\d+\/([A-Za-z0-9 .&'@\-_]+?)(?: not you|\/|\.|$)/i,     // Axis UPI
    /neft cr-[a-z0-9]+-([A-Za-z][A-Za-z0-9 .&'\-_]+?)(?:-|\.|$)/i,           // HDFC NEFT
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
  merchant = merchant.replace(/\s+(by|via) upi\b.*$/i, '').replace(/\s+/g, ' ').slice(0, 60) || 'Unknown';

  const tx = { type: type, bank: bank, amount: amount, merchant: merchant, account: account, mode: mode };
  if (type === 'Debit' && /\bemi\b|\bloan\b|\bn?ach\b|\becs\b/.test(lower)) tx.emi = true;
  if (type === 'Credit') {
    if (isRefund) tx.category = 'Refund';
    else if (/salary|\bsal\b/.test(lower)) tx.category = 'Salary';
    else if (/interest|int\.? ?pd/.test(lower)) tx.category = 'Interest';
    else if (/cashback/.test(lower)) tx.category = 'Cashback';
    else tx.category = 'Received';
  }
  return tx;
}

/** Which bank sent the message: a sure sign wins, otherwise the first bank mentioned. */
function bankOf_(lower) {
  const sure = BANKS.find(b => b[2].test(lower));
  if (sure) return sure[0];
  let best = null, at = Infinity;
  BANKS.forEach(b => {
    const m = lower.match(b[1]);
    if (m && m.index < at) { best = b[0]; at = m.index; }
  });
  return best;
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
    if (!tx.category) tx.category = categorize_(tx.merchant, tx.mode, getRules_(), tx.emi);
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
  if (tx.category === 'EMI') {
    const tz = Session.getScriptTimeZone(), mk = Utilities.formatDate(date, tz, 'yyyyMM');
    const paid = matchEmis_(getEmis_(), getData_().tx.filter(t =>
      t.type === 'Debit' && Utilities.formatDate(new Date(t.date), tz, 'yyyyMM') === mk));
    const mine = paid.find(e => e.paid && Math.abs(e.paid.amount - tx.amount) < 0.01 && e.paid.merchant === tx.merchant);
    const left = paid.filter(e => !e.paid).length;
    return '✓ ' + (mine ? mine.name + ' EMI paid ' : 'EMI paid ') + inr_(tx.amount) + ' · ' + tx.merchant +
      (paid.length ? ' · ' + (left ? left + ' more EMI' + (left > 1 ? 's' : '') + ' due this month' : 'all EMIs paid this month') : '');
  }
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

function categorize_(merchant, mode, rules, emi) {
  const m = String(merchant).toLowerCase();
  for (const r of rules) {
    if (!r[0]) continue;
    const kw = r[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('(^|[^a-z0-9])' + kw).test(m)) return r[1];
  }
  if (emi) return 'EMI';
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
      case 'setEmis': return { ok: true, result: setEmis_(body.emis) };
      case 'summary': {
        const text = summary_(body.period === 'week' ? 'week' : 'day', new Date());
        return { ok: true, result: text, notify: text };
      }
      default: return { ok: false, error: 'Unknown action' };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- EMIs you expect every month ----------

function getEmis_() {
  const sheet = ss_().getSheetByName(SHEET_EMIS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues()
    .map(r => ({ name: String(r[0]).trim(), amount: Number(r[1]) || 0,
                 day: Math.min(31, Math.max(1, Math.round(Number(r[2]) || 1))), match: String(r[3] || '').trim() }))
    .filter(e => e.name && e.amount > 0);
}

/** Called from the dashboard. list: [{name, amount, day, match}]. */
function setEmis(list) {
  if (!isOwner_()) throw new Error('Not allowed');
  return setEmis_(list);
}

function setEmis_(list) {
  const ss = ss_();
  let sheet = ss.getSheetByName(SHEET_EMIS);
  if (!sheet) { setup(); sheet = ss.getSheetByName(SHEET_EMIS); }
  const rows = (Array.isArray(list) ? list : []).slice(0, 30)
    .map(e => [String(e.name || '').trim().slice(0, 40), Number(e.amount) || 0,
               Math.min(31, Math.max(1, Math.round(Number(e.day) || 1))), String(e.match || '').trim().slice(0, 40)])
    .filter(r => r[0] && r[1] > 0);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, 4).setValues(rows);
  return getEmis_();
}

/**
 * Pairs each expected EMI with an EMI payment from that month: by its match word when it has one,
 * otherwise by an amount within 2%. Each payment is used once. Keep in step with matchEmis in Dashboard.html.
 */
function matchEmis_(emis, monthDebits) {
  const used = [];
  return emis.map(e => {
    const kw = e.match.toLowerCase();
    const hit = monthDebits.find(t => used.indexOf(t) === -1 && t.category === 'EMI' &&
      (kw ? String(t.merchant).toLowerCase().indexOf(kw) !== -1 : Math.abs(t.amount - e.amount) <= Math.max(1, e.amount * 0.02)));
    if (hit) used.push(hit);
    return Object.assign({}, e, { paid: hit || null });
  });
}

/** Reminders for the daily summary: EMIs due tomorrow, and this month's that haven't shown up. */
function emiReminders_(now, tx) {
  const emis = getEmis_();
  if (!emis.length) return [];
  const tz = Session.getScriptTimeZone();
  const fmt = (d, f) => Utilities.formatDate(d, tz, f);
  const daysIn = d => { const y = +fmt(d, 'yyyy'), m = +fmt(d, 'M'); return new Date(y, m, 0).getDate(); };
  const statusFor = d => matchEmis_(emis, tx.filter(t => t.type === 'Debit' && fmt(t.d, 'yyyyMM') === fmt(d, 'yyyyMM')));
  const out = [];
  const tomorrow = new Date(now.getTime() + 86400000), tDay = +fmt(tomorrow, 'd');
  statusFor(tomorrow).filter(e => !e.paid && Math.min(e.day, daysIn(tomorrow)) === tDay)
    .forEach(e => out.push('⏰ EMI due tomorrow: ' + e.name + ' ' + inr_(e.amount)));
  const today = +fmt(now, 'd');
  statusFor(now).filter(e => !e.paid && Math.min(e.day, daysIn(now)) < today)
    .forEach(e => out.push('⚠️ ' + e.name + ' EMI (due ' + e.day + ordinal_(e.day) + ') not seen yet'));
  return out;
}

function ordinal_(n) {
  return (n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
}

// ---------- daily and weekly summary (for a Shortcuts time automation) ----------

/** One notification-sized summary of today or the last 7 days, with budgets close to their limit. */
function summary_(period, now) {
  const tz = Session.getScriptTimeZone();
  const dayKey = d => Utilities.formatDate(d, tz, 'yyyyMMdd');
  const monthKey = d => Utilities.formatDate(d, tz, 'yyyyMM');
  const days = period === 'week' ? 7 : 1;
  const inDays = (d, from, n) => {
    const k = dayKey(d);
    for (let i = from; i < from + n; i++) if (k === dayKey(new Date(now.getTime() - i * 86400000))) return true;
    return false;
  };
  const tx = getData_().tx.map(t => Object.assign(t, { d: new Date(t.date) }));
  const isSpend = t => t.type === 'Debit' && t.category !== 'EMI';
  const spend = list => list.reduce((s, t) => s + (isSpend(t) ? t.amount : t.category === 'Refund' ? -t.amount : 0), 0);
  const current = tx.filter(t => inDays(t.d, 0, days));
  const earlier = tx.filter(t => inDays(t.d, days, days));
  const month = tx.filter(t => monthKey(t.d) === monthKey(now));
  const spent = spend(current), before = spend(earlier);
  const payments = current.filter(isSpend).length;

  const byCat = {};
  current.filter(isSpend).forEach(t => byCat[t.category] = (byCat[t.category] || 0) + t.amount);
  const top = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]).slice(0, 3)
    .map(c => c + ' ' + inr_(byCat[c])).join(', ');

  const label = period === 'week' ? 'This week' : 'Today';
  let line = payments === 0 ? label + ': no spending 🎉'
    : label + ': ' + inr_(spent) + ' on ' + payments + (payments === 1 ? ' payment' : ' payments') + (top ? ' (' + top + ')' : '');
  if (before > 0) {
    const pct = Math.round((spent - before) / before * 100);
    line += period === 'week' ? ', ' + (pct > 0 ? '▲' : '▼') + Math.abs(pct) + '% vs last week' : '';
  }
  const received = current.filter(t => t.type === 'Credit' && t.category !== 'Refund').reduce((s, t) => s + t.amount, 0);
  if (received > 0) line += '. Received ' + inr_(received);
  const monthName = Utilities.formatDate(now, tz, 'MMMM');
  line += '. ' + monthName + ' so far ' + inr_(spend(month));

  const budgets = getBudgets_();
  const warnings = Object.keys(budgets).map(c => {
    const used = month.filter(t => t.type === 'Debit' && t.category === c).reduce((s, t) => s + t.amount, 0);
    return { c: c, pct: Math.round(used / budgets[c] * 100) };
  }).filter(w => w.pct >= 80).sort((a, b) => b.pct - a.pct)
    .map(w => w.c + ' ' + w.pct + '%');
  if (warnings.length) line += '. ⚠️ Budget: ' + warnings.join(', ');
  const emiPaid = current.filter(t => t.type === 'Debit' && t.category === 'EMI').reduce((s, t) => s + t.amount, 0);
  if (emiPaid > 0) line += '. EMI paid ' + inr_(emiPaid);
  const reminders = period === 'day' ? emiReminders_(now, tx) : [];
  return line + '.' + (reminders.length ? '\n' + reminders.join('\n') : '');
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
    emis: getEmis_(),
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
  if (!tx) throw new Error("That doesn't look like a bank transaction message (SBI, ICICI, HDFC, Axis or Kotak).");
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
