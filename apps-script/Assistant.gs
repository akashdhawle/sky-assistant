/**
 * Sky assistant — answers "Ask Sky" questions with Claude and the tools below.
 *
 * The Ask Sky shortcut posts {action: 'ask', viewKey, text} to doPost (see appRequest_ in Code.gs).
 * Claude decides which tool to call; the tools run here, on your own sheet. The reply is short
 * plain text, because the shortcut speaks it aloud.
 *
 * One-time: in Apps Script, Project Settings → Script properties, add CLAUDE_API_KEY.
 * Optional properties: CLAUDE_MODEL (everyday questions, default Haiku) and
 * CLAUDE_REVIEW_MODEL (when you ask Sky to review your categories, default Sonnet).
 */

const SHEET_CHANGES = 'ChangeLog';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-5-5';
const DEFAULT_REVIEW_MODEL = 'claude-sonnet-5-5';
const MAX_TOOL_ROUNDS = 6;
const HISTORY_KEY = 'ask_history';
const HISTORY_SECONDS = 1800;      // a follow-up within 30 minutes continues the conversation
const HISTORY_MAX_CHARS = 90000;   // CacheService holds up to 100 KB per value
const BULK_CHANGE_LIMIT = 3;       // more changes than this in one go need a yes from you first

const ASK_SYSTEM = [
  "You are Sky, Akash's personal assistant. Right now you help with his expense tracker,",
  'which logs his bank transactions (SBI, ICICI, HDFC, Axis, Kotak) in a Google Sheet. Amounts are in Indian rupees.',
  '',
  'Your reply is read aloud by Siri, so:',
  '- Answer in 1 to 3 short spoken sentences, under 60 words. No lists, markdown, emoji or row numbers.',
  '- Say amounts like "₹1,240" and dates like "21 October".',
  '',
  'Use the tools for every fact about money; never guess a number.',
  'When Akash says a transaction is in the wrong category, find it, change it with set_category, and say exactly',
  'what changed, for example "Moved ₹450 Swiggy on 21 October from Food to Gifts." If several transactions could',
  'match, ask which one instead of guessing.',
  'Change at most ' + BULK_CHANGE_LIMIT + ' transactions per request. If a fix needs more, say how many and ask him to confirm first.',
  'If he says undo, use undo_last_change.',
  'Spending categories: ' + CATEGORIES.join(', ') + '. Income categories: ' + INCOME_CATEGORIES.join(', ') + '.',
  'If he asks for something you cannot do yet (books, news, reminders and so on), say it is coming soon.',
].join('\n');

const ASK_TOOLS = [
  {
    name: 'spending_summary',
    description: 'Totals for a period: money spent and received, spending by category, top merchants, and monthly budget use.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month'] },
      },
      required: ['period'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_transactions',
    description: 'Searches transactions, newest first. Use empty strings or 0 for filters you do not need. Dates are yyyy-mm-dd.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        merchant: { type: 'string', description: 'Part of the merchant name, any case. Empty for any.' },
        category: { type: 'string', description: 'Exact category name. Empty for any.' },
        from_date: { type: 'string', description: 'First day to include. Empty for no limit.' },
        to_date: { type: 'string', description: 'Last day to include. Empty for no limit.' },
        min_amount: { type: 'number', description: 'Smallest amount in rupees. 0 for any.' },
        limit: { type: 'integer', description: 'How many to return, 1 to 25.' },
      },
      required: ['merchant', 'category', 'from_date', 'to_date', 'min_amount', 'limit'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_category',
    description: 'Moves one transaction to another category and logs the change so it can be undone. ' +
      'remember_rule: true makes future payments to the same merchant use this category too.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer', description: 'The row from find_transactions or review_categories.' },
        category: { type: 'string', enum: CATEGORIES.concat(INCOME_CATEGORIES) },
        remember_rule: { type: 'boolean' },
      },
      required: ['row', 'category', 'remember_rule'],
      additionalProperties: false,
    },
  },
  {
    name: 'review_categories',
    description: 'Lists spending that may be in the wrong category: everything in Other, and merchants that appear ' +
      'under more than one category. Judge from the merchant names before suggesting changes.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { period: { type: 'string', enum: ['this_month', 'last_month'] } },
      required: ['period'],
      additionalProperties: false,
    },
  },
  {
    name: 'undo_last_change',
    description: 'Puts back the category of the most recent change made through Sky.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

// ---------- the conversation ----------

/** Answers one question. Returns the text to speak. */
function ask_(text) {
  const question = String(text || '').trim().slice(0, 2000);
  if (!question) return 'I didn\'t catch that. Try again?';
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('CLAUDE_API_KEY');
  if (!apiKey) return 'Sky needs a Claude API key first. Add CLAUDE_API_KEY in the script\'s properties.';

  const isReview = /\b(review|check|go through)\b.*\bcategor/i.test(question);
  const model = isReview ? (props.getProperty('CLAUDE_REVIEW_MODEL') || DEFAULT_REVIEW_MODEL)
    : (props.getProperty('CLAUDE_MODEL') || DEFAULT_MODEL);

  const cache = CacheService.getScriptCache();
  let messages = loadHistory_(cache, model);
  const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "EEEE d MMMM yyyy, HH:mm");
  messages.push({ role: 'user', content: '[Now: ' + now + ']\n' + question });

  let reply = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = callClaude_(apiKey, model, messages);
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'refusal') {
      reply = 'Sorry, I can\'t help with that one.';
      break;
    }
    reply = res.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim() || reply;
    if (res.stop_reason !== 'tool_use') break;
    const results = res.content.filter(b => b.type === 'tool_use').map(b => runTool_(b));
    messages.push({ role: 'user', content: results });
  }

  // Only a finished exchange is kept for follow-ups ("move it to Gifts").
  if (messages[messages.length - 1].role === 'assistant') saveHistory_(cache, model, messages);
  else cache.remove(HISTORY_KEY);
  return reply || 'Sorry, something went wrong. Try asking again.';
}

function callClaude_(apiKey, model, messages) {
  const body = {
    model: model,
    max_tokens: 4096,
    system: ASK_SYSTEM,
    tools: ASK_TOOLS,
    messages: messages,
    output_config: { effort: 'low' },
    cache_control: { type: 'ephemeral' },
  };
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  // Haiku has no server-side fallback; Sonnet and Opus retry a declined request on another model.
  if (!/haiku/.test(model)) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }
  const resp = UrlFetchApp.fetch(CLAUDE_URL, {
    method: 'post', contentType: 'application/json', headers: headers,
    payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  const data = JSON.parse(resp.getContentText() || '{}');
  if (code !== 200) {
    const msg = (data.error && data.error.message) || ('HTTP ' + code);
    throw new Error(code === 401 ? 'Claude API key was rejected' : 'Claude: ' + msg);
  }
  return data;
}

/** The previous exchange, if it was recent and used the same model (thinking blocks belong to one model). */
function loadHistory_(cache, model) {
  try {
    const saved = JSON.parse(cache.get(HISTORY_KEY) || 'null');
    return saved && saved.model === model ? saved.messages : [];
  } catch (err) {
    return [];
  }
}

function saveHistory_(cache, model, messages) {
  const json = JSON.stringify({ model: model, messages: messages });
  // History is never trimmed (that would change what Claude already saw); a long one starts over instead.
  if (json.length > HISTORY_MAX_CHARS) cache.remove(HISTORY_KEY);
  else cache.put(HISTORY_KEY, json, HISTORY_SECONDS);
}

function runTool_(block) {
  let out, isError = false;
  try {
    const input = block.input || {};
    switch (block.name) {
      case 'spending_summary': out = toolSummary_(input.period, new Date()); break;
      case 'find_transactions': out = toolFind_(input); break;
      case 'set_category': out = toolSetCategory_(input.row, input.category, input.remember_rule); break;
      case 'review_categories': out = toolReview_(input.period, new Date()); break;
      case 'undo_last_change': out = toolUndo_(); break;
      default: throw new Error('Unknown tool ' + block.name);
    }
  } catch (err) {
    out = { error: err.message };
    isError = true;
  }
  return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out), is_error: isError };
}

// ---------- tools ----------

/** [start, end) of a named period, in the script's time zone. */
function periodRange_(period, now) {
  const tz = Session.getScriptTimeZone();
  const y = +Utilities.formatDate(now, tz, 'yyyy'), m = +Utilities.formatDate(now, tz, 'M') - 1;
  const d = +Utilities.formatDate(now, tz, 'd'), dow = +Utilities.formatDate(now, tz, 'u');  // 1 = Monday
  const day = (yy, mm, dd) => new Date(yy, mm, dd);
  switch (period) {
    case 'today': return [day(y, m, d), day(y, m, d + 1)];
    case 'yesterday': return [day(y, m, d - 1), day(y, m, d)];
    case 'this_week': return [day(y, m, d - dow + 1), day(y, m, d + 1)];
    case 'last_week': return [day(y, m, d - dow - 6), day(y, m, d - dow + 1)];
    case 'last_month': return [day(y, m - 1, 1), day(y, m, 1)];
    default: return [day(y, m, 1), day(y, m, d + 1)];  // this_month
  }
}

function txIn_(range) {
  return getData_().tx.filter(t => {
    const d = new Date(t.date);
    return d >= range[0] && d < range[1];
  });
}

function shortTx_(t) {
  return {
    row: t.row, date: Utilities.formatDate(new Date(t.date), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    merchant: t.merchant, amount: t.amount, category: t.category, type: t.type, bank: t.bank,
  };
}

function toolSummary_(period, now) {
  const list = txIn_(periodRange_(period, now));
  const isSpend = t => t.type === 'Debit';
  const sum = arr => arr.reduce((s, t) => s + t.amount, 0);
  const byCat = {}, byMerchant = {};
  list.filter(isSpend).forEach(t => {
    byCat[t.category] = (byCat[t.category] || 0) + t.amount;
    byMerchant[t.merchant] = (byMerchant[t.merchant] || 0) + t.amount;
  });
  const top = (obj, n) => Object.keys(obj).sort((a, b) => obj[b] - obj[a]).slice(0, n)
    .map(k => ({ name: k, amount: Math.round(obj[k]) }));
  const out = {
    period: period,
    spent: Math.round(sum(list.filter(isSpend))),
    payments: list.filter(isSpend).length,
    refunds: Math.round(sum(list.filter(t => t.type === 'Credit' && t.category === 'Refund'))),
    received: Math.round(sum(list.filter(t => t.type === 'Credit' && t.category !== 'Refund'))),
    by_category: top(byCat, 12),
    top_merchants: top(byMerchant, 5),
  };
  if (period === 'this_month' || period === 'last_month') {
    const budgets = getBudgets_();
    out.budgets = Object.keys(budgets).map(c => ({
      category: c, limit: budgets[c], used: Math.round(byCat[c] || 0),
      percent: Math.round((byCat[c] || 0) / budgets[c] * 100),
    }));
  }
  return out;
}

function toolFind_(q) {
  const merchant = String(q.merchant || '').toLowerCase().trim();
  const category = String(q.category || '').trim();
  const from = q.from_date ? new Date(q.from_date + 'T00:00:00') : null;
  const to = q.to_date ? new Date(q.to_date + 'T23:59:59') : null;
  const limit = Math.min(25, Math.max(1, Math.round(Number(q.limit) || 10)));
  const hits = getData_().tx.filter(t => {
    const d = new Date(t.date);
    return (!merchant || String(t.merchant).toLowerCase().indexOf(merchant) !== -1) &&
      (!category || t.category === category) &&
      (!from || d >= from) && (!to || d <= to) &&
      t.amount >= (Number(q.min_amount) || 0);
  });
  hits.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { count: hits.length, transactions: hits.slice(0, limit).map(shortTx_) };
}

function toolSetCategory_(row, category, rememberRule) {
  const sheet = ss_().getSheetByName(SHEET_TX);
  row = Number(row);
  if (!(row >= 2 && row <= sheet.getLastRow())) throw new Error('No such row');
  const before = sheet.getRange(row, 1, 1, 5).getValues()[0];
  const from = String(before[4]);
  if (from === category) return { changed: false, note: 'Already in ' + category };
  setCategory_(row, category, rememberRule);
  logChange_(row, before, from, category);
  return { changed: true, row: row, merchant: before[3], amount: Number(before[2]), from: from, to: category,
    rule_saved: !!rememberRule };
}

function toolReview_(period, now) {
  const spend = txIn_(periodRange_(period, now)).filter(t => t.type === 'Debit');
  const cats = {};
  spend.forEach(t => {
    const k = String(t.merchant).toLowerCase();
    (cats[k] = cats[k] || {})[t.category] = true;
  });
  const mixed = Object.keys(cats).filter(k => Object.keys(cats[k]).length > 1);
  const suspects = spend.filter(t => t.category === 'Other' || mixed.indexOf(String(t.merchant).toLowerCase()) !== -1);
  return { count: suspects.length, transactions: suspects.slice(0, 40).map(shortTx_), categories: CATEGORIES };
}

function toolUndo_() {
  const log = ss_().getSheetByName(SHEET_CHANGES);
  if (!log || log.getLastRow() < 2) return { undone: false, note: 'Nothing to undo' };
  const rows = log.getRange(2, 1, log.getLastRow() - 1, 7).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r[6]) continue;  // already undone
    setCategory_(Number(r[1]), String(r[4]), false);
    log.getRange(i + 2, 7).setValue(new Date());
    return { undone: true, merchant: r[2], amount: Number(r[3]), back_to: r[4], was: r[5] };
  }
  return { undone: false, note: 'Nothing to undo' };
}

/** One row per change: when, row, merchant, amount, from, to, undone at. */
function logChange_(row, before, from, to) {
  const ss = ss_();
  let log = ss.getSheetByName(SHEET_CHANGES);
  if (!log) {
    log = ss.insertSheet(SHEET_CHANGES);
    log.appendRow(['When', 'Row', 'Merchant', 'Amount', 'From', 'To', 'Undone at']);
    log.setFrozenRows(1);
  }
  log.appendRow([new Date(), row, before[3], Number(before[2]), from, to, '']);
}
