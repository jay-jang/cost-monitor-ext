import { fetchJsonWithTabFallback, ProviderError } from './http.js';
import { clampPct } from '../common/format.js';

const ORG_CACHE_TTL = 24 * 60 * 60 * 1000;

// 응답 윈도우 키 → 표시 라벨 (null 윈도우는 해당 플랜에 없음 — 건너뜀)
const WINDOW_LABELS = [
  ['five_hour', '세션 (5시간)'],
  ['seven_day', '주간 (전체)'],
  ['seven_day_opus', '주간 (Opus)'],
  ['seven_day_sonnet', '주간 (Sonnet)'],
  ['seven_day_oauth_apps', '주간 (OAuth 앱)'],
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
    throw new ProviderError('auth', 'claude.ai 조직 정보를 찾을 수 없습니다');
  }
  // API 콘솔 전용 조직(capabilities == ['api'])은 플랜 한도가 없음
  const usable = orgs.filter((o) => {
    const caps = o.capabilities || [];
    return !(caps.length === 1 && caps[0] === 'api');
  });
  const candidates = usable.length ? usable : orgs;

  // claude.ai가 활성 조직 uuid를 lastActiveOrg 쿠키에 기록함 — 설정 화면과 일치
  let active = null;
  try {
    const cookie = await chrome.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' });
    if (cookie?.value) active = candidates.find((o) => o.uuid === cookie.value);
  } catch {
    // cookies 권한 문제 등은 무시하고 휴리스틱으로
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
      // 조직을 떠났거나 전환한 경우 — 캐시 비우고 한 번 재발견
      if (e.type !== 'notfound') throw e;
      org = await getOrg(true);
      data = await fetchJsonWithTabFallback(
        `https://claude.ai/api/organizations/${org.uuid}/usage`,
        'https://claude.ai/*'
      );
    }

    const windows = parseWindows(data);
    if (windows.length === 0) {
      throw new ProviderError('parse', '사용량 필드를 찾지 못했습니다');
    }
    return { plan: org.plan, windows };
  },
};
