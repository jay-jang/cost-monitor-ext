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
  document.documentElement.setAttribute('data-theme-mode', opts.themeMode);
  document.documentElement.setAttribute('data-theme-name', opts.themeMode === 'dark' ? opts.themeDark : opts.themeLight);
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
    if (p.usageUrl) {
      const link = document.createElement('a');
      link.className = 'pext';
      link.textContent = '↗';
      link.href = p.usageUrl;
      link.title = 'Open usage page';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: p.usageUrl });
      });
      head.append(link);
    }
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
      } else if (snap.errorType === 'unsupported' || snap.errorType === 'parse') {
        card.append(makeCta('Open Service Page →', () => chrome.tabs.create({ url: p.loginUrl })));
      }
    } else {
      latest = Math.max(latest, snap.at || 0);
      if (!snap.windows || snap.windows.length === 0) {
        const m = document.createElement('div');
        m.className = 'muted';
        m.textContent = snap.usageNote || (snap.noActiveLimits ? 'No active limits' : 'Usage data unavailable');
        card.append(m);
      } else {
        for (const w of snap.windows || []) {
          const pct = clampPct(w.usedPct);
          if (pct === null) continue;
          const sev = severity(pct, opts);
          const left = Math.round(100 - pct);

          const win = document.createElement('div');
          win.className = 'win';

          const top = document.createElement('div');
          top.className = 'wtop';
          const label = document.createElement('span');
          label.className = 'wlabel';
          label.textContent = w.label;
          label.title = w.label;
          const val = document.createElement('span');
          val.className = `wpct ${sev}`;
          val.textContent = `${left}%`;
          top.append(label, val);

          const barRow = document.createElement('div');
          barRow.className = 'wbar-row';
          const bar = document.createElement('div');
          bar.className = 'bar';
          const fill = document.createElement('div');
          fill.className = `fill ${sev}`;
          fill.style.width = `${left}%`; // fuel gauge — bar length is the remaining quota
          if (sev === 'ok') {
            fill.style.background = `linear-gradient(90deg, color-mix(in srgb, ${p.color} 65%, #000) 0%, ${p.color} 100%)`;
          }
          bar.append(fill);
          barRow.append(bar);

          const resetText = formatReset(w.resetAt);
          if (resetText) {
            const reset = document.createElement('span');
            reset.className = 'wreset';
            reset.textContent = resetText;
            barRow.append(reset);
          }

          win.append(top, barRow);
          card.append(win);
        }
      }
      if (snap.usageNote && snap.windows?.length) {
        const note = document.createElement('div');
        note.className = 'muted';
        note.textContent = snap.usageNote;
        card.append(note);
      }
      if (snap.details?.length) {
        const details = document.createElement('div');
        details.className = 'usage-details';
        for (const detail of snap.details) {
          const row = document.createElement('div');
          row.className = 'detail-row';
          const label = document.createElement('span');
          label.className = 'detail-label';
          label.textContent = detail.label;
          const value = document.createElement('span');
          value.className = 'detail-value';
          value.textContent = detail.value;
          row.append(label, value);
          details.append(row);
        }
        card.append(details);
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
