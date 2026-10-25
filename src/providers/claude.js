import { fetchJsonWithTabFallback, ProviderError } from './http.js';
import { clampPct, formatMinorCurrency } from '../common/format.js';
import { finiteNumber, isRecord, resetTimestamp } from '../common/parse.js';

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
  if (tier.includes('enterprise')) return 'Enterprise';
  if (tier.includes('team')) return 'Team';
  if (tier.includes('max_20x')) return 'Max 20x';
  if (tier.includes('max_5x')) return 'Max 5x';
  if (tier.includes('pro') || capabilities.includes('claude_pro')) return 'Pro';
  if (tier.includes('free')) return 'Free';
  return null;
}

async function activeOrgId() {
  try {
    const cookie = await chrome.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' });
    return cookie?.value || null;
  } catch {
    return null;
  }
}

async function discoverOrg(activeId) {
  const orgs = await fetchJsonWithTabFallback(
    'https://claude.ai/api/organizations',
    'https://claude.ai/*'
  );
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new ProviderError('auth', 'claude.ai organization info not found');
  }
  // Organizations for API console only (capabilities == ['api']) do not have plan limits
  const valid = orgs.filter((o) => isRecord(o) && typeof o.uuid === 'string' && o.uuid);
  if (!valid.length) throw new ProviderError('parse', 'Claude organization fields not recognized');
  const usable = valid.filter((o) => {
    const caps = Array.isArray(o.capabilities) ? o.capabilities : [];
    return !(caps.length === 1 && caps[0] === 'api');
  });
  const candidates = usable.length ? usable : valid;

  // claude.ai records the active organization uuid in lastActiveOrg cookie — matches settings UI
  const active = candidates.find((o) => o.uuid === activeId);
  if (activeId && !active) {
    throw new ProviderError('unsupported', 'Selected Claude organization has no available subscription usage — open claude.ai');
  }
  const org =
    active ||
    candidates.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat')) ||
    candidates[0];

  return {
    uuid: org.uuid,
    plan: planFromTier(typeof org.rate_limit_tier === 'string' ? org.rate_limit_tier : '',
      Array.isArray(org.capabilities) ? org.capabilities : []),
    at: Date.now(),
  };
}

async function getOrg(force = false) {
  // The active workspace can change while the 24-hour metadata cache is still valid.
  const activeId = await activeOrgId();
  if (!force) {
    const { claudeOrg } = await chrome.storage.local.get('claudeOrg');
    if (claudeOrg?.uuid && (!activeId || activeId === claudeOrg.uuid) &&
      Date.now() - claudeOrg.at < ORG_CACHE_TTL) return claudeOrg;
  }
  const org = await discoverOrg(activeId);
  await chrome.storage.local.set({ claudeOrg: org });
  return org;
}

export function parseClaudeUsage(data) {
  if (!isRecord(data)) throw new ProviderError('parse', 'Claude usage response format changed');
  const windows = [];
  const details = [];
  let recognized = false;
  let incomplete = false;
  const words = (s) => s.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
  // New clients receive server-defined meters. This includes model-scoped Fable limits;
  // a fixed list of seven_day_* keys alone silently loses these rows.
  if (Array.isArray(data.limits)) {
    recognized = true;
    for (const row of data.limits) {
      const usedPct = clampPct(finiteNumber(row?.percent));
      if (!isRecord(row) || typeof row.kind !== 'string' || typeof row.group !== 'string' || usedPct === null) {
        incomplete = true;
        continue;
      }
      const model = row.scope?.model?.display_name || '';
      const surface = row.scope?.surface?.display_name || '';
      const id = row.kind === 'session' && !model && !surface ? 'five_hour'
        : row.kind === 'weekly_all' && !model && !surface ? 'seven_day'
        : `scoped:${[row.kind, row.group, model, surface].map(encodeURIComponent).join(':')}`;
      const scope = [model, surface].filter(Boolean).join(' · ');
      const label = row.kind === 'weekly_all' ? 'Weekly (Total)'
        : `${words(row.group)}${scope ? ` (${scope})` : ''}`;
      windows.push({ id, label, usedPct, resetAt: resetTimestamp(row.resets_at) });
    }
  } else {
    if (data.limits != null) incomplete = true;
    const labels = new Map(WINDOW_LABELS);
    for (const key of Object.keys(data).filter(k => k === 'five_hour' || /^seven_day(?:_\w+)?$/.test(k))) {
      recognized = true;
      const w = data[key];
      if (w === null) continue; // Known window explicitly absent on this plan.
      const usedPct = clampPct(finiteNumber(w?.utilization ?? w?.utilization_pct));
      if (!isRecord(w) || usedPct === null) { incomplete = true; continue; }
      const label = labels.get(key) || `Weekly (${words(key.slice('seven_day_'.length))})`;
      windows.push({ id: key, label, usedPct, resetAt: resetTimestamp(w.resets_at) });
    }
  }
  // Current usage replies also expose typed money under spend, including its exponent.
  // Prefer that over the compatibility extra_usage fields when both are present.
  const spend = data.spend;
  const extra = data.extra_usage;
  if (isRecord(spend) && typeof spend.enabled === 'boolean') {
    recognized = true;
    details.push({ id: 'extra-usage', label: 'Usage credits', value: spend.enabled ? 'Enabled' : 'Disabled' });
    const money = (value) => {
      const amount = finiteNumber(value?.amount_minor);
      if (!isRecord(value) || amount === null || amount < 0 || typeof value.currency !== 'string') return null;
      return formatMinorCurrency(amount, value.currency, finiteNumber(value.exponent));
    };
    const used = money(spend.used);
    const limit = money(spend.limit);
    if (used !== null || limit !== null) {
      details.push({ id: 'extra-spend', label: 'Extra usage spend',
        value: `${used ?? 'Unavailable'} / ${limit ?? 'limit unavailable'}` });
    }
  } else if (isRecord(extra) && typeof extra.is_enabled === 'boolean') {
    recognized = true;
    details.push({ id: 'extra-usage', label: 'Usage credits', value: extra.is_enabled ? 'Enabled' : 'Disabled' });
    const used = finiteNumber(extra.used_credits);
    const limit = finiteNumber(extra.monthly_limit);
    const currency = typeof extra.currency === 'string' ? extra.currency.toUpperCase() : 'USD';
    if ((used !== null && used >= 0) || (limit !== null && limit >= 0)) {
      details.push({ id: 'extra-spend', label: 'Monthly extra spend',
        value: `${used !== null && used >= 0 ? formatMinorCurrency(used, currency, finiteNumber(extra.decimal_places)) : 'Unavailable'} / ${limit !== null && limit >= 0
          ? formatMinorCurrency(limit, currency, finiteNumber(extra.decimal_places)) : 'limit unavailable'}` });
    }
  } else if (extra != null) incomplete = true;
  if (spend != null && (!isRecord(spend) || typeof spend.enabled !== 'boolean')) incomplete = true;
  if (!recognized) throw new ProviderError('parse', 'Claude usage fields not recognized — open the usage page');
  const quotaKnown = Array.isArray(data.limits) || Object.keys(data).some(k => k === 'five_hour' || /^seven_day(?:_\w+)?$/.test(k));
  return { windows, details, noActiveLimits: quotaKnown && !windows.length && !incomplete,
    usageNote: incomplete ? 'Some quota data is unavailable' : !quotaKnown ? 'Quota data unavailable' : null };
}

export const claude = {
  id: 'claude',
  name: 'Claude',
  color: '#d97757',
  loginUrl: 'https://claude.ai/settings/usage',
  usageUrl: 'https://claude.ai/settings/usage',

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

    return { plan: org.plan, ...parseClaudeUsage(data) };
  },
};
