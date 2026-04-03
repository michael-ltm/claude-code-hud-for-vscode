#!/bin/bash
# Claude Code Statusline Bridge
# This script is used as a Claude Code statusline plugin.
# It reads JSON data from stdin and writes it to a temp file
# that the VS Code extension watches.

DATA_FILE="${TMPDIR:-/tmp}/claude-code-hud-data.json"

# Read all stdin
INPUT=$(cat)

# Write to data file atomically
echo "$INPUT" > "${DATA_FILE}.tmp" && mv "${DATA_FILE}.tmp" "$DATA_FILE"

# Output a minimal statusline (required by Claude Code)
echo ""
