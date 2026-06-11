# 동작 방식 (Architecture)

이 문서는 LLM Quota Monitor 확장이 각 서비스의 사용량을 **어떻게** 읽어오는지, 그리고 내부 구성요소가 어떻게 맞물려 도는지를 설명합니다.

---

## 1. 큰 그림

```
                        ┌─────────────────────────────────────┐
   chrome.alarms ──────▶│        background.js (SW)           │
   팝업 열기 / 옵션 변경  │  refreshAll() → 각 provider 폴링      │
                        └───────────────┬─────────────────────┘
                                        │ fetchUsage()
                ┌───────────────────────┼───────────────────────┐
                ▼                       ▼                       ▼
          claude.js               codex.js               antigravity.js
        (쿠키 세션)            (NextAuth 토큰)         (Google OAuth + UA)
                │                       │                       │
                ▼                       ▼                       ▼
        claude.ai 내부 API      chatgpt.com wham API    cloudcode-pa API
                                        │
                                        ▼
                        snapshots → chrome.storage.local
                                        │
                        ┌───────────────┼───────────────┐
                        ▼               ▼               ▼
                      배지            팝업 카드         알림
```

모든 provider는 동일한 **어댑터 계약**을 따릅니다 (`providers/index.js`):

```js
{
  id, name, color, loginUrl,
  async fetchUsage() -> {
    plan: string | null,
    windows: [{ id, label, usedPct (0~100), resetAt (epoch ms | null) }],
  }
  // 실패 시 ProviderError(type: 'auth' | 'network' | 'parse' | 'notfound') throw
}
```

`background.js`는 provider가 무엇인지 몰라도 됩니다 — 그냥 `fetchUsage()`를 부르고, 돌아온 `windows`로 배지/팝업/알림을 그립니다. 새 서비스를 추가하려면 어댑터 파일 하나 만들고 `index.js`에 등록하면 끝입니다.

---

## 2. 폴링 & 표시 파이프라인 (`background.js`)

1. **스케줄링** — `chrome.alarms`로 N분(기본 5분)마다 `refreshAll()` 호출. 팝업을 열거나 옵션을 바꿔도 즉시 1회 폴링합니다. 알람과 팝업 폴링이 겹쳐도 `refreshing` 가드로 한 번만 실행됩니다.
2. **수집** — 켜져 있는 provider들의 `fetchUsage()`를 `Promise.all`로 병렬 호출. 성공/실패 결과를 `snapshots[providerId]`에 저장 (`{ at, ok, plan, windows }` 또는 `{ ok:false, errorType, message }`).
3. **배지** — 전체 윈도우 중 **가장 높은 사용률**을 배지 숫자로 표시. `warnPct`(기본 75) 이상 주황, `critPct`(기본 90) 이상 빨강. 사용량이 하나도 없고 인증 오류만 있으면 `!` 표시.
4. **알림** — 사용률이 경고/위험 기준을 **처음 넘는 순간**에만 1회 알림 (엣지 트리거). `notifyState`에 마지막 레벨을 기록해 매 폴링마다 반복 알림하지 않습니다.

---

## 3. 공통 HTTP 레이어 (`providers/http.js`)

Claude와 Codex는 **브라우저에 저장된 세션 쿠키**로 인증합니다. 서비스 워커의 `fetch(..., { credentials: 'include' })`가 쿠키를 자동으로 싣습니다.

문제는 **Cloudflare** 등이 확장 컨텍스트에서 나온 요청을 막을 수 있다는 것. 이를 위해 `fetchJsonWithTabFallback()`이 있습니다:

1. 먼저 서비스 워커에서 직접 `fetch`.
2. `403`(보안 차단) 또는 `0`(네트워크 오류)이면 → **이미 열려 있는 해당 사이트 탭**을 찾아 `chrome.scripting.executeScript`로 그 페이지 컨텍스트에서 같은 출처 `fetch`를 실행. 진짜 브라우저 탭에서 나간 요청이라 Cloudflare를 통과합니다.
3. 그래도 안 되면 `ProviderError`를 던지고, 팝업이 "로그인하러 가기" 링크를 띄웁니다.

`ProviderError.type`은 `auth | network | parse | notfound`로 분류되어 UI가 상황에 맞는 안내를 보여줍니다.

---

## 4. Claude (`providers/claude.js`)

> 출처: `claude.ai/api/organizations/{org}/usage` — 설정 → 사용량 페이지가 쓰는 바로 그 내부 API

**조직(org) 발견**
- `claude.ai/api/organizations`로 소속 조직 목록을 받습니다.
- `capabilities`가 `['api']`뿐인 조직(API 콘솔 전용, 플랜 한도 없음)은 제외.
- claude.ai가 활성 조직 UUID를 기록하는 `lastActiveOrg` 쿠키를 읽어 **설정 화면과 동일한 조직**을 선택. 쿠키가 없으면 `chat` 기능이 있는 조직 → 첫 조직 순으로 폴백.
- 결과는 24시간 캐시. 조직을 떠나서 `404`가 나면 캐시를 비우고 1회 재발견.

**사용량 파싱**
- `utilization`(사용률 %)과 `resets_at`(리셋 시각)을 가진 윈도우들을 추출:
  - `five_hour` — 세션 (5시간)
  - `seven_day` — 주간 (전체)
  - `seven_day_opus` / `seven_day_sonnet` / `seven_day_oauth_apps` — 모델·앱별 주간
- 플랜에 없는 윈도우는 응답에 없으므로 자동으로 건너뜁니다.
- 플랜 라벨은 `rate_limit_tier`에서 추론 (`max_20x` → Max 20x, `pro` → Pro 등).

이 수치는 **Claude Code 사용분을 포함한 통합 사용량**입니다.

---

## 5. Codex (`providers/codex.js`)

> 출처: `chatgpt.com/backend-api/wham/usage`

**2단계 인증**
1. `chatgpt.com/api/auth/session`(NextAuth)에서 `accessToken`을 꺼냅니다 — 쿠키 세션 기반.
2. 그 토큰을 `Authorization: Bearer ...`로 실어 `wham/usage`를 호출.

**사용량 파싱**
- `rate_limit.primary_window` → 세션(5시간), `rate_limit.secondary_window` → 주간.
- 각 윈도우의 `used_percent`, 리셋은 `reset_at`(epoch 초) 또는 `reset_after_seconds`(상대) 둘 다 처리.
- 윈도우 라벨은 `limit_window_seconds`로 자동 판별 (1일 미만이면 "세션 N시간", 7일 근처면 "주간").
- 플랜 라벨은 `plan_type`.

`wham/usage`가 Cloudflare `403`을 내면 위의 **열린 탭 폴백**으로 재시도합니다. 그래도 막히면 chatgpt.com에 한 번 방문(로그인/보안 확인)하면 풀립니다.

---

## 6. Antigravity (`providers/antigravity.js` + `antigravity-auth.js`)

Antigravity는 다른 둘과 근본적으로 다릅니다. **쿠키로 접근 가능한 웹 사용량 페이지가 없습니다.** 대신 Antigravity IDE가 쓰는 것과 같은 비공개 **Cloud Code API**(`cloudcode-pa.googleapis.com`)를 확장이 직접 OAuth로 호출합니다.

### 6.1 OAuth 연결 (`antigravity-auth.js`)

표준 **Authorization Code + PKCE** 흐름이되, Chrome 확장 환경에 맞춘 트릭이 들어갑니다.

1. 옵션 페이지에서 "Google 계정 연결" → `startConnect()`가 PKCE `code_verifier`/`code_challenge`를 만들어 `agPendingAuth`에 저장하고, Google 동의 화면 탭을 엽니다.
2. 리디렉션 URI는 `http://127.0.0.1:51121/` (installed-app 클라이언트라 임의 루프백 포트/경로 허용). **아무도 listen하지 않으므로 페이지 자체는 실패**하지만, 그 직전 탭의 URL에 `?code=...`가 실립니다.
3. `chrome.tabs.onUpdated` 리스너가 그 리디렉션 탭을 감지해 **URL에서 `code`를 가로채고** 탭을 닫습니다.
4. `code` + `code_verifier`로 토큰을 교환해 `agTokens`(refresh/access)를 `chrome.storage.local`에 저장. access token이 만료되면 refresh token으로 갱신합니다.

> **왜 PKCE가 필수인가:** 이 OAuth 클라이언트는 `code_verifier` 없이 토큰을 교환하면 `400`으로 거부합니다.

> **왜 이 클라이언트인가:** 쿼터 API(`fetchAvailableModels`)는 **Antigravity 자체 OAuth 클라이언트**(`1071006060591-...`, IDE 바이너리에서 추출한 공개 installed-app 클라이언트)로 발급된 토큰에만 권한을 줍니다. gemini-cli 등 다른 클라이언트 토큰은 `loadCodeAssist`는 통과해도 `fetchAvailableModels`에서 `403`이 납니다. (GCP ToS 사용자용 클라이언트 `884354919052-...`는 별개지만, 대다수 사용자 = 비-GcpTos이므로 전자를 기본값으로 씁니다.)

### 6.2 쿼터 조회 (`antigravity.js`)

1. **`loadCodeAssist`** — 사용자의 관리형 GCP 프로젝트 ID와 요금제(tier)를 받습니다. 24시간 캐시(`agProject`).
2. **`fetchAvailableModels`** — 모델별 쿼터(`quotaInfo.remainingFraction`, `resetTime`, `isExhausted`)를 받습니다.

### 6.3 ⚠️ User-Agent 게이트 (핵심)

`fetchAvailableModels`는 **`User-Agent: antigravity/<버전> <OS>/<arch>` 헤더로 온 요청에만 200을 주고, 그 외(브라우저 기본 UA 등)에는 `403 PERMISSION_DENIED`를 반환합니다.** 올바른 OAuth 클라이언트 토큰만으로는 부족하고, **클라이언트 + User-Agent 두 조건이 모두** 충족돼야 합니다.

그런데 **Chrome 확장의 `fetch()`는 `User-Agent`를 바꿀 수 없습니다** (forbidden header). MV3에서는 이를 `declarativeNetRequest` **동적 규칙**으로 우회합니다 (`background.js`의 `ensureAntigravityUserAgent()`):

```
condition: cloudcode-pa.googleapis.com 로 가는 xmlhttprequest
action:    User-Agent 헤더를 antigravity/... 로 set
```

OS/arch는 실행 환경에서 추론해 채웁니다.

> 이 게이트가 "계정은 연결됐는데 쿼터만 403"이라는 증상의 원인이었습니다 — `loadCodeAssist`는 UA를 따지지 않아 연결은 성공하는 것처럼 보이지만, `fetchAvailableModels`만 막혔던 것.

### 6.4 풀(pool) 단위 표시

모델이 너무 많고 여러 모델이 **공유 쿼터 풀**로 묶여 있어서, 풀별 대표 사용량만 보여줍니다 (`parsePools`):

| 풀 | 매칭 | 라벨 |
|---|---|---|
| `flash` | 이름에 `flash` | Flash |
| `pro` | 이름에 `pro` | Pro |
| `opus` | 이름에 `opus`/`claude`/`gpt` | Opus |

각 풀에서 **가장 많이 쓴(remaining이 가장 적은) 모델**을 그 풀의 대표 사용량으로 삼습니다. `remainingFraction`을 `usedPct = 100 * (1 - fraction)`으로 환산하고, `resetTime`을 리셋 시각으로 씁니다.

---

## 7. 옵션 & 저장소

`common/options.js` — `chrome.storage.sync`에 저장 (기기 간 동기화):

| 옵션 | 기본값 | 의미 |
|---|---|---|
| `providers` | 모두 on | 서비스별 on/off |
| `pollMinutes` | 5 | 폴링 주기 (1~15분) |
| `warnPct` | 75 | 경고 기준(주황) |
| `critPct` | 90 | 위험 기준(빨강) |
| `notify` | true | 데스크톱 알림 |

런타임 데이터는 `chrome.storage.local`:

| 키 | 내용 |
|---|---|
| `snapshots` | provider별 최근 사용량 결과 |
| `notifyState` | 알림 엣지 트리거 상태 |
| `claudeOrg` | Claude 조직 캐시(24h) |
| `agTokens` | Antigravity OAuth 토큰 |
| `agProject` | Antigravity 프로젝트/요금제 캐시(24h) |
| `agAccount` | 연결된 Google 계정/오류 표시용 |
| `agPendingAuth` | 진행 중 OAuth의 PKCE verifier |

---

## 8. 주의사항

- 세 서비스 모두 **비공개 내부 API**라 예고 없이 바뀔 수 있습니다. 파싱은 방어적으로 되어 있고, 깨지면 팝업에 오류와 해당 서비스로 가는 링크가 뜹니다.
- 토큰/쿠키는 외부로 전송되지 않습니다 — 요청은 각 서비스의 도메인으로만 나갑니다.
- Antigravity 클라이언트 ID/시크릿은 IDE에서 추출한 **공개 installed-app 자격증명**입니다. 원하면 `antigravity-auth.js`에서 본인 GCP OAuth 클라이언트로 교체할 수 있지만, 그 경우 `fetchAvailableModels`의 User-Agent 게이트는 별도로 충족돼야 합니다.
</content>
</invoke>
