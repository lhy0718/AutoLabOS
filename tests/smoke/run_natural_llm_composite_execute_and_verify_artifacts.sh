#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

ROOT_DIR="$SMOKE_ROOT_DIR"
RUN_ID="$(smoke_run_id)"
RUN_DIR="$(smoke_run_dir "$RUN_ID")"

smoke_reset_collect_artifacts "$RUN_DIR"
smoke_set_fake_codex_multi_step_plan \
  "$RUN_ID" \
  "I'll clear the current paper set and then recollect open-access results from the last five years by relevance." \
  "/agent clear collect_papers $RUN_ID" \
  "/agent collect --last-years 5 --sort relevance --open-access --run $RUN_ID"
smoke_set_fake_semantic_scholar_fixture "llm-composite" "LLM Composite Paper"

smoke_run_expect "natural_llm_composite_execute_and_verify_artifacts.exp" "$RUN_ID"
smoke_verify_collect_artifacts "$RUN_DIR" "$(smoke_bib_key_for_prefix "llm-composite")" "3" "true" "" "llm composite"
