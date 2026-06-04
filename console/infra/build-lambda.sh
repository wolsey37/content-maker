#!/usr/bin/env bash
# Lambda 배포 zip 빌드 — console/ 의 서버 코드 + node_modules(@aws-sdk 번들) 를 lambda.zip 으로.
# 사용: bash console/infra/build-lambda.sh  → console/lambda.zip 생성
set -euo pipefail

cd "$(dirname "$0")/.."   # console/

echo "› 의존성 설치(@aws-sdk 포함)…"
npm install --silent

echo "› lambda.zip 패키징…"
rm -f lambda.zip
# 런타임에 필요한 것만: 진입점/코어/백엔드/스토리지/유틸 + package.json + node_modules.
# 제외: HTML·bridge(로컬 전용)·infra·output.
zip -rq lambda.zip \
  lambda.mjs server-core.mjs util.mjs \
  backends storage package.json \
  node_modules \
  -x "node_modules/.bin/*" "node_modules/.package-lock.json"

echo "✓ console/lambda.zip ($(du -h lambda.zip | cut -f1)) 생성 완료"
echo "  → CFN CodeS3Bucket/CodeS3Key 로 업로드 후 'aws cloudformation deploy' 에 사용"
