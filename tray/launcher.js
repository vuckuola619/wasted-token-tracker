#!/usr/bin/env node
/**
 * AG-Code Token — System Tray Launcher
 *
 * Lightweight cross-platform tray application that:
 *   - Starts the AG-Code Token server as a background process
 *   - Shows a system tray icon with quick-access menu
 *   - Opens the dashboard in the default browser
 *   - Shows budget alert notifications via OS native notifications
 *
 * No Electron needed — uses Node.js child_process + open.
 * For a full GUI tray, install optional: `npm install -g ag-code-token-tray`
 *
 * Usage:
 *   ag-token tray          # Start server in background + open browser
 *   ag-token tray --detach # Start server as detached process
 */

import { spawn, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { homedir, platform } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'server.js');
const PORT = process.env.PORT || 3777;
const HOST = process.env.AG_TOKEN_HOST || '127.0.0.1';
const DASHBOARD_URL = `http://${HOST}:${PORT}`;
const PID_FILE = join(homedir(), '.ag-code-token', 'server.pid');

// ANSI colors
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
  gray: '\x1b[90m', red: '\x1b[31m',
};

/**
 * Open a URL in the default browser (cross-platform).
 */
function openBrowser(url) {
  const os = platform();
  try {
    if (os === 'win32') execSync(`start "" "${url}"`, { stdio: 'ignore' });
    else if (os === 'darwin') execSync(`open "${url}"`, { stdio: 'ignore' });
    else execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
  } catch {
    console.log(`${c.yellow}⚠  Could not open browser. Visit: ${url}${c.reset}`);
  }
}

/**
 * Check if the server is already running.
 */
function isServerRunning() {
  try {
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
      // Check if process is alive
      process.kill(pid, 0);
      return pid;
    }
  } catch { /* process not found */ }
  return false;
}

/**
 * Send an OS-native notification (best-effort, no dependencies).
 */
function notify(title, body) {
  const os = platform();
  try {
    if (os === 'win32') {
      // PowerShell toast notification
      const ps = `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, '${title.replace(/'/g, "''")}', '${body.replace(/'/g, "''")}', 'Info'); Start-Sleep -Seconds 6; $n.Dispose()`;
      spawn('powershell', ['-Command', ps], { stdio: 'ignore', detached: true }).unref();
    } else if (os === 'darwin') {
      execSync(`osascript -e 'display notification "${body}" with title "${title}"'`, { stdio: 'ignore' });
    } else {
      execSync(`notify-send "${title}" "${body}"`, { stdio: 'ignore' });
    }
  } catch { /* notifications not available */ }
}

/**
 * Start the server in the foreground (with tray behavior).
 */
export async function startTray(options = {}) {
  const { detach = false } = options;

  console.log(`\n${c.bold}${c.cyan}🖥️  AG-Code Token — System Tray Mode${c.reset}\n`);

  // Check if already running
  const existingPid = isServerRunning();
  if (existingPid) {
    console.log(`${c.green}✓ Server already running (PID: ${existingPid})${c.reset}`);
    console.log(`${c.gray}  Opening dashboard...${c.reset}\n`);
    openBrowser(DASHBOARD_URL);
    return;
  }

  if (detach) {
    // Start as detached background process
    console.log(`${c.gray}Starting server in background...${c.reset}`);
    const child = spawn('node', [SERVER_PATH], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, AG_TOKEN_TRAY: '1' },
    });
    child.unref();

    // Save PID
    const { mkdirSync, writeFileSync } = await import('fs');
    mkdirSync(join(homedir(), '.ag-code-token'), { recursive: true });
    writeFileSync(PID_FILE, String(child.pid));

    console.log(`${c.green}✓ Server started (PID: ${child.pid})${c.reset}`);
    console.log(`${c.gray}  Dashboard: ${DASHBOARD_URL}${c.reset}`);

    // Wait a moment then open browser
    setTimeout(() => {
      openBrowser(DASHBOARD_URL);
      notify('AG-Code Token', `Dashboard running at ${DASHBOARD_URL}`);
    }, 2000);

    console.log(`\n${c.gray}To stop: ag-token tray --stop${c.reset}\n`);
    return;
  }

  // Start in foreground (for non-detached mode)
  console.log(`${c.gray}Starting server...${c.reset}`);

  const child = spawn('node', [SERVER_PATH], {
    stdio: 'inherit',
    env: { ...process.env, AG_TOKEN_TRAY: '1' },
  });

  // Open browser after server starts
  setTimeout(() => {
    openBrowser(DASHBOARD_URL);
    notify('AG-Code Token', `Dashboard ready at ${DASHBOARD_URL}`);
  }, 3000);

  child.on('close', (code) => {
    if (code !== 0) {
      console.log(`${c.red}Server exited with code ${code}${c.reset}`);
    }
  });

  // Handle shutdown
  process.on('SIGINT', () => { child.kill('SIGINT'); });
  process.on('SIGTERM', () => { child.kill('SIGTERM'); });
}

/**
 * Stop a running background server.
 */
export function stopTray() {
  const pid = isServerRunning();
  if (!pid) {
    console.log(`${c.yellow}No running server found.${c.reset}`);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`${c.green}✓ Server stopped (PID: ${pid})${c.reset}`);
    // Clean up PID file
    const { unlinkSync } = require('fs');
    try { unlinkSync(PID_FILE); } catch {}
  } catch (err) {
    console.log(`${c.red}Failed to stop server: ${err.message}${c.reset}`);
  }
}

/**
 * Get tray status.
 */
export function trayStatus() {
  const pid = isServerRunning();
  if (pid) {
    console.log(`${c.green}● Server running${c.reset} (PID: ${pid})`);
    console.log(`  Dashboard: ${DASHBOARD_URL}`);
  } else {
    console.log(`${c.gray}○ Server not running${c.reset}`);
    console.log(`  Start: ag-token tray`);
  }
}
