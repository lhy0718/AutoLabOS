#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

ROOT_DIR="$SMOKE_ROOT_DIR"
RUN_ID="$(smoke_run_id)"

smoke_set_fake_codex_single_command \
  "$RUN_ID" \
  "최근 5년 필터와 관련도 정렬로 100편 수집을 제안합니다." \
  "/agent collect --last-years 5 --sort relevance --limit 100 --run $RUN_ID"

smoke_run_expect "natural_collect_pending_command.exp" "$RUN_ID"
