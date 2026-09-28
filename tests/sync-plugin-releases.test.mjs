// Regression tests for scripts/sync-plugin-releases.sh: a single plugin's
// candidate failure must not stop later plugins from syncing, and the failed
// plugin's workspace state must not leak into the next plugin.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storeEntries = ["plugins", "publishers", "schemas", "catalog", "signing-keys.json", "revoked.json", "scripts"];

let releaseSequence = 0;

function release(repository, tag) {
  releaseSequence += 1;
  return {
    repository,
    tag,
    releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`,
    releaseCandidatesUrl: `https://example.invalid/${releaseSequence}/release-candidates.json`,
    metadataUrl: `https://example.invalid/${releaseSequence}/.dbx-store.json`,
  };
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.stderr}`);
  return result.stdout;
}

function commit(cwd, message) {
  git(cwd, ["add", "-A"]);
  const result = spawnSync(
    "git",
    ["-c", "user.name=dbx-store-test", "-c", "user.email=dbx-store-test@example.invalid", "commit", "--quiet", "-m", message],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git commit failed in ${cwd}:\n${result.stderr}`);
}

// Creates a throwaway clone of the catalog layout with a local bare origin, so
// the sync script performs real branch/commit/push work without GitHub.
function setupFixture({ slug, setup } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), `dbx-store-sync-${slug}-`));
  const origin = path.join(tmp, "origin.git");
  const work = path.join(tmp, "work");
  git(tmp, ["init", "--bare", "--initial-branch=main", origin]);
  git(tmp, ["clone", "--quiet", origin, work]);
  for (const entry of storeEntries) {
    cpSync(path.join(repoRoot, entry), path.join(work, entry), { recursive: true });
  }
  cpSync(
    path.join(repoRoot, "tests", "fixtures", "sync-release-candidate.stub.mjs"),
    path.join(work, "scripts", "sync-release-candidate.mjs"),
  );
  commit(work, "fixture base");
  git(work, ["push", "--quiet", "--set-upstream", "origin", "main"]);
  if (setup) setup({ work, origin, tmp });
  return { tmp, origin, work };
}

function runSync(fixture, { releases, scenarios = {}, rawReleases, existingPrBranch, ghFailCreate } = {}) {
  const releasesPath = path.join(fixture.tmp, "releases.json");
  writeFileSync(releasesPath, rawReleases ?? `${JSON.stringify(releases, null, 2)}\n`);
  const bin = path.join(fixture.tmp, "bin");
  mkdirSync(bin, { recursive: true });
  cpSync(path.join(repoRoot, "tests", "fixtures", "gh.stub.sh"), path.join(bin, "gh"));
  chmodSync(path.join(bin, "gh"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_REPOSITORY: "t8y2/dbx-store",
    GH_TOKEN: "stub-token",
    STUB_SCENARIOS: JSON.stringify(scenarios),
    ...(existingPrBranch ? { STUB_GH_EXISTING_BRANCH: existingPrBranch } : {}),
    ...(ghFailCreate ? { STUB_GH_FAIL_CREATE: "1" } : {}),
  };
  const result = spawnSync("bash", ["scripts/sync-plugin-releases.sh", releasesPath], { cwd: fixture.work, env, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("a failing candidate is skipped while later plugins keep syncing", (t) => {
  const fixture = setupFixture({ slug: "isolation" });
  t.after(() => rmSync(fixture.tmp, { recursive: true, force: true }));
  const scenarios = {
    "v1.0.0": { id: "io.dbx.files", publisher: "jinpy", version: "9.9.1" },
    "v1.0.1": { id: "io.dbx.kafka", publisher: "jinpy", version: "9.9.1", invalidLocalization: true },
    "v1.0.2": { id: "io.dbx.ldap", publisher: "jinpy", version: "9.9.1" },
  };
  const result = runSync(fixture, {
    releases: [
      release("example/dbx-plugin-a", "v1.0.0"),
      release("kingwrcy/dbx-totp", "v1.0.1"),
      release("example/dbx-plugin-c", "v1.0.2"),
    ],
    scenarios,
  });

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Prepared io\.dbx\.files@9\.9\.1 with 1 target\(s\)/);
  assert.match(result.output, /candidate validation failed for kingwrcy\/dbx-totp@v1\.0\.1 \(plugin io\.dbx\.kafka@9\.9\.1\)/);
  assert.match(result.output, /localization 'zh-CN' contains unknown field\(s\): releaseNotes/);
  assert.match(result.output, /Prepared io\.dbx\.ldap@9\.9\.1 with 1 target\(s\)/);
  assert.match(result.output, /created pull request/);

  const branches = git(fixture.origin, ["branch", "--list", "--format=%(refname:short)"]);
  assert.ok(branches.includes("automation/plugin-release/io.dbx.files/9.9.1"));
  assert.ok(branches.includes("automation/plugin-release/io.dbx.ldap/9.9.1"));
  assert.ok(!branches.includes("automation/plugin-release/io.dbx.kafka/9.9.1"), "failed plugin must not push a branch");

  const committedFiles = git(fixture.work, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n");
  assert.deepEqual(committedFiles, ["candidates/io.dbx.ldap.json"], "failed candidate must not leak into the next plugin's commit");
  assert.equal(git(fixture.work, ["log", "-1", "--format=%s"]).trim(), "chore(store): sync io.dbx.ldap@9.9.1 candidate");
  assert.equal(git(fixture.work, ["status", "--porcelain"]), "", "worktree must be clean after the batch");

  const candidate = JSON.parse(git(fixture.origin, ["show", "automation/plugin-release/io.dbx.ldap/9.9.1:candidates/io.dbx.ldap.json"]));
  assert.equal(candidate.id, "io.dbx.ldap");
  assert.equal(candidate.version, "9.9.1");
});

test("an existing automation branch is updated in place and the PR update path runs", (t) => {
  const branch = "automation/plugin-release/io.dbx.files/9.9.1";
  const fixture = setupFixture({
    slug: "existing-branch",
    setup: ({ work }) => {
      git(work, ["checkout", "--quiet", "-b", branch]);
      mkdirSync(path.join(work, "candidates"), { recursive: true });
      writeFileSync(
        path.join(work, "candidates", "io.dbx.files.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            id: "io.dbx.files",
            publisher: "jinpy",
            version: "9.9.1",
            targets: [{ target: "universal", url: "https://example.invalid/candidate.dbxp", sha256: "b".repeat(64), size: 2048 }],
          },
          null,
          2,
        )}\n`,
      );
      commit(work, "stale candidate");
      git(work, ["push", "--quiet", "origin", branch]);
      git(work, ["checkout", "--quiet", "main"]);
    },
  });
  t.after(() => rmSync(fixture.tmp, { recursive: true, force: true }));
  const scenarios = { "v1.0.0": { id: "io.dbx.files", publisher: "jinpy", version: "9.9.1" } };
  const result = runSync(fixture, { releases: [release("example/dbx-plugin-a", "v1.0.0")], scenarios, existingPrBranch: branch });

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Updated PR #123/);
  assert.equal(git(fixture.origin, ["log", "-1", "--format=%s", branch]).trim(), "chore(store): sync io.dbx.files@9.9.1 candidate");
  const history = git(fixture.origin, ["log", "--format=%s", branch]).trim().split("\n");
  assert.ok(history.includes("stale candidate"), "existing branch history must be preserved");
  const candidate = JSON.parse(git(fixture.origin, ["show", `${branch}:candidates/io.dbx.files.json`]));
  assert.equal(candidate.targets[0].sha256, "a".repeat(64), "existing branch must receive the freshly prepared candidate");
});

test("already listed and already finalized plugins are skipped", (t) => {
  const finalizedBranch = "automation/plugin-release/io.dbx.ldap/9.9.2";
  const fixture = setupFixture({
    slug: "skips",
    setup: ({ work }) => {
      git(work, ["checkout", "--quiet", "-b", finalizedBranch]);
      const plugin = JSON.parse(readFileSync(path.join(work, "plugins", "io.dbx.ldap.json"), "utf8"));
      plugin.versions.push({ version: "9.9.2", releasedAt: "2026-01-01T00:00:00Z", releaseNotes: "", artifacts: [] });
      writeFileSync(path.join(work, "plugins", "io.dbx.ldap.json"), `${JSON.stringify(plugin, null, 2)}\n`);
      commit(work, "finalized candidate");
      git(work, ["push", "--quiet", "origin", finalizedBranch]);
      git(work, ["checkout", "--quiet", "main"]);
    },
  });
  t.after(() => rmSync(fixture.tmp, { recursive: true, force: true }));
  const listedVersion = JSON.parse(readFileSync(path.join(fixture.work, "plugins", "io.dbx.files.json"), "utf8")).latestVersion;
  const scenarios = {
    "v2.0.0": { id: "io.dbx.files", publisher: "jinpy", version: listedVersion },
    "v2.0.1": { id: "io.dbx.ldap", publisher: "jinpy", version: "9.9.2" },
  };
  const result = runSync(fixture, {
    releases: [release("example/dbx-plugin-a", "v2.0.0"), release("example/dbx-plugin-d", "v2.0.1")],
    scenarios,
  });

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, new RegExp(`io\\.dbx\\.files@${listedVersion.replaceAll(".", "\\.")} is already listed; skipping`));
  assert.match(result.output, /io\.dbx\.ldap@9\.9\.2 is already finalized; skipping/);
  const branches = git(fixture.origin, ["branch", "--list", "--format=%(refname:short)"]);
  assert.ok(!branches.includes(`automation/plugin-release/io.dbx.files/${listedVersion}`));
});

test("a truncated candidate from a failed write is cleaned up before the next plugin", (t) => {
  const fixture = setupFixture({ slug: "write-failure" });
  t.after(() => rmSync(fixture.tmp, { recursive: true, force: true }));
  const scenarios = {
    "v3.0.0": { id: "io.dbx.kafka", publisher: "jinpy", version: "9.9.3", failWrite: true },
    "v3.0.1": { id: "io.dbx.ldap", publisher: "jinpy", version: "9.9.3" },
  };
  const result = runSync(fixture, {
    releases: [release("example/dbx-plugin-b", "v3.0.0"), release("example/dbx-plugin-c", "v3.0.1")],
    scenarios,
  });

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /skipping example\/dbx-plugin-b@v3\.0\.0: candidate writing failed/);
  assert.match(result.output, /Prepared io\.dbx\.ldap@9\.9\.3/);
  const committedFiles = git(fixture.work, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n");
  assert.deepEqual(committedFiles, ["candidates/io.dbx.ldap.json"]);
  assert.equal(git(fixture.work, ["status", "--porcelain"]), "");
});

test("GitHub infrastructure failures still fail the run", (t) => {
  const fixture = setupFixture({ slug: "gh-failure" });
  t.after(() => rmSync(fixture.tmp, { recursive: true, force: true }));
  const scenarios = { "v4.0.0": { id: "io.dbx.files", publisher: "jinpy", version: "9.9.4" } };
  const result = runSync(fixture, {
    releases: [release("example/dbx-plugin-a", "v4.0.0")],
    scenarios,
    ghFailCreate: true,
  });

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /stub gh pr create failure/);
});

test("an unusable discovery plan fails the run instead of syncing nothing", (t) => {
  const fixture = setupFixture({ slug: "plan-failure" });
  t.after(() => rmSync(fixture.tmp, { recursive: true, force: true }));
  const result = runSync(fixture, { rawReleases: "{ this is not json" });

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /SyntaxError|JSON/);
});
