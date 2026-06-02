# content-maker

SNS 콘텐츠 제작 파이프라인 — 로컬에 설치된 LLM CLI(**Codex / Claude / Antigravity(agy)**)를 브라우저 콘솔에서 단계별로 오케스트레이션해 **기획 → 대본 → 이미지·영상 제작용 스크립트**까지 한 번에 생성합니다.

> 기본은 이미지·영상 제작용 **"스크립트(프롬프트·스토리보드)"** 를 만듭니다. 추가로 **카드뉴스·피드·스토리는 `codex`/`agy` 로 실제 이미지**를, **릴스는 영상 엔진(Higgsfield)을 `claude`/`codex` CLI→MCP 로 호출해 실제 영상까지** 만들어 작업폴더 `output/` 에 저장합니다.

## 구성

```
console/
  content-orchestrator.html   # 단일 HTML 콘솔 (간단/고급 모드, 다크 모드)
  bridge.mjs                  # 로컬 브리지 (Node 내장 모듈만, 의존성 0)
  README.md                   # 콘솔 상세 사용법
docs/
  sns-content-orchestration-workflow.md   # 범용 SNS 콘텐츠 제작 워크플로우 제안
  orchestration-management-console.md      # 운영 콘솔(제어 계약) 설계
  pipeline-design.md / mirra-local-workflow-proposal.md
```

## 빠른 시작

```bash
cd console
node bridge.mjs
# 터미널에 표시된 주소(http://127.0.0.1:8787)를 브라우저로 열기
```

기본 **간단 모드**에서 콘텐츠 종류를 고르고 주제를 입력한 뒤 **✨ 콘텐츠 만들기**를 누르면 **한 단계씩** 진행됩니다. 각 단계 결과를 확인·편집한 뒤 버튼이 **▶ 다음 단계**로 바뀌고, 마지막에 대본·이미지 프롬프트·영상 프롬프트가 완성됩니다. 멈추지 않고 한 번에 끝내려면 **⏩ 전체 자동**을 누르세요. 각 결과는 복사 버튼으로 바로 사용하거나 **결과 저장(.md)** 할 수 있습니다.

자세한 내용·CLI 매핑·보안은 [`console/README.md`](console/README.md)를 참고하세요.

## 특징

- **로컬 CLI 실행** — API 키를 어디에도 저장하지 않고 각 CLI의 자체 로그인을 사용. 브리지는 `127.0.0.1`에만 바인딩.
- **간단 모드 / 고급 모드** — 일반 사용자는 입력 한 칸 + 버튼 하나. 고급 모드에서 단계별 LLM 선택, 프롬프트 템플릿 편집, 모델 지정 등 노출.
- **도메인 룰팩** — 규제·점수 기준을 바꿔 끼워 화장품 → 식품·패션 등 다른 분야로 전환.
- 다크 모드, 결과 carry-forward, 단계별 진행 표시.

## 요구사항

- Node 18+
- 사용할 LLM CLI 중 하나 이상 설치·로그인: `codex` / `claude` / `agy`(Google Antigravity, Gemini 모델)

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
