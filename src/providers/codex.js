import { fetchJsonWithTabFallback, ProviderError } from './http.js';
import { clampPct } from '../common/format.js';
import { finiteNumber, isRecord } from '../common/parse.js';

const DAY = 24 * 3600;

function windowLabel(w, fallback) {
  const sec = finiteNumber(w.limit_window_seconds);
  if (sec !== null && sec > 0) {
    if (sec < 3600) return `Session (${Math.round(sec / 60)}m)`;
    if (sec < DAY) return `Session (${Math.round(sec / 3600)}h)`;
    if (sec >= 6.5 * DAY && sec <= 8 * DAY) return 'Weekly';
    return `${Math.round(sec / 3600 / 24)}d`;
  }
  return fallback;
}

function parseWindow(id, w, fallbackLabel) {
  if (!isRecord(w)) return null;
  const usedPct = clampPct(finiteNumber(w.used_percent));
  if (usedPct === null) return null;
  let resetAt = null;
  const absolute = finiteNumber(w.reset_at);
  const after = finiteNumber(w.reset_after_seconds);
  if (absolute !== null && absolute > 0) {
    resetAt = absolute * 1000; // Epoch seconds unit
  } else if (after !== null && after >= 0) {
    resetAt = Date.now() + after * 1000;
  }
  return { id, label: windowLabel(w, fallbackLabel), usedPct, resetAt };
}

function planLabel(planType) {
  if (!planType || typeof planType !== 'string') return null;
  if (['prolite', 'pro', 'proplus'].includes(planType)) return 'Pro';
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}

export function parseCodexUsage(data) {
  if (!isRecord(data)) throw new ProviderError('parse', 'Codex usage response format changed');
  const windows = [];
  const details = [];
  let recognized = false;
  let incomplete = false;
  function addLimits(id, limits, label = '') {
    if (limits === null) { recognized = true; return; }
    if (!isRecord(limits)) { incomplete = true; return; }
    if (!Object.hasOwn(limits, 'primary_window') && !Object.hasOwn(limits, 'secondary_window')) {
      incomplete = true;
      return;
    }
    for (const [key, fallback] of [['primary', 'Session'], ['secondary', 'Weekly']]) {
      const field = `${key}_window`;
      if (!Object.hasOwn(limits, field)) continue;
      recognized = true;
      if (limits[field] === null) continue;
      const w = parseWindow(id ? `${id}:${key}` : key, limits[field], fallback);
      if (w) windows.push({ ...w, label: label ? `${label} · ${w.label}` : w.label });
      else incomplete = true;
    }
  }
  if (Object.hasOwn(data, 'rate_limit')) addLimits('', data.rate_limit);
  if (Object.hasOwn(data, 'code_review_rate_limit')) {
    addLimits('code-review', data.code_review_rate_limit, 'GitHub Code Review');
  }
  if (Array.isArray(data.additional_rate_limits)) {
    for (const limit of data.additional_rate_limits) {
      if (!isRecord(limit) || typeof limit.metered_feature !== 'string' || !limit.metered_feature) {
        incomplete = true;
        continue;
      }
      addLimits(`additional:${limit.metered_feature}`, limit.rate_limit,
        typeof limit.limit_name === 'string' && limit.limit_name ? limit.limit_name : limit.metered_feature);
    }
  } else if (data.additional_rate_limits != null) incomplete = true;

  const credits = data.credits;
  if (isRecord(credits)) {
    const balance = finiteNumber(credits.balance);
    if (credits.unlimited === true || balance !== null || typeof credits.has_credits === 'boolean') {
      recognized = true;
      details.push({ id: 'credits', label: 'Credits', value: credits.unlimited === true
        ? 'Unlimited' : balance !== null ? String(balance) : credits.has_credits ? 'Available' : 'None' });
    }
    if (credits.overage_limit_reached === true) {
      details.push({ id: 'overage', label: 'Credit overage', value: 'Limit reached' });
    }
  }
  if (typeof data.spend_control?.reached === 'boolean') {
    recognized = true;
    details.push({ id: 'spend-control', label: 'Spend control',
      value: data.spend_control.reached ? 'Limit reached' : 'Not reached' });
  }
  const resets = data.rate_limit_reset_credits;
  const count = finiteNumber(resets?.available_count);
  const applicable = finiteNumber(resets?.applicable_available_count);
  if (count !== null && count >= 0) {
    recognized = true;
    details.push({ id: 'reset-credits', label: 'Rate-limit resets', value:
      `${count} available${applicable !== null && applicable >= 0 ? ` · ${applicable} usable now` : ''}` });
  }
  if (typeof data.rate_limit_reached_type === 'string' && data.rate_limit_reached_type) {
    details.push({ id: 'limit-status', label: 'Limit reached', value: data.rate_limit_reached_type.replaceAll('_', ' ') });
  }
  if (!recognized) throw new ProviderError('parse', 'Codex usage fields not recognized — open the usage page');
  // Only an explicit empty quota response means there are no active limits.
  const explicitEmpty = Object.hasOwn(data, 'rate_limit') && (data.rate_limit === null ||
    (isRecord(data.rate_limit) && data.rate_limit.primary_window === null && data.rate_limit.secondary_window === null));
  return { plan: planLabel(data.plan_type), windows, details,
    noActiveLimits: windows.length === 0 && explicitEmpty && !incomplete,
    usageNote: incomplete ? 'Some quota data is unavailable' :
      windows.length === 0 && !explicitEmpty ? 'Quota data unavailable' : null };
}

export const codex = {
  id: 'codex',
  name: 'Codex',
  color: '#10a37f',
  loginUrl: 'https://chatgpt.com/codex/settings/usage',
  usageUrl: 'https://chatgpt.com/codex/settings/usage',

  async fetchUsage() {
    // 1. Fetch accessToken from the NextAuth session endpoint.
    let session;
    try {
      session = await fetchJsonWithTabFallback(
        'https://chatgpt.com/api/auth/session',
        'https://chatgpt.com/*'
      );
    } catch (e) {
      if (e instanceof ProviderError && e.type === 'auth') {
        throw new ProviderError('auth', 'ChatGPT login required');
      }
      throw e;
    }

    const token = session?.accessToken;
    if (!token) {
      throw new ProviderError('auth', 'ChatGPT login required (no session token)');
    }

    // 2. Call the usage API including the Bearer token.
    // If 403 (Cloudflare), retry from an open chatgpt.com tab.
    const data = await fetchJsonWithTabFallback(
      'https://chatgpt.com/backend-api/wham/usage',
      'https://chatgpt.com/*',
      {
        headers: {
          authorization: `Bearer ${token}`
        }
      }
    );

    return parseCodexUsage(data);
  },
};
