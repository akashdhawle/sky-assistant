/**
 * Sky assistant — answers "Ask Sky" questions with an AI model and the tools below.
 *
 * The Ask Sky shortcut and the app's Ask Sky box post {action: 'ask', viewKey, text} to doPost
 * (see appRequest_ in Code.gs); the dashboard calls ask() directly.
 * The model decides which tool to call; the tools run here, on your own sheet. The reply is short
 * plain text, because the shortcut speaks it aloud.
 *
 * Two providers work: Google Gemini (free tier) and Claude. In Apps Script, Project Settings →
 * Script properties, add GEMINI_API_KEY or CLAUDE_API_KEY. With both, Gemini is used unless
 * AI_PROVIDER is set to claude.
 * Optional properties: GEMINI_MODEL (default Gemini Flash-Lite), CLAUDE_MODEL (everyday questions,
 * default Haiku) and CLAUDE_REVIEW_MODEL (when you ask Sky to review your categories, default Sonnet).
 */

const SHEET_CHANGES = 'ChangeLog';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';  // new free accounts get little or no free use of the bigger Flash
const DEFAULT_MODEL = 'claude-haiku-5-5';
const DEFAULT_REVIEW_MODEL = 'claude-sonnet-5-5';
const MAX_TOOL_ROUNDS = 6;
const HISTORY_KEY = 'ask_history';
const HISTORY_SECONDS = 1800;      // a follow-up within 30 minutes continues the conversation
const HISTORY_MAX_CHARS = 90000;   // CacheService holds up to 100 KB per value
const BULK_CHANGE_LIMIT = 3;       // more changes than this in one go need a yes from you first

// Each list is its own tab: Added, title, detail, Status, Rating, Note.
const LISTS = {
  books: { sheet: 'Books', title: 'Title', detail: 'Author', statuses: ['To read', 'Reading', 'Read'] },
  movies: { sheet: 'Movies', title: 'Title', detail: 'Year or director', statuses: ['To watch', 'Watched'] },
  places: { sheet: 'Places', title: 'Place', detail: 'Where', statuses: ['Want to go', 'Visited'] },
};
const LIST_STATUSES = ['To read', 'Reading', 'Read', 'To watch', 'Watched', 'Want to go', 'Visited'];
const SHEET_QUOTES = 'Quotes';
const SHEET_JOURNAL = 'Journal';

const ASK_SYSTEM = [
  "You are Sky, Akash's personal assistant. You help with his expense tracker, which logs his bank transactions",
  '(SBI, ICICI, HDFC, Axis, Kotak) in a Google Sheet with amounts in Indian rupees, and with his lists:',
  'books, movies, places to visit, saved quotes and his journal.',
  '',
  'Your reply is read aloud by Siri, so:',
  '- Answer in 1 to 3 short spoken sentences, under 60 words. No lists, markdown, emoji or row numbers.',
  '- Say amounts like "₹1,240" and dates like "21 October".',
  '',
  'Money:',
  'Use the tools for every fact about money; never guess a number.',
  'When Akash says a transaction is in the wrong category, find it, change it with set_category, and say exactly',
  'what changed, for example "Moved ₹450 Swiggy on 21 October from Food to Gifts." If several transactions could',
  'match, ask which one instead of guessing.',
  'Change at most ' + BULK_CHANGE_LIMIT + ' transactions per request. If a fix needs more, say how many and ask him to confirm first.',
  'If he says undo, use undo_last_change.',
  'Spending categories: ' + CATEGORIES.join(', ') + '. Income categories: ' + INCOME_CATEGORIES.join(', ') + '.',
  '',
  'Lists:',
  '- "Add X to my TBR / reading list" is a book; "watchlist" is a movie or show; "places to visit" is a place.',
  '- When adding a book or movie without the author or year, fill it in only if you are sure which one he means.',
  '- Say what you did in a few words, for example "Added Atomic Habits by James Clear to your reading list."',
  '- "I finished X" or "I watched X" means update its status; ask for a rating out of 5 only if he seems happy to give one.',
  '- To suggest what to read or watch next, look at the list first and pick from it.',
  '- Save quotes word for word. When reading one back, say the quote, then who said it or the book.',
  '- Journal: save what he says in his own words, only removing filler like "um". Read entries back only when he asks.',
  'If he asks for something you cannot do yet (news, reminders, stocks and so on), say it is coming soon.',
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
  {
    name: 'list_add',
    description: 'Adds a book, movie or place to its list. detail is the author (books), year or director (movies), ' +
      'or city and country (places); note is anything else he mentions. Use empty strings for what you do not know.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        list: { type: 'string', enum: ['books', 'movies', 'places'] },
        title: { type: 'string' },
        detail: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['list', 'title', 'detail', 'note'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_update',
    description: 'Changes an item on a list, found by part of its title. Books: To read, Reading, Read. ' +
      'Movies: To watch, Watched. Places: Want to go, Visited. Removed takes it off the list. ' +
      'Use keep for status, 0 for rating and an empty note to leave them as they are. A new note replaces the old one.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        list: { type: 'string', enum: ['books', 'movies', 'places'] },
        title: { type: 'string', description: 'Part of the title, any case.' },
        status: { type: 'string', enum: LIST_STATUSES.concat(['Removed', 'keep']) },
        rating: { type: 'integer', description: '1 to 5, or 0 to keep.' },
        note: { type: 'string' },
      },
      required: ['list', 'title', 'status', 'rating', 'note'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_show',
    description: 'Reads a list, newest first, with how many items have each status. Use any for every status.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        list: { type: 'string', enum: ['books', 'movies', 'places'] },
        status: { type: 'string', enum: LIST_STATUSES.concat(['any']) },
        limit: { type: 'integer', description: 'How many to return, 1 to 30.' },
      },
      required: ['list', 'status', 'limit'],
      additionalProperties: false,
    },
  },
  {
    name: 'quote_save',
    description: 'Saves a quote word for word. source is the book, film or place it is from; author is who said or wrote it. ' +
      'Empty strings when unknown.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { quote: { type: 'string' }, source: { type: 'string' }, author: { type: 'string' } },
      required: ['quote', 'source', 'author'],
      additionalProperties: false,
    },
  },
  {
    name: 'quote_random',
    description: 'Picks a random saved quote. about narrows it to quotes whose text, source or author contains it; empty for any.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { about: { type: 'string' } },
      required: ['about'],
      additionalProperties: false,
    },
  },
  {
    name: 'journal_add',
    description: 'Saves a journal entry for today, in his own words.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { entry: { type: 'string' } },
      required: ['entry'],
      additionalProperties: false,
    },
  },
  {
    name: 'journal_read',
    description: 'Reads journal entries, newest first. Dates are yyyy-mm-dd; empty strings for no limit or no search.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string' },
        to_date: { type: 'string' },
        search: { type: 'string', description: 'A word or phrase the entry contains.' },
        limit: { type: 'integer', description: 'How many to return, 1 to 10.' },
      },
      required: ['from_date', 'to_date', 'search', 'limit'],
      additionalProperties: false,
    },
  },
];

// ---------- the conversation ----------

/** Called from the dashboard's Ask Sky box. */
function ask(text) {
  if (!isOwner_()) throw new Error('Not allowed');
  return ask_(text);
}

/** Answers one question. Returns the text to speak. */
function ask_(text) {
  const question = String(text || '').trim().slice(0, 2000);
  if (!question) return 'I didn\'t catch that. Try again?';
  const props = PropertiesService.getScriptProperties();
  const provider = aiProvider_(props);
  const p = PROVIDERS[provider];
  const apiKey = props.getProperty(p.keyName);
  if (!apiKey) return 'Sky needs an API key first. Add GEMINI_API_KEY or CLAUDE_API_KEY in the script\'s properties.';

  const isReview = /\b(review|check|go through)\b.*\bcategor/i.test(question);
  const model = provider === 'gemini' ? (props.getProperty('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL)
    : isReview ? (props.getProperty('CLAUDE_REVIEW_MODEL') || DEFAULT_REVIEW_MODEL)
    : (props.getProperty('CLAUDE_MODEL') || DEFAULT_MODEL);

  const cache = CacheService.getScriptCache();
  let messages = loadHistory_(cache, model);
  const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "EEEE d MMMM yyyy, HH:mm");
  messages.push(p.userMessage('[Now: ' + now + ']\n' + question));

  let reply = '', finished = false;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const turn = p.call(apiKey, model, messages);
    if (turn.message) messages.push(turn.message);
    if (turn.refused) {
      reply = 'Sorry, I can\'t help with that one.';
      break;
    }
    reply = turn.text || reply;
    if (!turn.calls.length) {
      finished = true;
      break;
    }
    messages.push(p.resultsMessage(turn.calls.map(c => runTool_(c))));
  }

  // Only a finished exchange is kept for follow-ups ("move it to Gifts").
  if (finished) saveHistory_(cache, model, messages);
  else cache.remove(HISTORY_KEY);
  return reply || 'Sorry, something went wrong. Try asking again.';
}

/** gemini or claude: AI_PROVIDER if set, otherwise whichever key is there (Gemini first). */
function aiProvider_(props) {
  const chosen = String(props.getProperty('AI_PROVIDER') || '').trim().toLowerCase();
  if (PROVIDERS[chosen]) return chosen;
  return props.getProperty('GEMINI_API_KEY') ? 'gemini' : 'claude';
}

// Each provider keeps history in its own message format and returns one turn as
// {message, text, calls: [{id, name, input}], refused}.
const PROVIDERS = {
  claude: {
    keyName: 'CLAUDE_API_KEY',
    userMessage: text => ({ role: 'user', content: text }),
    call: callClaude_,
    resultsMessage: results => ({
      role: 'user',
      content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.out), is_error: r.isError })),
    }),
  },
  gemini: {
    keyName: 'GEMINI_API_KEY',
    userMessage: text => ({ role: 'user', parts: [{ text: text }] }),
    call: callGemini_,
    resultsMessage: results => ({
      role: 'user',
      parts: results.map(r => ({ functionResponse: Object.assign(
        { name: r.name, response: r.isError ? { error: r.out.error } : { result: r.out } }, r.id ? { id: r.id } : {}) })),
    }),
  },
};

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
  const content = data.content || [];
  return {
    message: { role: 'assistant', content: content },
    text: content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim(),
    calls: data.stop_reason === 'tool_use' ? content.filter(b => b.type === 'tool_use') : [],
    refused: data.stop_reason === 'refusal',
  };
}

function callGemini_(apiKey, model, contents) {
  const body = {
    systemInstruction: { parts: [{ text: ASK_SYSTEM }] },
    contents: contents,
    tools: [{ functionDeclarations: ASK_TOOLS.map(geminiTool_) }],
  };
  const resp = UrlFetchApp.fetch(GEMINI_URL + encodeURIComponent(model) + ':generateContent', {
    method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  const data = JSON.parse(resp.getContentText() || '{}');
  if (code !== 200) {
    const msg = (data.error && data.error.message) || ('HTTP ' + code);
    // Google's message names the limit that was hit (per minute or per day) and when to retry.
    if (code === 429) throw new Error('Gemini limit reached: ' + msg.split('\n')[0].slice(0, 300));
    throw new Error(/API key/i.test(msg) ? 'Gemini API key was rejected' : 'Gemini: ' + msg);
  }
  const cand = (data.candidates || [])[0];
  if (!cand || !cand.content) return { message: null, text: '', calls: [], refused: true };
  const parts = cand.content.parts || [];
  return {
    // The model's turn goes back unchanged: its parts can carry thought signatures that Gemini checks.
    message: { role: 'model', parts: parts },
    text: parts.filter(x => typeof x.text === 'string' && !x.thought).map(x => x.text).join(' ').trim(),
    calls: parts.filter(x => x.functionCall).map(x => ({ id: x.functionCall.id, name: x.functionCall.name, input: x.functionCall.args || {} })),
    refused: /SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(cand.finishReason || ''),
  };
}

/** A Claude tool definition in Gemini's format, which has no additionalProperties and no empty objects. */
function geminiTool_(tool) {
  const schema = tool.input_schema;
  const decl = { name: tool.name, description: tool.description };
  if (Object.keys(schema.properties).length) {
    decl.parameters = { type: 'object', properties: schema.properties, required: schema.required };
  }
  return decl;
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
  // History is never trimmed (that would change what the model already saw); a long one starts over instead.
  if (json.length > HISTORY_MAX_CHARS) cache.remove(HISTORY_KEY);
  else cache.put(HISTORY_KEY, json, HISTORY_SECONDS);
}

/** Runs one tool call: {id, name, input} → {id, name, out, isError}. */
function runTool_(call) {
  let out, isError = false;
  try {
    const input = call.input || {};
    switch (call.name) {
      case 'spending_summary': out = toolSummary_(input.period, new Date()); break;
      case 'find_transactions': out = toolFind_(input); break;
      case 'set_category': out = toolSetCategory_(input.row, input.category, input.remember_rule); break;
      case 'review_categories': out = toolReview_(input.period, new Date()); break;
      case 'undo_last_change': out = toolUndo_(); break;
      case 'list_add': out = toolListAdd_(input); break;
      case 'list_update': out = toolListUpdate_(input); break;
      case 'list_show': out = toolListShow_(input); break;
      case 'quote_save': out = toolQuoteSave_(input); break;
      case 'quote_random': out = toolQuoteRandom_(input.about); break;
      case 'journal_add': out = toolJournalAdd_(input.entry); break;
      case 'journal_read': out = toolJournalRead_(input); break;
      default: throw new Error('Unknown tool ' + call.name);
    }
  } catch (err) {
    out = { error: err.message };
    isError = true;
  }
  return { id: call.id, name: call.name, out: out, isError: isError };
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

// ---------- lists, quotes and journal ----------

/** The tab with these headers, created on first use. */
function tab_(name, headers) {
  const ss = ss_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function listCfg_(list) {
  const cfg = LISTS[list];
  if (!cfg) throw new Error('No list called ' + list);
  return cfg;
}

/** Every item on a list (Removed ones too), oldest first, with its row. */
function listItems_(list) {
  const cfg = listCfg_(list);
  const sheet = tab_(cfg.sheet, ['Added', cfg.title, cfg.detail, 'Status', 'Rating', 'Note']);
  const last = sheet.getLastRow();
  const rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, 6).getValues();
  return {
    sheet: sheet,
    items: rows.map((r, i) => ({
      row: i + 2, added: r[0], title: String(r[1]), detail: String(r[2]), status: String(r[3]),
      rating: Number(r[4]) || 0, note: String(r[5]),
    })).filter(it => it.title),
  };
}

function shortItem_(it) {
  return { title: it.title, detail: it.detail, status: it.status, rating: it.rating, note: it.note,
    added: it.added ? Utilities.formatDate(new Date(it.added), Session.getScriptTimeZone(), 'yyyy-MM-dd') : '' };
}

function toolListAdd_(q) {
  const cfg = listCfg_(q.list);
  const title = String(q.title || '').trim();
  if (!title) throw new Error('A title is needed');
  const data = listItems_(q.list);
  const same = data.items.find(it => it.status !== 'Removed' && it.title.toLowerCase() === title.toLowerCase());
  if (same) return { added: false, note: 'Already on the list', item: shortItem_(same) };
  data.sheet.appendRow([new Date(), title, String(q.detail || '').trim(), cfg.statuses[0], '', String(q.note || '').trim()]);
  return { added: true, list: q.list, title: title, detail: q.detail, status: cfg.statuses[0] };
}

function toolListUpdate_(q) {
  const cfg = listCfg_(q.list);
  const want = String(q.title || '').trim().toLowerCase();
  if (!want) throw new Error('Say which one');
  const data = listItems_(q.list);
  const live = data.items.filter(it => it.status !== 'Removed');
  let hits = live.filter(it => it.title.toLowerCase() === want);
  if (!hits.length) hits = live.filter(it => it.title.toLowerCase().indexOf(want) !== -1);
  if (!hits.length) return { updated: false, note: 'Not on the ' + q.list + ' list' };
  if (hits.length > 1) return { updated: false, note: 'More than one match; ask which', matches: hits.slice(0, 5).map(shortItem_) };
  const it = hits[0];
  const status = q.status && q.status !== 'keep' ? q.status : it.status;
  if (status !== 'Removed' && cfg.statuses.indexOf(status) === -1) {
    throw new Error('Status for ' + q.list + ' must be one of ' + cfg.statuses.join(', '));
  }
  const rating = Math.round(Number(q.rating) || 0);
  if (rating < 0 || rating > 5) throw new Error('Rating is 1 to 5');
  const note = String(q.note || '').trim();
  data.sheet.getRange(it.row, 4, 1, 3).setValues([[status, rating || it.rating || '', note || it.note]]);
  return { updated: true, title: it.title, from: it.status, status: status, rating: rating || it.rating, note: note || it.note };
}

function toolListShow_(q) {
  const live = listItems_(q.list).items.filter(it => it.status !== 'Removed');
  const counts = {};
  live.forEach(it => counts[it.status] = (counts[it.status] || 0) + 1);
  const hits = live.filter(it => !q.status || q.status === 'any' || it.status === q.status).reverse();
  const limit = Math.min(30, Math.max(1, Math.round(Number(q.limit) || 10)));
  return { list: q.list, counts: counts, total: hits.length, items: hits.slice(0, limit).map(shortItem_) };
}

function quotes_() {
  const sheet = tab_(SHEET_QUOTES, ['Added', 'Quote', 'Source', 'Author']);
  const last = sheet.getLastRow();
  const rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, 4).getValues();
  return { sheet: sheet, quotes: rows.map(r => ({ quote: String(r[1]), source: String(r[2]), author: String(r[3]) })).filter(x => x.quote) };
}

function toolQuoteSave_(q) {
  const quote = String(q.quote || '').trim();
  if (!quote) throw new Error('No quote given');
  const data = quotes_();
  if (data.quotes.some(x => x.quote.toLowerCase() === quote.toLowerCase())) return { saved: false, note: 'Already saved' };
  data.sheet.appendRow([new Date(), quote, String(q.source || '').trim(), String(q.author || '').trim()]);
  return { saved: true, total: data.quotes.length + 1 };
}

function toolQuoteRandom_(about) {
  const want = String(about || '').trim().toLowerCase();
  const all = quotes_().quotes;
  const pool = want ? all.filter(x => (x.quote + ' ' + x.source + ' ' + x.author).toLowerCase().indexOf(want) !== -1) : all;
  if (!pool.length) return { found: false, note: all.length ? 'No saved quote matches' : 'No quotes saved yet' };
  return Object.assign({ found: true, of: pool.length }, pool[Math.floor(Math.random() * pool.length)]);
}

function toolJournalAdd_(entry) {
  const text = String(entry || '').trim();
  if (!text) throw new Error('Nothing to save');
  tab_(SHEET_JOURNAL, ['Date', 'Entry']).appendRow([new Date(), text]);
  return { saved: true, words: text.split(/\s+/).length };
}

function toolJournalRead_(q) {
  const sheet = tab_(SHEET_JOURNAL, ['Date', 'Entry']);
  const last = sheet.getLastRow();
  const rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, 2).getValues();
  const from = q.from_date ? new Date(q.from_date + 'T00:00:00') : null;
  const to = q.to_date ? new Date(q.to_date + 'T23:59:59') : null;
  const want = String(q.search || '').trim().toLowerCase();
  const tz = Session.getScriptTimeZone();
  const hits = rows.filter(r => {
    const d = new Date(r[0]);
    return r[1] && (!from || d >= from) && (!to || d <= to) && (!want || String(r[1]).toLowerCase().indexOf(want) !== -1);
  }).reverse();
  const limit = Math.min(10, Math.max(1, Math.round(Number(q.limit) || 3)));
  return { total: hits.length, entries: hits.slice(0, limit).map(r => ({
    date: Utilities.formatDate(new Date(r[0]), tz, 'yyyy-MM-dd HH:mm'), entry: String(r[1]) })) };
}

// ---------- the app's Lists screen ----------
// The dashboard calls these directly; the installable app goes through appRequest_ in Code.gs.
// Each change returns every list again, so the screen redraws from one call.

function getLists() {
  if (!isOwner_()) throw new Error('Not allowed');
  return getLists_();
}
function listAdd(list, item) {
  if (!isOwner_()) throw new Error('Not allowed');
  return listAdd_(list, item);
}
function listSet(list, row, changes) {
  if (!isOwner_()) throw new Error('Not allowed');
  return listSet_(list, row, changes);
}
function quoteAdd(quote) {
  if (!isOwner_()) throw new Error('Not allowed');
  return quoteAdd_(quote);
}
function journalAdd(entry) {
  if (!isOwner_()) throw new Error('Not allowed');
  return journalAdd_(entry);
}

function getLists_() {
  const out = { statuses: {} };
  Object.keys(LISTS).forEach(k => {
    out.statuses[k] = LISTS[k].statuses;
    out[k] = listItems_(k).items.filter(it => it.status !== 'Removed').reverse()
      .map(it => Object.assign({ row: it.row }, shortItem_(it)));
  });
  out.quotes = quotes_().quotes.reverse();
  out.journal = toolJournalRead_({ from_date: '', to_date: '', search: '', limit: 10 }).entries;
  return out;
}

function listAdd_(list, item) {
  item = item || {};
  toolListAdd_({ list: list, title: item.title, detail: item.detail, note: item.note });
  return getLists_();
}

/** Sets status and/or rating (0 clears it) on one row, from the app. */
function listSet_(list, row, changes) {
  const cfg = listCfg_(list);
  const it = listItems_(list).items.find(x => x.row === Number(row));
  if (!it) throw new Error('That item is gone; pull to refresh');
  changes = changes || {};
  const status = changes.status || it.status;
  if (status !== 'Removed' && cfg.statuses.indexOf(status) === -1) throw new Error('Unknown status ' + status);
  const rating = 'rating' in changes ? Math.round(Number(changes.rating) || 0) : it.rating;
  if (rating < 0 || rating > 5) throw new Error('Rating is 1 to 5');
  const sheet = ss_().getSheetByName(cfg.sheet);
  sheet.getRange(it.row, 4, 1, 2).setValues([[status, rating || '']]);
  return getLists_();
}

function quoteAdd_(quote) {
  toolQuoteSave_(quote || {});
  return getLists_();
}

function journalAdd_(entry) {
  toolJournalAdd_(entry);
  return getLists_();
}
