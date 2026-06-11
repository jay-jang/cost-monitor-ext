import { PROVIDERS } from '../providers/index.js';
import { getOptions } from '../common/options.js';
import { formatReset, formatAgo, clampPct } from '../common/format.js';

const cardsEl = document.getElementById('cards');
const updatedEl = document.getElementById('updated');
const refreshBtn = document.getElementById('refresh');

document.getElementById('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

refreshBtn.addEventListener('click', () => refresh());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.snapshots) render(changes.snapshots.newValue || {});
});

async function refresh() {
  refreshBtn.classList.add('spinning');
  try {
    await chrome.runtime.sendMessage({ type: 'refresh' });
  } catch {
    // 서비스 워커가 깨어나는 중이면 메시지가 유실될 수 있음 — storage 이벤트로 갱신됨
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

function barColor(pct, opts) {
  if (pct >= opts.critPct) return 'var(--crit)';
  if (pct >= opts.warnPct) return 'var(--warn)';
  return 'var(--ok)';
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
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = '아직 조회 전입니다';
      card.append(err);
    } else if (!snap.ok) {
      latest = Math.max(latest, snap.at || 0);
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = snap.message || '조회 실패';
      card.append(err);
      if (snap.errorType === 'auth' && p.authCta === 'options') {
        card.append(makeCta('설정에서 Google 계정 연결 →', () => chrome.runtime.openOptionsPage()));
      } else if (snap.errorType === 'auth') {
        card.append(makeCta('로그인하러 가기 →', () => chrome.tabs.create({ url: p.loginUrl })));
      } else if (snap.errorType === 'unsupported') {
        card.append(makeCta('서비스 페이지 열기 →', () => chrome.tabs.create({ url: p.loginUrl })));
      }
    } else {
      latest = Math.max(latest, snap.at || 0);
      for (const w of snap.windows || []) {
        const pct = clampPct(w.usedPct);
        if (pct === null) continue;

        const win = document.createElement('div');
        win.className = 'window';

        const row = document.createElement('div');
        row.className = 'wrow';
        const label = document.createElement('span');
        label.className = 'wlabel';
        label.textContent = w.label;
        const val = document.createElement('span');
        val.className = 'wpct';
        val.textContent = `남음 ${Math.round(100 - pct)}%`;
        row.append(label, val);

        const bar = document.createElement('div');
        bar.className = 'bar';
        const fill = document.createElement('div');
        fill.className = 'fill';
        fill.style.width = `${pct}%`;
        fill.style.background = barColor(pct, opts);
        bar.append(fill);

        win.append(row, bar);
        const resetText = formatReset(w.resetAt);
        if (resetText) {
          const reset = document.createElement('div');
          reset.className = 'reset';
          reset.textContent = resetText;
          win.append(reset);
        }
        card.append(win);
      }
    }
    cardsEl.append(card);
  }

  updatedEl.textContent = latest ? `업데이트: ${formatAgo(latest)}` : '';
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
