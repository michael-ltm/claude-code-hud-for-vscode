import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import type { HudData } from './types';

const DATA_FILE = path.join(os.homedir(), '.claude-code-hud', 'status.json');

// Stale threshold: if data is older than 30s, consider it inactive
const STALE_MS = 30_000;

let modelItem: vscode.StatusBarItem;
let contextItem: vscode.StatusBarItem;
let fiveHourItem: vscode.StatusBarItem;
let sevenDayItem: vscode.StatusBarItem;
let timer: ReturnType<typeof setInterval> | undefined;
let fileWatcher: fs.FSWatcher | undefined;

export function activate(context: vscode.ExtensionContext) {
  // Create status bar items (right-aligned, ordered by priority)
  modelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
  contextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 199);
  fiveHourItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 198);
  sevenDayItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 197);

  context.subscriptions.push(modelItem, contextItem, fiveHourItem, sevenDayItem);

  // Auto-configure Claude Code statusline bridge on activation
  autoConfigureBridge(context);

  // Initial update
  updateStatusBar();

  // Watch for file changes
  startFileWatcher(context);
  // Re-create watcher periodically in case dir was created after extension started
  const watcherCheck = setInterval(() => {
    if (!fileWatcher) {
      startFileWatcher(context);
    }
  }, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(watcherCheck) });

  // Also poll as a fallback (for stale detection & in case watch misses events)
  const config = vscode.workspace.getConfiguration('claudeCodeHud');
  const interval = config.get<number>('refreshInterval', 1000);
  timer = setInterval(updateStatusBar, interval);
  context.subscriptions.push({ dispose: () => { if (timer) clearInterval(timer); } });

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeCodeHud')) {
        updateStatusBar();
        if (timer) clearInterval(timer);
        const newInterval = vscode.workspace.getConfiguration('claudeCodeHud').get<number>('refreshInterval', 1000);
        timer = setInterval(updateStatusBar, newInterval);
      }
    })
  );

  // Register manual setup command as fallback
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeHud.setup', () => configureBridge(context))
  );
}

/**
 * Auto-configure the Claude Code statusline bridge.
 * Runs `claude config set statusline "node <bridge.mjs>"` silently on activation.
 */
function autoConfigureBridge(context: vscode.ExtensionContext) {
  const bridgePath = path.join(context.extensionPath, 'statusline-bridge', 'bridge.mjs');
  if (!fs.existsSync(bridgePath)) {
    return;
  }

  // Check if already configured with this exact path (avoid re-running every activation)
  const markerFile = path.join(context.globalStorageUri.fsPath, 'configured-bridge-path.txt');
  try {
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    if (fs.existsSync(markerFile)) {
      const savedPath = fs.readFileSync(markerFile, 'utf8').trim();
      if (savedPath === bridgePath) {
        // Already configured with same path, skip
        return;
      }
    }
  } catch {
    // continue with configuration
  }

  // Find claude CLI
  const claudeCmd = process.platform === 'win32' ? 'claude.exe' : 'claude';

  // Run: claude config set statusline "node /path/to/bridge.mjs"
  const statuslineValue = `node ${bridgePath}`;
  execFile(claudeCmd, ['config', 'set', 'statusline', statuslineValue], { timeout: 10000 }, (err) => {
    if (err) {
      // claude CLI not found or failed - try common paths
      const fallbackPaths = getFallbackClaudePaths();
      tryFallbackConfigure(fallbackPaths, statuslineValue, markerFile, bridgePath);
      return;
    }
    // Save marker so we don't re-run next time
    try { fs.writeFileSync(markerFile, bridgePath); } catch { /* ignore */ }
  });
}

function getFallbackClaudePaths(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      path.join(home, 'AppData', 'Local', 'npm', 'claude.cmd'),
      path.join(home, '.npm-global', 'bin', 'claude.cmd'),
    ];
  }
  return [
    '/usr/local/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
  ];
}

function tryFallbackConfigure(paths: string[], statuslineValue: string, markerFile: string, bridgePath: string) {
  if (paths.length === 0) {
    // All fallbacks exhausted - write config file directly
    writeConfigDirectly(statuslineValue, markerFile, bridgePath);
    return;
  }
  const claudePath = paths.shift()!;
  if (!fs.existsSync(claudePath)) {
    tryFallbackConfigure(paths, statuslineValue, markerFile, bridgePath);
    return;
  }
  execFile(claudePath, ['config', 'set', 'statusline', statuslineValue], { timeout: 10000 }, (err) => {
    if (err) {
      tryFallbackConfigure(paths, statuslineValue, markerFile, bridgePath);
      return;
    }
    try { fs.writeFileSync(markerFile, bridgePath); } catch { /* ignore */ }
  });
}

/**
 * If claude CLI is not available, write the config directly to ~/.claude/settings.json
 */
function writeConfigDirectly(statuslineValue: string, markerFile: string, bridgePath: string) {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
    // Only set if not already configured
    if (settings['statusline'] !== statuslineValue) {
      settings['statusline'] = statuslineValue;
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
    try { fs.writeFileSync(markerFile, bridgePath); } catch { /* ignore */ }
  } catch {
    // Last resort failed - user will need manual setup
  }
}

async function configureBridge(context: vscode.ExtensionContext) {
  const bridgePath = path.join(context.extensionPath, 'statusline-bridge', 'bridge.mjs');

  if (!fs.existsSync(bridgePath)) {
    vscode.window.showErrorMessage('Bridge script not found. Please reinstall the extension.');
    return;
  }

  const statuslineValue = `node ${bridgePath}`;
  const settingsCmd = `claude config set statusline "${statuslineValue}"`;

  const result = await vscode.window.showInformationMessage(
    'Configure Claude Code statusline bridge?',
    { modal: true, detail: `This will run:\n${settingsCmd}` },
    'Auto Configure',
    'Copy Command'
  );

  if (result === 'Auto Configure') {
    autoConfigureBridge(context);
    vscode.window.showInformationMessage('Claude Code HUD bridge configured! Start a new Claude Code session to see stats.');
  } else if (result === 'Copy Command') {
    await vscode.env.clipboard.writeText(settingsCmd);
    vscode.window.showInformationMessage('Command copied to clipboard!');
  }
}

function startFileWatcher(context: vscode.ExtensionContext) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      return;
    }
    fileWatcher = fs.watch(dir, (_eventType: string, filename: string | null) => {
      // filename can be null on some platforms (e.g. Linux)
      if (!filename || filename === 'status.json') {
        updateStatusBar();
      }
    });
    fileWatcher.on('error', () => {
      fileWatcher?.close();
      fileWatcher = undefined;
    });
    context.subscriptions.push({ dispose: () => { fileWatcher?.close(); fileWatcher = undefined; } });
  } catch {
    fileWatcher = undefined;
  }
}

function readHudData(): HudData | null {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return null;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw) as HudData;
  } catch {
    return null;
  }
}

function getContextPercent(data: HudData): number {
  const cw = data.context_window;
  if (!cw) return 0;

  if (typeof cw.used_percentage === 'number' && !Number.isNaN(cw.used_percentage)) {
    return Math.min(100, Math.max(0, Math.round(cw.used_percentage)));
  }

  const size = cw.context_window_size;
  if (!size || size <= 0) return 0;

  const usage = cw.current_usage;
  if (!usage) return 0;

  const total = (usage.input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);
  return Math.min(100, Math.round((total / size) * 100));
}

function getModelName(data: HudData): string {
  if (data.model?.display_name?.trim()) {
    return data.model.display_name.trim();
  }
  if (data.model?.id?.trim()) {
    return data.model.id.trim();
  }
  return 'Unknown';
}

function formatResetTime(resetAt: number | null | undefined): string {
  if (typeof resetAt !== 'number' || resetAt <= 0) return '';
  const resetDate = new Date(resetAt * 1000);
  const now = new Date();
  const diffMs = resetDate.getTime() - now.getTime();
  if (diffMs <= 0) return ' (resetting...)';
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 60) return ` (resets in ${diffMin}m)`;
  const diffHr = Math.round(diffMin / 60);
  return ` (resets in ${diffHr}h)`;
}

function updateStatusBar() {
  const config = vscode.workspace.getConfiguration('claudeCodeHud');
  const data = readHudData();

  // If no data or stale data, hide everything
  if (!data || (Date.now() - data.timestamp > STALE_MS)) {
    modelItem.hide();
    contextItem.hide();
    fiveHourItem.hide();
    sevenDayItem.hide();
    return;
  }

  // Model
  if (config.get<boolean>('showModel', true)) {
    const name = getModelName(data);
    modelItem.text = `$(hubot) ${name}`;
    modelItem.tooltip = `Claude Code Model: ${name}`;
    modelItem.show();
  } else {
    modelItem.hide();
  }

  // Context
  if (config.get<boolean>('showContext', true)) {
    const pct = getContextPercent(data);
    contextItem.text = `$(dashboard) Ctx: ${pct}%`;
    const size = data.context_window?.context_window_size;
    const sizeLabel = size ? ` (${Math.round(size / 1000)}K tokens)` : '';
    contextItem.tooltip = `Context Window Usage: ${pct}%${sizeLabel}`;
    contextItem.backgroundColor = pct >= 90
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : pct >= 70
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    contextItem.show();
  } else {
    contextItem.hide();
  }

  // 5-hour rate limit
  if (config.get<boolean>('showFiveHour', true)) {
    const fiveHour = data.rate_limits?.five_hour?.used_percentage;
    if (typeof fiveHour === 'number' && Number.isFinite(fiveHour)) {
      const pct = Math.round(Math.min(100, Math.max(0, fiveHour)));
      const resetInfo = formatResetTime(data.rate_limits?.five_hour?.resets_at);
      fiveHourItem.text = `$(clock) 5h: ${pct}%`;
      fiveHourItem.tooltip = `5-Hour Rate Limit: ${pct}%${resetInfo}`;
      fiveHourItem.backgroundColor = pct >= 90
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : pct >= 70
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
      fiveHourItem.show();
    } else {
      fiveHourItem.hide();
    }
  } else {
    fiveHourItem.hide();
  }

  // 7-day rate limit
  if (config.get<boolean>('showSevenDay', true)) {
    const sevenDay = data.rate_limits?.seven_day?.used_percentage;
    if (typeof sevenDay === 'number' && Number.isFinite(sevenDay)) {
      const pct = Math.round(Math.min(100, Math.max(0, sevenDay)));
      const resetInfo = formatResetTime(data.rate_limits?.seven_day?.resets_at);
      sevenDayItem.text = `$(calendar) 7d: ${pct}%`;
      sevenDayItem.tooltip = `7-Day Rate Limit: ${pct}%${resetInfo}`;
      sevenDayItem.backgroundColor = pct >= 90
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : pct >= 70
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
      sevenDayItem.show();
    } else {
      sevenDayItem.hide();
    }
  } else {
    sevenDayItem.hide();
  }
}

export function deactivate() {
  if (timer) clearInterval(timer);
  fileWatcher?.close();
}
