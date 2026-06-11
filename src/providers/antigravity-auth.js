import { ProviderError } from './http.js';

// fetchAvailableModels only allows tokens issued to the Antigravity IDE's own OAuth client.
// Tokens from the gemini-cli client (681255809395) pass loadCodeAssist but get 403 (PERMISSION_DENIED) in fetchAvailableModels.
//
// The value below is the public client extracted from the Antigravity IDE binary (vs/platform/cloudCode/common/oauthClient.js).
// The IDE uses the 884354919052 client for GCP ToS users (isGcpTos), and the 1071006060591 client for other regular users.
// Since the majority of users (including Google One AI Pro) have isGcpTos=false, we use 1071006060591 as default.
//
// NOTE: This is an installed-app (Desktop) OAuth client. Per Google's own docs, the client secret of a
// distributed native app is NOT confidential ("the client secret is obviously not treated as a secret") —
// it is already extractable from the IDE binary. Security here relies on PKCE + per-user consent + the
// loopback redirect restriction, NOT on this secret. Leaking it does not expose any user's tokens or data.
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
// The installed-app client allows loopback redirects to arbitrary ports.
// Although the page will fail because nothing is listening, we just need to intercept the code in the tab URL.
export const REDIRECT_URI = 'http://127.0.0.1:51121/';
const PENDING_TTL = 10 * 60 * 1000;

// PKCE — This client will reject token exchanges with a 400 error without code_verifier.
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
    // Best effort token revocation
    fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(agTokens.refreshToken)}`,
      { method: 'POST' }
    ).catch(() => {});
  }
  await chrome.storage.local.remove(['agTokens', 'agAccount', 'agProject', 'agPendingAuth']);
}

// Watch OAuth redirection tab — register once in background
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
        agAccount: { error: u.searchParams.get('error') || 'Authentication cancelled' },
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
        // Email is for display only
      }
      await chrome.storage.local.set({ agAccount: { email } });
      onConnected?.();
    } catch (e) {
      await chrome.storage.local.set({ agAccount: { error: `Token exchange failed: ${e.message}` } });
    }
  });
}

export async function getAccessToken() {
  const { agTokens } = await chrome.storage.local.get('agTokens');
  if (!agTokens?.refreshToken) {
    throw new ProviderError('auth', 'Please connect your Google Account in Settings');
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
      throw new ProviderError('auth', 'Google authentication expired — please reconnect in Settings');
    }
    throw new ProviderError('network', `Token refresh failed: ${e.message}`);
  }
}
