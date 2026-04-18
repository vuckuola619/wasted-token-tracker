/**
 * AG-Code Token — Budget Alerts & Threshold Engine
 *
 * Configurable budget thresholds with breach detection and notification routing.
 * Budget config is persisted at ~/.ag-code-token/budgets.json.
 *
 * Features:
 *   - Per-period budgets (daily, weekly, monthly)
 *   - Per-provider budgets (optional)
 *   - Warning thresholds (50%, 80%, 100%)
 *   - Breach history tracking
 *   - Notification callback system (feeds into webhooks)
 *
 * Zero npm dependencies — uses only Node.js built-ins.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { auditLog } from './security.js';

// ─── Configuration ─────────────────────────────────────────────────────────────
const AG_DIR = join(homedir(), '.ag-code-token');
const BUDGET_CONFIG_PATH = join(AG_DIR, 'budgets.json');
const BREACH_HISTORY_PATH = join(AG_DIR, 'budget-breaches.json');

const DEFAULT_THRESHOLDS = [
  { percent: 50, level: 'info', label: '50% budget used' },
  { percent: 80, level: 'warning', label: '80% budget used' },
  { percent: 100, level: 'critical', label: 'Budget exceeded' },
  { percent: 150, level: 'emergency', label: 'Budget significantly exceeded' },
];

const DEFAULT_BUDGET = {
  daily: null,    // e.g. 10.00 (USD)
  weekly: null,   // e.g. 50.00
  monthly: null,  // e.g. 200.00
  perProvider: {}, // e.g. { antigravity: { daily: 5.00 } }
  thresholds: DEFAULT_THRESHOLDS,
  notifications: {
    enabled: true,
    webhooks: true,        // Route to webhook module
    dashboard: true,       // Show in dashboard UI
    cooldownMinutes: 60,   // Don't re-alert within this window
  },
};

// ─── In-Memory State ───────────────────────────────────────────────────────────
let budgetConfig = null;
let breachHistory = [];
let notificationCallbacks = [];
let lastAlerts = new Map(); // key → timestamp (cooldown tracking)

// ─── Persistence ───────────────────────────────────────────────────────────────

/**
 * Load budget configuration from disk.
 */
export async function loadBudgetConfig() {
  try {
    if (existsSync(BUDGET_CONFIG_PATH)) {
      const raw = await readFile(BUDGET_CONFIG_PATH, 'utf-8');
      budgetConfig = { ...DEFAULT_BUDGET, ...JSON.parse(raw) };
    } else {
      budgetConfig = { ...DEFAULT_BUDGET };
    }
  } catch {
    budgetConfig = { ...DEFAULT_BUDGET };
  }
  // Load breach history
  try {
    if (existsSync(BREACH_HISTORY_PATH)) {
      breachHistory = JSON.parse(await readFile(BREACH_HISTORY_PATH, 'utf-8'));
      // Keep only last 100 breaches
      if (breachHistory.length > 100) breachHistory = breachHistory.slice(-100);
    }
  } catch {
    breachHistory = [];
  }
  return budgetConfig;
}

/**
 * Save budget configuration to disk.
 */
export async function saveBudgetConfig(config) {
  try {
    await mkdir(AG_DIR, { recursive: true });
    budgetConfig = { ...DEFAULT_BUDGET, ...config };
    await writeFile(BUDGET_CONFIG_PATH, JSON.stringify(budgetConfig, null, 2));
    auditLog('budget_config_updated', { daily: config.daily, weekly: config.weekly, monthly: config.monthly });
  } catch (err) {
    auditLog('budget_save_error', { error: err.message, level: 'error' });
    throw err;
  }
}

/**
 * Get current budget configuration.
 */
export function getBudgetConfig() {
  return budgetConfig || DEFAULT_BUDGET;
}

// ─── Breach Detection ──────────────────────────────────────────────────────────

/**
 * Check current spending against budget thresholds.
 * Returns an array of active alerts.
 *
 * @param {Object} spending - { daily: number, weekly: number, monthly: number }
 * @param {Object} [providerSpending] - { [provider]: { daily, weekly, monthly } }
 * @returns {Object[]} Array of alert objects
 */
export function checkBudgets(spending, providerSpending = {}) {
  if (!budgetConfig) return [];
  const alerts = [];
  const now = Date.now();
  const cooldownMs = (budgetConfig.notifications?.cooldownMinutes || 60) * 60_000;
  const thresholds = budgetConfig.thresholds || DEFAULT_THRESHOLDS;

  // Check global budgets
  const periods = ['daily', 'weekly', 'monthly'];
  for (const period of periods) {
    const budget = budgetConfig[period];
    if (budget === null || budget === undefined || budget <= 0) continue;

    const spent = spending[period] || 0;
    const percent = (spent / budget) * 100;

    for (const threshold of thresholds) {
      if (percent >= threshold.percent) {
        const key = `global:${period}:${threshold.percent}`;
        const lastAlert = lastAlerts.get(key);
        const isCooldown = lastAlert && (now - lastAlert) < cooldownMs;

        alerts.push({
          id: key,
          scope: 'global',
          period,
          budget,
          spent,
          percent: Math.round(percent * 10) / 10,
          level: threshold.level,
          label: threshold.label,
          breached: percent >= 100,
          coolingDown: isCooldown,
        });
      }
    }
  }

  // Check per-provider budgets
  for (const [provider, limits] of Object.entries(budgetConfig.perProvider || {})) {
    for (const period of periods) {
      const budget = limits[period];
      if (budget === null || budget === undefined || budget <= 0) continue;

      const spent = providerSpending[provider]?.[period] || 0;
      const percent = (spent / budget) * 100;

      for (const threshold of thresholds) {
        if (percent >= threshold.percent) {
          const key = `provider:${provider}:${period}:${threshold.percent}`;
          const lastAlert = lastAlerts.get(key);
          const isCooldown = lastAlert && (now - lastAlert) < cooldownMs;

          alerts.push({
            id: key,
            scope: 'provider',
            provider,
            period,
            budget,
            spent,
            percent: Math.round(percent * 10) / 10,
            level: threshold.level,
            label: `${provider}: ${threshold.label}`,
            breached: percent >= 100,
            coolingDown: isCooldown,
          });
        }
      }
    }
  }

  return alerts;
}

/**
 * Fire notifications for new budget alerts (respects cooldown).
 */
export async function processAlerts(alerts) {
  if (!budgetConfig?.notifications?.enabled) return;
  const now = Date.now();
  const cooldownMs = (budgetConfig.notifications?.cooldownMinutes || 60) * 60_000;
  const newAlerts = [];

  for (const alert of alerts) {
    if (alert.coolingDown) continue;
    lastAlerts.set(alert.id, now);
    newAlerts.push(alert);

    // Record breach
    breachHistory.push({
      ...alert,
      timestamp: new Date().toISOString(),
      coolingDown: undefined,
    });
  }

  if (newAlerts.length === 0) return;

  // Persist breach history
  try {
    await mkdir(AG_DIR, { recursive: true });
    await writeFile(BREACH_HISTORY_PATH, JSON.stringify(breachHistory.slice(-100)));
  } catch { /* non-critical */ }

  // Fire notification callbacks (webhooks, etc.)
  for (const callback of notificationCallbacks) {
    try {
      await callback(newAlerts);
    } catch (err) {
      auditLog('budget_notification_error', { error: err.message, level: 'error' });
    }
  }

  auditLog('budget_alerts_fired', { count: newAlerts.length, levels: newAlerts.map(a => a.level) });
}

/**
 * Register a notification callback (used by webhook module).
 */
export function onBudgetAlert(callback) {
  notificationCallbacks.push(callback);
}

/**
 * Get breach history for the dashboard.
 */
export function getBreachHistory(limit = 20) {
  return breachHistory.slice(-limit).reverse();
}

/**
 * Calculate spending for each period from summary data.
 * This is called by the server to compute spending against budgets.
 */
export function computeSpending(summaries) {
  return {
    daily: summaries.today?.totalCostUSD || 0,
    weekly: summaries.week?.totalCostUSD || 0,
    monthly: summaries.month?.totalCostUSD || 0,
  };
}
