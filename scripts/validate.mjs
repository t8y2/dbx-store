import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDirectory = path.join(root, "plugins");
const publishersDirectory = path.join(root, "publishers");
const candidatesDirectory = path.join(root, "candidates");
const signingKeysPath = path.join(root, "signing-keys.json");
const revokedPath = path.join(root, "revoked.json");
const catalogPath = path.join(root, "catalog", "index.json");
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const signingKeyIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const signingKeyStatuses = new Set(["preview", "active", "retired"]);
const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const sha256Pattern = /^[a-f0-9]{64}$/i;
const planCandidates = process.argv.includes("--plan-candidates");
const storeReleaseUrlPrefix = "https://github.com/t8y2/dbx-store/releases/";
const pluginIconPublicBaseUrl = "https://dl.dbxio.com";

await rejectCommittedPackages(root);
const publishers = await loadPublishers();
const signingKeys = await loadRepositorySigningKeys();
const revoked = await loadRevocations();

const files = (await readdir(pluginsDirectory)).filter((file) => file.endsWith(".json")).sort();
const plugins = [];
for (const file of files) {
  const plugin = JSON.parse(await readFile(path.join(pluginsDirectory, file), "utf8"));
  validatePlugin(plugin, file, publishers, signingKeys, revoked);
  plugins.push(normalizePlugin(plugin));
}

const ids = new Set();
for (const plugin of plugins) {
  assert(!ids.has(plugin.id), `Duplicate plugin id '${plugin.id}'`);
  ids.add(plugin.id);
}

const candidates = await loadCandidates(plugins);

const catalog = {
  $schema: "../schemas/marketplace.schema.json",
  catalogVersion: 1,
  repository: {
    id: "dbx-official",
    name: "DBX Marketplace",
    homepage: "https://github.com/t8y2/dbx-store",
  },
  plugins: plugins.sort((left, right) => left.id.localeCompare(right.id)),
};

await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

if (planCandidates) {
  console.log(JSON.stringify({ candidates: candidates.map((candidate) => ({
    id: candidate.id,
    publisher: candidate.publisher,
    version: candidate.version,
    releaseNotes: candidate.releaseNotes ?? "",
    targets: candidate.targets,
  })) }));
} else {
  log(`Validated ${plugins.length} plugin metadata file(s)`);
}

if (candidates.length > 0 && !planCandidates) {
  const listing = candidates.map((candidate) => `${candidate.id}@${candidate.version}`).join(", ");
  throw new Error(
    `Catalog contains ${candidates.length} open candidate(s) awaiting DBX Store signing: ${listing}. ` +
      "A DBX maintainer must review the pull request and run the 'Sign plugin PR candidates' workflow on it. " +
      "The workflow finalizes plugins/*.json and catalog/index.json; this check passes once no candidates/*.json remain.",
  );
}

function validatePlugin(plugin, file, publishers, signingKeys, revoked) {
  assert(plugin && typeof plugin === "object" && !Array.isArray(plugin), `${file}: plugin metadata must be an object`);
  assertExactKeys(
    plugin,
    ["id", "name", "description", "publisher", "verified", "icon", "tags", "permissions", "source", "homepage", "license", "latestVersion", "versions", "localizations"],
    `${file}: plugin metadata`,
  );
  assert(identifierPattern.test(plugin.id || ""), `${file}: invalid plugin id`);
  assert(file === `${plugin.id}.json`, `${file}: filename must match plugin id '${plugin.id}.json'`);
  assert(nonempty(plugin.name), `${file}: name is required`);
  assert(identifierPattern.test(plugin.publisher || ""), `${file}: publisher must be a registered publisher id`);
  const publisher = publishers.byId.get(plugin.publisher);
  assert(publisher, `${file}: publisher '${plugin.publisher}' is not registered`);
  assert(semverPattern.test(plugin.latestVersion || ""), `${file}: latestVersion must be semantic versioning`);
  assert(Array.isArray(plugin.versions) && plugin.versions.length > 0, `${file}: at least one version is required`);
  assert(plugin.versions.some((version) => version.version === plugin.latestVersion), `${file}: latestVersion is missing from versions`);
  const versions = new Set();
  for (const version of plugin.versions) {
    assert(version && typeof version === "object" && !Array.isArray(version), `${file}: version entries must be objects`);
    assertExactKeys(version, ["version", "releasedAt", "releaseNotes", "artifacts"], `${file}: version '${version.version || "unknown"}'`);
    assert(semverPattern.test(version.version || ""), `${file}: invalid version '${version.version}'`);
    assert(!versions.has(version.version), `${file}: duplicate version '${version.version}'`);
    assert(!revoked.pluginVersions.has(`${plugin.id}@${version.version}`), `${file}: plugin version '${plugin.id}@${version.version}' is revoked`);
    versions.add(version.version);
    assert(Array.isArray(version.artifacts), `${file}: version '${version.version}' artifacts must be an array`);
    const targets = new Set();
    for (const artifact of version.artifacts) {
      assert(artifact && typeof artifact === "object" && !Array.isArray(artifact), `${file}: artifact entries must be objects`);
      assertExactKeys(
        artifact,
        ["target", "url", "sha256", "signingKeyId", "size"],
        `${file}: artifact '${version.version}/${artifact.target || "unknown"}'`,
      );
      assert(/^[a-z0-9-]{1,64}$/.test(artifact.target || ""), `${file}: invalid target '${artifact.target}'`);
      assert(!targets.has(artifact.target), `${file}: duplicate target '${artifact.target}' in ${version.version}`);
      targets.add(artifact.target);
      const url = parseUrl(artifact.url, `${file}: invalid artifact URL`);
      assert(url.protocol === "https:", `${file}: artifact URLs must use HTTPS`);
      assert(sha256Pattern.test(artifact.sha256 || ""), `${file}: invalid SHA-256 for ${version.version}/${artifact.target}`);
      assert(signingKeyIdPattern.test(artifact.signingKeyId || ""), `${file}: invalid signingKeyId for ${version.version}/${artifact.target}`);
      const signingKey = signingKeys.get(artifact.signingKeyId);
      assert(signingKey, `${file}: repository signing key '${artifact.signingKeyId}' is not registered`);
      assert(signingKey.status !== "preview", `${file}: preview signing key '${artifact.signingKeyId}' cannot publish catalog artifacts`);
      assert(!revoked.signingKeys.has(artifact.signingKeyId), `${file}: signing key '${artifact.signingKeyId}' is revoked`);
      assert(Number.isSafeInteger(artifact.size) && artifact.size >= 0 && artifact.size <= 512 * 1024 * 1024, `${file}: invalid artifact size for ${version.version}/${artifact.target}`);
    }
  }
  if (plugin.localizations !== undefined) {
    assert(plugin.localizations && typeof plugin.localizations === "object" && !Array.isArray(plugin.localizations), `${file}: localizations must be an object`);
    for (const [locale, localization] of Object.entries(plugin.localizations)) {
      assert(localization && typeof localization === "object" && !Array.isArray(localization), `${file}: localization '${locale}' must be an object`);
      assertExactKeys(localization, ["name", "description"], `${file}: localization '${locale}'`);
    }
  }
  // Advisory only: bilingual coverage is a store-side quality bar, not a
  // hard requirement — authors may submit single-language listings, so this
  // warns instead of failing and points at the maintainer's /localize fill.
  const listingLocales = plugin.localizations && typeof plugin.localizations === "object" && !Array.isArray(plugin.localizations) ? plugin.localizations : {};
  const hasLocale = (locale) => Boolean(listingLocales[locale]?.description?.trim());
  if (!hasLocale("zh-CN")) {
    console.warn(`::warning file=plugins/${file}::${plugin.id}: missing zh-CN localization — comment /localize on the PR to auto-fill`);
  }
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(String(plugin.description)) && !hasLocale("en")) {
    console.warn(`::warning file=plugins/${file}::${plugin.id}: Chinese base without an en localization — comment /localize on the PR to auto-fill`);
  }
}

async function loadCandidates(plugins) {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const entries = await directoryJsonFiles(candidatesDirectory);
  const candidates = [];
  const seen = new Set();
  for (const file of entries) {
    const file_ = path.join(candidatesDirectory, file);
    const candidate = JSON.parse(await readFile(file_, "utf8"));
    validateCandidate(candidate, file, publishers, revoked, byId.get(candidate?.id));
    assert(!seen.has(candidate.id), `${file}: duplicate candidate for plugin '${candidate.id}'`);
    seen.add(candidate.id);
    candidates.push(candidate);
  }
  return candidates;
}

function validateCandidate(candidate, file, publishers, revoked, existingPlugin) {
  assert(candidate && typeof candidate === "object" && !Array.isArray(candidate), `${file}: candidate metadata must be an object`);
  assertExactKeys(
    candidate,
    ["schemaVersion", "id", "publisher", "version", "releaseNotes", "name", "description", "icon", "tags", "permissions", "source", "homepage", "license", "localizations", "targets"],
    `${file}: candidate metadata`,
  );
  assert(candidate.schemaVersion === 1, `${file}: unsupported candidate schema version`);
  assert(identifierPattern.test(candidate.id || ""), `${file}: invalid plugin id`);
  assert(file === `${candidate.id}.json`, `${file}: filename must match plugin id '${candidate.id}.json'`);
  assert(identifierPattern.test(candidate.publisher || ""), `${file}: invalid publisher id`);
  const publisher = publishers.byId.get(candidate.publisher);
  assert(publisher, `${file}: publisher '${candidate.publisher}' is not registered`);
  if (existingPlugin) {
    assert(existingPlugin.publisher === candidate.publisher, `${file}: publisher '${candidate.publisher}' does not own plugin '${candidate.id}'`);
  }
  assert(semverPattern.test(candidate.version || ""), `${file}: version must use semantic versioning`);
  assert(!revoked.pluginVersions.has(`${candidate.id}@${candidate.version}`), `${file}: plugin version '${candidate.id}@${candidate.version}' is revoked`);
  if (existingPlugin) {
    assert(
      !existingPlugin.versions.some((version) => version.version === candidate.version),
      `${file}: version '${candidate.version}' is already listed for plugin '${candidate.id}'`,
    );
  }
  if (!existingPlugin) {
    assert(nonempty(candidate.name), `${file}: name is required for a new plugin listing`);
    assert(typeof candidate.source === "string" && candidate.source.startsWith("https://"), `${file}: source must be an HTTPS repository URL for review`);
    assert(nonempty(candidate.license), `${file}: license is required for a new plugin listing`);
  }
  for (const field of ["name", "description", "icon", "source", "homepage", "license"]) {
    if (candidate[field] !== undefined) assert(nonempty(candidate[field]), `${file}: '${field}' must be a non-empty string when provided`);
  }
  if (candidate.source !== undefined) assert(candidate.source.startsWith("https://"), `${file}: source must use HTTPS`);
  if (candidate.homepage !== undefined) assert(candidate.homepage.startsWith("https://") || candidate.homepage.startsWith("http://"), `${file}: homepage must use HTTP(S)`);
  if (candidate.icon !== undefined) assert(candidate.icon.startsWith("https://") || candidate.icon.startsWith("http://"), `${file}: icon must use HTTP(S)`);
  for (const field of ["tags", "permissions"]) {
    if (candidate[field] !== undefined) {
      assert(Array.isArray(candidate[field]) && candidate[field].every((entry) => nonempty(entry)) && new Set(candidate[field]).size === candidate[field].length, `${file}: '${field}' must be an array of unique non-empty strings`);
    }
  }
  if (candidate.localizations !== undefined) {
    assert(candidate.localizations && typeof candidate.localizations === "object" && !Array.isArray(candidate.localizations), `${file}: localizations must be an object`);
    for (const [locale, localization] of Object.entries(candidate.localizations)) {
      assert(localization && typeof localization === "object" && !Array.isArray(localization), `${file}: localization '${locale}' must be an object`);
      assertExactKeys(localization, ["name", "description"], `${file}: localization '${locale}'`);
    }
  }
  if (candidate.releaseNotes !== undefined) assert(typeof candidate.releaseNotes === "string", `${file}: releaseNotes must be a string`);
  assert(Array.isArray(candidate.targets) && candidate.targets.length > 0, `${file}: at least one candidate target is required`);
  const targets = new Set();
  for (const target of candidate.targets) {
    assert(target && typeof target === "object" && !Array.isArray(target), `${file}: target entries must be objects`);
    assertExactKeys(target, ["target", "url", "sha256", "size"], `${file}: candidate target '${target.target || "unknown"}'`);
    assert(/^[a-z0-9-]{1,64}$/.test(target.target || ""), `${file}: invalid target '${target.target}'`);
    assert(!targets.has(target.target), `${file}: duplicate target '${target.target}'`);
    targets.add(target.target);
    const url = parseUrl(target.url, `${file}: invalid candidate URL for '${target.target}'`);
    assert(url.protocol === "https:", `${file}: candidate URLs must use HTTPS`);
    assert(!target.url.startsWith(storeReleaseUrlPrefix), `${file}: candidate URLs must not reference DBX Store releases; submit the unsigned candidate artifact`);
    assert(sha256Pattern.test(target.sha256 || ""), `${file}: invalid SHA-256 for target '${target.target}'`);
    assert(Number.isSafeInteger(target.size) && target.size >= 1 && target.size <= 512 * 1024 * 1024, `${file}: invalid size for target '${target.target}'`);
  }
}

async function directoryJsonFiles(directory) {
  try {
    return (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function loadPublishers() {
  const byId = new Map();
  const files = (await readdir(publishersDirectory)).filter((file) => file.endsWith(".json")).sort();
  for (const file of files) {
    const publisher = JSON.parse(await readFile(path.join(publishersDirectory, file), "utf8"));
    assert(publisher && typeof publisher === "object" && !Array.isArray(publisher), `${file}: publisher record must be an object`);
    assertExactKeys(publisher, ["id", "name", "status"], `${file}: publisher record`);
    assert(identifierPattern.test(publisher.id || ""), `${file}: invalid publisher id`);
    assert(file === `${publisher.id}.json`, `${file}: filename must match publisher id '${publisher.id}.json'`);
    assert(!byId.has(publisher.id), `${file}: duplicate publisher id '${publisher.id}'`);
    assert(nonempty(publisher.name), `${file}: publisher name is required`);
    assert(nonempty(publisher.status), `${file}: publisher status is required`);
    byId.set(publisher.id, publisher);
  }
  return { byId };
}

async function loadRepositorySigningKeys() {
  const document = JSON.parse(await readFile(signingKeysPath, "utf8"));
  assert(document && typeof document === "object" && !Array.isArray(document), "signing-keys.json: document must be an object");
  assertExactKeys(document, ["version", "keys"], "signing-keys.json");
  assert(document.version === 1, "signing-keys.json: unsupported version");
  assert(Array.isArray(document.keys) && document.keys.length > 0, "signing-keys.json: at least one repository key is required");
  const keysById = new Map();
  for (const key of document.keys) {
    assert(key && typeof key === "object" && !Array.isArray(key), "signing-keys.json: key records must be objects");
    assertExactKeys(key, ["id", "algorithm", "publicKey", "status", "purpose"], `signing-keys.json: key '${key.id || "unknown"}'`);
    assert(signingKeyIdPattern.test(key.id || ""), `signing-keys.json: invalid key id '${key.id}'`);
    assert(!keysById.has(key.id), `signing-keys.json: duplicate key id '${key.id}'`);
    assert(key.algorithm === "ed25519", `signing-keys.json: key '${key.id}' must use ed25519`);
    assert(key.purpose === "repository-package-signing", `signing-keys.json: key '${key.id}' has an unsupported purpose`);
    assert(signingKeyStatuses.has(key.status), `signing-keys.json: key '${key.id}' has invalid status '${key.status}'`);
    assertEd25519PublicKey(key.publicKey, `signing-keys.json: key '${key.id}' has an invalid public key`);
    keysById.set(key.id, key);
  }
  return keysById;
}

async function loadRevocations() {
  const document = JSON.parse(await readFile(revokedPath, "utf8"));
  assert(document && typeof document === "object" && !Array.isArray(document), "revoked.json: document must be an object");
  assertExactKeys(document, ["version", "pluginVersions", "signingKeys"], "revoked.json");
  assert(document?.version === 1, "revoked.json: unsupported version");
  assert(Array.isArray(document.pluginVersions), "revoked.json: pluginVersions must be an array");
  assert(Array.isArray(document.signingKeys), "revoked.json: signingKeys must be an array");
  const pluginVersions = new Set();
  for (const entry of document.pluginVersions) {
    assert(entry && typeof entry === "object" && !Array.isArray(entry), "revoked.json: plugin version entries must be objects");
    assertExactKeys(entry, ["pluginId", "version"], "revoked.json: plugin version entry");
    assert(identifierPattern.test(entry.pluginId || ""), `revoked.json: invalid plugin id '${entry.pluginId}'`);
    assert(semverPattern.test(entry.version || ""), `revoked.json: invalid plugin version '${entry.version}'`);
    const identity = `${entry.pluginId}@${entry.version}`;
    assert(!pluginVersions.has(identity), `revoked.json: duplicate plugin version '${identity}'`);
    pluginVersions.add(identity);
  }
  for (const keyId of document.signingKeys) {
    assert(signingKeyIdPattern.test(keyId || ""), `revoked.json: invalid signing key id '${keyId}'`);
  }
  return { pluginVersions, signingKeys: new Set(document.signingKeys) };
}

function iconExtension(url) {
  const match = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname.split("/").pop() ?? "");
  const ext = match?.[1]?.toLowerCase();
  if (ext !== "svg" && ext !== "png") {
    throw new Error(`unsupported icon asset '${url}': plugin icons must be SVG or PNG files`);
  }
  return ext;
}

function normalizePlugin(plugin) {
  const normalized = structuredClone(plugin);
  normalized.verified = normalized.verified === true;
  normalized.description ||= "";
  normalized.tags ||= [];
  normalized.permissions ||= [];
  if (normalized.icon) normalized.icon = `${pluginIconPublicBaseUrl}/plugins/${normalized.id}/${normalized.latestVersion}/icon.${iconExtension(normalized.icon)}`;
  normalized.versions.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }));
  for (const version of normalized.versions) version.artifacts.sort((left, right) => left.target.localeCompare(right.target));
  return normalized;
}

async function rejectCommittedPackages(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await rejectCommittedPackages(entryPath);
    if (entry.isFile()) {
      assert(!entry.name.endsWith(".dbxp"), `Binary plugin package must not be committed: ${path.relative(root, entryPath)}`);
      const metadata = await stat(entryPath);
      assert(metadata.size <= 1024 * 1024, `Repository file exceeds 1 MiB: ${path.relative(root, entryPath)}`);
    }
  }
}

function parseUrl(value, message) {
  try {
    return new URL(value);
  } catch {
    throw new Error(message);
  }
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertEd25519PublicKey(value, message) {
  assert(typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value), message);
  assert(Buffer.from(value, "base64").length === 32, message);
}

function assertExactKeys(value, allowed, context) {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  assert(unknown.length === 0, `${context} contains unknown field(s): ${unknown.join(", ")}`);
}

function log(message) {
  console.error(message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
