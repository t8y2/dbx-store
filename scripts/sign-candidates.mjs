import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Signs every candidate in a validate.mjs --plan-candidates plan with the DBX
// Store repository key via the reviewed packager, verifies candidate bytes and
// manifest identity, and emits upload/receipt/digest metadata for publishing.

const planPath = requiredOption("--plan");
const keyId = requiredOption("--key-id");
const packagerManifest = requiredOption("--packager");
const artifactBaseUrl = normalizeBaseUrl(requiredOption("--artifact-base-url"));
const outDirectory = path.resolve(requiredOption("--out", "."));

const plan = JSON.parse(await readFile(planPath, "utf8"));
if (!Array.isArray(plan.candidates) || plan.candidates.length === 0) throw new Error("Signing plan contains no candidates");
await rm(outDirectory, { recursive: true, force: true });
await mkdir(outDirectory, { recursive: true });

const digests = {};
const uploads = [];

for (const candidate of plan.candidates) {
  for (const target of candidate.targets) {
    const outputName = `${candidate.id}-${candidate.version}-${target.target}.dbxp`;
    const candidatePath = path.join(outDirectory, `candidate-${outputName}`);
    const signedPath = path.join(outDirectory, outputName);
    console.log(`Signing ${candidate.id}@${candidate.version} ${target.target} ...`);

    execFileSync(
      "curl",
      ["--fail", "--location", "--max-redirs", "5", "--proto", "=https", "--tlsv1.2", "--output", candidatePath, target.url],
      { stdio: ["ignore", "inherit", "inherit"] },
    );

    const bytes = await readFile(candidatePath);
    const sha256 = digest(bytes);
    if (sha256 !== target.sha256.toLowerCase()) {
      throw new Error(`Candidate SHA-256 mismatch for ${outputName}: expected ${target.sha256}, got ${sha256}`);
    }
    if (bytes.length !== target.size) {
      throw new Error(`Candidate size mismatch for ${outputName}: expected ${target.size}, got ${bytes.length}`);
    }

    const entries = execFileSync("unzip", ["-Z1", candidatePath], { encoding: "utf8" }).split(/\r?\n/);
    if (entries.includes("signature.json")) throw new Error(`Official signing accepts only unsigned candidates: ${outputName}`);
    const manifest = JSON.parse(execFileSync("unzip", ["-p", candidatePath, "manifest.json"], { encoding: "utf8" }));
    if (manifest.id !== candidate.id) throw new Error(`Expected plugin ${candidate.id} in ${outputName}, got ${manifest.id}`);
    if (manifest.version !== candidate.version) throw new Error(`Expected version ${candidate.version} in ${outputName}, got ${manifest.version}`);
    if (manifest.publisher !== candidate.publisher) throw new Error(`Expected publisher ${candidate.publisher} in ${outputName}, got ${manifest.publisher}`);

    const artifactUrl = `${artifactBaseUrl}/plugins/${candidate.id}/${candidate.version}/${outputName}`;
    execFileSync(
      "cargo",
      [
        "run",
        "--locked",
        "--manifest-path",
        packagerManifest,
        "--",
        "sign",
        candidatePath,
        signedPath,
        "--key-id",
        keyId,
        "--artifact-metadata",
        `${signedPath.replace(/\.dbxp$/, "")}.artifact.json`,
        "--target",
        target.target,
        "--artifact-url",
        artifactUrl,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );

    const signedBytes = await readFile(signedPath);
    const signedSha256 = digest(signedBytes);
    const artifact = JSON.parse(await readFile(`${signedPath.replace(/\.dbxp$/, "")}.artifact.json`, "utf8"));
    const receipt = {
      schemaVersion: 1,
      pluginId: candidate.id,
      version: candidate.version,
      target: target.target,
      repositorySigningKeyId: keyId,
      candidate: { url: target.url, sha256: target.sha256.toLowerCase(), size: target.size },
      artifact,
      workflowRun: process.env.GITHUB_SERVER_URL
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "local",
    };
    await writeFile(`${signedPath.replace(/\.dbxp$/, "")}.signing-receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);

    digests[`${candidate.id}/${candidate.version}/${target.target}`] = { sha256: signedSha256, size: signedBytes.length };
    uploads.push({
      prefix: `plugins/${candidate.id}/${candidate.version}`,
      files: [outputName, `${outputName.replace(/\.dbxp$/, "")}.artifact.json`, `${outputName.replace(/\.dbxp$/, "")}.signing-receipt.json`],
    });
    await rm(candidatePath, { force: true });
  }
}

await writeFile(path.join(outDirectory, "signed.json"), `${JSON.stringify(digests, null, 2)}\n`);
await writeFile(path.join(outDirectory, "uploads.json"), `${JSON.stringify(uploads, null, 2)}\n`);
console.log(`Signed ${Object.keys(digests).length} artifact(s)`);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requiredOption(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required option ${name}`);
  }
  return process.argv[index + 1];
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("--artifact-base-url must use HTTPS");
  return value.replace(/\/+$/, "");
}
