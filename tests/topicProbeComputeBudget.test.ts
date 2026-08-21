import path from "node:path";
import { tmpdir } from "node:os";
import {
  mkdtemp,
  readFile,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  appendTopicProbeComputeActualUsage,
  appendTopicProbeComputePreflight,
  appendTopicProbeComputeUnverifiableUsage,
  buildTopicProbeComputeBudgetContract,
  parseTopicProbeComputeBudgetCeilingFromBrief,
  parseTopicProbeComputeBudgetDeclaration,
  parseTopicProbeComputeUsageEvidence,
  sha256Utf8,
  validateTopicProbeComputeBudgetContract,
  validateTopicProbeComputeUsageLedger,
  topicProbeComputeBudgetFitsWithin,
  type TopicProbeComputeBudgetLimits
} from "../src/core/topicProbeComputeBudget.js";
import { hashCanonical } from "../src/core/canonicalHash.js";

function limits(): TopicProbeComputeBudgetLimits {
  return {
    bounded_probe: {
      max_gpu_hours: 3,
      max_concurrent_gpus: 2,
      max_trials: 8
    },
    confirmatory: {
      max_gpu_hours: 13,
      max_concurrent_gpus: 2,
      max_trials: 24
    }
  };
}

function declaration(value: TopicProbeComputeBudgetLimits = limits()): string {
  return JSON.stringify(value);
}

function contract(value: TopicProbeComputeBudgetLimits = limits()) {
  return buildTopicProbeComputeBudgetContract({
    runId: "run_compute_fixture",
    stage: "bounded_probe",
    activeTopicProbeContractSha256: "a".repeat(64),
    localBudget: declaration(value),
    briefComputeBudgetCeiling: limits(),
    limits: value,
    generatedAt: "2026-01-01T00:00:00.000Z"
  });
}

function rehashLedgerEntry(
  entry: Record<string, unknown>
): Record<string, unknown> {
  const { content_sha256: _contentSha256, ...payload } = entry;
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

describe("topicProbeComputeBudget", () => {
  it("parses a machine-readable brief ceiling and rejects oversized candidates", () => {
    const ceiling = parseTopicProbeComputeBudgetCeilingFromBrief([
      "# Research Brief",
      "",
      "## Constraints",
      "",
      `- Machine-readable compute ceiling: \`${declaration()}\``
    ].join("\n"));
    expect(topicProbeComputeBudgetFitsWithin(limits(), ceiling)).toBe(true);
    expect(topicProbeComputeBudgetFitsWithin({
      ...limits(),
      bounded_probe: {
        ...limits().bounded_probe,
        max_trials: limits().bounded_probe.max_trials + 1
      }
    }, ceiling)).toBe(false);
  });

  it("fails closed when a brief omits the machine-readable ceiling", () => {
    expect(() => parseTopicProbeComputeBudgetCeilingFromBrief(
      "# Research Brief\n\n## Constraints\n\n- Keep execution bounded."
    )).toThrow("topic_probe_compute_budget_brief_ceiling_missing");
  });

  it("parses stage-bound natural-language ceilings without borrowing values across stages", () => {
    const parsed = parseTopicProbeComputeBudgetDeclaration(
      [
        "Keep the bounded probe within 3.5 aggregate GPU-hours on at most two local GPUs.",
        "Keep the confirmatory study within 11 GPU-hours on at most three local GPUs.",
        "The bounded probe allows at most 7 trials; the confirmatory stage allows at most 19 trials."
      ].join(" ")
    );

    expect(parsed).toEqual({
      bounded_probe: {
        max_gpu_hours: 3.5,
        max_concurrent_gpus: 2,
        max_trials: 7
      },
      confirmatory: {
        max_gpu_hours: 11,
        max_concurrent_gpus: 3,
        max_trials: 19
      }
    });
  });

  it.each([
    [
      "missing confirmatory ceiling",
      "The bounded probe is limited to 4 GPU-hours on at most one GPU and allows at most 4 trials.",
      "topic_probe_compute_budget_confirmatory_max_gpu_hours_missing"
    ],
    [
      "missing GPU concurrency",
      "The bounded probe is limited to 4 GPU-hours and at most 4 trials. The confirmatory study is limited to 10 GPU-hours and at most 10 trials.",
      "topic_probe_compute_budget_bounded_probe_max_concurrent_gpus_missing"
    ],
    [
      "unbound GPU-hour value",
      "Use 4 GPU-hours and at most one GPU.",
      "topic_probe_compute_budget_gpu_hours_stage_ambiguous"
    ],
    [
      "conflicting bounded ceilings",
      [
        "The bounded probe is limited to 4 GPU-hours on at most one GPU and at most 4 trials.",
        "The bounded probe is limited to 5 GPU-hours.",
        "The confirmatory stage is limited to 10 GPU-hours on at most one GPU and at most 10 trials."
      ].join(" "),
      "topic_probe_compute_budget_bounded_probe_max_gpu_hours_conflict"
    ],
    [
      "missing bounded trial cap",
      "The bounded probe is limited to 4 GPU-hours on at most one GPU. The confirmatory stage is limited to 10 GPU-hours on at most two GPUs and at most 10 trials.",
      "topic_probe_compute_budget_bounded_probe_max_trials_missing"
    ],
    [
      "global explicit GPU concurrency",
      "max_concurrent_gpus=2. The bounded probe is limited to 4 GPU-hours and at most 4 trials. The confirmatory stage is limited to 10 GPU-hours and at most 10 trials.",
      "topic_probe_compute_budget_bounded_probe_max_concurrent_gpus_missing"
    ],
    [
      "unbound natural GPU concurrency",
      "Use at most two GPUs. The bounded probe is limited to 4 GPU-hours and at most 4 trials. The confirmatory stage is limited to 10 GPU-hours and at most 10 trials.",
      "topic_probe_compute_budget_max_concurrent_gpus_stage_ambiguous"
    ]
  ])("fails closed for %s", (_label, source, errorCode) => {
    expect(() =>
      parseTopicProbeComputeBudgetDeclaration(source)
    ).toThrow(errorCode);
  });

  it("requires max_trials in both structured stage limits", () => {
    expect(() => parseTopicProbeComputeBudgetDeclaration(JSON.stringify({
      bounded_probe: {
        max_gpu_hours: 3,
        max_concurrent_gpus: 1
      },
      confirmatory: {
        max_gpu_hours: 9,
        max_concurrent_gpus: 2,
        max_trials: 12
      }
    }))).toThrow(
      "topic_probe_compute_budget_declaration_schema_invalid"
    );
  });

  it("requires structured max_trials to be positive", () => {
    expect(() => parseTopicProbeComputeBudgetDeclaration(JSON.stringify({
      ...limits(),
      confirmatory: {
        ...limits().confirmatory,
        max_trials: 0
      }
    }))).toThrow(
      "topic_probe_compute_budget_declaration_schema_invalid"
    );
  });

  it("hash-binds the selected stage limit to the active contract and source declaration", () => {
    const built = contract();
    const valid = validateTopicProbeComputeBudgetContract(built, {
      runId: built.run_id,
      stage: "bounded_probe",
      activeTopicProbeContractSha256:
        built.active_topic_probe_contract_sha256,
      localBudget: declaration()
    });
    const tampered = {
      ...built,
      active_limit: {
        ...built.active_limit,
        max_gpu_hours: built.active_limit.max_gpu_hours + 1
      }
    };

    expect(valid.valid).toBe(true);
    expect(
      validateTopicProbeComputeBudgetContract(tampered).reasons
    ).toEqual(expect.arrayContaining([
      "topic_probe_compute_budget_contract_content_hash_mismatch",
      "topic_probe_compute_budget_contract_active_limit_mismatch"
    ]));
  });

  it("rejects rehashed limit tampering against the expected local budget", () => {
    const built = contract();
    const tamperedLimits = {
      ...built.limits,
      bounded_probe: {
        ...built.limits.bounded_probe,
        max_gpu_hours: built.limits.bounded_probe.max_gpu_hours + 1
      }
    };
    const { content_sha256: _contentSha256, ...tamperedPayload } = {
      ...built,
      limits: tamperedLimits,
      active_limit: tamperedLimits.bounded_probe
    };
    const rehashed = {
      ...tamperedPayload,
      content_sha256: hashCanonical(tamperedPayload)
    };

    expect(validateTopicProbeComputeBudgetContract(rehashed)).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining([
        "topic_probe_compute_budget_contract_exceeds_brief_ceiling"
      ])
    });
    expect(validateTopicProbeComputeBudgetContract(rehashed, {
      localBudget: declaration()
    })).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining([
        "topic_probe_compute_budget_contract_declaration_mismatch"
      ])
    });
  });

  it("rejects a runtime contract whose candidate budget exceeds the brief ceiling", () => {
    const oversized = {
      ...limits(),
      bounded_probe: {
        ...limits().bounded_probe,
        max_trials: limits().bounded_probe.max_trials + 1
      }
    };

    expect(() => buildTopicProbeComputeBudgetContract({
      runId: "run_compute_fixture",
      stage: "bounded_probe",
      activeTopicProbeContractSha256: "a".repeat(64),
      localBudget: declaration(oversized),
      briefComputeBudgetCeiling: limits(),
      limits: oversized
    })).toThrow(
      "topic_probe_compute_budget_contract_exceeds_brief_ceiling"
    );
  });

  it("requires cache hits to report zero GPUs and zero fresh trials", () => {
    expect(parseTopicProbeComputeUsageEvidence({
      compute_usage: {
        schema_version: 1,
        execution_kind: "cache_hit",
        actual_gpu_count: 0,
        fresh_executed_trials: 0,
        cached_trials: 4
      }
    })).toMatchObject({
      execution_kind: "cache_hit",
      actual_gpu_count: 0,
      fresh_executed_trials: 0
    });

    expect(() =>
      parseTopicProbeComputeUsageEvidence({
        compute_usage: {
          schema_version: 1,
          execution_kind: "cache_hit",
          actual_gpu_count: 1,
          fresh_executed_trials: 0,
          cached_trials: 4
        }
      })
    ).toThrow(
      "topic_probe_compute_usage_evidence_execution_kind_mismatch"
    );
  });

  it("blocks preflight when a declared trial cap lacks an execution-specific estimate", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "autolabos-topic-compute-trial-estimate-")
    );
    const result = await appendTopicProbeComputePreflight({
      ledgerPath: path.join(root, "usage.jsonl"),
      contract: contract(),
      profile: "supplemental",
      command: "run configured supplemental profile",
      estimatedWallTimeMs: 1_000,
      estimatedGpuCount: 1
    });

    expect(result.allowed).toBe(false);
    expect(result.entry).toBeUndefined();
    expect(result.reasons).toContain(
      "topic_probe_compute_preflight_trial_estimate_missing"
    );
  });

  it("serializes simultaneous preflight reservations without corrupting the ledger", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "autolabos-topic-compute-concurrent-")
    );
    const ledgerPath = path.join(root, "usage.jsonl");
    const budget = contract();
    const results = await Promise.all([
      appendTopicProbeComputePreflight({
        ledgerPath,
        contract: budget,
        profile: "primary",
        command: "run configured primary profile",
        estimatedWallTimeMs: 60_000,
        estimatedGpuCount: 1,
        estimatedFreshTrials: 1
      }),
      appendTopicProbeComputePreflight({
        ledgerPath,
        contract: budget,
        profile: "candidate_profile",
        command: "run configured candidate profile",
        estimatedWallTimeMs: 60_000,
        estimatedGpuCount: 1,
        estimatedFreshTrials: 1
      })
    ]);

    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
    expect(results.find((result) => !result.allowed)?.reasons).toContain(
      "topic_probe_compute_usage_ledger_pending_attempt_unresolved"
    );

    const raw = await readFile(ledgerPath, "utf8");
    const validated = validateTopicProbeComputeUsageLedger(raw, budget);
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(validated.valid).toBe(true);
    expect(validated.pendingAttempt).toBe(1);
  });

  it("recovers an abandoned stale ledger file lock", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "autolabos-topic-compute-stale-lock-")
    );
    const ledgerPath = path.join(root, "usage.jsonl");
    const lockPath = `${ledgerPath}.lock`;
    await writeFile(
      lockPath,
      `${JSON.stringify({ token: "abandoned_lock" })}\n`,
      "utf8"
    );
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleTime, staleTime);

    const result = await appendTopicProbeComputePreflight({
      ledgerPath,
      contract: contract(),
      profile: "primary",
      command: "run configured primary profile",
      estimatedWallTimeMs: 60_000,
      estimatedGpuCount: 1,
      estimatedFreshTrials: 1
    });

    expect(result.allowed).toBe(true);
    expect(result.validation.valid).toBe(true);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds retries while a fresh ledger file lock remains held", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "autolabos-topic-compute-held-lock-")
    );
    const ledgerPath = path.join(root, "usage.jsonl");
    const lockPath = `${ledgerPath}.lock`;
    await writeFile(
      lockPath,
      `${JSON.stringify({ token: "active_lock" })}\n`,
      "utf8"
    );
    const startedAt = Date.now();

    await expect(appendTopicProbeComputePreflight({
      ledgerPath,
      contract: contract(),
      profile: "primary",
      command: "run configured primary profile",
      estimatedWallTimeMs: 60_000,
      estimatedGpuCount: 1,
      estimatedFreshTrials: 1
    })).rejects.toThrow(
      "topic_probe_compute_usage_ledger_lock_timeout"
    );

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    await expect(readFile(ledgerPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  }, 5_000);

  it("computes GPU-hours from measured wall time and actual GPU count while accumulating retries", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "autolabos-topic-compute-ledger-")
    );
    const ledgerPath = path.join(root, "usage.jsonl");
    const budget = contract();
    const command = "run configured experiment";

    const firstPreflight = await appendTopicProbeComputePreflight({
      ledgerPath,
      contract: budget,
      profile: "primary",
      command,
      estimatedWallTimeMs: 3_600_000,
      estimatedGpuCount: 2,
      estimatedFreshTrials: 2,
      recordedAt: "2026-01-01T00:00:00.000Z"
    });
    expect(firstPreflight.allowed).toBe(true);

    const firstActual = await appendTopicProbeComputeActualUsage({
      ledgerPath,
      contract: budget,
      profile: "primary",
      command,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:30:00.000Z",
      wallTimeMs: 1_800_000,
      evidence: {
        schema_version: 1,
        execution_kind: "gpu_execution",
        actual_gpu_count: 2,
        fresh_executed_trials: 2,
        cached_trials: 0
      },
      usageEvidenceSha256: sha256Utf8("attempt-one"),
      recordedAt: "2026-01-01T00:30:00.000Z"
    });
    expect(firstActual.allowed).toBe(true);
    expect(firstActual.entry.gpu_hours).toBe(1);

    const retryPreflight = await appendTopicProbeComputePreflight({
      ledgerPath,
      contract: budget,
      profile: "primary_retry",
      command,
      estimatedWallTimeMs: 3_600_000,
      estimatedGpuCount: 2,
      estimatedFreshTrials: 3,
      recordedAt: "2026-01-01T00:31:00.000Z"
    });
    expect(retryPreflight.allowed).toBe(true);

    const retryActual = await appendTopicProbeComputeActualUsage({
      ledgerPath,
      contract: budget,
      profile: "primary_retry",
      command,
      startedAt: "2026-01-01T00:31:00.000Z",
      finishedAt: "2026-01-01T01:31:00.000Z",
      wallTimeMs: 3_600_000,
      evidence: {
        schema_version: 1,
        execution_kind: "gpu_execution",
        actual_gpu_count: 2,
        fresh_executed_trials: 3,
        cached_trials: 1
      },
      usageEvidenceSha256: sha256Utf8("attempt-two"),
      recordedAt: "2026-01-01T01:31:00.000Z"
    });
    expect(retryActual.allowed).toBe(true);
    expect(retryActual.entry.cumulative_gpu_hours).toBe(3);
    expect(retryActual.entry.cumulative_fresh_executed_trials).toBe(5);

    const blocked = await appendTopicProbeComputePreflight({
      ledgerPath,
      contract: budget,
      profile: "supplemental",
      command,
      estimatedWallTimeMs: 1,
      estimatedGpuCount: 1,
      estimatedFreshTrials: 1,
      recordedAt: "2026-01-01T01:32:00.000Z"
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons).toContain(
      "topic_probe_compute_preflight_max_gpu_hours_exceeded"
    );

    const raw = await readFile(ledgerPath, "utf8");
    const validated = validateTopicProbeComputeUsageLedger(raw, budget);
    expect(validated.valid).toBe(true);
    expect(validated.blocked).toBe(true);
    expect(validated.cumulativeGpuHours).toBe(3);
    expect(validated.cumulativeFreshExecutedTrials).toBe(5);
  });

  it("fails closed when measured post-execution GPU-hours exceed the ceiling", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "autolabos-topic-compute-actual-overage-")
    );
    const ledgerPath = path.join(root, "usage.jsonl");
    const budget = contract();
    const command = "run configured experiment";
    await appendTopicProbeComputePreflight({
      ledgerPath,
      contract: budget,
      profile: "primary",
      command,
      estimatedWallTimeMs: 1_000,
      estimatedGpuCount: 1,
      estimatedFreshTrials: 1
    });
    const actual = await appendTopicProbeComputeActualUsage({
      ledgerPath,
      contract: budget,
      profile: "primary",
      command,
      startedAt: "2026-01-01T00:00:00.000Z",
      wallTimeMs: 7_200_000,
      evidence: {
        schema_version: 1,
        execution_kind: "gpu_execution",
        actual_gpu_count: 2,
        fresh_executed_trials: 1,
        cached_trials: 0
      },
      usageEvidenceSha256: sha256Utf8("actual-overage")
    });

    expect(actual.allowed).toBe(false);
    expect(actual.reasons).toContain(
      "topic_probe_compute_actual_max_gpu_hours_exceeded"
    );
    expect(actual.entry.cumulative_gpu_hours).toBe(4);
  });

  it("fails closed when actual GPU concurrency exceeds its preflight reservation", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "autolabos-topic-compute-reservation-overage-")
    );
    const ledgerPath = path.join(root, "usage.jsonl");
    const budget = contract();
    const command = "run configured experiment";
    await appendTopicProbeComputePreflight({
      ledgerPath,
      contract: budget,
      profile: "primary",
      command,
      estimatedWallTimeMs: 60_000,
      estimatedGpuCount: 1,
      estimatedFreshTrials: 1
    });

    const actual = await appendTopicProbeComputeActualUsage({
      ledgerPath,
      contract: budget,
      profile: "primary",
      command,
      startedAt: "2026-01-01T00:00:00.000Z",
      wallTimeMs: 60_000,
      evidence: {
        schema_version: 1,
        execution_kind: "gpu_execution",
        actual_gpu_count: 2,
        fresh_executed_trials: 1,
        cached_trials: 0
      },
      usageEvidenceSha256: sha256Utf8("reservation-overage")
    });

    expect(actual.allowed).toBe(false);
    expect(actual.reasons).toContain(
      "topic_probe_compute_actual_gpu_count_exceeds_preflight_reservation"
    );
    expect(actual.entry.within_budget).toBe(false);
  });

  it("does not charge a cache hit as GPU execution or a fresh trial", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "autolabos-topic-compute-cache-")
    );
    const ledgerPath = path.join(root, "usage.jsonl");
    const budget = contract();
    const command = "read configured cache";
    await appendTopicProbeComputePreflight({
      ledgerPath,
      contract: budget,
      profile: "primary",
      command,
      estimatedWallTimeMs: 1,
      estimatedGpuCount: 0,
      estimatedFreshTrials: 0
    });
    const result = await appendTopicProbeComputeActualUsage({
      ledgerPath,
      contract: budget,
      profile: "primary",
      command,
      startedAt: "2026-01-01T00:00:00.000Z",
      wallTimeMs: 900_000,
      evidence: {
        schema_version: 1,
        execution_kind: "cache_hit",
        actual_gpu_count: 0,
        fresh_executed_trials: 0,
        cached_trials: 6
      },
      usageEvidenceSha256: sha256Utf8("cache-evidence")
    });

    expect(result.allowed).toBe(true);
    expect(result.entry.gpu_hours).toBe(0);
    expect(result.entry.cumulative_gpu_hours).toBe(0);
    expect(result.entry.cumulative_fresh_executed_trials).toBe(0);
  });

  it("refuses to append actual usage with a different pending reservation binding", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "autolabos-topic-compute-append-binding-")
    );
    const ledgerPath = path.join(root, "usage.jsonl");
    const budget = contract();
    await appendTopicProbeComputePreflight({
      ledgerPath,
      contract: budget,
      profile: "primary",
      command: "run configured primary profile",
      estimatedWallTimeMs: 60_000,
      estimatedGpuCount: 1,
      estimatedFreshTrials: 1
    });

    await expect(appendTopicProbeComputeActualUsage({
      ledgerPath,
      contract: budget,
      profile: "candidate_profile",
      command: "run configured primary profile",
      startedAt: "2026-01-01T00:00:00.000Z",
      wallTimeMs: 30_000,
      evidence: {
        schema_version: 1,
        execution_kind: "gpu_execution",
        actual_gpu_count: 1,
        fresh_executed_trials: 1,
        cached_trials: 0
      },
      usageEvidenceSha256: sha256Utf8("binding-evidence")
    })).rejects.toThrow(
      "topic_probe_compute_usage_ledger_pending_binding_mismatch"
    );

    const raw = await readFile(ledgerPath, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(validateTopicProbeComputeUsageLedger(raw, budget).valid).toBe(true);
  });

  it("rejects rehashed actual entries with command, profile, or attempt drift", async () => {
    const mutations: Array<[
      string,
      (entry: Record<string, unknown>) => void
    ]> = [
      ["command", (entry) => {
        entry.command_sha256 = sha256Utf8(
          "run alternative configured profile"
        );
      }],
      ["profile", (entry) => {
        entry.profile = "candidate_profile";
      }],
      ["attempt", (entry) => {
        entry.attempt = Number(entry.attempt) + 1;
      }]
    ];

    for (const [field, mutate] of mutations) {
      const root = await mkdtemp(
        path.join(tmpdir(), `autolabos-topic-compute-${field}-binding-`)
      );
      const ledgerPath = path.join(root, "usage.jsonl");
      const budget = contract();
      const command = "run configured primary profile";
      await appendTopicProbeComputePreflight({
        ledgerPath,
        contract: budget,
        profile: "primary",
        command,
        estimatedWallTimeMs: 60_000,
        estimatedGpuCount: 1,
        estimatedFreshTrials: 1
      });
      await appendTopicProbeComputeActualUsage({
        ledgerPath,
        contract: budget,
        profile: "primary",
        command,
        startedAt: "2026-01-01T00:00:00.000Z",
        wallTimeMs: 30_000,
        evidence: {
          schema_version: 1,
          execution_kind: "gpu_execution",
          actual_gpu_count: 1,
          fresh_executed_trials: 1,
          cached_trials: 0
        },
        usageEvidenceSha256: sha256Utf8(`${field}-binding-evidence`)
      });

      const entries = (await readFile(ledgerPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      mutate(entries[1]);
      entries[1] = rehashLedgerEntry(entries[1]);
      const validation = validateTopicProbeComputeUsageLedger(
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        budget
      );

      expect(validation.valid, field).toBe(false);
      expect(validation.reasons, field).toContain(
        "topic_probe_compute_usage_ledger_preflight_binding_mismatch:2"
      );
    }
  });

  it("rejects a rehashed unverifiable entry with command binding drift", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "autolabos-topic-compute-unverifiable-binding-")
    );
    const ledgerPath = path.join(root, "usage.jsonl");
    const budget = contract();
    const command = "run configured primary profile";
    await appendTopicProbeComputePreflight({
      ledgerPath,
      contract: budget,
      profile: "primary",
      command,
      estimatedWallTimeMs: 60_000,
      estimatedGpuCount: 1,
      estimatedFreshTrials: 1
    });
    await appendTopicProbeComputeUnverifiableUsage({
      ledgerPath,
      contract: budget,
      profile: "primary",
      command,
      startedAt: "2026-01-01T00:00:00.000Z",
      wallTimeMs: 30_000,
      reasonCodes: ["topic_probe_compute_usage_evidence_missing"]
    });

    const entries = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    entries[1].command_sha256 = sha256Utf8(
      "run alternative configured profile"
    );
    entries[1] = rehashLedgerEntry(entries[1]);
    const validation = validateTopicProbeComputeUsageLedger(
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      budget
    );

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain(
      "topic_probe_compute_usage_ledger_preflight_binding_mismatch:2"
    );
  });

  it("detects an edited ledger line even when later entries are untouched", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "autolabos-topic-compute-tamper-")
    );
    const ledgerPath = path.join(root, "usage.jsonl");
    const budget = contract();
    await appendTopicProbeComputePreflight({
      ledgerPath,
      contract: budget,
      profile: "primary",
      command: "run configured experiment",
      estimatedWallTimeMs: 1_000,
      estimatedGpuCount: 1,
      estimatedFreshTrials: 1
    });
    const lines = (await readFile(ledgerPath, "utf8")).trim().split("\n");
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    first.estimated_gpu_count = 2;
    await writeFile(
      ledgerPath,
      `${JSON.stringify(first)}\n${lines.slice(1).join("\n")}`,
      "utf8"
    );

    expect(
      validateTopicProbeComputeUsageLedger(
        await readFile(ledgerPath, "utf8"),
        budget
      ).reasons
    ).toContain(
      "topic_probe_compute_usage_ledger_content_hash_mismatch:1"
    );
  });
});
