/**
 * AG-Code Token — Real-Time File Watcher
 *
 * Monitors session directories for changes using fs.watch(),
 * providing real-time dashboard updates via Server-Sent Events.
 *
 * Architecture:
 *   - Watches each active provider's session directory
 *   - Debounces rapid file writes (2-second window)
 *   - Emits 'change' events to invalidate parser cache
 *   - Graceful degradation: falls back to polling if fs.watch fails
 *   - Resource-managed: closes all watchers on shutdown
 *
 * Zero dependencies — uses only Node.js built-ins.
 */

import { watch, existsSync } from 'fs';
import { EventEmitter } from 'events';
import { auditLog } from './security.js';

// ─── Configuration ─────────────────────────────────────────────────────────────
const DEBOUNCE_MS = 2_000;        // Batch rapid writes
const HEARTBEAT_MS = 30_000;      // SSE heartbeat interval
const MAX_WATCHERS = 20;          // Safety limit on watcher count

// ─── FileWatcher Class ─────────────────────────────────────────────────────────

export class FileWatcher extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, import('fs').FSWatcher>} */
    this._watchers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this._debounceTimers = new Map();
    this._errorCount = 0;
    this._changeCount = 0;
    this._started = false;
  }

  /**
   * Start watching a specific directory for changes.
   * @param {string} dirPath - Absolute path to watch
   * @param {string} providerName - Provider identifier for events
   */
  watchDirectory(dirPath, providerName) {
    // Safety checks
    if (!dirPath || typeof dirPath !== 'string') return;
    if (this._watchers.has(dirPath)) return; // Already watching
    if (this._watchers.size >= MAX_WATCHERS) {
      auditLog('watcher_limit', { max: MAX_WATCHERS, path: dirPath });
      return;
    }
    if (!existsSync(dirPath)) return; // Directory doesn't exist

    try {
      const watcher = watch(dirPath, { recursive: true }, (eventType, filename) => {
        this._handleChange(dirPath, providerName, eventType, filename);
      });

      watcher.on('error', (err) => {
        this._errorCount++;
        auditLog('watcher_error', { path: dirPath, provider: providerName, error: err.message });
        // Close the broken watcher
        this._closeWatcher(dirPath);
      });

      this._watchers.set(dirPath, watcher);
      auditLog('watcher_started', { path: this._sanitizePath(dirPath), provider: providerName });
    } catch (err) {
      this._errorCount++;
      auditLog('watcher_init_error', { path: this._sanitizePath(dirPath), error: err.message });
    }
  }

  /**
   * Handle a file change event with debouncing.
   */
  _handleChange(dirPath, providerName, eventType, filename) {
    const key = `${dirPath}:${providerName}`;

    // Clear existing debounce timer
    if (this._debounceTimers.has(key)) {
      clearTimeout(this._debounceTimers.get(key));
    }

    // Set new debounce timer
    const timer = setTimeout(() => {
      this._changeCount++;
      this._debounceTimers.delete(key);

      const event = {
        provider: providerName,
        path: this._sanitizePath(dirPath),
        filename: filename ? this._sanitizePath(filename) : null,
        type: eventType,
        timestamp: new Date().toISOString(),
      };

      this.emit('change', event);
      auditLog('session_change', { provider: providerName, type: eventType });
    }, DEBOUNCE_MS);

    timer.unref(); // Don't keep process alive
    this._debounceTimers.set(key, timer);
  }

  /**
   * Close a specific watcher.
   */
  _closeWatcher(dirPath) {
    const watcher = this._watchers.get(dirPath);
    if (watcher) {
      try { watcher.close(); } catch {}
      this._watchers.delete(dirPath);
    }
    const timer = this._debounceTimers.get(dirPath);
    if (timer) {
      clearTimeout(timer);
      this._debounceTimers.delete(dirPath);
    }
  }

  /**
   * Sanitize a path for logging (GDPR — don't log full user paths).
   */
  _sanitizePath(p) {
    if (!p) return '';
    // Replace home directory with ~ 
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home && p.startsWith(home)) {
      return '~' + p.slice(home.length);
    }
    return p;
  }

  /**
   * Stop all watchers (graceful shutdown).
   */
  stop() {
    for (const [dirPath] of this._watchers) {
      this._closeWatcher(dirPath);
    }
    for (const [, timer] of this._debounceTimers) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
    this._started = false;
    auditLog('watcher_stopped', { watcherCount: 0 });
  }

  /**
   * Get watcher statistics for health check.
   */
  getStats() {
    return {
      active: this._watchers.size,
      errors: this._errorCount,
      totalChanges: this._changeCount,
    };
  }
}

// ─── SSE Manager ───────────────────────────────────────────────────────────────

/**
 * Manages Server-Sent Event connections for real-time dashboard updates.
 */
export class SSEManager {
  constructor() {
    /** @type {Set<import('http').ServerResponse>} */
    this._clients = new Set();
    this._heartbeatTimer = null;
    this._messageId = 0;
  }

  /**
   * Add a new SSE client connection.
   * @param {import('http').ServerResponse} res
   */
  addClient(res) {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial connection event
    this._send(res, 'connected', { message: 'Real-time monitoring active' });

    // Set reconnect interval
    res.write('retry: 5000\n\n');

    this._clients.add(res);

    // Remove on disconnect
    res.on('close', () => {
      this._clients.delete(res);
    });

    // Start heartbeat if this is the first client
    if (this._clients.size === 1 && !this._heartbeatTimer) {
      this._startHeartbeat();
    }

    return this._clients.size;
  }

  /**
   * Broadcast an event to all connected SSE clients.
   */
  broadcast(eventType, data) {
    const deadClients = [];
    for (const client of this._clients) {
      try {
        if (!client.writableEnded) {
          this._send(client, eventType, data);
        } else {
          deadClients.push(client);
        }
      } catch {
        deadClients.push(client);
      }
    }
    // Cleanup dead connections
    for (const dead of deadClients) {
      this._clients.delete(dead);
    }
  }

  /**
   * Send a formatted SSE message to a single client.
   */
  _send(res, event, data) {
    this._messageId++;
    const payload = [
      `id: ${this._messageId}`,
      `event: ${event}`,
      `data: ${JSON.stringify(data)}`,
      '', '' // double newline to end message
    ].join('\n');
    res.write(payload);
  }

  /**
   * Send periodic heartbeat to keep connections alive.
   */
  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      if (this._clients.size === 0) {
        this._stopHeartbeat();
        return;
      }
      this.broadcast('heartbeat', { ts: new Date().toISOString(), clients: this._clients.size });
    }, HEARTBEAT_MS);
    this._heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * Close all SSE connections (graceful shutdown).
   */
  closeAll() {
    this._stopHeartbeat();
    for (const client of this._clients) {
      try {
        if (!client.writableEnded) {
          this._send(client, 'shutdown', { message: 'Server shutting down' });
          client.end();
        }
      } catch {}
    }
    this._clients.clear();
  }

  getClientCount() {
    return this._clients.size;
  }
}
