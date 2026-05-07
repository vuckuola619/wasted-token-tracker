/**
 * Wasted Token Tracker — Programmatic API
 *
 * npm package entry point. Allows programmatic usage:
 *
 *   import { getSummary, getProviders, loadPricing } from 'wasted-token-tracker';
 *
 *   await loadPricing();
 *   const summary = await getSummary('today');
 *   console.log(`Today's cost: $${summary.totalCostUSD.toFixed(2)}`);
 *
 * @module wasted-token-tracker
 */

// ─── Core Exports ──────────────────────────────────────────────────────────────
export { loadPricing, getModelCosts, calculateCost, getShortModelName, getContextWindow } from './models.js';
export { parseAllSessions, getAggregateSummary, getDateRange, invalidateCache } from './parser.js';
export { getActiveProviders, getProviderNames, discoverAllSessions } from './providers/index.js';

// ─── Budget & Alerts ──────────────────────────────────────────────────────────
export {
  loadBudgetConfig, saveBudgetConfig, getBudgetConfig,
  checkBudgets, processAlerts, onBudgetAlert,
  getBreachHistory, computeSpending,
} from './budget.js';

// ─── Webhooks ─────────────────────────────────────────────────────────────────
export {
  loadWebhookConfig, saveWebhookConfig, getWebhookConfig,
  sendWebhookNotification, testWebhook,
} from './webhooks.js';

// ─── Currency ─────────────────────────────────────────────────────────────────
export {
  loadCurrencyConfig, saveCurrencyConfig,
  convertFromUSD, convertToSpecific,
  getAvailableCurrencies, getCurrentCurrency,
  CURRENCIES,
} from './currency.js';

// ─── Convenience Wrappers ──────────────────────────────────────────────────────

/**
 * Quick summary — initialize pricing and return a summary for the given period.
 *
 * @param {'today'|'week'|'30days'|'month'|'all'} period
 * @param {'all'|string} provider
 * @returns {Promise<Object>} Aggregate summary
 *
 * @example
 * import { getSummary } from 'wasted-token-tracker';
 * const today = await getSummary('today');
 * console.log(`Cost: $${today.totalCostUSD.toFixed(2)}`);
 */
export async function getSummary(period = 'week', provider = 'all') {
  const { loadPricing: lp } = await import('./models.js');
  const { getAggregateSummary: gas } = await import('./parser.js');
  await lp();
  return gas(period, provider);
}

/**
 * Get active providers on this machine.
 *
 * @returns {Promise<Object[]>} Array of { name, displayName, sessionCount }
 *
 * @example
 * import { getProviders } from 'wasted-token-tracker';
 * const providers = await getProviders();
 * for (const p of providers) {
 *   console.log(`${p.displayName}: ${p.sessionCount} sessions`);
 * }
 */
export async function getProviders() {
  const { loadPricing: lp } = await import('./models.js');
  const { getActiveProviders: gap } = await import('./providers/index.js');
  await lp();
  return gap();
}

/**
 * Export usage data as JSON for a given period.
 *
 * @param {'today'|'week'|'30days'|'month'|'all'} period
 * @returns {Promise<Object[]>} Array of project summaries
 */
export async function exportData(period = 'week', provider = 'all') {
  const { loadPricing: lp } = await import('./models.js');
  const { parseAllSessions: pas, getDateRange: gdr } = await import('./parser.js');
  await lp();
  const { range } = gdr(period);
  return pas(range, provider);
}

/**
 * Package metadata.
 */
export const VERSION = '1.4.0';
export const NAME = 'wasted-token-tracker';
