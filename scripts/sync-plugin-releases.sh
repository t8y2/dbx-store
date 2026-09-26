#!/usr/bin/env bash
# Sync discovered plugin releases into unsigned catalog candidate PRs.
#
# A release/metadata/candidate problem belongs to a single plugin: report it
# with its repository, tag and plugin id, restore the workspace state that
# plugin produced, and keep syncing the remaining plugins. Registry/discovery,
# Git and GitHub infrastructure failures still abort the whole run.
set -euo pipefail

releases_file="${1:-/tmp/dbx-plugin-releases.json}"

if [ ! -f "$releases_file" ]; then
  echo "::error::Release discovery plan not found: $releases_file" >&2
  exit 1
fi

# A corrupt discovery result must fail the run instead of silently syncing
# nothing: the loop below only sees records, not whether the plan is usable.
node -e '
  const fs = require("node:fs");
  const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(plan)) throw new Error("release discovery plan must be an array");
' "$releases_file"

# Restore candidates/<plugin>.json to the committed state of the current
# branch. Only the candidate produced by the failing plugin is touched, so a
# tracked candidate that predates this run survives untouched.
restore_candidate() {
  local candidate="$1"
  git reset --quiet -- "$candidate" 2>/dev/null || true
  if git cat-file -e "HEAD:${candidate}" 2>/dev/null; then
    git checkout HEAD -- "$candidate"
  else
    rm -f -- "$candidate"
  fi
  # validate.mjs regenerates catalog/index.json as a side effect; drop any
  # local rewrite so the next plugin starts from a clean tree.
  git reset --quiet -- catalog/index.json 2>/dev/null || true
  if git cat-file -e "HEAD:catalog/index.json" 2>/dev/null; then
    git checkout HEAD -- catalog/index.json
  fi
  # Remove the directory this run may have created, but never a non-empty one
  # that holds tracked or user candidates.
  rmdir candidates 2>/dev/null || true
}

# Report a per-plugin candidate validation failure without failing the run.
# The annotation keeps the repository, tag and plugin id visible in the
# Actions summary even though the step continues.
report_validation_failure() {
  local description="$1"
  local validation_error="$2"
  local message
  message="$(printf '%s\n' "$validation_error" | awk '/^Error:/ { sub(/^Error: /, ""); print; exit }')"
  if [ -z "$message" ]; then
    message="$(printf '%s\n' "$validation_error" | awk 'NF { print; exit }')"
  fi
  echo "::warning title=Candidate validation failed for ${description}::candidate validation failed for ${description}: ${message}"
}

while IFS=$'\t' read -r repository tag release_url candidates_url metadata_url; do
  [ -n "$repository" ] || continue
  node scripts/sync-release-candidate.mjs \
    --repository "$repository" \
    --tag "$tag" \
    --release-candidates-url "$candidates_url" \
    --metadata-url "$metadata_url" \
    --output /tmp/plugin-candidate.json \
    || { echo "::warning::skipping ${repository}@${tag}: candidate processing failed"; continue; }
  if ! read -r plugin_id plugin_version < <(node -e '
    const fs = require("node:fs");
    const candidate = JSON.parse(fs.readFileSync("/tmp/plugin-candidate.json", "utf8"));
    process.stdout.write(`${candidate.id} ${candidate.version}\n`);
  ' 2>/dev/null); then
    echo "::warning::skipping ${repository}@${tag}: candidate identity could not be read"
    continue
  fi
  if node -e '
    const fs = require("node:fs");
    const file = `plugins/${process.argv[1]}.json`;
    if (!fs.existsSync(file)) process.exit(1);
    const plugin = JSON.parse(fs.readFileSync(file, "utf8"));
    process.exit(plugin.versions.some((entry) => entry.version === process.argv[2]) ? 0 : 1);
  ' "$plugin_id" "$plugin_version"; then
    echo "$plugin_id@$plugin_version is already listed; skipping"
    continue
  fi
  branch="automation/plugin-release/${plugin_id}/${plugin_version}"
  if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    git fetch origin "$branch"
    git checkout -B "$branch" "origin/$branch"
  else
    git checkout -B "$branch" origin/main
  fi
  if node -e '
    const fs = require("node:fs");
    const file = `plugins/${process.argv[1]}.json`;
    if (!fs.existsSync(file)) process.exit(1);
    const plugin = JSON.parse(fs.readFileSync(file, "utf8"));
    process.exit(plugin.versions.some((entry) => entry.version === process.argv[2]) ? 0 : 1);
  ' "$plugin_id" "$plugin_version"; then
    echo "$plugin_id@$plugin_version is already finalized; skipping"
    continue
  fi
  if ! node scripts/sync-release-candidate.mjs \
    --repository "$repository" \
    --tag "$tag" \
    --release-candidates-url "$candidates_url" \
    --metadata-url "$metadata_url" \
    --output "candidates/${plugin_id}.json"; then
    echo "::warning::skipping ${repository}@${tag}: candidate writing failed"
    restore_candidate "candidates/${plugin_id}.json"
    continue
  fi
  if ! validation_error="$(node scripts/validate.mjs --plan-candidates 2>&1 >/dev/null)"; then
    report_validation_failure "${repository}@${tag} (plugin ${plugin_id}@${plugin_version})" "$validation_error"
    restore_candidate "candidates/${plugin_id}.json"
    continue
  fi
  git config user.name "dbx-store-automation[bot]"
  git config user.email "dbx-store-automation[bot]@users.noreply.github.com"
  git add "candidates/${plugin_id}.json"
  if git diff --cached --quiet; then
    echo "$plugin_id@$plugin_version candidate is unchanged"
  else
    git commit -m "chore(store): sync ${plugin_id}@${plugin_version} candidate"
    git push --force-with-lease --set-upstream origin "$branch"
  fi
  title="feat(store): submit ${plugin_id}@${plugin_version}"
  cat > /tmp/pr-body.md <<EOF
Automated catalog sync from [${repository}](https://github.com/${repository}) release [${tag}](${release_url}).

This PR contains unsigned candidate metadata only. A DBX Store maintainer must review it and run the protected signing workflow before merge.
EOF
  pr=$(gh pr list --repo "$GITHUB_REPOSITORY" --head "$branch" --state open --json number --jq '.[0].number // empty')
  if [ -n "$pr" ]; then
    gh pr edit "$pr" --repo "$GITHUB_REPOSITORY" --title "$title" --body-file /tmp/pr-body.md
    echo "Updated PR #$pr"
  else
    gh pr create --repo "$GITHUB_REPOSITORY" --base main --head "$branch" --title "$title" --body-file /tmp/pr-body.md
  fi
done < <(node -e '
  const fs = require("node:fs");
  for (const release of JSON.parse(fs.readFileSync(process.argv[1], "utf8"))) {
    console.log([release.repository, release.tag, release.releaseUrl, release.releaseCandidatesUrl, release.metadataUrl].join("\t"));
  }
' "$releases_file")
