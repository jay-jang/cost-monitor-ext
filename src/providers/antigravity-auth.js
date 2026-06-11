import { ProviderError } from './http.js';

// fetchAvailableModels는 Antigravity IDE 자체 OAuth 클라이언트로 발급된 토큰만 허용한다.
// gemini-cli 클라이언트(681255809395) 토큰은 loadCodeAssist는 통과하지만 fetchAvailableModels에서
// 403(PERMISSION_DENIED)이 난다.
//
// 아래 값은 Antigravity IDE 바이너리(vs/platform/cloudCode/common/oauthClient.js)에서 추출한 공개 클라이언트.
// IDE는 GCP ToS 사용자(isGcpTos)에게는 884354919052 클라이언트를, 그 외 일반 사용자에게는
// 1071006060591 클라이언트를 사용한다. 대다수 사용자(Google One AI Pro 포함)는 isGcpTos=false 이므로
// 1071006060591을 기본으로 사용한다.
const CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];
// installed-app 클라이언트는 임의 포트의 루프백 리디렉션을 허용.
// 아무것도 listen하지 않아 페이지는 실패하지만, 탭 URL에 실린 code를 가로채면 된다.
export const REDIRECT_URI = 'http://127.0.0.1:51121/';
const PENDING_TTL = 10 * 60 * 1000;

// PKCE — 이 클라이언트는 code_verifier 없이는 토큰 교환이 400으로 거부된다.
function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function makePkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function buildAuthUrl(challenge) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      ...params,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `HTTP ${res.status}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

export async function startConnect() {
  const { verifier, challenge } = await makePkce();
  await chrome.storage.local.set({ agPendingAuth: { at: Date.now(), verifier } });
  await chrome.tabs.create({ url: buildAuthUrl(challenge) });
}

export async function disconnect() {
  const { agTokens } = await chrome.storage.local.get('agTokens');
  if (agTokens?.refreshToken) {
    // 베스트 에포트 토큰 폐기
    fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(agTokens.refreshToken)}`,
      { method: 'POST' }
    ).catch(() => {});
  }
  await chrome.storage.local.remove(['agTokens', 'agAccount', 'agProject', 'agPendingAuth']);
}

// OAuth 리디렉션 탭 감시 — background에서 1회 등록
export function initAuthListener(onConnected) {
  chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    const url = info.url || tab?.url;
    if (!url || (!url.startsWith(REDIRECT_URI) && !url.startsWith('http://localhost:51121/'))) return;

    const { agPendingAuth } = await chrome.storage.local.get('agPendingAuth');
    if (!agPendingAuth || Date.now() - agPendingAuth.at > PENDING_TTL) return;
    await chrome.storage.local.remove('agPendingAuth');
    chrome.tabs.remove(tabId).catch(() => {});
    const verifier = agPendingAuth.verifier;

    const u = new URL(url);
    const code = u.searchParams.get('code');
    if (!code) {
      await chrome.storage.local.set({
        agAccount: { error: u.searchParams.get('error') || '인증이 취소되었습니다' },
      });
      return;
    }

    try {
      const tok = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      });
      await chrome.storage.local.set({
        agTokens: {
          refreshToken: tok.refresh_token,
          accessToken: tok.access_token,
          expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
        },
      });
      let email = null;
      try {
        const info2 = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tok.access_token}` },
        }).then((r) => r.json());
        email = info2.email || null;
      } catch {
        // 이메일은 표시용일 뿐
      }
      await chrome.storage.local.set({ agAccount: { email } });
      onConnected?.();
    } catch (e) {
      await chrome.storage.local.set({ agAccount: { error: `토큰 교환 실패: ${e.message}` } });
    }
  });
}

export async function getAccessToken() {
  const { agTokens } = await chrome.storage.local.get('agTokens');
  if (!agTokens?.refreshToken) {
    throw new ProviderError('auth', '설정에서 Google 계정을 연결해 주세요');
  }
  if (agTokens.accessToken && Date.now() < agTokens.expiresAt - 5 * 60 * 1000) {
    return agTokens.accessToken;
  }
  try {
    const tok = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: agTokens.refreshToken,
    });
    await chrome.storage.local.set({
      agTokens: {
        refreshToken: tok.refresh_token || agTokens.refreshToken,
        accessToken: tok.access_token,
        expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
      },
    });
    return tok.access_token;
  } catch (e) {
    if (e.code === 'invalid_grant') {
      await chrome.storage.local.remove('agTokens');
      throw new ProviderError('auth', 'Google 인증이 만료됐습니다 — 설정에서 다시 연결해 주세요');
    }
    throw new ProviderError('network', `토큰 갱신 실패: ${e.message}`);
  }
}
