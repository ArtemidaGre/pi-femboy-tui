#!/usr/bin/env bash
# Offline checks for the femboy package: real pi packages + real loader (jiti),
# no TUI and no model call. Pass --show to print a sample panel/rows/overlay.
#
# Run from anywhere; both checks import the extension sources relative to
# tools/, so the repo's own node_modules (npm install) supplies pi's packages.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -d "$root/node_modules/@earendil-works/pi-tui" ]]; then
  echo "missing devDependencies — run: npm install" >&2
  exit 2
fi

node "$root/tools/link-check.mjs"
node "$root/tools/render-check.mjs" "$@"
