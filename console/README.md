# 콘텐츠 제작 파이프라인 콘솔 (로컬 CLI 실행형)

브라우저 콘솔 + 로컬 브리지로 구성된 경량 도구. **LLM 호출은 로컬 PC의 LLM CLI(`codex`/`claude`/`agy`)를 터미널에서 실행해 처리**한다. API 키를 브라우저·브리지에 저장하지 않고, 각 CLI의 자체 로그인을 사용한다. (`agy` = Google Antigravity 에이전트 CLI, Gemini 모델)

> 범위: 기본은 **이미지·영상 제작용 스크립트**를 생성한다. 추가로 **카드뉴스·피드·스토리는 `codex`/`agy` 로 실제 이미지**를, **릴스는 영상 엔진(Higgsfield)을 `codex`/`claude` CLI→MCP 로 호출해 실제 영상까지** 만들어 작업폴더 `output/` 에 저장한다.

## 구성

- `content-maker.html` — 6단계 콘솔 UI. 단계별 실행 · 전송 프롬프트 확인 · 요청/결과 확인 · 결과 편집 · 단계 간 carry-forward.
- `bridge.mjs` — 로컬 브리지(Node 내장 모듈만, 의존성 0). HTML 서빙 + CLI 실행.

## 왜 브리지가 필요한가

브라우저는 보안 샌드박스 때문에 로컬 프로세스(터미널 CLI)를 직접 실행할 수 없다. 그래서 작은 로컬 브리지가 중계한다:

```
브라우저(content-maker.html)
   │  POST /run { provider, model, prompt }
   ▼
bridge.mjs (127.0.0.1)
   │  spawn: codex/claude/agy  (프롬프트는 argv, stdin 무시 — agy 모델 지정 시만 stdin)
   ▼
LLM CLI → stdout(최종 답변) → 브리지 → 브라우저
```

브리지가 HTML도 함께 서빙하므로 same-origin이 되어 CORS·`file://` 문제가 없다.

## 사전 준비

- Node 18+
- 사용할 LLM CLI 중 **하나 이상** 설치·로그인: `codex` / `claude` / `agy`

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
| agy    | 모델 없음: `agy -p "<프롬프트>"` · 모델 지정: `echo "<프롬프트>" \| agy -p --model=<flash\|pro\|flash_lite>` (프롬프트를 stdin 으로 전달) |

- **codex**: `--skip-git-repo-check` 는 임시 디렉터리(비-깃 저장소)에서 실행하므로 필수다. codex 자체 기본 샌드박스(`sandbox: read-only`, `approval: never`)는 유지된다.
- **claude 권한(기본 OFF, 옵트인)**: `claude -p` 는 기본적으로 승인 게이트를 유지한다. 만약 신뢰/권한 프롬프트로 비대화형에서 멈춘다면, 위험을 이해한 상태에서 권한 우회를 켤 수 있다 — `BRIDGE_CLAUDE_SKIP_PERMS=1 node bridge.mjs`. (승인 게이트를 끄고 임의 프롬프트를 자율 실행하므로 신중히.)

- 프롬프트는 기본적으로 **명령 인자(argv) 마지막 요소**로 전달되고 **stdin 은 무시**한다 → 쉘 미사용(명령 주입 불가) + Codex 의 non-TTY 파이프 무한대기 회피. (예외: `agy` 는 `--model` 지정 시 프롬프트를 stdin 으로 받으므로 그때만 stdin 사용.)
- **모델 최신화**: 콘솔 고급 설정의 **[🔄 모델 최신화]** 버튼 → 브리지 `GET /models`. codex 는 `~/.codex/models_cache.json`(codex 가 서버에서 받아 캐시), agy 는 `agy --help` 의 티어, claude 는 기본 세트에서 목록을 가져온다.
- CLI 플래그가 환경과 다르면 `bridge.mjs` 의 `PROVIDERS` 한 곳만 고치면 된다.
- CLI 는 임시 디렉터리(`os.tmpdir()`)에서 실행되어 이 저장소 파일을 읽지 않는다.

## 영상 제작 단계 (릴스 전용)

콘텐츠 종류가 **릴스**면 마지막에 **🎬 영상 제작** 카드가 나타난다. 이미지 프롬프트 단계(스틸)와 영상 프롬프트 단계(모션)에서 **컷**을 자동 추출하고(각 컷 `IMAGE:`/`MOTION:`), 컷마다 다음을 수행한다:

```
콘솔 → POST /video { provider, engine, videoModel, aspect, imagePrompt, motionPrompt, runId, idx }
   ▼
bridge.mjs → 선택한 CLI(codex/claude)에 자연어 지시문 전달
   ▼
CLI → 자기 MCP 영상 엔진(Higgsfield) 자율 호출:
   ① generate_image (스틸 등록·9:16)  → 이미지 job_id
   ② generate_video (start_image=①, 모션 프롬프트) → 영상 잡
   ③ job_status 폴링 → 최종 mp4 URL
   ▼
CLI 가 마지막 줄에 `RESULT_JSON: {...}` 출력 → 브리지가 mp4 를 내려받아 output/<runId>/<idx>.mp4 저장
```

- **엔진 셀렉트박스**: 현재 **Higgsfield** 만 활성(다른 엔진은 placeholder — 추후 추가). 각 CLI 에 해당 MCP 서버가 설정돼 있어야 한다(예: codex `~/.codex/config.toml` 의 `[mcp_servers.higgsfield]`).
- **LLM 셀렉트박스**: **`claude`(권장·기본) / `codex`**. **agy 는 MCP 영상 엔진 미연동이라 제외**한다.
  - **claude**: 브리지가 `/video` 호출 시 `--allowedTools=`(= 형 단일 토큰)로 **필요한 higgsfield 도구만 열거**(generate_image·generate_video·job_status·job_display·show_generations·reveal_generation·models_explore)해 붙여 **dangerous 플래그 없이** 자율 허용한다. (로컬 파일 업로드 도구는 이 흐름에 불필요하므로 제외.) 긴 생성 호출을 끝까지 완주하고, 서버 오류(플랜·크레딧 등)도 **원문 그대로** 표출한다. (실측: image→video→mp4 저장까지 성공.)
  - **codex**: read-only MCP(models_explore 등)는 되지만, **생성처럼 오래 걸리는 호출을 codex 의 MCP 클라이언트가 ~13초 후 스스로 취소**(`user cancelled MCP tool call`)해 실패하는 경우가 있다. 이때 콘솔엔 "image generation cancelled" 로 떠 원인이 모호하니 **claude 로 전환**할 것.
- **영상 모델 셀렉트박스**: 엔진별 모델(Higgsfield: `seedance_2_0` 등 9:16·start_image 지원 모델).
- 1컷당 **실제 호출**(이미지+영상 렌더 · 컷당 수 분·크레딧 발생). 컷당 대기는 `VIDEO_TIMEOUT_MS`(기본 600000ms).

## 옵션 (환경변수)

```bash
PORT=9000 node bridge.mjs            # 포트 변경(기본 8787)
TIMEOUT_MS=600000 node bridge.mjs    # CLI 1회 실행 최대 대기(기본 240000ms)
IMAGE_TIMEOUT_MS=180000 node bridge.mjs   # 이미지 1장 생성 최대 대기
VIDEO_TIMEOUT_MS=600000 node bridge.mjs   # 영상 1컷 제작 최대 대기(이미지+영상 렌더+폴링)
```

## 보안

- 브리지는 `127.0.0.1` 에만 바인딩되어 외부 네트워크에 노출되지 않는다.
- 브리지는 로컬에서 LLM CLI를 실행하므로, **콘솔을 쓸 때만 켜두고 끝나면 `Ctrl+C` 로 종료**한다.
- API 키는 저장/전송하지 않는다(각 CLI 자체 로그인 사용).
