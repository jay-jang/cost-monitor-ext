import { fetchJsonWithTabFallback, ProviderError } from './http.js';
import { clampPct } from '../common/format.js';

const ORG_CACHE_TTL = 24 * 60 * 60 * 1000;

// Response window key -> display label (null windows are not in that plan - skipped)
const WINDOW_LABELS = [
  ['five_hour', 'Session (5h)'],
  ['seven_day', 'Weekly (Total)'],
  ['seven_day_opus', 'Weekly (Opus)'],
  ['seven_day_sonnet', 'Weekly (Sonnet)'],
  ['seven_day_oauth_apps', 'Weekly (OAuth Apps)'],
];

function planFromTier(tier = '', capabilities = []) {
  if (tier.includes('max_20x')) return 'Max 20x';
  if (tier.includes('max_5x')) return 'Max 5x';
  if (tier.includes('pro') || capabilities.includes('claude_pro')) return 'Pro';
  if (tier.includes('free')) return 'Free';
  return null;
}

async function discoverOrg() {
  const orgs = await fetchJsonWithTabFallback(
    'https://claude.ai/api/organizations',
    'https://claude.ai/*'
  );
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new ProviderError('auth', 'claude.ai organization info not found');
  }
  // Organizations for API console only (capabilities == ['api']) do not have plan limits
  const usable = orgs.filter((o) => {
    const caps = o.capabilities || [];
    return !(caps.length === 1 && caps[0] === 'api');
  });
  const candidates = usable.length ? usable : orgs;

  // claude.ai records the active organization uuid in lastActiveOrg cookie — matches settings UI
  let active = null;
  try {
    const cookie = await chrome.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' });
    if (cookie?.value) active = candidates.find((o) => o.uuid === cookie.value);
  } catch {
    // Ignore cookie permission issues etc. and fall back to heuristics
  }
  const org =
    active ||
    candidates.find((o) => (o.capabilities || []).includes('chat')) ||
    candidates[0];

  return {
    uuid: org.uuid,
    plan: planFromTier(org.rate_limit_tier || '', org.capabilities || []),
    at: Date.now(),
  };
}

async function getOrg(force = false) {
  if (!force) {
    const { claudeOrg } = await chrome.storage.local.get('claudeOrg');
    if (claudeOrg?.uuid && Date.now() - claudeOrg.at < ORG_CACHE_TTL) return claudeOrg;
  }
  const org = await discoverOrg();
  await chrome.storage.local.set({ claudeOrg: org });
  return org;
}

function parseWindows(data) {
  const windows = [];
  for (const [key, label] of WINDOW_LABELS) {
    const w = data?.[key];
    if (!w || typeof w !== 'object') continue;
    const usedPct = clampPct(Number(w.utilization ?? w.utilization_pct));
    if (usedPct === null) continue;
    const resetAt = w.resets_at ? Date.parse(w.resets_at) : null;
    windows.push({ id: key, label, usedPct, resetAt: Number.isNaN(resetAt) ? null : resetAt });
  }
  return windows;
}

export const claude = {
  id: 'claude',
  name: 'Claude',
  color: '#d97757',
  loginUrl: 'https://claude.ai/settings/usage',

  async fetchUsage() {
    let org = await getOrg();
    let data;
    try {
      data = await fetchJsonWithTabFallback(
        `https://claude.ai/api/organizations/${org.uuid}/usage`,
        'https://claude.ai/*'
      );
    } catch (e) {
      // In case they left or switched organization — clear cache and rediscover
      if (e.type !== 'notfound') throw e;
      org = await getOrg(true);
      data = await fetchJsonWithTabFallback(
        `https://claude.ai/api/organizations/${org.uuid}/usage`,
        'https://claude.ai/*'
      );
    }

    const windows = parseWindows(data);
    if (windows.length === 0) {
      throw new ProviderError('parse', 'Usage fields not found');
    }
    return { plan: org.plan, windows };
  },
};
