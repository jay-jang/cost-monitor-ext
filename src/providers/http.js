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

// 해당 사이트 탭이 열려 있으면 그 탭의 페이지 컨텍스트에서 같은 출처(fetch)로 요청.
// Cloudflare 등이 확장 컨텍스트 요청을 막을 때의 검증된 우회 경로.
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
    throw new ProviderError('auth', `로그인 또는 보안 확인이 필요합니다 (HTTP ${status})`);
  }
  if (status === 404) throw new ProviderError('notfound', 'HTTP 404');
  if (status === 0) throw new ProviderError('network', `네트워크 오류: ${body}`);
  if (status < 200 || status >= 300) throw new ProviderError('network', `HTTP ${status}`);
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new ProviderError('parse', '응답 파싱 실패 — 로그인 페이지로 리디렉션됐을 수 있습니다');
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

// 서비스 워커 직접 fetch가 403/네트워크 오류, 또는 JSON이 아닌 응답(로그인·보안 HTML이
// 200으로 오는 경우)이면 열린 탭을 통해 재시도한다.
export async function fetchJsonWithTabFallback(url, tabUrlPattern, init = {}) {
  let { status, body } = await rawFetch(url, init);
  if (status === 403 || status === 0 || (status >= 200 && status < 300 && !looksLikeJson(body))) {
    const viaTab = await fetchViaOpenTab(tabUrlPattern, url, init);
    if (viaTab) ({ status, body } = viaTab);
  }
  throwForStatus(status, body);
  return parseJson(body);
}
