import { ProviderError } from './http.js';
import { clampPct } from '../common/format.js';
import { getAccessToken } from './antigravity-auth.js';

// The Antigravity stable build talks to cloudcode-pa; the daily/Insiders build talks to
// daily-cloudcode-pa. Gemini quota is tracked separately per backend (third-party Claude/GPT
// quota is shared), so we query both and show the tighter limit — matching whichever build the
// user actually runs without any configuration.
const BASES = [
  'https://cloudcode-pa.googleapis.com/v1internal',
  'https://daily-cloudcode-pa.googleapis.com/v1internal',
];
const CLIENT_METADATA = { ideName: 'antigravity', ideType: 'ANTIGRAVITY' };

// Legacy model fallback. Argon can have a separate quota despite being a Google model;
// keep its model-reported limit distinct from the ordinary Gemini pool.
const POOLS = [
  {
    id: 'gemini',
    label: 'Gemini',
    providers: ['MODEL_PROVIDER_GOOGLE'],
    match: (k) => /gemini|flash|imagen|tab_|chat_/.test(k),
  },
  {
    id: 'claude_gpt',
    label: 'Claude & GPT',
    providers: ['MODEL_PROVIDER_ANTHROPIC', 'MODEL_PROVIDER_OPENAI'],
    match: (k) => /claude|sonnet|opus|gpt/.test(k),
  },
  {
    id: 'argon',
    label: 'Gemini 4 Argon',
    match: (k) => /argon/.test(k),
  },
];

async function postJson(path, body, token, base = BASES[0]) {
  let res;
  try {
    res = await fetch(`${base}:${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ProviderError('network', `Network error: ${e.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError('auth', 'Google authentication denied — please reconnect in Settings');
  }
  if (!res.ok) throw new ProviderError('network', `HTTP ${res.status}`);
  return res.json();
}

function tierLabel(id) {
  if (!id) return null;
  const k = String(id).toLowerCase();
  if (k.includes('ultra')) return 'Ultra';
  if (k.includes('pro')) return 'Pro';
  if (k.includes('legacy')) return 'Legacy';
  if (k.includes('free') || k.includes('standard')) return 'Free';
  return id;
}

async function getProjectInfo(token, force = false) {
  if (!force) {
    const { agProject } = await chrome.storage.local.get('agProject');
    if (agProject?.at && Date.now() - agProject.at < 24 * 3600 * 1000) return agProject;
  }
  // The account/project is the same on both backends; use whichever responds first.
  let data;
  let lastErr;
  for (const base of BASES) {
    try {
      data = await postJson('loadCodeAssist', { metadata: CLIENT_METADATA }, token, base);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!data) throw lastErr;
  const raw = data?.cloudaicompanionProject;
  const project = typeof raw === 'string' ? raw : raw?.id || null;
  const tier = tierLabel(data?.paidTier?.id || data?.currentTier?.id);
  const info = { project, tier, at: Date.now() };
  await chrome.storage.local.set({ agProject: info });
  return info;
}

// A model's usage (Argon may report a weekly limit). When exhausted the API omits remainingFraction
// (and no longer sends isExhausted), leaving only resetTime — treat that as 100% used so the
// pool is still reported instead of silently dropped (which made the limit "disappear").
function modelUsedPct(q) {
  if (!q) return null;
  const frac = Number(q.remainingFraction);
  if (Number.isFinite(frac)) return clampPct(100 * (1 - frac));
  if (q.isExhausted || q.resetTime) return 100;
  return null;
}

// Compact group label for the popup, e.g. "Gemini Models" -> "Gemini",
// "Claude and GPT models" -> "Claude & GPT".
function groupLabel(name) {
  if (!name) return 'Antigravity';
  return name.replace(/\s*models?$/i, '').replace(/\band\b/i, '&').trim();
}

// retrieveUserQuotaSummary is the read-only source behind the IDE's "Model Quota" panel:
// server-defined groups and windows, including a separate Argon weekly bucket on paid Pro.
function parseQuotaSummary(data) {
  const groups = data?.groups;
  if (!Array.isArray(groups)) return [];
  const windows = [];
  for (const g of groups) {
    const gl = groupLabel(g.displayName);
    for (const b of g.buckets || []) {
      const frac = Number(b.remainingFraction);
      let usedPct;
      if (Number.isFinite(frac)) usedPct = clampPct(100 * (1 - frac));
      else if (b.isExhausted || b.resetTime) usedPct = 100; // exhausted buckets omit remainingFraction
      else continue;
      const winLabel =
        b.window === '5h' ? '5h' : b.window === 'weekly' ? 'Weekly' : b.displayName || b.window;
      const resetRaw = b.resetTime ? Date.parse(b.resetTime) : null;
      windows.push({
        id: b.bucketId || `${gl}-${b.window}`,
        label: `${gl} · ${winLabel}`,
        usedPct,
        resetAt: Number.isNaN(resetRaw) ? null : resetRaw,
      });
    }
  }
  return windows;
}

// Merge the same bucket coming from multiple backends, keeping the tighter (most-used) one,
// because only the backend the user's client actually talks to reflects their real consumption.
function mergeWindows(lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const w of list) {
      const cur = byId.get(w.id);
      if (!cur || w.usedPct > cur.usedPct) byId.set(w.id, w);
    }
  }
  return [...byId.values()];
}

function parsePools(models) {
  const entries = Array.isArray(models)
    ? models.map((m) => [m.id || m.name || '', m])
    : Object.entries(models || {});

  const windows = [];
  for (const pool of POOLS) {
    let best = null; // Models in a pool share one quota; show the tightest (most used) as representative
    for (const [key, model] of entries) {
      const provider = model?.modelProvider;
      const modelKey = String(key).toLowerCase();
      const isArgon = /argon/.test(modelKey);
      const inPool = pool.id === 'argon'
        ? pool.match(modelKey)
        : !isArgon && (provider ? pool.providers.includes(provider) : pool.match(modelKey));
      if (!inPool) continue;
      const usedPct = modelUsedPct(model?.quotaInfo);
      if (usedPct === null) continue;
      const resetRaw = model.quotaInfo.resetTime ? Date.parse(model.quotaInfo.resetTime) : null;
      if (best === null || usedPct > best.usedPct) {
        best = {
          id: pool.id,
          label: pool.label,
          usedPct,
          resetAt: Number.isNaN(resetRaw) ? null : resetRaw,
        };
      }
    }
    if (best) windows.push(best);
  }
  return windows;
}

export const antigravity = {
  id: 'antigravity',
  name: 'Antigravity',
  color: '#4285f4',
  loginUrl: 'https://antigravity.google/',
  authCta: 'options', // Connect Google account in options page on auth error

  async fetchUsage() {
    const token = await getAccessToken();
    const info = await getProjectInfo(token);
    const body = info.project ? { project: info.project } : {};

    // Primary: per-group weekly + 5-hour limits, exactly as shown in the IDE's quota panel.
    // Query both backends and merge so we match whichever Antigravity build the user runs.
    const settled = await Promise.allSettled(
      BASES.map((base) => postJson('retrieveUserQuotaSummary', body, token, base))
    );
    const lists = settled
      .filter((r) => r.status === 'fulfilled')
      .map((r) => parseQuotaSummary(r.value));
    const windows = mergeWindows(lists);
    if (windows.length) return { plan: info.tier, windows };

    // Every summary call failed — surface auth errors, otherwise fall back to the model list.
    const authErr = settled.find(
      (r) => r.status === 'rejected' && r.reason instanceof ProviderError && r.reason.type === 'auth'
    );
    if (authErr) throw authErr.reason;

    const data = await postJson('fetchAvailableModels', body, token);
    if (!data || typeof data !== 'object') {
      throw new ProviderError('parse', 'Quota info not found');
    }
    const modelWindows = parsePools(data?.models);
    if (!modelWindows.length) throw new ProviderError('parse', 'Quota fields not recognized — open Settings');
    return { plan: info.tier, windows: modelWindows };
  },
};
