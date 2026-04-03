#!/usr/bin/env node
/**
 * Claude Code Statusline Bridge
 *
 * This script runs as a Claude Code statusline plugin.
 * It reads stdin JSON data from Claude Code and writes it to a temp file
 * that the VS Code extension can watch.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

const DATA_DIR = join(homedir(), '.claude-code-hud');
const DATA_FILE = join(DATA_DIR, 'status.json');

async function main() {
  if (process.stdin.isTTY) {
    process.exit(0);
  }

  const chunks = [];
  process.stdin.setEncoding('utf8');

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const raw = chunks.join('');
  if (!raw.trim()) {
    process.exit(0);
  }

  try {
    const data = JSON.parse(raw);

    // Extract the fields we care about
    const output = {
      timestamp: Date.now(),
      model: data.model || null,
      context_window: data.context_window || null,
      rate_limits: data.rate_limits || null,
      cwd: data.cwd || null,
    };

    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  } catch {
    // silently ignore parse errors
  }

  // Output minimal statusline (required by Claude Code)
  process.stdout.write('');
}

main().catch(() => process.exit(1));
