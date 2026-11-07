import { readFile, writeFile } from "node:fs/promises";

const registryPath = process.argv[2] || "automation/plugin-sources.json";
const outputPath = process.argv[3] || "/tmp/dbx-plugin-releases.json";
const registry = JSON.parse(await readFile(registryPath, "utf8"));
if (registry.version !== 1 || !Array.isArray(registry.plugins)) throw new Error("Unsupported plugin source registry");

const discovered = [];
for (const source of registry.plugins) {
  if (source.autoUpdate !== true) continue;
  assertRepository(source.repository);
  let releases;
  try {
    releases = await fetchJson(`https://api.github.com/repos/${source.repository}/releases?per_page=30`);
  } catch (error) {
    // A deleted/private/renamed upstream repo must not take down discovery
    // for every other plugin; report it and keep going.
    console.warn(`::warning::skipping ${source.repository}: ${error.message}`);
    continue;
  }
  const release = releases.find((entry) => !entry.draft && !entry.prerelease && entry.assets.some((asset) => asset.name === "release-candidates.json"));
  if (!release) {
    console.log(`No published candidate release found for ${source.repository}`);
    continue;
  }
  const candidateAsset = release.assets.find((asset) => asset.name === "release-candidates.json");
  assertUrl(candidateAsset.browser_download_url, `${source.repository} candidate URL`);
  const metadataPath = source.metadataPath || ".dbx-store.json";
  if (!/^\.?[A-Za-z0-9._/-]+$/.test(metadataPath) || metadataPath.includes("..")) throw new Error(`Invalid metadata path for ${source.repository}`);
  discovered.push({
    repository: source.repository,
    tag: release.tag_name,
    releaseUrl: release.html_url,
    releaseCandidatesUrl: candidateAsset.browser_download_url,
    metadataUrl: `https://raw.githubusercontent.com/${source.repository}/${encodeURIComponent(release.tag_name)}/${metadataPath.replace(/^\/+/, "")}`,
  });
}

await writeFile(outputPath, `${JSON.stringify(discovered, null, 2)}\n`);
console.log(`Discovered ${discovered.length} plugin release(s)`);

function assertRepository(value) {
  if (!/^[^/]+\/[A-Za-z0-9._-]+$/.test(value || "")) throw new Error(`Invalid plugin repository '${value}'`);
}

function assertUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
}

async function fetchJson(url) {
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.json();
}
