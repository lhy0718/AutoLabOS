#!/usr/bin/env node
import { generateFullSeedAuditDemo } from "../dist/core/audit/auditDemoBundle.js";

const args = process.argv.slice(2);
let outDir;
for (let index = 0; index < args.length; index += 1) {
  const token = args[index];
  if (token === "--out-dir") {
    const value = args[index + 1];
    if (!value) {
      process.stderr.write("Missing value for --out-dir.\n");
      process.exitCode = 1;
      process.exit();
    }
    outDir = value;
    index += 1;
    continue;
  }
  if (token === "--help" || token === "-h") {
    process.stdout.write([
      "demo-audit-full-seeds",
      "",
      "Usage:",
      "  node scripts/demo-audit-full-seeds.mjs [--out-dir outputs/audit-full-seeds]",
      "",
      "Runs AGB-001 through AGB-010 through the built paper-readiness and literature-discovery audit demo."
    ].join("\n") + "\n");
    process.exit();
  }
  process.stderr.write(`Unsupported argument: ${token}\n`);
  process.exitCode = 1;
  process.exit();
}

const manifest = await generateFullSeedAuditDemo({
  cwd: process.cwd(),
  outDir
});

process.stdout.write([
  `Full audit seed demo generated: ${manifest.output_dir}`,
  `All expected outcomes met: ${manifest.all_expected_outcomes_met}`,
  ...manifest.entries.map((entry) =>
    `${entry.seed_id}: expected=${entry.expected_verdict}; actual=${entry.actual_verdict}; blockers=${entry.expected_blockers.join(",")}; report=${entry.report_path}`
  )
].join("\n") + "\n");

if (!manifest.all_expected_outcomes_met) {
  process.exitCode = 1;
}
