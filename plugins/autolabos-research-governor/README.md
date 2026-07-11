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
npm run plugin:doctor
npm run plugin:doctor -- --strict
npm run plugin:discovery-check
npm run validate:plugin-bridge
npm run validate:plugin-bridge:local
npm run plugin:sync-cache
npm run plugin:release-check
```

`npm run plugin:contract` prints the public artifact and intent contract.
`npm run plugin:dogfood` checks the plugin manifest, skill, marketplace entry,
README, helper scripts, and package wiring as an untrusted artifact bundle.
`npm run plugin:doctor` reports whether the installed Codex plugin cache is
aligned with the repo-local plugin contract. Use
`npm run plugin:doctor -- --strict` in CI or release checks when cache drift
should fail the command instead of only appearing in the JSON verdict.
`npm run plugin:discovery-check` verifies that local Codex lists the plugin as installed and enabled at the manifest version, resolves it to this repository, and passes the strict cache/skill cross-check. It requires a local Codex installation and is not a substitute for CI's structural contract tests.
`npm run validate:plugin-bridge` runs a deterministic CI-safe research chain through the repo plugin bridge. `npm run validate:plugin-bridge:local` first verifies discovery and cache alignment, then runs the same chain through the installed cache bridge; it is the workstation acceptance gate.
`npm run plugin:sync-cache` performs a dry run for copying the repo-local plugin
into the installed Codex cache; add `-- --write` only when intentionally
refreshing the local Codex installation. `npm run plugin:release-check` bundles
contract, dogfood, strict doctor, pack, and public-surface hygiene checks.

After changing plugin files, reinstall the plugin or restart the Codex thread so
cached skill text cannot drift from the repo-local contract.

## Executable Intents

The bundled bridge delegates deterministic work to the installed AutoLabOS CLI:

```sh
npm run plugin:research -- --check
npm run plugin:research -- audit --external <artifact-root> --out-dir outputs/research-governance/audit
npm run plugin:research -- review --gate outputs/research-governance/audit/gate-report.json
npm run plugin:research -- improve --review outputs/research-governance/review/review-report.json
npm run plugin:research -- pack --gate outputs/research-governance/audit/gate-report.json --review outputs/research-governance/review/review-report.json
```

The bridge emits a blocking `GateReport` when the `autolabos` CLI is unavailable.
It never substitutes a fabricated audit result. A blocked or downgraded research
verdict is a valid governance outcome and is preserved through packaging.

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
