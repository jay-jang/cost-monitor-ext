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
  themeMode: document.getElementById('themeMode'),
  themeDark: document.getElementById('themeDark'),
  themeLight: document.getElementById('themeLight'),
  themeDarkRow: document.getElementById('theme-dark-row'),
  themeLightRow: document.getElementById('theme-light-row'),
};

function applyTheme(mode, darkStyle, lightStyle) {
  document.documentElement.setAttribute('data-theme-mode', mode);
  document.documentElement.setAttribute('data-theme-name', mode === 'dark' ? darkStyle : lightStyle);
  
  if (mode === 'dark') {
    els.themeDarkRow.removeAttribute('hidden');
    els.themeLightRow.setAttribute('hidden', '');
  } else {
    els.themeDarkRow.setAttribute('hidden', '');
    els.themeLightRow.removeAttribute('hidden');
  }
}

async function load() {
  const opts = await getOptions();
  els.claude.checked = opts.providers.claude;
  els.codex.checked = opts.providers.codex;
  els.antigravity.checked = opts.providers.antigravity;
  els.pollMinutes.value = String(opts.pollMinutes);
  els.warnPct.value = opts.warnPct;
  els.critPct.value = opts.critPct;
  els.notify.checked = opts.notify;
  els.themeMode.value = opts.themeMode;
  els.themeDark.value = opts.themeDark;
  els.themeLight.value = opts.themeLight;
  applyTheme(opts.themeMode, opts.themeDark, opts.themeLight);
}

let savedTimer;

async function save() {
  const warn = Math.min(99, Math.max(1, Number(els.warnPct.value) || 75));
  const crit = Math.min(100, Math.max(warn + 1, Number(els.critPct.value) || 90));
  const mode = els.themeMode.value;
  const darkStyle = els.themeDark.value;
  const lightStyle = els.themeLight.value;

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
    themeMode: mode,
    themeDark: darkStyle,
    themeLight: lightStyle,
  });

  applyTheme(mode, darkStyle, lightStyle);

  els.saved.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => els.saved.classList.remove('show'), 2000);
}

for (const key of ['claude', 'codex', 'antigravity', 'pollMinutes', 'warnPct', 'critPct', 'notify', 'themeMode', 'themeDark', 'themeLight']) {
  els[key].addEventListener('change', save);
}

// --- Antigravity Google Account Connection ---
const agStatus = document.getElementById('ag-status');
const agConnect = document.getElementById('ag-connect');
const agDisconnect = document.getElementById('ag-disconnect');

async function renderAgStatus() {
  const { agTokens, agAccount } = await chrome.storage.local.get(['agTokens', 'agAccount']);
  if (agTokens?.refreshToken) {
    agStatus.textContent = `Connected${agAccount?.email ? `: ${agAccount.email}` : ''}`;
    agStatus.className = 'ag-status ok';
    agConnect.hidden = true;
    agDisconnect.hidden = false;
  } else {
    agStatus.textContent = agAccount?.error ? `Connection Failed: ${agAccount.error}` : 'Not Connected';
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
