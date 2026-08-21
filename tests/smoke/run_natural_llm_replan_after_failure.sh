#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

ROOT_DIR="$SMOKE_ROOT_DIR"
RUN_ID="$(smoke_run_id)"
RUN_DIR="$(smoke_run_dir "$RUN_ID")"

smoke_reset_collect_artifacts "$RUN_DIR"
smoke_set_fake_codex_two_turn_replan \
  "$RUN_ID" \
  "I'll clear the current paper set and then recollect it." \
  "/agent clear collect_papers $RUN_ID" \
  "/agent collect --limit nope --run $RUN_ID" \
  "The previous collect step failed. I can retry with a corrected collect command." \
  "/agent collect --limit 20 --run $RUN_ID"
smoke_set_fake_semantic_scholar_fixture "llm-replan" "LLM Replan Paper"

smoke_run_expect "natural_llm_replan_after_failure.exp" "$RUN_ID"
smoke_verify_collect_artifacts "$RUN_DIR" "$(smoke_bib_key_for_prefix "llm-replan")" "3" "" "20" "llm replan"
