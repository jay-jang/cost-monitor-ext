# Architecture

This document describes **how** the Coding Agent Quota Monitor extension fetches usage data from each service and how its internal components work together.

---

## 1. Big Picture

```
                        ┌─────────────────────────────────────┐
   chrome.alarms ──────▶│        background.js (SW)           │
   Open Popup / Options │  refreshAll() → Poll each provider  │
                        └───────────────┬─────────────────────┘
                                        │ fetchUsage()
                ┌───────────────────────┼───────────────────────┐
                ▼                       ▼                       ▼
          claude.js               codex.js               antigravity.js
       (Cookie Session)       (NextAuth Token)       (Google OAuth + UA)
                │                       │                       │
                ▼                       ▼                       ▼
        claude.ai Internal API  chatgpt.com wham API    cloudcode-pa API
                                        │
                                        ▼
                        snapshots → chrome.storage.local
                                        │
                        ┌───────────────┼───────────────┐
                        ▼               ▼               ▼
                      Badge         Popup Cards     Notification
```

All providers follow the same **adapter contract** (`providers/index.js`):

```js
{
  id, name, color, loginUrl,
  async fetchUsage() -> {
    plan: string | null,
    windows: [{ id, label, usedPct (0~100), resetAt (epoch ms | null) }],
  }
  // Throws ProviderError(type: 'auth' | 'network' | 'parse' | 'notfound' | 'unsupported') on failure
}
```

`background.js` does not need to know the details of each provider — it simply calls `fetchUsage()` and uses the returned `windows` to update the badge, popups, and notifications. Adding a new service is as simple as creating an adapter file and registering it in `index.js`.

---

## 2. Polling & Display Pipeline (`background.js`)

1. **Scheduling** — `chrome.alarms` calls `refreshAll()` every N minutes (default: 5 minutes). Opening the popup or changing options triggers an immediate poll. If an alarm poll overlaps with a popup poll, the `refreshing` guard ensures only one execution runs.
2. **Collection** — Calls `fetchUsage()` for all enabled providers in parallel using `Promise.all`. The successful or failed results are saved to `snapshots[providerId]` (`{ at, ok, plan, windows }` or `{ ok: false, errorType, message }`).
3. **Badge** — Displays the usage % of the window that **changed most recently** versus the previous poll (the limit you are actively consuming), tracked via a persisted `windowState` map (`{ [provider:window]: { pct, changedAt } }`). If nothing changed this poll, the last-changed selection is kept. Because a single model usually refreshes its session and weekly windows together in one response, ties on change-time prefer the **shorter-term window** (soonest reset) — so the badge favors the live session value over a maxed-out weekly; usage % breaks any further tie. The badge background uses the **provider's brand color** so you can tell which service the number belongs to. If there is no usage data but an authentication error exists, it displays `!`.
4. **Notification** — Sends a desktop notification **only the first time** the usage crosses a threshold level (edge-triggered). The last level is recorded in `notifyState` to prevent repeated notifications on every poll.

---

## 3. Common HTTP Layer (`providers/http.js`)

Claude and Codex authenticate using the **browser-stored session cookies**. The service worker's `fetch(..., { credentials: 'include' })` automatically includes these cookies.

However, security protections like **Cloudflare** can block requests originating from the extension context. To bypass this, `fetchJsonWithTabFallback()` is implemented:

1. The service worker first performs a direct `fetch`.
2. If it encounters a `403` (security block) or `0` (network error), it searches for an **already open tab of the respective site** and runs `chrome.scripting.executeScript` to execute the same origin `fetch` inside the page context. Because the request originates from a real browser tab, it successfully bypasses Cloudflare.
3. If it still fails, it throws a `ProviderError`, and the popup displays a "Go to Login" link.

`ProviderError.type` is classified into `auth | network | parse | notfound | unsupported` so that the UI can guide the user appropriately.

---

## 4. Claude (`providers/claude.js`)

> Source: `claude.ai/api/organizations/${org}/usage` — the exact same internal API used by Settings -> Usage page.

**Organization (org) Discovery**
- Fetches the user's organization list from `claude.ai/api/organizations`.
- Excludes organizations with only `['api']` capabilities (API console only, no plan limits).
- Reads the `lastActiveOrg` cookie, where claude.ai records the active organization UUID, to match the **exact organization selected in the settings UI**. If the cookie is missing, it falls back to an organization with `chat` capabilities, and then to the first organization.
- Results are cached for 24 hours. If a `404` error occurs because the user left the organization, the cache is cleared and rediscovered once.

**Usage Parsing**
- Extracts windows containing `utilization` (usage %) and `resets_at` (reset time):
  - `five_hour` — Session (5h)
  - `seven_day` — Weekly (Total)
  - `seven_day_opus` / `seven_day_sonnet` / `seven_day_oauth_apps` — Weekly limits per model or app
- Windows not available in the user's plan are absent from the response and automatically skipped.
- The plan label is inferred from `rate_limit_tier` (`max_20x` -> Max 20x, `pro` -> Pro, etc.).

These figures represent **integrated usage including Claude Code usage**.

---

## 5. Codex (`providers/codex.js`)

> Source: `chatgpt.com/backend-api/wham/usage`

**2-Step Authentication**
1. Extracts `accessToken` from `chatgpt.com/api/auth/session` (NextAuth) — based on the cookie session.
2. Calls `wham/usage` by passing the token in `Authorization: Bearer ...`.

**Usage Parsing**
- `rate_limit.primary_window` -> Session (5h), `rate_limit.secondary_window` -> Weekly.
- Handles `used_percent` for each window. Handles resets via both `reset_at` (epoch seconds) and `reset_after_seconds` (relative offset).
- Automatically determines window labels from `limit_window_seconds` (less than 1 day is labeled "Session Nh", near 7 days is labeled "Weekly").
- The plan label is mapped from `plan_type`.

If `wham/usage` returns a Cloudflare `403`, it retries using the **open tab fallback** described above. If still blocked, visiting chatgpt.com once (for login or security challenge) will resolve it.

---

## 6. Antigravity (`providers/antigravity.js` + `antigravity-auth.js`)

Antigravity is fundamentally different from the other two. **It does not have a web-accessible page for checking usage via cookies.** Instead, the extension directly calls the private **Cloud Code API** (`cloudcode-pa.googleapis.com`) used by the Antigravity IDE via Google OAuth.

### 6.1 OAuth Connection (`antigravity-auth.js`)

The extension uses the standard **Authorization Code + PKCE** flow, tailored with a few tricks for the Chrome extension environment:

1. Clicking "Connect Google Account" in options -> `startConnect()` generates a PKCE `code_verifier`/`code_challenge`, stores it in `agPendingAuth`, and opens the Google OAuth consent screen tab.
2. The redirect URI is `http://127.0.0.1:51121/` (an arbitrary loopback port allowed for installed-app clients). **Although the page itself fails to load because nothing is listening, the `?code=...` query is appended to the tab URL.**
3. A `chrome.tabs.onUpdated` listener detects this redirect tab, **captures the `code` from the URL**, and closes the tab.
4. Exchanges the `code` + `code_verifier` for tokens, storing `agTokens` (refresh/access) in `chrome.storage.local`. If the access token expires, it is automatically renewed using the refresh token.

> **Why PKCE is mandatory:** The OAuth client will reject token exchange requests with a `400` error if `code_verifier` is missing.

> **Why this specific client is used:** The quota API (`fetchAvailableModels`) only grants permissions to tokens generated by the **Antigravity OAuth client** (`1071006060591-...`, the public installed-app client extracted from the IDE binary). Using other client tokens, such as gemini-cli, will successfully call `loadCodeAssist` but return `403` on `fetchAvailableModels`. (The GCP ToS client `884354919052-...` is separate, but because the majority of users are non-GcpTos, we use the former as default.)

### 6.2 Quota Fetching (`antigravity.js`)

1. **`loadCodeAssist`** — Retrieves the user's managed GCP project ID and billing tier. Cached for 24 hours (`agProject`).
2. **`fetchAvailableModels`** — Fetches remaining quotas per model (`quotaInfo.remainingFraction`, `resetTime`, `isExhausted`).

### 6.3 ⚠️ User-Agent Gate (Crucial)

**The `fetchAvailableModels` endpoint returns 200 only if the request has the `User-Agent: antigravity/<version> <OS>/<arch>` header; otherwise, it returns `403 PERMISSION_DENIED`.** A valid OAuth token is not enough; **both the correct client token and the correct User-Agent** are required.

However, **Chrome extension `fetch()` calls cannot modify the `User-Agent` header** (it is a forbidden header). Under MV3, this is bypassed using `declarativeNetRequest` **dynamic rules** (`ensureAntigravityUserAgent()` in `background.js`):

```
Condition: xmlhttprequest heading to cloudcode-pa.googleapis.com
Action:    Set the User-Agent header to antigravity/...
```

The OS and architecture are inferred from the user agent of the host environment.

> This User-Agent requirement was the reason why connection seemed successful (as `loadCodeAssist` doesn't enforce UA, returning account info) but quota queries returned `403`.

### 6.4 Pool-based Display

Since there are many models and they share quota pools, the extension aggregates and displays usage by pool (`parsePools`):

| Pool | Matching Logic | Label |
|---|---|---|
| `flash` | Name contains `flash` | Flash |
| `pro` | Name contains `pro` | Pro |
| `opus` | Name contains `opus`, `claude`, or `gpt` | Opus |

The **most heavily used model (smallest remaining fraction)** in each pool represents the usage of that pool. The `remainingFraction` is converted to `usedPct = 100 * (1 - fraction)`, and `resetTime` is used for the reset countdown.

---

## 7. Options & Storage

`common/options.js` — stored in `chrome.storage.sync` (synced across devices):

| Option | Default | Description |
|---|---|---|
| `providers` | All enabled | Toggle individual tracking services |
| `pollMinutes` | 5 | Polling interval (1 to 15 minutes) |
| `warnPct` | 75 | Warning threshold (turns orange) |
| `critPct` | 90 | Critical threshold (turns red) |
| `notify` | true | Enable desktop notifications |

Runtime data stored in `chrome.storage.local`:

| Key | Description |
|---|---|
| `snapshots` | Latest usage results per provider |
| `notifyState` | State tracker for edge-triggered notifications |
| `windowState` | Per-window `{ pct, changedAt }` used to pick the badge's most-recently-changed window |
| `claudeOrg` | Cache for Claude organization info (24h) |
| `agTokens` | Antigravity OAuth tokens |
| `agProject` | Cache for Antigravity project/billing tier (24h) |
| `agAccount` | Connected Google Account info or errors |
| `agPendingAuth` | PKCE verifier for in-progress OAuth flows |

---

## 8. Caveats

- All three services use **private internal APIs**, which may change without notice. Parsing is implemented defensively, and if an API breaks, the popup will display an error message along with a direct link to the respective service page.
- Session tokens and cookies are never sent to external servers — all requests are sent directly to the respective service domains.
- The Antigravity client ID/secret are **public installed-app credentials** extracted from the IDE. If desired, you can replace them in `antigravity-auth.js` with your own GCP OAuth client, but the User-Agent gate for `fetchAvailableModels` must still be satisfied.
