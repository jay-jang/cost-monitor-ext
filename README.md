# Coding Agent Quota Monitor

A Chrome extension that lets you check your Claude Code, Codex, and Antigravity plan usage (remaining quota limits) in real-time right from your Chrome toolbar.

Since it queries the **server-side usage APIs of each service** rather than reading local logs, you will see the same usage numbers even when working across multiple machines.

## Installation

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select this folder (`cost-monitor-ext`).

## Service Tracking Mechanisms

| Service | Data Source | Requirements |
|---|---|---|
| Claude | `claude.ai/api/organizations/{org}/usage` (the same internal API used by Settings -> Usage page) | Logged into claude.ai in your browser |
| Codex | `chatgpt.com/backend-api/wham/usage` (Cookie authentication) | Logged into chatgpt.com in your browser |
| Antigravity | `{cloudcode-pa, daily-cloudcode-pa}.googleapis.com/v1internal:retrieveUserQuotaSummary` (per-group weekly + 5-hour limits, merged across both backends) | Connect Google Account via OAuth on the options page |

- **Claude / Codex**: Works automatically without any additional configuration if you are already logged in via your browser. The extension automatically inherits the session cookies, and no credentials or tokens are sent to external servers (all requests are made directly to the respective service domain).
- **Antigravity**: There is no dedicated web page or simple cookie API for checking quota limits. Instead, the extension directly calls the Cloud Code API used by the Antigravity IDE via Google OAuth. To connect, simply click the **Connect Google Account** button on the Options page and grant permissions once.
  - The extension uses the **Antigravity public OAuth client** (extracted from the IDE binary) with **PKCE**, as the quota API only accepts tokens from this client.
  - The quota API (`fetchAvailableModels`) requires the `User-Agent: antigravity/...` header. Since `fetch()` inside a Chrome extension cannot change the User-Agent directly, `declarativeNetRequest` is used to rewrite the header.
  - The request requires the `cloud-platform` scope (demanded by the Cloud Code API). Tokens are saved locally inside `chrome.storage.local`.

> For a detailed explanation of the implementation principles, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Features

- **Toolbar Badge**: Shows the usage % of the window whose quota changed most recently (i.e. the limit you are actively consuming), so the badge follows your current activity. The badge background is the **brand color of that service** (Claude orange / Codex green / Antigravity blue) so you can tell at a glance which service the number belongs to.
- **Popup**: Cards for each service showing the remaining percentage progress bar and reset countdown for each quota window (e.g., 5-hour session, weekly, model pools). Click the ↗ next to a service name to open its usage page (Claude / Codex; Antigravity has no such page).
- **Desktop Notifications**: A one-time notification is triggered when usage first crosses the warning/critical threshold.
- **Options**: Toggle individual services, configure polling interval (1–15 mins), warning/critical thresholds, and desktop notification toggles.

## Things to Note

- All three services use **private internal APIs**, which may change without notice. Parsing is implemented defensively, and if an API breaks, the popup will display an error message along with a direct link to the respective service page.
- Codex (chatgpt.com) can occasionally trigger Cloudflare security checks. If this happens and you have a chatgpt.com tab open, the request will automatically retry via that tab; otherwise, visiting chatgpt.com once will resolve the check.
- Claude's usage metrics include usage from Claude Code (integrated 5-hour sessions, weekly limits, and Opus weekly window).
- Antigravity usage comes from `v1internal:retrieveUserQuotaSummary` — the same read-only source behind the IDE's "Model Quota" panel. It reports two groups, **Gemini** (all Google models) and **Claude & GPT** (Anthropic + OpenAI models), each with both a **Weekly** and a **5-hour** limit (four bars total). The stable Antigravity build talks to `cloudcode-pa` while the daily/Insiders build talks to `daily-cloudcode-pa`, and **Gemini quota is tracked separately per backend** (third-party Claude/GPT quota is shared). The extension therefore queries **both** backends and shows the tighter (more-used) limit per group, so it matches whichever build you run with no configuration. If both summary calls fail it falls back to deriving the 5-hour usage from `fetchAvailableModels` (an exhausted limit there drops `remainingFraction` and returns only `resetTime`, and is shown as 100% used rather than skipped).

## Project Structure

```
manifest.json            MV3 configuration, host permissions, declarativeNetRequest
src/
├── background.js        Alarm polling, badge management, notifications, OAuth callback, Antigravity User-Agent rule
├── common/              Default options, time-formatting helpers
├── providers/
│   ├── index.js         Adapter registry (common contract)
│   ├── http.js          Cookie authentication fetch + open tab proxy fallback
│   ├── claude.js        Org discovery -> usage window parsing
│   ├── codex.js         Session token -> wham/usage window parsing
│   ├── antigravity.js   loadCodeAssist -> retrieveUserQuotaSummary (weekly + 5h per group)
│   └── antigravity-auth.js  Google OAuth (Auth Code + PKCE, loopback code capture)
├── popup/               Usage card UI
└── options/             Settings panel + Antigravity account connection
```

For more details on internal operations, please refer to [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

To add a new service, create a new adapter file in `providers/` and register it in `index.js`. Adapter contract: `fetchUsage() -> { plan, windows: [{ id, label, usedPct, resetAt }] }`.
