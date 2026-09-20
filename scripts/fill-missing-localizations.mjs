import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Fill missing marketplace localizations so every listing is bilingual:
// Chinese-locale clients resolve Chinese, every other locale falls back to
// the English base (pluginMarketplace.ts: exact locale, then language
// prefix, then base description). Deterministic steps (mirroring the base
// into `en`, zh-CN into `zh`) run in code; only real translation goes
// through the LLM, so the model can never touch structure or artifacts.
//
// Standing policy (approved by the store maintainer, 2026-09-20):
//   - base name/description is normalized to English; when a listing was
//     submitted with a Chinese base, the original copy is preserved in its
//     zh-CN/zh entries verbatim;
//   - a plain `zh` entry mirrors zh-CN so zh-TW clients hit Chinese through
//     the language-prefix match (skipped when a native zh-TW entry exists,
//     e.g. io.dbx.kafka);
//   - kafka-style extra locales (es/it/ja/pt-BR/zh-TW) are author data and
//     are never generated or modified here.
//
// Usage: node scripts/fill-missing-localizations.mjs [--dry-run] [plugin-id ...]
// Env:   DBX_LOCALIZE_API_KEY (required for translations)
//        DBX_LOCALIZE_MODEL    (default: deepseek-flash)
//        DBX_LOCALIZE_BASE_URL (default: https://api.deepseek.com)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Candidates are filled too: a first submission lives only in candidates/
// until signing promotes it to plugins/, so localizations added there flow
// through finalize-candidates.mjs into the published entry.
const listingDirectories = [
  path.join(root, "plugins"),
  path.join(root, "candidates"),
];
const dryRun = process.argv.includes("--dry-run");
const onlyIds = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith("--")));

const cjkPattern = /[\u3400-\u9fff\uf900-\ufaff]/;
const hasCJK = (value) => cjkPattern.test(value || "");

const apiKey = process.env.DBX_LOCALIZE_API_KEY;
const model = process.env.DBX_LOCALIZE_MODEL || "deepseek-flash";
const baseUrl = (process.env.DBX_LOCALIZE_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");

// Style anchors taken from human-reviewed catalog entries so generated
// translations match the tone of the existing store copy.
const styleExamples = [
  {
    en: "A Postman-style HTTP workbench: compose requests, send them through a native sidecar, and inspect responses.",
    zh: "类似 Postman 的 HTTP 接口调试作台构造请求、通过原生 Sidecar 发送并查看响应。",
  },
  {
    en: "Manage Kubernetes clusters, workloads and resources from DBX.",
    zh: "在 DBX 中管理 Kubernetes 集群、工作负载和资源。",
  },
];

async function translate({ name, description }, targetLocale) {
  if (!apiKey) throw new Error("DBX_LOCALIZE_API_KEY is not set; cannot translate");
  const intoChinese = targetLocale === "zh-CN";
  const instructions = intoChinese
    ? "Translate the plugin listing below into natural Simplified Chinese for a developer-facing plugin marketplace."
    : "Translate the plugin listing below into concise natural English for a developer-facing plugin marketplace.";
  const rules = [
    instructions,
    "Keep product and proper nouns verbatim (DBX, XXL-JOB, draw.io, Kafka, LeetCode, S3, ...).",
    intoChinese
      ? "Translate the name only if a natural Chinese name exists; otherwise keep it unchanged."
      : "Keep the name unchanged unless it contains Chinese words with an obvious English equivalent.",
    "Match the length, register and sentence style of the examples. Full sentences, no bullet lists, no quotes.",
    'Reply with ONLY a JSON object: {"name": "...", "description": "..."} and nothing else.',
  ];
  const userPrompt = [
    ...rules,
    "",
    "Examples of the store's tone:",
    ...styleExamples.map((example) => `EN: ${example.en}\nZH: ${example.zh}`),
    "",
    `Now translate this listing to ${intoChinese ? "Simplified Chinese" : "English"}:`,
    `name: ${name}`,
    `description: ${description}`,
  ].join("\n");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: userPrompt }],
      max_tokens: 4096,
      temperature: 0.2,
    }),
  });
  if (!response.ok) {
    throw new Error(`translate: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content || "";
  const jsonText = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`translate: model returned non-JSON output: ${content.slice(0, 200)}`);
  }
  const translatedName = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const translatedDescription = typeof parsed.description === "string" ? parsed.description.trim() : "";
  if (!translatedName || !translatedDescription) {
    throw new Error(`translate: model returned empty fields: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return { name: translatedName, description: translatedDescription };
}

async function fillListing(plugin) {
  const original = { name: plugin.name, description: plugin.description };
  const localizations = plugin.localizations || {};
  const baseZh = hasCJK(plugin.description);
  const actions = [];
  let changed = false;

  const entry = (locale) => localizations[locale] || (localizations[locale] = {});
  const hasEntry = (locale) => Boolean(localizations[locale]?.description?.trim());

  if (baseZh && !hasEntry("en")) {
    const translated = await translate(original, "en");
    entry("en").name = translated.name;
    entry("en").description = translated.description;
    actions.push(`en (translated)`);
    changed = true;
  }
  if (baseZh && !hasEntry("zh-CN")) {
    entry("zh-CN").name = original.name;
    entry("zh-CN").description = original.description;
    actions.push("zh-CN (preserved original)");
    changed = true;
  }
  if (!baseZh && !hasEntry("zh-CN")) {
    const translated = await translate(original, "zh-CN");
    entry("zh-CN").name = translated.name;
    entry("zh-CN").description = translated.description;
    actions.push("zh-CN (translated)");
    changed = true;
  }
  if (!hasEntry("en")) {
    entry("en").name = plugin.name;
    entry("en").description = plugin.description;
    actions.push("en (mirrored base)");
    changed = true;
  }
  const hasChineseVariant = Object.keys(localizations).some((locale) => locale === "zh" || locale === "zh-TW");
  if (hasEntry("zh-CN") && !hasChineseVariant) {
    localizations.zh = {
      name: localizations["zh-CN"].name,
      description: localizations["zh-CN"].description,
    };
    actions.push("zh (mirrored zh-CN)");
    changed = true;
  }
  if (baseZh && hasEntry("en")) {
    // English base is the fallback for locales without a matching entry.
    plugin.name = localizations.en.name;
    plugin.description = localizations.en.description;
    actions.push("base -> English");
    changed = true;
  }
  if (changed) plugin.localizations = localizations;
  return { actions, changed };
}

const plan = [];
for (const directory of listingDirectories) {
  let names;
  try {
    names = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
  } catch {
    continue; // candidates/ may not exist on every checkout
  }
  for (const file of names) {
    const plugin = JSON.parse(await readFile(path.join(directory, file), "utf8"));
    if (onlyIds.size > 0 && !onlyIds.has(plugin.id)) continue;
    const { actions, changed } = await fillListing(plugin);
    if (changed) plan.push({ id: plugin.id, directory, file, actions, plugin });
  }
}

for (const item of plan) {
  if (dryRun) {
    console.log(`[dry-run] ${item.id}: ${item.actions.join(", ")}`);
  } else {
    await writeFile(
      path.join(item.directory, item.file),
      `${JSON.stringify(item.plugin, null, 2)}\n`,
    );
    console.log(`filled ${item.id}: ${item.actions.join(", ")}`);
  }
}
if (plan.length === 0) console.log("No localization gaps found.");
else if (!dryRun) console.log(`\nRegenerate the catalog with: node scripts/validate.mjs`);
