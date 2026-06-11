# LLM Quota Monitor

Claude Code · Codex · Antigravity 플랜 사용량(남은 한도)을 Chrome 툴바에서 실시간으로 확인하는 확장 프로그램입니다.

로컬 로그가 아니라 **각 서비스의 서버 쪽 사용량 API**를 읽기 때문에, 여러 머신에서 작업해도 어디서나 같은 수치가 보입니다.

## 설치

1. Chrome에서 `chrome://extensions` 접속
2. 우측 상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드** → 이 폴더(`cost-monitor-ext`) 선택

## 서비스별 동작 방식

| 서비스 | 데이터 출처 | 준비물 |
|---|---|---|
| Claude | `claude.ai/api/organizations/{org}/usage` (설정→사용량 페이지와 같은 내부 API) | 브라우저에서 claude.ai 로그인 |
| Codex | `chatgpt.com/backend-api/wham/usage` (쿠키 인증) | 브라우저에서 chatgpt.com 로그인 |
| Antigravity | `cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` (모델별 남은 쿼터) | 옵션 페이지에서 Google 계정 OAuth 연결 |

- **Claude / Codex**: 브라우저에 이미 로그인돼 있으면 별도 설정 없이 동작합니다. 세션 쿠키가 자동으로 사용되며, 쿠키나 토큰이 외부로 전송되지 않습니다 (요청은 해당 서비스 도메인으로만 나감).
- **Antigravity**: 쿼터를 보여주는 웹 페이지/쿠키 API가 존재하지 않습니다 (조사 결과 확정). 대신 Antigravity IDE가 쓰는 것과 같은 Cloud Code API를 확장이 직접 OAuth로 호출합니다. 옵션 페이지에서 **Google 계정 연결** 버튼을 눌러 한 번만 동의하면 됩니다.
  - **Antigravity 자체 OAuth 클라이언트**(IDE 바이너리에서 추출한 공개 installed-app 클라이언트)를 **PKCE**와 함께 사용합니다. 쿼터 API가 이 클라이언트 토큰만 허용하기 때문입니다.
  - 쿼터 API(`fetchAvailableModels`)는 `User-Agent: antigravity/...` 헤더를 요구합니다. Chrome 확장의 `fetch()`는 User-Agent를 못 바꾸므로 `declarativeNetRequest`로 이 헤더를 덮어씁니다.
  - 요청 범위에 `cloud-platform`이 포함됩니다 (Cloud Code API가 이 스코프를 요구). 토큰은 `chrome.storage.local`에만 저장됩니다.

> 동작 원리의 자세한 설명은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 참고.

## 기능

- **툴바 배지**: 전체 서비스 중 가장 빡빡한 한도의 사용률(%)을 항상 표시. 75% 이상 주황, 90% 이상 빨강 (기준 변경 가능)
- **팝업**: 서비스별 카드 — 한도 윈도우(5시간 세션 / 주간 / 모델 풀)마다 남은 % 바 + 리셋 카운트다운
- **데스크톱 알림**: 사용률이 경고/위험 기준을 처음 넘을 때 1회 알림 (엣지 트리거)
- **옵션**: 서비스 on/off, 폴링 주기(1~15분), 경고 기준, 알림 토글

## 알아둘 점

- 세 서비스 모두 **비공개 내부 API**라서 예고 없이 바뀔 수 있습니다. 파싱은 방어적으로 구현돼 있고, 깨지면 팝업에 오류와 함께 해당 서비스 페이지로 가는 링크가 뜹니다.
- Codex(chatgpt.com)는 Cloudflare 보안 확인이 끼어들 수 있습니다. 이 경우 chatgpt.com 탭이 열려 있으면 그 탭을 통해 자동으로 재시도하고, 없으면 "로그인하러 가기"로 한 번 방문하면 풀립니다.
- Claude의 사용량은 Claude Code 사용분을 포함한 통합 수치입니다 (5시간 세션 / 주간 / Opus 주간 윈도우).
- Antigravity는 모델별 쿼터가 풀 단위(Gemini 3 / Claude·GPT / Gemini 2.5)로 공유되므로 풀별로 표시합니다. 주간 한도는 프로브 호출이 실제 쿼터를 소모하기 때문에 표시하지 않습니다.

## 구조

```
manifest.json            MV3, 호스트 권한, declarativeNetRequest
src/
├── background.js        알람 폴링, 배지, 알림, OAuth 콜백, Antigravity User-Agent 규칙
├── common/              옵션 기본값, 시간 포맷
├── providers/
│   ├── index.js         어댑터 레지스트리 (공통 계약)
│   ├── http.js          쿠키 인증 fetch + 열린 탭 프록시 폴백
│   ├── claude.js        조직 발견 → usage 윈도우 파싱
│   ├── codex.js         세션 토큰 → wham/usage 윈도우 파싱
│   ├── antigravity.js   loadCodeAssist → fetchAvailableModels 풀 파싱
│   └── antigravity-auth.js  Google OAuth (Auth Code + PKCE, 루프백 코드 캡처)
├── popup/               사용량 카드 UI
└── options/             설정 + Antigravity 계정 연결
```

자세한 내부 동작은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)를 참고하세요.

새 서비스를 추가하려면 `providers/`에 어댑터 파일 하나를 만들고 `index.js`에 등록하면 됩니다. 어댑터 계약: `fetchUsage() → { plan, windows: [{ id, label, usedPct, resetAt }] }`.
