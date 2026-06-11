import { fetchJsonWithTabFallback, ProviderError } from './http.js';
import { clampPct } from '../common/format.js';

const DAY = 24 * 3600;

function windowLabel(w, fallback) {
  const sec = Number(w.limit_window_seconds);
  if (Number.isFinite(sec) && sec > 0) {
    if (sec < DAY) return `Session (${Math.round(sec / 3600)}h)`;
    if (sec >= 6.5 * DAY && sec <= 8 * DAY) return 'Weekly';
    return `${Math.round(sec / 3600 / 24)}d`;
  }
  return fallback;
}

function parseWindow(id, w, fallbackLabel) {
  if (!w || typeof w !== 'object') return null;
  const usedPct = clampPct(Number(w.used_percent));
  if (usedPct === null) return null;
  let resetAt = null;
  if (Number.isFinite(Number(w.reset_at))) {
    resetAt = Number(w.reset_at) * 1000; // Epoch seconds unit
  } else if (Number.isFinite(Number(w.reset_after_seconds))) {
    resetAt = Date.now() + Number(w.reset_after_seconds) * 1000;
  }
  return { id, label: windowLabel(w, fallbackLabel), usedPct, resetAt };
}

function planLabel(planType) {
  if (!planType || typeof planType !== 'string') return null;
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}

export const codex = {
  id: 'codex',
  name: 'Codex',
  color: '#10a37f',
  loginUrl: 'https://chatgpt.com/codex/settings/usage',

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

    const rl = data?.rate_limit || {};
    const windows = [
      parseWindow('primary', rl.primary_window, 'Session (5h)'),
      parseWindow('secondary', rl.secondary_window, 'Weekly'),
    ].filter(Boolean);

    if (windows.length === 0) {
      throw new ProviderError('parse', 'Usage fields not found');
    }
    return { plan: planLabel(data.plan_type), windows };
  },
};
