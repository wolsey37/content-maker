# content-maker

SNS 콘텐츠 제작 파이프라인 — 로컬에 설치된 LLM CLI(**Codex / Claude / Gemini**)를 브라우저 콘솔에서 단계별로 오케스트레이션해 **기획 → 대본 → 이미지·영상 제작용 스크립트**까지 한 번에 생성합니다.

> 본 콘솔은 이미지·영상 제작용 **"스크립트(프롬프트·스토리보드)"까지** 만듭니다. 실제 영상 생성(Hailuo / Kling / Premiere 등)은 별도 툴에서 진행합니다.

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

기본 **간단 모드**에서 주제를 입력하고 **✨ 콘텐츠 만들기**를 누르면, 진행 상황을 보며 대본·이미지 프롬프트·영상 프롬프트가 차례로 완성됩니다. 각 결과는 복사 버튼으로 바로 사용하거나 **결과 저장(.md)** 할 수 있습니다.

자세한 내용·CLI 매핑·보안은 [`console/README.md`](console/README.md)를 참고하세요.

## 특징

- **로컬 CLI 실행** — API 키를 어디에도 저장하지 않고 각 CLI의 자체 로그인을 사용. 브리지는 `127.0.0.1`에만 바인딩.
- **간단 모드 / 고급 모드** — 일반 사용자는 입력 한 칸 + 버튼 하나. 고급 모드에서 단계별 LLM 선택, 프롬프트 템플릿 편집, 모델 지정 등 노출.
- **도메인 룰팩** — 규제·점수 기준을 바꿔 끼워 화장품 → 식품·패션 등 다른 분야로 전환.
- 다크 모드, 결과 carry-forward, 단계별 진행 표시.

## 요구사항

- Node 18+
- 사용할 LLM CLI 중 하나 이상 설치·로그인: `codex` / `claude` / `gemini`

---
🤖 Generated with [Claude Code](https://claude.com/claude-code)
