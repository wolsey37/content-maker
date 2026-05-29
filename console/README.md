# 콘텐츠 제작 파이프라인 콘솔 (로컬 CLI 실행형)

브라우저 콘솔 + 로컬 브리지로 구성된 경량 도구. **LLM 호출은 로컬 PC의 LLM CLI(`codex`/`claude`/`gemini`)를 터미널에서 실행해 처리**한다. API 키를 브라우저·브리지에 저장하지 않고, 각 CLI의 자체 로그인을 사용한다.

> 범위: **이미지·영상 제작용 "스크립트"까지만** 생성한다. 실제 영상 생성(Hailuo/Kling/Premiere 등)은 범위 밖이며 별도 툴에서 진행한다.

## 구성

- `content-orchestrator.html` — 6단계 콘솔 UI. 단계별 실행 · 전송 프롬프트 확인 · 요청/결과 확인 · 결과 편집 · 단계 간 carry-forward.
- `bridge.mjs` — 로컬 브리지(Node 내장 모듈만, 의존성 0). HTML 서빙 + CLI 실행.

## 왜 브리지가 필요한가

브라우저는 보안 샌드박스 때문에 로컬 프로세스(터미널 CLI)를 직접 실행할 수 없다. 그래서 작은 로컬 브리지가 중계한다:

```
브라우저(content-orchestrator.html)
   │  POST /run { provider, model, prompt }
   ▼
bridge.mjs (127.0.0.1)
   │  spawn: codex/claude/gemini  (프롬프트는 argv, stdin 무시)
   ▼
LLM CLI → stdout(최종 답변) → 브리지 → 브라우저
```

브리지가 HTML도 함께 서빙하므로 same-origin이 되어 CORS·`file://` 문제가 없다.

## 사전 준비

- Node 18+
- 사용할 LLM CLI 중 **하나 이상** 설치·로그인: `codex` / `claude` / `gemini`

## 실행

```bash
cd console
node bridge.mjs
```

1. 터미널에 뜬 주소 `http://127.0.0.1:8787` 를 브라우저로 연다.
2. 상단 **[연결 확인]** 으로 브리지 연결과 감지된 CLI(✓/✗)를 점검한다.
3. **LLM 선택 → 기본 모델명 확인 → 전역 입력(주제·룰팩·플랫폼)** 입력.
4. 각 단계 카드의 **[실행]** 을 순서대로. 이전 단계 결과가 다음 단계 프롬프트에 자동 반영된다.
5. 끝나면 **[Markdown 내보내기]** 로 스크립트 묶음을 저장한다.

## CLI 명령 매핑 (`bridge.mjs` 의 `PROVIDERS`)

| provider | 실행 명령 |
|---|---|
| codex  | `codex exec --skip-git-repo-check [--model M] "<프롬프트>"` |
| claude | `claude -p [--dangerously-skip-permissions(옵트인)] [--model M] "<프롬프트>"` |
| gemini | `gemini [-m M] -p "<프롬프트>"` |

- **codex**: `--skip-git-repo-check` 는 임시 디렉터리(비-깃 저장소)에서 실행하므로 필수다. codex 자체 기본 샌드박스(`sandbox: read-only`, `approval: never`)는 유지된다.
- **claude 권한(기본 OFF, 옵트인)**: `claude -p` 는 기본적으로 승인 게이트를 유지한다. 만약 신뢰/권한 프롬프트로 비대화형에서 멈춘다면, 위험을 이해한 상태에서 권한 우회를 켤 수 있다 — `BRIDGE_CLAUDE_SKIP_PERMS=1 node bridge.mjs`. (승인 게이트를 끄고 임의 프롬프트를 자율 실행하므로 신중히.)

- 프롬프트는 **명령 인자(argv) 마지막 요소**로 전달되고 **stdin 은 무시**한다 → 쉘 미사용(명령 주입 불가) + Codex 의 non-TTY 파이프 무한대기 회피.
- CLI 플래그가 환경과 다르면 `bridge.mjs` 의 `PROVIDERS` 한 곳만 고치면 된다.
- CLI 는 임시 디렉터리(`os.tmpdir()`)에서 실행되어 이 저장소 파일을 읽지 않는다.

## 옵션 (환경변수)

```bash
PORT=9000 node bridge.mjs          # 포트 변경(기본 8787)
TIMEOUT_MS=600000 node bridge.mjs  # CLI 1회 실행 최대 대기(기본 240000ms)
```

## 보안

- 브리지는 `127.0.0.1` 에만 바인딩되어 외부 네트워크에 노출되지 않는다.
- 브리지는 로컬에서 LLM CLI를 실행하므로, **콘솔을 쓸 때만 켜두고 끝나면 `Ctrl+C` 로 종료**한다.
- API 키는 저장/전송하지 않는다(각 CLI 자체 로그인 사용).
