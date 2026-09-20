# Contributing a plugin

Plugin submissions use a **single pull request**: you open one PR with the
candidate metadata, DBX Store reviews it, and the protected signing workflow
finalizes the catalog files on the same PR automatically. There is no separate
submission issue.

Do not submit ordinary plugin source code to `t8y2/dbx`. Keep it in the plugin's own source repository. Pull requests to `t8y2/dbx` are only for the host platform, SDKs, CLI, schemas, documentation, and official examples.

## Submission checklist

1. Publish the plugin source in a publicly reviewable repository.
2. Build one unsigned `.dbxp` candidate per supported target and publish the artifacts at immutable HTTPS URLs (for example your repository's Release, object storage, or CDN).
3. Fork `t8y2/dbx-store` and open a pull request against `main` containing:
   - `publishers/<publisher-id>.json` — first submission only;
   - `candidates/<plugin-id>.json` — the candidate metadata below.
4. Fill in the pull request template: capabilities, permissions, data access, network access, and native sidecar behavior.
5. CI validates the candidate and stays **red** with `open candidate(s) awaiting DBX Store signing` until signing completes. This is intentional — it blocks merging unsigned work.
6. After review, a DBX maintainer runs the protected **Sign plugin PR candidates** workflow on your pull request. The workflow syncs your branch with its base branch, verifies the pinned candidate bytes, signs them with the repository key, publishes immutable signed assets to the configured R2 bucket, and commits the finalized `plugins/<plugin-id>.json`, the regenerated `catalog/index.json`, and the removal of `candidates/<plugin-id>.json` back to your PR branch.
7. Once CI is green, a maintainer merges the pull request.

The store automation polls repositories listed in `automation/plugin-sources.json` and creates or updates candidate PRs. It requires the protected signing workflow and a maintainer merge; the automation App must not have access to `DBX_STORE_SIGNING_KEY`.

To enable this automation, install a dedicated GitHub App on `t8y2/dbx-store` with only Metadata read, Contents read/write, and Pull requests read/write permissions. Configure `DBX_STORE_AUTOMATION_APP_ID` and `DBX_STORE_AUTOMATION_APP_PRIVATE_KEY` only as Actions secrets in `dbx-store`. These credentials are for opening catalog PRs only and must be different from the signing secret. Register a public plugin repository with `autoUpdate: true` in `automation/plugin-sources.json`; plugin repositories need no automation secret.

For an already-listed plugin, the synchronizer only needs the repository release and `release-candidates.json`; `.dbx-store.json` is optional and is used only for first-submission metadata or intentional listing updates.

For a new version of an already-listed plugin, submit `candidates/<plugin-id>.json` with the new version only; listing fields you omit keep their current values, and any field you include replaces the stored value. The publisher must already own the plugin.

## Candidate file format

`candidates/<plugin-id>.json` (validated by `node scripts/validate.mjs`, schema in `schemas/plugin-candidate.schema.json`):

```json
{
  "schemaVersion": 1,
  "id": "com.example.plugin",
  "publisher": "example",
  "version": "1.0.0",
  "name": "Example Plugin",
  "description": "One-line description shown in the marketplace.",
  "icon": "https://example.com/icon.svg",
  "tags": ["files"],
  "permissions": ["host.events"],
  "source": "https://github.com/example/dbx-plugin/tree/v1.0.0",
  "homepage": "https://github.com/example/dbx-plugin",
  "license": "Apache-2.0",
  "releaseNotes": "Initial release.",
  "localizations": {
    "zh-CN": {
      "name": "示例插件",
      "description": "面向中文界面的一行描述。"
    }
  },
  "targets": [
    {
      "target": "darwin-arm64",
      "url": "https://github.com/example/dbx-plugin/releases/download/v1.0.0/com.example.plugin-1.0.0-darwin-arm64.dbxp",
      "sha256": "<64 hex chars of the unsigned candidate>",
      "size": 123456
    }
  ]
}
```

For a **new** plugin, `name`, `source`, and `license` are required; every other
listing field is optional. Candidate rules:

- `sha256` and `size` pin the exact unsigned candidate bytes; signing rejects any mismatch.
- The unsigned package's `manifest.json` must declare the same `id`, `version`, and `publisher` as the candidate metadata; signing rejects any mismatch.
- URLs must use HTTPS and must not reference `t8y2/dbx-store` releases (submit your own unsigned candidates, not already-signed artifacts).
- A version that is already listed, or revoked, cannot be resubmitted.
- `localizations` (optional) carries per-locale `name`/`description` entries for the marketplace listing. The recommended shape is an English base `description` plus a `zh-CN` entry: Chinese-locale clients resolve the `zh-CN` entry and every other locale falls back to the base description. Submissions without localizations are accepted; the store adds translated listing text before publishing.
- `plugins/*.json` and `catalog/index.json` are never edited manually; the signing workflow generates them.

Do not include plugin source directories, `.dbxp` binaries, signing private keys, or tokens.

## What the signing workflow does

`Sign plugin PR candidates` (triggered by a maintainer's `/sign` PR comment or a manual
workflow_dispatch on a PR number; environment
`plugin-signing` for non-owners or `plugin-signing-owner` for `t8y2`) first syncs the
PR branch with the base branch's store state, then verifies the repository key state, re-validates the PR tree,
downloads each pinned candidate, checks that packages are unsigned and their
manifest identity matches, signs with the protected `DBX_STORE_SIGNING_KEY`,
publishes the signed `.dbxp` plus artifact metadata and a signing receipt to
releases tagged `<plugin-id>-<version>`, and pushes the finalized catalog back
to the PR. Pushing back to fork PRs requires the `DBX_STORE_BOT_TOKEN` secret
and maintainer edits enabled; otherwise the workflow attaches the finalized
change as a patch artifact for manual application.

## Review boundaries

- The `verified` flag is assigned by DBX maintainers; submissions must leave it `false` unless a maintainer changes it during review.
- A plugin ID and publisher identity cannot be transferred silently.
- Every official artifact `signingKeyId` must reference a non-revoked DBX Store repository key from `signing-keys.json`.
- Publisher records establish attribution and review ownership; they do not grant cryptographic trust and do not contain signing keys.
- Release URLs must be immutable or version-addressed.
- Candidate SHA-256 and size values pin the reviewed bytes; signing does not trust a URL alone.
- Published signed assets are immutable and cannot be overwritten in place.
- Private keys, access tokens, `.dbxp` binaries, and other secrets must not be committed or exposed to plugin-author repositories.
- A reviewed update may still be rejected for excessive permissions, unclear licensing, unsafe native behavior, or unverifiable source-to-binary provenance.

The initial repository does not promise an automatic approval SLA. Review policy can evolve without changing the catalog v1 client protocol.
