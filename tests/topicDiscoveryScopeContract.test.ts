import { describe, expect, it } from "vitest";

import {
  assessTopicDiscoveryScientificScope,
  bindTopicDiscoveryScopeAnchor,
  buildTopicDiscoveryScopeContract
} from "../src/core/topicDiscoveryScopeContract.js";
import { TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION } from "../src/core/topicDiscoveryScientificTerms.js";

const COMPLETE_BRIEF = [
  "# Research Brief",
  "",
  "## Research Mode",
  "topic_discovery",
  "",
  "## Topic",
  "Search within document ranking reliability. Exclude proprietary services.",
  "",
  "## Scientific Scope",
  "### Scientific Object",
  "- document ranking",
  "",
  "### Empirical Problems",
  "- ranking stability under annotation disagreement",
  "- item-level uncertainty under finite label budgets",
  "- sample sufficiency for ranking conclusions",
  "",
  "### Scientific Relations",
  "- uncertainty calibration versus ranking reliability",
  "",
  "### Prior-Work Probes",
  "- whether recent test-set sufficiency work already subsumes the question",
  "",
  "### Admissibility Constraints",
  "- outcome-driven sample replacement and post-hoc endpoint selection are forbidden",
  "",
  "### Publication Goals",
  "- a short workshop contribution with enough novelty"
].join("\n");

describe("topic-discovery scientific scope contract", () => {
  it("builds stable atomic axes without promoting an explicit exclusion", () => {
    const first = buildTopicDiscoveryScopeContract(COMPLETE_BRIEF);
    const second = buildTopicDiscoveryScopeContract(COMPLETE_BRIEF);

    expect(first).toEqual(second);
    expect(first.enforced).toBe(true);
    expect(first.version).toBe(3);
    expect(first.termNormalizationVersion).toBe(TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION);
    expect(first.contractSource).toBe("explicit_scientific_scope");
    expect(first.sourceSections).toEqual(["scientific_scope"]);
    expect(first.declaredAnchorTerms).toEqual(["document", "ranking"]);
    const sourceTerms = first.axes.flatMap((axis) => axis.sourceTerms);
    expect(sourceTerms).not.toContain("proprietary");
    expect(sourceTerms).not.toContain("post");
    expect(sourceTerms).not.toContain("hoc");
    expect(sourceTerms).not.toContain("selection");
    for (const genericStem of ["be", "declar", "execut", "that"]) {
      expect(sourceTerms).not.toContain(genericStem);
    }
    expect(first.briefFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.scopeFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("requires direct brief-axis lineage and ignores free-form lens wording", () => {
    const contract = bindTopicDiscoveryScopeAnchor(
      buildTopicDiscoveryScopeContract(COMPLETE_BRIEF),
      ["document", "ranking"]
    );
    const diagnostic = assessTopicDiscoveryScientificScope({
      contract,
      sharedAnchorTerms: ["document", "ranking"],
      families: [
        { id: "declared_axis", axisTerms: ["stability", "annotation"] },
        { id: "adjacent_axis", axisTerms: ["adjacent", "mitigation"] }
      ],
      rejectedQueries: ['"document retrieval" prior axis'],
      candidateTitles: [
        "Adjacent mitigation for document ranking reliability",
        "Document ranking reliability with adjacent mitigation"
      ]
    });

    expect(diagnostic.status).toBe("failed");
    expect(diagnostic.families).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "declared_axis",
        relation: "lexical_refinement",
        retainedSourceTerms: ["stability", "annotation"],
        passed: true
      }),
      expect.objectContaining({
        id: "adjacent_axis",
        relation: "unbound",
        retainedSourceTerms: [],
        passed: false,
        failureReason: "no_brief_axis_lineage"
      })
    ]));
  });

  it("allows a technical expansion only when titles co-occur with its retained source term", () => {
    const contract = bindTopicDiscoveryScopeAnchor(
      buildTopicDiscoveryScopeContract(COMPLETE_BRIEF),
      ["document", "ranking"]
    );
    const supported = assessTopicDiscoveryScientificScope({
      contract,
      sharedAnchorTerms: ["document", "ranking"],
      families: [{ id: "technical_expansion", axisTerms: ["item", "response", "theory"] }],
      rejectedQueries: ['"document ranking" prior axis'],
      candidateTitles: [
        "Item response theory for document ranking decisions",
        "Document ranking evaluation with item response theory"
      ]
    });
    const unsupported = assessTopicDiscoveryScientificScope({
      contract,
      sharedAnchorTerms: ["document", "ranking"],
      families: [{ id: "technical_expansion", axisTerms: ["item", "response", "theory"] }],
      rejectedQueries: ['"document ranking" prior axis'],
      candidateTitles: ["Document ranking item analysis"]
    });

    expect(supported.status).toBe("passed");
    expect(supported.families[0]).toMatchObject({
      relation: "technical_expansion",
      retainedSourceTerms: ["item"],
      novelTerms: ["response", "theory"],
      candidateTitleSupport: 2,
      passed: true
    });
    expect(unsupported.families[0]).toMatchObject({
      candidateTitleSupport: 0,
      passed: false,
      failureReason: "unsupported_technical_expansion"
    });
  });

  it("normalizes derivational variants before counting title support", () => {
    const contract = bindTopicDiscoveryScopeAnchor(
      buildTopicDiscoveryScopeContract(COMPLETE_BRIEF),
      ["document", "ranking"]
    );
    const diagnostic = assessTopicDiscoveryScientificScope({
      contract,
      sharedAnchorTerms: ["document", "ranking"],
      families: [{ id: "measurement_expansion", axisTerms: ["uncertainty", "estimation"] }],
      rejectedQueries: ['"document ranking" prior axis'],
      candidateTitles: [
        "Estimative uncertainty for document ranking decisions",
        "Document ranking with uncertainty estimation"
      ]
    });

    expect(diagnostic.families[0]).toMatchObject({
      retainedSourceTerms: ["uncertainty"],
      novelTerms: ["estimation"],
      candidateTitleSupport: 2,
      passed: true
    });
  });

  it("preserves role-authorized scientific modifiers that are generic in unscoped queries", () => {
    const brief = [
      "# Research Brief",
      "",
      "## Research Mode",
      "topic_discovery",
      "",
      "## Topic",
      "Acoustic event segmentation under data scarcity",
      "",
      "## Scientific Scope",
      "### Scientific Object",
      "- acoustic event segmentation",
      "",
      "### Empirical Problems",
      "- limited labels under class imbalance",
      "- sensor noise under domain shift"
    ].join("\n");
    const contract = bindTopicDiscoveryScopeAnchor(
      buildTopicDiscoveryScopeContract(brief),
      ["acoustic", "event", "segmentation"]
    );
    const diagnostic = assessTopicDiscoveryScientificScope({
      contract,
      sharedAnchorTerms: ["acoustic", "event", "segmentation"],
      families: [
        { id: "label_scarcity", axisTerms: ["limited", "labels"] },
        { id: "sensor_noise", axisTerms: ["sensor", "noise"] }
      ],
      rejectedQueries: [],
      candidateTitles: []
    });

    expect(contract.axes[0]?.sourceTerms).toEqual([
      "limit",
      "label",
      "class",
      "imbalance"
    ]);
    expect(diagnostic.status).toBe("passed");
    expect(diagnostic.families[0]).toMatchObject({
      relation: "lexical_refinement",
      retainedSourceTerms: ["limit", "label"],
      novelTerms: [],
      passed: true
    });
  });

  it("accepts the compositional paper-review object without admitting procedural paper phrases", () => {
    const buildWithObject = (scientificObject: string) =>
      buildTopicDiscoveryScopeContract([
        "# Research Brief",
        "",
        "## Research Mode",
        "topic_discovery",
        "",
        "## Scientific Scope",
        "### Scientific Object",
        `- ${scientificObject}`,
        "",
        "### Empirical Problems",
        "- defect localization under incomplete evidence",
        "- reviewer consistency across revision rounds"
      ].join("\n"));

    const paperReview = buildWithObject("scientific paper review");
    const researchPaper = buildWithObject("research paper");
    const paperTopic = buildWithObject("paper topic");

    expect(paperReview.declaredAnchorTerms).toEqual(["scientific", "paper", "review"]);
    expect(paperReview.enforced).toBe(true);
    expect(researchPaper.declaredAnchorTerms).toEqual(["paper"]);
    expect(researchPaper.enforced).toBe(false);
    expect(paperTopic.declaredAnchorTerms).toEqual(["paper"]);
    expect(paperTopic.enforced).toBe(false);
  });

  it("accepts equivalent automatic-process wording without a technical expansion", () => {
    const contract = bindTopicDiscoveryScopeAnchor(
      buildTopicDiscoveryScopeContract([
        "# Research Brief",
        "",
        "## Research Mode",
        "topic_discovery",
        "",
        "## Scientific Scope",
        "### Scientific Object",
        "- scientific document assessment",
        "",
        "### Empirical Problems",
        "- automated report generation",
        "- error detection under sparse evidence"
      ].join("\n")),
      ["scientific", "document", "assessment"]
    );
    const diagnostic = assessTopicDiscoveryScientificScope({
      contract,
      sharedAnchorTerms: ["scientific", "document", "assessment"],
      families: [
        { id: "report_generation", axisTerms: ["automatic", "generation"] },
        { id: "error_detection", axisTerms: ["error", "detection"] }
      ],
      rejectedQueries: [],
      candidateTitles: []
    });

    expect(contract.declaredAnchorTerms).toEqual([
      "scientific",
      "document",
      "assessment"
    ]);
    expect(diagnostic.status).toBe("passed");
    expect(diagnostic.families[0]).toMatchObject({
      relation: "lexical_refinement",
      retainedSourceTerms: ["automat", "generation"],
      novelTerms: [],
      passed: true
    });
  });

  it("keeps an interior scientific compound token in the declared anchor", () => {
    const contract = buildTopicDiscoveryScopeContract([
      "# Research Brief",
      "",
      "## Research Mode",
      "topic_discovery",
      "",
      "## Scientific Scope",
      "### Scientific Object",
      "- automated research workflows",
      "",
      "### Empirical Problems",
      "- retrieval coverage calibration under finite budgets",
      "- premature stopping on open-ended target sets"
    ].join("\n"));

    expect(contract.declaredAnchorTerms).toEqual(["automat", "research", "workflow"]);
    expect(contract.queryAnchorTerms).toEqual(["automated", "research", "workflows"]);
    expect(contract.enforced).toBe(true);

    const genericCompound = buildTopicDiscoveryScopeContract([
      "# Research Brief",
      "",
      "## Research Mode",
      "topic_discovery",
      "",
      "## Scientific Scope",
      "### Scientific Object",
      "- adaptive search controllers",
      "",
      "### Empirical Problems",
      "- retrieval coverage under finite budgets",
      "- query robustness across task variants"
    ].join("\n"));
    expect(genericCompound.declaredAnchorTerms).toEqual([
      "adaptive",
      "search",
      "controller"
    ]);
    expect(genericCompound.enforced).toBe(true);
  });

  it("rejects a declared anchor longer than the executable query contract", () => {
    const contract = buildTopicDiscoveryScopeContract([
      "# Research Brief",
      "",
      "## Research Mode",
      "topic_discovery",
      "",
      "## Scientific Scope",
      "### Scientific Object",
      "- acoustic event boundary detection",
      "",
      "### Empirical Problems",
      "- segmentation stability under sensor noise",
      "- label efficiency under domain shift"
    ].join("\n"));

    expect(contract.declaredAnchorTerms).toEqual([
      "acoustic",
      "event",
      "boundary",
      "detection"
    ]);
    expect(contract.enforced).toBe(false);
  });

  it("fails closed during recovery when the brief lacks an enforceable scope", () => {
    const contract = buildTopicDiscoveryScopeContract(
      "# Research Brief\n\n## Research Mode\ntopic_discovery\n\n## Topic\nDocument ranking"
    );
    const diagnostic = assessTopicDiscoveryScientificScope({
      contract,
      sharedAnchorTerms: ["document", "ranking"],
      families: [{ id: "candidate", axisTerms: ["ranking", "stability"] }],
      rejectedQueries: ['"document ranking" prior axis'],
      candidateTitles: []
    });

    expect(diagnostic).toMatchObject({
      enforced: false,
      status: "insufficient_brief_source_material",
      recovery: true,
      families: [
        expect.objectContaining({
          passed: false,
          failureReason: "scope_contract_unavailable"
        })
      ]
    });
  });

  it("fails closed on an initial one-term expansion without title support", () => {
    const contract = buildTopicDiscoveryScopeContract(COMPLETE_BRIEF);
    const diagnostic = assessTopicDiscoveryScientificScope({
      contract,
      sharedAnchorTerms: ["document", "ranking"],
      families: [{ id: "initial_expansion", axisTerms: ["uncertainty", "estimation"] }],
      rejectedQueries: [],
      candidateTitles: []
    });

    expect(diagnostic).toMatchObject({
      status: "failed",
      anchor: { authority: "brief_declared", passed: true },
      families: [
        expect.objectContaining({
          retainedSourceTerms: ["uncertainty"],
          novelTerms: ["estimation"],
          passed: false,
          failureReason: "unsupported_technical_expansion"
        })
      ]
    });
  });

  it("keeps the scientific fingerprint stable across manuscript-only edits", () => {
    const first = buildTopicDiscoveryScopeContract(
      `${COMPLETE_BRIEF}\n\n## Manuscript Format\n- columns: 1`
    );
    const second = buildTopicDiscoveryScopeContract(
      `${COMPLETE_BRIEF}\n\n## Manuscript Format\n- columns: 2`
    );
    const changedProblem = buildTopicDiscoveryScopeContract(
      COMPLETE_BRIEF.replace(
        "sample sufficiency for ranking conclusions",
        "distribution shift for ranking conclusions"
      )
    );

    expect(first.briefFingerprint).not.toBe(second.briefFingerprint);
    expect(first.scopeFingerprint).toBe(second.scopeFingerprint);
    expect(first.contractFingerprint).toBe(second.contractFingerprint);
    expect(first.scopeFingerprint).not.toBe(changedProblem.scopeFingerprint);
  });

  it("canonicalizes a reordered declared anchor without changing the contract", () => {
    const contract = buildTopicDiscoveryScopeContract(COMPLETE_BRIEF);
    const rebound = bindTopicDiscoveryScopeAnchor(contract, ["ranking", "document"]);

    expect(rebound.sharedAnchorTerms).toEqual(["document", "ranking"]);
    expect(rebound.contractFingerprint).toBe(contract.contractFingerprint);
  });

  it("does not promote inferred process, exclusion, prior-work, or publication text", () => {
    const contract = buildTopicDiscoveryScopeContract([
      "# Research Brief",
      "",
      "## Research Mode",
      "topic_discovery",
      "",
      "## Topic",
      "Document retrieval decision reliability under controlled judgments.",
      "",
      "## Research Question",
      "How do ranking stability and annotation disagreement affect conclusions?",
      "",
      "## Dataset / Task / Bench",
      "The candidate must define its sampling frame; post-hoc endpoint selection is forbidden.",
      "",
      "## Questions / Risks",
      "Does recent prior work already subsume the question?",
      "Will enough novelty remain for a workshop paper?"
    ].join("\n"));

    expect(contract.contractSource).toBe("inferred_role_classifier");
    expect(contract.enforced).toBe(false);
    expect(contract.declaredAnchorTerms.length).toBeGreaterThan(5);
    expect(contract.axes).toHaveLength(1);
    expect(contract.priorWorkProbes).toHaveLength(1);
    expect(contract.units).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "exclusion", disposition: "excluded_from_scientific_scope" }),
      expect.objectContaining({ role: "prior_work_probe", disposition: "prior_work_probe_only" }),
      expect.objectContaining({ role: "publication_goal", disposition: "excluded_from_scientific_scope" })
    ]));
    expect(contract.axes.flatMap((axis) => axis.sourceTerms)).not.toContain("selection");
  });

  it("refuses to rebind an already frozen shared anchor", () => {
    const bound = bindTopicDiscoveryScopeAnchor(
      buildTopicDiscoveryScopeContract(COMPLETE_BRIEF),
      ["document", "ranking"]
    );

    expect(() => bindTopicDiscoveryScopeAnchor(bound, ["document", "classification"]))
      .toThrow("topic_discovery_scope_anchor_not_declared");
  });
});
