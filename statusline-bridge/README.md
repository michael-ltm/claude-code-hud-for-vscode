# Claude Code HUD Bridge

This is a statusline bridge script for Claude Code that feeds data to the VS Code extension.

## Setup

Add this to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "plugins": {
    "statusline": "path/to/claude-hud-bridge.sh"
  }
}
```

Or the VS Code extension will set this up automatically via the setup command.
