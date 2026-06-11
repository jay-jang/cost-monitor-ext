import { PROVIDERS } from '../providers/index.js';
import { getOptions } from '../common/options.js';
import { formatReset, formatAgo, clampPct } from '../common/format.js';

const cardsEl = document.getElementById('cards');
const updatedEl = document.getElementById('updated');
const refreshBtn = document.getElementById('refresh');

function openOptions(e) {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
}
document.getElementById('open-options').addEventListener('click', openOptions);
document.getElementById('settings').addEventListener('click', openOptions);

refreshBtn.addEventListener('click', () => refresh());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.snapshots) render(changes.snapshots.newValue || {});
});

async function refresh() {
  refreshBtn.classList.add('spinning');
  try {
    await chrome.runtime.sendMessage({ type: 'refresh', force: true });
  } catch {
    // Message might be lost if the service worker is waking up — will be updated by storage event
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

function severity(pct, opts) {
  if (pct >= opts.critPct) return 'crit';
  if (pct >= opts.warnPct) return 'warn';
  return 'ok';
}

let cachedOpts = null;

async function render(snapshots) {
  const opts = cachedOpts || (cachedOpts = await getOptions());
  cardsEl.textContent = '';
  let latest = 0;

  for (const p of PROVIDERS) {
    if (!opts.providers[p.id]) continue;
    const snap = snapshots[p.id];
    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    dot.style.boxShadow = `0 0 6px ${p.color}`;
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name;
    head.append(dot, name);
    if (snap?.ok && snap.plan) {
      const plan = document.createElement('span');
      plan.className = 'plan';
      plan.textContent = snap.plan;
      head.append(plan);
    }
    card.append(head);

    if (!snap) {
      const m = document.createElement('div');
      m.className = 'muted';
      m.textContent = 'No data fetched yet';
      card.append(m);
    } else if (!snap.ok) {
      latest = Math.max(latest, snap.at || 0);
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = snap.message || 'Fetch failed';
      card.append(err);
      if (snap.errorType === 'auth' && p.authCta === 'options') {
        card.append(makeCta('Connect Google Account in Settings →', () => chrome.runtime.openOptionsPage()));
      } else if (snap.errorType === 'auth') {
        card.append(makeCta('Go to Login →', () => chrome.tabs.create({ url: p.loginUrl })));
      } else if (snap.errorType === 'unsupported') {
        card.append(makeCta('Open Service Page →', () => chrome.tabs.create({ url: p.loginUrl })));
      }
    } else {
      latest = Math.max(latest, snap.at || 0);
      for (const w of snap.windows || []) {
        const pct = clampPct(w.usedPct);
        if (pct === null) continue;
        const sev = severity(pct, opts);
        const left = Math.round(100 - pct);

        const win = document.createElement('div');
        win.className = 'win';

        const main = document.createElement('div');
        main.className = 'wmain';

        const label = document.createElement('span');
        label.className = 'wlabel';
        label.textContent = w.label;
        label.title = w.label;

        const bar = document.createElement('div');
        bar.className = 'bar';
        const fill = document.createElement('div');
        fill.className = `fill ${sev}`;
        fill.style.width = `${left}%`; // fuel gauge — bar length is the remaining quota
        bar.append(fill);

        const val = document.createElement('span');
        val.className = `wpct ${sev}`;
        val.textContent = `${left}%`;

        main.append(label, bar, val);
        win.append(main);

        const resetText = formatReset(w.resetAt);
        if (resetText) {
          const reset = document.createElement('div');
          reset.className = 'wreset';
          reset.textContent = resetText;
          win.append(reset);
        }
        card.append(win);
      }
    }
    cardsEl.append(card);
  }

  updatedEl.textContent = latest ? `Updated: ${formatAgo(latest)}` : '';
}

function makeCta(text, onClick) {
  const a = document.createElement('a');
  a.className = 'cta';
  a.textContent = text;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return a;
}

(async function init() {
  const { snapshots = {} } = await chrome.storage.local.get('snapshots');
  await render(snapshots);
  refresh();
})();
