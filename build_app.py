"""Builds the app's index.html (docs/ in the repository, app/ in the project folder) (the installable Expenses app) from Dashboard.html.

Both pages share the same dashboard code. The app version swaps the Google
`api` block for one that talks to the script's web-app link with the view key,
and adds the connect screen, Home Screen tags and the offline service worker.

Run: python3 build_app.py
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).parent
# Repository layout (apps-script/ and docs/), or the flat project-folder layout (app/).
SRC = ROOT / 'apps-script' / 'Dashboard.html'
if not SRC.exists():
    SRC = ROOT / 'Dashboard.html'
OUT = ROOT / 'docs' if (ROOT / 'docs').exists() else ROOT / 'app'
src = SRC.read_text()

HEAD = """<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Expenses</title>
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Expenses">
<meta name="theme-color" content="#f6f7f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1115" media="(prefers-color-scheme: dark)">"""

CONNECT_CSS = """  #connect { padding: 24px 0; }
  #connect[hidden] { display: none; }
  #connect p { color: var(--muted); }
  #disconnect { display: block; margin: 24px auto 0; }
</style>"""

CONNECT_HTML = """<div id="connect" hidden>
  <div class="card">
    <h2>Connect your sheet</h2>
    <p>You only do this once on this phone. Paste your <b>receive link</b> (the same link that's in your Log Bank SMS shortcut) and the <b>View key</b> from the Setup tab of your Sky Expenses sheet.</p>
    <label class="field">App link (the receive link ending in /exec)
      <input id="cLink" type="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec"></label>
    <label class="field">View key
      <input id="cKey" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <div class="note" id="cNote"></div>
    <div class="actions"><button class="primary" id="cGo">Connect</button></div>
  </div>
</div>

<div id="msg">Loading…</div>"""

API = """/* BEGIN api */
// Talks to your own Google Apps Script with the view key saved on this device.
const store = {
  get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  del: k => { try { localStorage.removeItem(k); } catch (e) {} },
};
const ACTIONS = {
  getData: () => ({ action: 'data' }),
  setBudgets: budgets => ({ action: 'setBudgets', budgets }),
  setCategory: (row, category) => ({ action: 'setCategory', row, category }),
  addFromSms: text => ({ action: 'addSms', text }),
  addManual: entry => ({ action: 'addManual', entry }),
  setEmis: emis => ({ action: 'setEmis', emis }),
  ask: text => ({ action: 'ask', text }),
  getLists: () => ({ action: 'lists' }),
  listAdd: (list, item) => ({ action: 'listAdd', list, item }),
  listSet: (list, row, changes) => ({ action: 'listSet', list, row, changes }),
  quoteAdd: quote => ({ action: 'quoteAdd', quote }),
  journalAdd: entry => ({ action: 'journalAdd', entry }),
};
function call(link, viewKey, body) {
  return fetch(link, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },  // avoids a CORS preflight
    body: JSON.stringify(Object.assign({ viewKey }, body)),
  }).then(r => r.json()).then(r => {
    if (!r.ok) throw new Error(r.error || 'Request failed');
    return r.result;
  });
}
const api = (fn, ...args) => {
  const link = store.get('link'), key = store.get('viewKey');
  const p = call(link, key, ACTIONS[fn](...args));
  if (fn !== 'getData') return p;
  return p.then(d => { store.set('cache', JSON.stringify(d)); return d; })
    .catch(err => {
      const cached = store.get('cache');
      if (!cached) throw err;
      setTimeout(() => { $('compare').textContent = 'Offline: showing your last saved data'; }, 0);
      return JSON.parse(cached);
    });
};

function showConnect() {
  document.querySelector('.month').style.visibility = 'hidden';
  $('msg').hidden = true; $('app').hidden = true; $('fab').hidden = true; $('connect').hidden = false;
  $('views').hidden = true; $('lists').hidden = true;
  const h = new URLSearchParams(location.hash.slice(1));
  $('cLink').value = h.get('link') || store.get('link') || '';
  $('cKey').value = h.get('key') || '';
}
$('cGo').onclick = () => {
  const link = $('cLink').value.trim(), key = $('cKey').value.trim();
  if (!/^https:\\/\\/script\\.google\\.com\\/macros\\/s\\/.+\\/exec$/.test(link)) {
    $('cNote').className = 'note neg'; $('cNote').textContent = 'The link should start with https://script.google.com/macros/s/ and end with /exec';
    return;
  }
  $('cNote').className = 'note'; $('cNote').textContent = 'Connecting…';
  call(link, key, { action: 'data' }).then(d => {
    store.set('link', link); store.set('viewKey', key); store.set('cache', JSON.stringify(d));
    history.replaceState(null, '', location.pathname);
    $('connect').hidden = true; $('msg').hidden = false;
    document.querySelector('.month').style.visibility = ''; load();
  }).catch(e => { $('cNote').className = 'note neg'; $('cNote').textContent = 'Could not connect: ' + e.message; });
};
function disconnect() {
  if (!confirm('Disconnect this phone from your sheet? Your data stays in your sheet.')) return;
  ['link', 'viewKey', 'cache'].forEach(store.del);
  showConnect();
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
/* END api */"""

out = src
out = out.replace('<base target="_top">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="Expenses">', HEAD, 1)
out = out.replace('</style>', CONNECT_CSS, 1)
out = out.replace('<div id="msg">Loading…</div>', CONNECT_HTML, 1)
out = out.replace('  <div class="card"><h2>Transactions</h2><ul class="rows" id="list"></ul></div>\n</div>',
                  '  <div class="card"><h2>Transactions</h2><ul class="rows" id="list"></ul></div>\n'
                  '  <button class="ghost" id="disconnect" onclick="disconnect()">Disconnect this phone</button>\n</div>', 1)
out, n = re.subn(r'/\* BEGIN api \*/.*?/\* END api \*/', lambda m: API, out, flags=re.S)
assert n == 1, 'api block not found'
assert out.rstrip().endswith('load();\n</script>\n</body>\n</html>'.rstrip()) or 'load();\n</script>' in out
out = out.replace('\nload();\n</script>', "\nif (store.get('link') && store.get('viewKey')) load(); else showConnect();\n</script>", 1)
for marker in [HEAD[:40], 'id="connect"', 'showConnect();\n</script>', 'id="disconnect"']:
    assert marker in out, marker
(OUT / 'index.html').write_text(out)
print('wrote', OUT / 'index.html')
