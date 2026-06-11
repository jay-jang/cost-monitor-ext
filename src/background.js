import { PROVIDERS } from './providers/index.js';
import { getOptions } from './common/options.js';
import { formatReset, clampPct } from './common/format.js';
import { initAuthListener, startConnect, disconnect } from './providers/antigravity-auth.js';

const ALARM_NAME = 'poll-usage';

// cloudcode-pa의 fetchAvailableModels는 Antigravity User-Agent로 온 요청에만 권한을 준다(그 외엔 403).
// 확장 fetch()는 User-Agent를 못 바꾸므로(forbidden header) declarativeNetRequest로 덮어쓴다.
const AG_UA_RULE_ID = 1;

function antigravityUA() {
  const p = (self.navigator?.userAgent || '').toLowerCase();
  const os = p.includes('win') ? 'windows' : p.includes('mac') ? 'darwin' : 'linux';
  const arch = p.includes('arm') || p.includes('aarch64') ? 'arm64' : 'amd64';
  return `antigravity/2.0.4 ${os}/${arch}`;
}

async function ensureAntigravityUserAgent() {
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const hasRule = rules.some((r) => r.id === AG_UA_RULE_ID);
    if (!hasRule) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [AG_UA_RULE_ID],
        addRules: [
          {
            id: AG_UA_RULE_ID,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [{ header: 'user-agent', operation: 'set', value: antigravityUA() }],
            },
            condition: {
              urlFilter: '||cloudcode-pa.googleapis.com/',
              resourceTypes: ['xmlhttprequest'],
            },
          },
        ],
      });
    }
  } catch (e) {
    console.error('Antigravity User-Agent 규칙 등록 실패', e);
  }
}

ensureAntigravityUserAgent();

initAuthListener(() => refreshAll(true));

chrome.runtime.onInstalled.addListener(() => {
  ensureAntigravityUserAgent();
  schedule();
  refreshAll(true);
});

chrome.runtime.onStartup.addListener(() => {
  ensureAntigravityUserAgent();
  schedule();
  refreshAll(true);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refreshAll();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.options) {
    schedule();
    refreshAll(true);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'refresh') {
    refreshAll(!!msg.force).then(() => sendResponse({ ok: true }));
    return true; // keep the message channel open for the async response
  }
  if (msg?.type === 'antigravity-connect') {
    startConnect().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'antigravity-disconnect') {
    disconnect()
      .then(() => refreshAll(true))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function schedule() {
  const opts = await getOptions();
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: opts.pollMinutes,
    delayInMinutes: opts.pollMinutes,
  });
}

let refreshing = null;

function refreshAll(force = false) {
  // 팝업 오픈과 알람이 겹쳐도 한 번만 폴링
  if (!refreshing) {
    refreshing = doRefreshAll(force).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function doRefreshAll(force = false) {
  const opts = await getOptions();
  if (force) {
    await chrome.storage.local.remove(['claudeOrg', 'agProject']);
  }
  const { snapshots = {} } = await chrome.storage.local.get('snapshots');

  await Promise.all(
    PROVIDERS.map(async (p) => {
      if (!opts.providers[p.id]) {
        delete snapshots[p.id];
        return;
      }
      try {
        const data = await p.fetchUsage();
        snapshots[p.id] = { at: Date.now(), ok: true, ...data };
      } catch (e) {
        snapshots[p.id] = {
          at: Date.now(),
          ok: false,
          errorType: e.type || 'network',
          message: String(e.message || e),
        };
      }
    })
  );

  await chrome.storage.local.set({ snapshots });
  await updateBadge(snapshots, opts);
  await maybeNotify(snapshots, opts);
}

async function updateBadge(snapshots, opts) {
  let worst = null;
  let anyAuthError = false;

  for (const p of PROVIDERS) {
    const snap = snapshots[p.id];
    if (!snap) continue;
    if (!snap.ok) {
      if (snap.errorType === 'auth') anyAuthError = true;
      continue;
    }
    for (const w of snap.windows || []) {
      const pct = clampPct(w.usedPct);
      if (pct === null) continue;
      if (worst === null || pct > worst) worst = pct;
    }
  }

  if (worst !== null) {
    const color =
      worst >= opts.critPct ? '#d93025' : worst >= opts.warnPct ? '#f9ab00' : '#188038';
    await chrome.action.setBadgeText({ text: String(Math.round(worst)) });
    await chrome.action.setBadgeBackgroundColor({ color });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    }
  } else if (anyAuthError) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

async function maybeNotify(snapshots, opts) {
  if (!opts.notify) return;
  const { notifyState = {} } = await chrome.storage.local.get('notifyState');
  const next = { ...notifyState };

  for (const p of PROVIDERS) {
    const snap = snapshots[p.id];
    if (!snap?.ok) continue;
    for (const w of snap.windows || []) {
      const pct = clampPct(w.usedPct);
      if (pct === null) continue;
      const key = `${p.id}:${w.id}`;
      const level = pct >= opts.critPct ? 'crit' : pct >= opts.warnPct ? 'warn' : null;
      if (level && next[key] !== level) {
        chrome.notifications.create(`${key}:${level}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: `${p.name} 사용량 ${Math.round(pct)}%`,
          message: `${w.label} 한도의 ${Math.round(pct)}%를 사용했습니다. ${formatReset(w.resetAt)}`,
          priority: level === 'crit' ? 2 : 1,
        });
      }
      next[key] = level;
    }
  }

  await chrome.storage.local.set({ notifyState: next });
}
