import { GRAPH_NODE_ORDER, GraphNodeId, RunRecord } from "../../types.js";

export interface NaturalAssistantContext {
  input: string;
  runs: RunRecord[];
  activeRunId?: string;
}

export interface NaturalAssistantResponse {
  lines: string[];
  targetRunId?: string;
  pendingCommand?: string;
}

type InputLanguage = "en" | "ko";

const STRUCTURE_KEYWORDS = [
  "structure",
  "architecture",
  "pipeline",
  "workflow",
  "state graph",
  "flow",
  "구조",
  "아키텍처",
  "파이프라인",
  "워크플로",
  "상태 그래프",
  "흐름"
];

const NEXT_KEYWORDS = [
  "next",
  "what next",
  "recommend",
  "suggest",
  "how",
  "how do i",
  "what should i do",
  "해야",
  "다음",
  "추천",
  "어떻게",
  "뭐해",
  "무엇",
  "뭘",
  "진행"
];

const STATUS_KEYWORDS = [
  "status",
  "progress",
  "state",
  "paused",
  "stuck",
  "blocked",
  "halted",
  "상태",
  "진행",
  "현황",
  "멈",
  "중단",
  "막혔",
  "어디까지"
];

const EXECUTE_INTENT_KEYWORDS = [
  "run",
  "execute",
  "start",
  "go ahead",
  "do it",
  "retry",
  "approve",
  "실행",
  "시작",
  "진행해",
  "진행해줘",
  "해줘",
  "해주세요",
  "돌려",
  "재시도",
  "승인"
];

export function buildNaturalAssistantResponse(ctx: NaturalAssistantContext): NaturalAssistantResponse {
  const text = ctx.input.trim();
  const lower = text.toLowerCase();
  const language = detectInputLanguage(text);
  const wantsStructure = includesAny(lower, STRUCTURE_KEYWORDS);
  const wantsNext = includesAny(lower, NEXT_KEYWORDS);
  const wantsStatus = includesAny(lower, STATUS_KEYWORDS);
  const wantsExecution = includesAny(lower, EXECUTE_INTENT_KEYWORDS);

  const targetRun = resolveTargetRun(ctx.runs, ctx.activeRunId, lower);

  const lines: string[] = [];
  if (wantsStructure) {
    lines.push(
      localize(
        language,
        "Workflow: collect_papers -> analyze_papers -> generate_hypotheses -> design_experiments -> implement_experiments -> run_experiments -> analyze_results -> write_paper",
        "워크플로: collect_papers -> analyze_papers -> generate_hypotheses -> design_experiments -> implement_experiments -> run_experiments -> analyze_results -> write_paper"
      )
    );
  }

  if (!targetRun) {
    lines.push(localize(language, "No run is active yet.", "활성 run이 없습니다."));
    lines.push(localize(language, "Next step: /new", "다음 단계: /new"));
    lines.push(localize(language, "Optional check: /doctor", "선택 점검: /doctor"));
    return { lines, pendingCommand: wantsExecution ? "/new" : undefined };
  }

  const nodeState = targetRun.graph.nodeStates[targetRun.currentNode];
  const doneCount = GRAPH_NODE_ORDER.filter((node) => {
    const status = targetRun.graph.nodeStates[node].status;
    return status === "completed" || status === "skipped";
  }).length;

  if (wantsStatus || wantsNext || wantsExecution) {
    lines.push(localize(language, `Run: ${targetRun.id} | ${targetRun.title}`, `런: ${targetRun.id} | ${targetRun.title}`));
    lines.push(
      localize(
        language,
        `Status: ${targetRun.status} | Node: ${targetRun.currentNode} (${nodeState.status}) | Progress: ${doneCount}/${GRAPH_NODE_ORDER.length}`,
        `상태: ${targetRun.status} | 노드: ${targetRun.currentNode} (${nodeState.status}) | 진행률: ${doneCount}/${GRAPH_NODE_ORDER.length}`
      )
    );

    const recommendation = buildNextStepRecommendation(targetRun, nodeState.status, language);
    lines.push(...recommendation.lines);
    return {
      lines,
      targetRunId: targetRun.id,
      pendingCommand: wantsExecution ? recommendation.primaryCommand : undefined
    };
  }

  lines.push(
    localize(
      language,
      "I can answer run status, next step, and result counts. Ask for details like: 'How many papers were collected?'",
      "run 상태, 다음 단계, 결과 개수 질문에 답할 수 있습니다. 예: '논문 몇 개 수집됐어?'"
    )
  );
  return {
    lines,
    targetRunId: targetRun.id
  };
}

interface NextStepRecommendation {
  lines: string[];
  primaryCommand?: string;
}

function buildNextStepRecommendation(
  run: RunRecord,
  nodeStatus: RunRecord["graph"]["nodeStates"][GraphNodeId]["status"],
  language: InputLanguage
): NextStepRecommendation {
  if (run.status === "completed") {
    return {
      lines: [
        localize(language, "Run is already completed.", "run이 이미 완료되었습니다."),
        localize(language, "Next step: /new", "다음 단계: /new")
      ],
      primaryCommand: "/new"
    };
  }

  if (run.status === "failed_budget") {
    const command = `/agent budget ${run.id}`;
    return {
      lines: [
        localize(language, `Budget exceeded at ${run.currentNode}.`, `예산이 ${run.currentNode} 단계에서 초과되었습니다.`),
        localize(language, `Next step: ${command}`, `다음 단계: ${command}`),
        localize(
          language,
          `Then retry: /agent retry ${run.currentNode} ${run.id}`,
          `그 다음 재시도: /agent retry ${run.currentNode} ${run.id}`
        )
      ],
      primaryCommand: command
    };
  }

  if (run.status === "failed" || nodeStatus === "failed") {
    const command = `/agent retry ${run.currentNode} ${run.id}`;
    return {
      lines: [localize(language, `Next step: ${command}`, `다음 단계: ${command}`)],
      primaryCommand: command
    };
  }

  if (run.status === "paused" && nodeStatus === "needs_approval") {
    return {
      lines: [localize(language, "Next step: /approve", "다음 단계: /approve")],
      primaryCommand: "/approve"
    };
  }

  if (run.status === "running" || run.status === "pending" || nodeStatus === "pending" || nodeStatus === "running") {
    const command = `/agent run ${run.currentNode} ${run.id}`;
    return {
      lines: [localize(language, `Next step: ${command}`, `다음 단계: ${command}`)],
      primaryCommand: command
    };
  }

  const command = `/agent run ${run.currentNode} ${run.id}`;
  return {
    lines: [
      localize(language, "You can inspect graph status with /agent graph", "/agent graph 로 그래프 상태를 확인할 수 있습니다."),
      localize(language, `Suggested execution: ${command}`, `권장 실행: ${command}`)
    ],
    primaryCommand: command
  };
}

function resolveTargetRun(runs: RunRecord[], activeRunId: string | undefined, lowerInput: string): RunRecord | undefined {
  for (const run of runs) {
    if (lowerInput.includes(run.id.toLowerCase()) || lowerInput.includes(run.title.toLowerCase())) {
      return run;
    }
  }

  if (activeRunId) {
    const active = runs.find((run) => run.id === activeRunId);
    if (active) {
      return active;
    }
  }

  return runs[0];
}

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function detectInputLanguage(input: string): InputLanguage {
  return /[\p{Script=Hangul}]/u.test(input) ? "ko" : "en";
}

function localize(language: InputLanguage, english: string, korean: string): string {
  return language === "ko" ? korean : english;
}
