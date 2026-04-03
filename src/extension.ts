import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

  // Register setup command
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeHud.setup', setupBridge)
  );
}

function startFileWatcher(context: vscode.ExtensionContext) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      return;
    }
    fileWatcher = fs.watch(dir, (_eventType, filename) => {
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

async function setupBridge() {
  const bridgePath = path.resolve(__dirname, '..', 'statusline-bridge', 'bridge.mjs');

  if (!fs.existsSync(bridgePath)) {
    vscode.window.showErrorMessage('Bridge script not found. Please reinstall the extension.');
    return;
  }

  // Quote path for cross-platform compatibility (Windows paths with spaces)
  const quotedPath = bridgePath.includes(' ') ? `"${bridgePath}"` : bridgePath;
  const settingsCmd = `claude config set statusline "node ${quotedPath}"`;

  const result = await vscode.window.showInformationMessage(
    'To display Claude Code stats, you need to configure the statusline plugin.\nRun the following command in your terminal:',
    { modal: true, detail: settingsCmd },
    'Copy Command',
    'Run in Terminal'
  );

  if (result === 'Copy Command') {
    await vscode.env.clipboard.writeText(settingsCmd);
    vscode.window.showInformationMessage('Command copied to clipboard! Paste it in your terminal.');
  } else if (result === 'Run in Terminal') {
    const terminal = vscode.window.createTerminal('Claude Code HUD Setup');
    terminal.show();
    terminal.sendText(settingsCmd);
  }
}

export function deactivate() {
  if (timer) clearInterval(timer);
  fileWatcher?.close();
}
