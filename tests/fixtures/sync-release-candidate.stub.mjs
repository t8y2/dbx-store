// Test double for scripts/sync-release-candidate.mjs. The release sync tests
// replace the real script with this stub so they stay offline and can force
// per-plugin failures. Scenarios are provided through STUB_SCENARIOS, keyed by
// release tag.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const tag = option("--tag");
const repository = option("--repository");
const output = option("--output");

const scenarios = JSON.parse(process.env.STUB_SCENARIOS ?? "{}");
const scenario = scenarios[tag];
if (!scenario) throw new Error(`stub has no scenario for ${tag}`);

if (scenario.failWrite && !path.isAbsolute(output)) {
  // Simulate a truncated candidate left behind by a failed repository write so
  // tests can prove the workflow cleans it up before the next plugin. The
  // preflight write to /tmp still succeeds, as it does in the real flow.
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, '{ "schemaVersion": 1,');
  throw new Error("stub candidate write failure");
}

const candidate = {
  schemaVersion: 1,
  id: scenario.id,
  publisher: scenario.publisher,
  version: scenario.version,
  targets: [
    {
      target: "universal",
      url: `https://github.com/${repository}/releases/download/${tag}/candidate.dbxp`,
      sha256: "a".repeat(64),
      size: 1024,
    },
  ],
};

if (scenario.invalidLocalization) {
  // Mirrors the real kingwrcy/dbx-totp@0.2.1 failure: an unknown field inside
  // a localization object.
  candidate.localizations = { "zh-CN": { name: "示例", description: "描述", releaseNotes: "legacy" } };
}

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(candidate, null, 2)}\n`);
console.log(`Prepared ${candidate.id}@${candidate.version} with ${candidate.targets.length} target(s)`);
