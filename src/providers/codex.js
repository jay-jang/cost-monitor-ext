import { fetchJsonWithTabFallback, ProviderError } from './http.js';
import { clampPct } from '../common/format.js';

const DAY = 24 * 3600;

function windowLabel(w, fallback) {
  const sec = Number(w.limit_window_seconds);
  if (Number.isFinite(sec) && sec > 0) {
    if (sec < DAY) return `세션 (${Math.round(sec / 3600)}시간)`;
    if (sec >= 6.5 * DAY && sec <= 8 * DAY) return '주간';
    return `${Math.round(sec / 3600 / 24)}일`;
  }
  return fallback;
}

function parseWindow(id, w, fallbackLabel) {
  if (!w || typeof w !== 'object') return null;
  const usedPct = clampPct(Number(w.used_percent));
  if (usedPct === null) return null;
  let resetAt = null;
  if (Number.isFinite(Number(w.reset_at))) {
    resetAt = Number(w.reset_at) * 1000; // epoch 초 단위
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
    // 1. NextAuth 세션 엔드포인트에서 accessToken을 가져옵니다.
    let session;
    try {
      session = await fetchJsonWithTabFallback(
        'https://chatgpt.com/api/auth/session',
        'https://chatgpt.com/*'
      );
    } catch (e) {
      if (e instanceof ProviderError && e.type === 'auth') {
        throw new ProviderError('auth', 'ChatGPT 로그인이 필요합니다');
      }
      throw e;
    }

    const token = session?.accessToken;
    if (!token) {
      throw new ProviderError('auth', 'ChatGPT 로그인이 필요합니다 (세션 토큰 없음)');
    }

    // 2. Bearer 토큰을 포함하여 사용량 API를 호출합니다.
    // 403(Cloudflare)이면 열린 chatgpt.com 탭에서 같은 출처로 재시도.
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
      parseWindow('primary', rl.primary_window, '세션 (5시간)'),
      parseWindow('secondary', rl.secondary_window, '주간'),
    ].filter(Boolean);

    if (windows.length === 0) {
      throw new ProviderError('parse', '사용량 필드를 찾지 못했습니다');
    }
    return { plan: planLabel(data.plan_type), windows };
  },
};
