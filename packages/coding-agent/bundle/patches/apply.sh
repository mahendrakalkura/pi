# Applies patches/chrome-devtools-mcp.patch to node_modules after every `npm install` in
# packages/coding-agent/bundle. The patch makes chrome-devtools-mcp emulate a focused page only on
# pages a tool works with, so Pi leaves the user's other Chromium tabs hidden and throttled.
set -euo pipefail
cd "$(dirname "$0")/.."

target=node_modules/chrome-devtools-mcp
patch_file="$PWD/patches/chrome-devtools-mcp.patch"

# An already patched tree reverses cleanly, so there is nothing to do.
if patch --dry-run --reverse --force --silent -p1 -d "$target" -i "$patch_file" > /dev/null 2>&1; then
    exit 0
fi

# A version bump that moves the patched lines fails here, before any file is touched.
if ! patch --dry-run --forward --force --silent -p1 -d "$target" -i "$patch_file" > /dev/null; then
    echo "patches/chrome-devtools-mcp.patch no longer applies to $target; rebase the patch onto the new version" >&2
    exit 1
fi
patch --forward --force --silent --no-backup-if-mismatch -p1 -d "$target" -i "$patch_file"
