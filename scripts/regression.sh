#!/usr/bin/env bash
# 第三轮回归测试：依次执行全部检查，并把真实输出写入 docs/testing/results/<名称>-r3-regression.txt
# Round-3 regression: run every check and save the real output to docs/testing/results/<name>-r3-regression.txt
# 用法 / usage: scripts/regression.sh <name>
set -uo pipefail
name="${1:?usage: scripts/regression.sh <name>}"
cd "$(dirname "$0")/.."
out="docs/testing/results/${name}-r3-regression.txt"
mkdir -p "$(dirname "$out")"
: > "$out"
status=0

run() {
  local label="$1"; shift
  echo "===== [$label] $* =====" | tee -a "$out"
  local start=$(date +%s)
  "$@" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -vE '^\s*(<launching>|\[pid=)' >> "$out"
  local code=${PIPESTATUS[0]}
  echo "===== [$label] exit=$code duration=$(( $(date +%s) - start ))s =====" | tee -a "$out"
  echo >> "$out"
  [ "$code" -eq 0 ] || status=1
}

echo "# Round 3 regression: $name — $(date -u +%Y-%m-%dT%H:%M:%SZ) — commit $(git rev-parse --short HEAD)" >> "$out"
run lint npm run lint
run typecheck npm run typecheck
run unit-integration npx vitest run --reporter=verbose
run build-pages env BUILD_TARGET=pages NEXT_PUBLIC_STATIC_PREVIEW=1 npx next build
run build npm run build
run e2e npx playwright test
echo "RESULT: $([ $status -eq 0 ] && echo PASS || echo FAIL)" | tee -a "$out"
exit $status
