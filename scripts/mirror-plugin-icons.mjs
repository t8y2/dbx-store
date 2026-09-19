import { readFile } from "node:fs/promises";

const catalog = JSON.parse(await readFile("catalog/index.json", "utf8"));

for (const plugin of catalog.plugins) {
  // Icons are optional; the client falls back to a default glyph when none is mirrored.
  if (!plugin.icon) continue;
  const expectedPrefix = `https://dl.dbxio.com/plugins/${plugin.id}/${plugin.latestVersion}/icon.`;
  if (!plugin.icon.startsWith(expectedPrefix)) throw new Error(`Unexpected catalog icon URL for ${plugin.id}: ${plugin.icon}`);
  const extension = plugin.icon.slice(expectedPrefix.length);
  if (!/^(svg|png)$/.test(extension)) throw new Error(`Unsupported icon extension for ${plugin.id}: ${extension}`);
  const version = plugin.versions.find((entry) => entry.version === plugin.latestVersion);
  const artifact = version?.artifacts[0];
  if (!artifact) throw new Error(`Missing latest artifact for ${plugin.id}@${plugin.latestVersion}`);
  process.stdout.write(`${plugin.id}\t${plugin.latestVersion}\t${artifact.url}\tplugins/${plugin.id}/${plugin.latestVersion}/icon.${extension}\n`);
}
