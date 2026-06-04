#!/usr/bin/env bash
# Cloudflare Pages 배포 — content-orchestrator.html(+SERVER_API_BASE 주입) + functions/auth 프록시.
# 사용: bash console/infra/deploy-pages.sh [FunctionUrl]
#   FunctionUrl 미지정 시 아래 기본값(배포된 Lambda) 사용.
set -euo pipefail
cd "$(dirname "$0")/.."   # console/

FNURL="${1:-https://g4dwkhm7ue7x26ivz4bqgy7biy0kwhxh.lambda-url.ap-northeast-2.on.aws}"

rm -rf dist && mkdir -p dist
# content-orchestrator.html → dist/index.html (서버 모드 백엔드 = Lambda Function URL 주입)
sed "s|var SERVER_API_BASE = \"\";|var SERVER_API_BASE = \"${FNURL}\";|" content-orchestrator.html > dist/index.html
cp -r functions dist/functions
echo "› SERVER_API_BASE=${FNURL} 주입, functions/auth 포함"

# --commit-message 는 ASCII 로 명시(HEAD 한글 커밋 메시지 인코딩 이슈 회피).
wrangler pages deploy dist --project-name=content-maker --branch=main --commit-dirty=true --commit-message="content-maker deploy"
