# Applies every patch below to node_modules after every `npm install` in packages/coding-agent/bundle.
# - chrome-devtools-mcp.patch makes chrome-devtools-mcp name the CDP target of every page it lists, so
#   the browser guard in the dotfiles knows which window holds each page.
# - pi-lsp-adapter.patch keeps the language servers of every live owner in this process, so a
#   subagent child's startup cleanup never terminates its parent's servers.
# - pi-subagents.patch hands a child session the inline extensions that subagents.json
#   `childInlineExtensions` names, out of the ones Pi's main() publishes on globalThis, and gives an
#   agent whose `tools:` holds `*` the main session's own tool selection. It also runs a resume with
#   run_in_background: true in the background and rejects foreground subagent tool calls in the TUI.
set -euo pipefail
cd "$(dirname "$0")/.."

# apply_patch applies patches/<patch> to node_modules/<package>, once.
apply_patch() {
    local target="node_modules/$1"
    local patch_file="$PWD/patches/$2"

    # An already patched tree reverses cleanly, so there is nothing to do.
    if patch --dry-run --reverse --force --silent -p1 -d "$target" -i "$patch_file" > /dev/null 2>&1; then
        return 0
    fi

    # A version bump that moves the patched lines fails here, before any file is touched.
    if ! patch --dry-run --forward --force --silent -p1 -d "$target" -i "$patch_file" > /dev/null; then
        echo "patches/$2 no longer applies to $target; rebase the patch onto the new version" >&2
        exit 1
    fi
    patch --forward --force --silent --no-backup-if-mismatch -p1 -d "$target" -i "$patch_file"
}

apply_patch "@gotgenes/pi-subagents" pi-subagents.patch
apply_patch pi-lsp-adapter pi-lsp-adapter.patch
apply_patch chrome-devtools-mcp chrome-devtools-mcp.patch
