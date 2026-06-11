export class ProviderError extends Error {
  constructor(type, message) {
    super(message);
    this.type = type; // 'auth' | 'network' | 'parse' | 'notfound' | 'unsupported'
  }
}

async function rawFetch(url, init = {}) {
  try {
    const res = await fetch(url, {
      credentials: 'include',
      ...init,
      headers: { accept: 'application/json', ...(init.headers || {}) },
    });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: String(e?.message || e) };
  }
}

// If a tab of that site is open, request from the page context of that tab (same origin).
// A verified bypass path when Cloudflare, etc., blocks requests from the extension context.
async function fetchViaOpenTab(tabUrlPattern, url, init = {}) {
  try {
    const tabs = await chrome.tabs.query({ url: tabUrlPattern });
    const tab = tabs.find((t) => t.id != null && !t.discarded);
    if (!tab) return null;
    const headers = init.headers || {};
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (u, h) => {
        try {
          const r = await fetch(u, {
            credentials: 'include',
            headers: { accept: 'application/json', ...h },
          });
          return { status: r.status, body: await r.text() };
        } catch (e) {
          return { status: 0, body: String(e?.message || e) };
        }
      },
      args: [url, headers],
    });
    return injection?.result ?? null;
  } catch {
    return null;
  }
}

function throwForStatus(status, body) {
  if (status === 401 || status === 403) {
    throw new ProviderError('auth', `Login or security check required (HTTP ${status})`);
  }
  if (status === 404) throw new ProviderError('notfound', 'HTTP 404');
  if (status === 0) throw new ProviderError('network', `Network error: ${body}`);
  if (status < 200 || status >= 300) throw new ProviderError('network', `HTTP ${status}`);
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new ProviderError('parse', 'Failed to parse response — might have been redirected to the login page');
  }
}

export async function fetchJson(url, init = {}) {
  const { status, body } = await rawFetch(url, init);
  throwForStatus(status, body);
  return parseJson(body);
}

function looksLikeJson(body) {
  const s = (body || '').trimStart();
  return s.startsWith('{') || s.startsWith('[');
}

// If direct fetch from the service worker fails with 403/network error, or returns a non-JSON response 
// (e.g. login/security HTML returning 200), retry via an open tab.
export async function fetchJsonWithTabFallback(url, tabUrlPattern, init = {}) {
  let { status, body } = await rawFetch(url, init);
  if (status === 403 || status === 0 || (status >= 200 && status < 300 && !looksLikeJson(body))) {
    const viaTab = await fetchViaOpenTab(tabUrlPattern, url, init);
    if (viaTab) ({ status, body } = viaTab);
  }
  throwForStatus(status, body);
  return parseJson(body);
}
