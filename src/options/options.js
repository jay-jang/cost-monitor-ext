import { getOptions, setOptions } from '../common/options.js';

const els = {
  claude: document.getElementById('p-claude'),
  codex: document.getElementById('p-codex'),
  antigravity: document.getElementById('p-antigravity'),
  pollMinutes: document.getElementById('pollMinutes'),
  warnPct: document.getElementById('warnPct'),
  critPct: document.getElementById('critPct'),
  notify: document.getElementById('notify'),
  saved: document.getElementById('saved'),
};

async function load() {
  const opts = await getOptions();
  els.claude.checked = opts.providers.claude;
  els.codex.checked = opts.providers.codex;
  els.antigravity.checked = opts.providers.antigravity;
  els.pollMinutes.value = String(opts.pollMinutes);
  els.warnPct.value = opts.warnPct;
  els.critPct.value = opts.critPct;
  els.notify.checked = opts.notify;
}

let savedTimer;

async function save() {
  const warn = Math.min(99, Math.max(1, Number(els.warnPct.value) || 75));
  const crit = Math.min(100, Math.max(warn + 1, Number(els.critPct.value) || 90));
  await setOptions({
    providers: {
      claude: els.claude.checked,
      codex: els.codex.checked,
      antigravity: els.antigravity.checked,
    },
    pollMinutes: Number(els.pollMinutes.value) || 5,
    warnPct: warn,
    critPct: crit,
    notify: els.notify.checked,
  });
  els.saved.style.visibility = 'visible';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (els.saved.style.visibility = 'hidden'), 1500);
}

for (const key of ['claude', 'codex', 'antigravity', 'pollMinutes', 'warnPct', 'critPct', 'notify']) {
  els[key].addEventListener('change', save);
}

// --- Antigravity Google 계정 연결 ---
const agStatus = document.getElementById('ag-status');
const agConnect = document.getElementById('ag-connect');
const agDisconnect = document.getElementById('ag-disconnect');

async function renderAgStatus() {
  const { agTokens, agAccount } = await chrome.storage.local.get(['agTokens', 'agAccount']);
  if (agTokens?.refreshToken) {
    agStatus.textContent = `연결됨${agAccount?.email ? `: ${agAccount.email}` : ''}`;
    agStatus.className = 'ag-status ok';
    agConnect.hidden = true;
    agDisconnect.hidden = false;
  } else {
    agStatus.textContent = agAccount?.error ? `연결 실패: ${agAccount.error}` : '연결 안 됨';
    agStatus.className = agAccount?.error ? 'ag-status err' : 'ag-status';
    agConnect.hidden = false;
    agDisconnect.hidden = true;
  }
}

agConnect.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'antigravity-connect' });
});
agDisconnect.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'antigravity-disconnect' });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.agTokens || changes.agAccount)) renderAgStatus();
});

load();
renderAgStatus();
