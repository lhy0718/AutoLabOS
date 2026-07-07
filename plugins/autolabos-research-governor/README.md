# AutoLabOS Research Governor

AutoLabOS Research Governor is the Codex-facing governance plugin for AutoLabOS.
It treats Codex and external research tools as execution engines, while
AutoLabOS owns artifact intake, evidence gates, claim ceilings, downgrade
decisions, node strengthening, and paper-readiness packaging.

The plugin does not promise that a completed workflow or compiled draft is a
paper-ready result. External outputs remain untrusted evidence until AutoLabOS
gates classify them.

## First Run

Run these commands from the repository root when installing, changing, or
auditing the plugin:

```sh
npm run plugin:contract
npm run plugin:dogfood
```

`npm run plugin:contract` prints the public artifact and intent contract.
`npm run plugin:dogfood` checks the plugin manifest, skill, marketplace entry,
README, helper scripts, and package wiring as an untrusted artifact bundle.

After changing plugin files, reinstall the plugin or restart the Codex thread so
cached skill text cannot drift from the repo-local contract.

## Command Intents

- `research:new`: create or repair a governed research brief.
- `research:audit`: audit a run or external artifact bundle as untrusted evidence.
- `research:review`: review paper readiness, claim ceilings, downgrade class, and repair targets.
- `research:improve`: map gate or review failures to node-local strengthening.
- `research:pack`: export a traceable paper-readiness bundle.

## Artifact Contract

- `ResearchBrief`
- `EvidenceBundle`
- `GateReport`
- `ReviewReport`
- `MetaHarnessPatchPlan`
- `PaperReadinessBundle`

## Governance Boundary

The standalone AutoLabOS TUI and web app remain the reference workflow,
compatibility shell, and live-validation environment. The public product
boundary is plugin-first: other agents may execute work, but AutoLabOS gates
the resulting artifacts before any paper-readiness claim is allowed.

Keep plugin examples and fixtures domain-neutral. Concrete model names,
benchmarks, datasets, condition markers, run ids, and private local paths belong
in run artifacts or user-provided inputs, not in reusable plugin code or docs.

See `docs/codex-plugin-governance.md` for the full direction and adapter
strategy.
