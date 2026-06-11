import { ProviderError } from './http.js';
import { clampPct } from '../common/format.js';
import { getAccessToken } from './antigravity-auth.js';

const BASE = 'https://cloudcode-pa.googleapis.com/v1internal';
const CLIENT_METADATA = { ideName: 'antigravity', ideType: 'ANTIGRAVITY' };

// Models are grouped into shared pools — only display representative usage per pool
const POOLS = [
  { id: 'flash', label: 'Flash', match: (k) => /flash/.test(k) },
  { id: 'pro', label: 'Pro', match: (k) => /pro/.test(k) },
  { id: 'opus', label: 'Opus', match: (k) => /opus|claude|gpt/.test(k) },
];

async function postJson(path, body, token) {
  let res;
  try {
    res = await fetch(`${BASE}:${path}`, {
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
  const data = await postJson('loadCodeAssist', { metadata: CLIENT_METADATA }, token);
  const raw = data?.cloudaicompanionProject;
  const project = typeof raw === 'string' ? raw : raw?.id || null;
  const tier = tierLabel(data?.paidTier?.id || data?.currentTier?.id);
  const info = { project, tier, at: Date.now() };
  await chrome.storage.local.set({ agProject: info });
  return info;
}

function parsePools(models) {
  const entries = Array.isArray(models)
    ? models.map((m) => [m.id || m.name || '', m])
    : Object.entries(models || {});

  const windows = [];
  for (const pool of POOLS) {
    let best = null; // The tightest (most used) model within the pool represents the pool usage
    for (const [key, model] of entries) {
      if (!pool.match(String(key).toLowerCase())) continue;
      const q = model?.quotaInfo;
      if (!q) continue;
      let usedPct;
      const frac = Number(q.remainingFraction);
      if (Number.isFinite(frac)) {
        usedPct = clampPct(100 * (1 - frac));
      } else if (q.isExhausted) {
        usedPct = 100;
      } else {
        continue;
      }
      const resetAt = q.resetTime ? Date.parse(q.resetTime) : null;
      if (best === null || usedPct > best.usedPct) {
        best = {
          id: pool.id,
          label: pool.label,
          usedPct,
          resetAt: Number.isNaN(resetAt) ? null : resetAt,
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
    const data = await postJson(
      'fetchAvailableModels',
      info.project ? { project: info.project } : {},
      token
    );

    const windows = parsePools(data?.models);
    if (windows.length === 0) {
      throw new ProviderError('parse', 'Quota info not found');
    }
    return { plan: info.tier, windows };
  },
};
