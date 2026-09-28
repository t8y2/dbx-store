#!/usr/bin/env bash
# Test double for the GitHub CLI used by the release sync tests. It records
# nothing and never touches GitHub; tests control the two observable paths
# through environment variables.
set -euo pipefail

if [ "${1:-}" = "pr" ] && [ "${2:-}" = "list" ]; then
  head=""
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --head)
        head="${2:-}"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  if [ -n "${STUB_GH_EXISTING_BRANCH:-}" ] && [ "$head" = "$STUB_GH_EXISTING_BRANCH" ]; then
    echo "123"
  fi
  exit 0
fi

if [ "${1:-}" = "pr" ] && [ "${2:-}" = "create" ]; then
  if [ "${STUB_GH_FAIL_CREATE:-}" = "1" ]; then
    echo "stub gh pr create failure" >&2
    exit 1
  fi
  echo "created pull request for ${GITHUB_REPOSITORY:-unknown}"
  exit 0
fi

if [ "${1:-}" = "pr" ] && [ "${2:-}" = "edit" ]; then
  echo "updated pull request"
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 1
