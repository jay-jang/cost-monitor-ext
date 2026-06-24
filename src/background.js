import { PROVIDERS } from './providers/index.js';
import { getOptions } from './common/options.js';
import { formatReset, clampPct } from './common/format.js';
import { initAuthListener, startConnect, disconnect } from './providers/antigravity-auth.js';

const ALARM_NAME = 'poll-usage';

// cloudcode-pa's fetchAvailableModels grants permission only to requests with an Antigravity User-Agent (otherwise returns 403).
// Since extension fetch() cannot change the User-Agent (forbidden header), we overwrite it using declarativeNetRequest.
const AG_UA_RULE_ID = 1;

function antigravityUA() {
  const p = (self.navigator?.userAgent || '').toLowerCase();
  const os = p.includes('win') ? 'windows' : p.includes('mac') ? 'darwin' : 'linux';
  const arch = p.includes('arm') || p.includes('aarch64') ? 'arm64' : 'amd64';
  return `antigravity/2.0.4 ${os}/${arch}`;
}

async function ensureAntigravityUserAgent() {
  try {
    // Always (re)register so existing installs pick up filter changes. The substring filter
    // (no '||' anchor) matches both cloudcode-pa and daily-cloudcode-pa.
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
            urlFilter: 'cloudcode-pa.googleapis.com/',
            resourceTypes: ['xmlhttprequest'],
          },
        },
      ],
    });
  } catch (e) {
    console.error('Failed to register Antigravity User-Agent rule', e);
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

const fail = (sendResponse) => (e) => sendResponse({ ok: false, error: String(e?.message || e) });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'refresh') {
    refreshAll(!!msg.force)
      .then(() => sendResponse({ ok: true }))
      .catch(fail(sendResponse));
    return true; // keep the message channel open for the async response
  }
  if (msg?.type === 'antigravity-connect') {
    startConnect()
      .then(() => sendResponse({ ok: true }))
      .catch(fail(sendResponse));
    return true;
  }
  if (msg?.type === 'antigravity-disconnect') {
    disconnect()
      .then(() => refreshAll(true))
      .then(() => sendResponse({ ok: true }))
      .catch(fail(sendResponse));
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
let pendingForce = false;

function refreshAll(force = false) {
  // Poll only once even if popup opening and alarm overlap
  if (refreshing) {
    // If a force request overlaps while a non-force polling is running, guarantee one more cache-invalidating poll after it completes
    if (force) pendingForce = true;
    return refreshing;
  }
  refreshing = runRefreshLoop(force).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function runRefreshLoop(force) {
  await doRefreshAll(force);
  while (pendingForce) {
    pendingForce = false;
    await doRefreshAll(true);
  }
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
  await updateBadge(snapshots);
  await maybeNotify(snapshots, opts);
}

// 배지는 직전 폴링 대비 사용량이 가장 최근에 바뀐 윈도우(=지금 활발히 소모 중인 한도)를
// 보여준다. 변화가 없으면 마지막으로 바뀐 윈도우 선택을 유지한다. 한 모델은 보통 세션·주간
// 윈도우가 한 응답에서 함께 갱신되므로, 동시에 바뀐 윈도우들 중에서는 단기(리셋이 임박한)
// 값을 우선한다. 그래도 동률이면 사용률이 높은 것. 색은 그 윈도우가 속한 서비스의 브랜드 색.
async function pickBadgeWindow(snapshots) {
  const { windowState = {} } = await chrome.storage.local.get('windowState');
  const now = Date.now();
  const next = {};
  let pick = null; // { pct, color, changedAt, reset }

  for (const p of PROVIDERS) {
    const snap = snapshots[p.id];
    if (!snap?.ok) continue;
    for (const w of snap.windows || []) {
      const pct = clampPct(w.usedPct);
      if (pct === null) continue;
      const key = `${p.id}:${w.id}`;
      const prev = windowState[key];
      const changedAt = !prev || prev.pct !== pct ? now : prev.changedAt;
      next[key] = { pct, changedAt };
      // 단기 우선: 리셋이 임박할수록(작을수록) 단기 윈도우. 없으면 장기로 취급.
      const reset = typeof w.resetAt === 'number' ? w.resetAt : Infinity;
      if (
        pick === null ||
        changedAt > pick.changedAt ||
        (changedAt === pick.changedAt && reset < pick.reset) ||
        (changedAt === pick.changedAt && reset === pick.reset && pct > pick.pct)
      ) {
        pick = { pct, color: p.color, changedAt, reset };
      }
    }
  }

  await chrome.storage.local.set({ windowState: next });
  return pick;
}

async function updateBadge(snapshots) {
  const pick = await pickBadgeWindow(snapshots);
  const anyAuthError = PROVIDERS.some((p) => {
    const s = snapshots[p.id];
    return s && !s.ok && s.errorType === 'auth';
  });

  if (pick) {
    const opts = await getOptions();
    const val = opts.badgeMode === 'remaining' ? 100 - pick.pct : pick.pct;
    await chrome.action.setBadgeText({ text: String(Math.round(val)) });
    await chrome.action.setBadgeBackgroundColor({ color: pick.color });
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
          title: `${p.name} Usage ${Math.round(pct)}%`,
          message: `Used ${Math.round(pct)}% of the ${w.label} limit. ${formatReset(w.resetAt)}`,
          priority: level === 'crit' ? 2 : 1,
        });
      }
      next[key] = level;
    }
  }

  await chrome.storage.local.set({ notifyState: next });
}
