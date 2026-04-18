/**
 * AG-Code Token — Multi-Currency Support
 *
 * Converts USD costs to 12+ currencies with:
 *   - Offline fallback rates (hardcoded, always available)
 *   - Daily updates from ECB exchange rate API (free, no API key)
 *   - User-configurable preferred currency
 *   - Symbol/locale formatting
 *
 * Config persisted at ~/.ag-code-token/currency.json.
 * Zero npm dependencies.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { auditLog } from './security.js';

// ─── Configuration ─────────────────────────────────────────────────────────────
const AG_DIR = join(homedir(), '.ag-code-token');
const CURRENCY_CONFIG_PATH = join(AG_DIR, 'currency.json');
const RATES_CACHE_PATH = join(AG_DIR, 'exchange-rates.json');
const RATES_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ECB_API_URL = 'https://api.frankfurter.app/latest?from=USD';

// ─── Currency Definitions ──────────────────────────────────────────────────────
export const CURRENCIES = {
  USD: { symbol: '$', name: 'US Dollar', locale: 'en-US', decimals: 2 },
  EUR: { symbol: '€', name: 'Euro', locale: 'de-DE', decimals: 2 },
  GBP: { symbol: '£', name: 'British Pound', locale: 'en-GB', decimals: 2 },
  JPY: { symbol: '¥', name: 'Japanese Yen', locale: 'ja-JP', decimals: 0 },
  CNY: { symbol: '¥', name: 'Chinese Yuan', locale: 'zh-CN', decimals: 2 },
  KRW: { symbol: '₩', name: 'South Korean Won', locale: 'ko-KR', decimals: 0 },
  INR: { symbol: '₹', name: 'Indian Rupee', locale: 'en-IN', decimals: 2 },
  BRL: { symbol: 'R$', name: 'Brazilian Real', locale: 'pt-BR', decimals: 2 },
  CAD: { symbol: 'CA$', name: 'Canadian Dollar', locale: 'en-CA', decimals: 2 },
  AUD: { symbol: 'A$', name: 'Australian Dollar', locale: 'en-AU', decimals: 2 },
  CHF: { symbol: 'CHF', name: 'Swiss Franc', locale: 'de-CH', decimals: 2 },
  THB: { symbol: '฿', name: 'Thai Baht', locale: 'th-TH', decimals: 2 },
};

// ─── Fallback Exchange Rates (approximate, updated periodically) ───────────────
const FALLBACK_RATES = {
  USD: 1.0,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 154.5,
  CNY: 7.24,
  KRW: 1380,
  INR: 83.5,
  BRL: 5.12,
  CAD: 1.37,
  AUD: 1.55,
  CHF: 0.88,
  THB: 36.2,
};

// ─── State ─────────────────────────────────────────────────────────────────────
let currentCurrency = 'USD';
let exchangeRates = { ...FALLBACK_RATES };
let ratesFetchedAt = 0;

// ─── Config Persistence ────────────────────────────────────────────────────────

export async function loadCurrencyConfig() {
  try {
    if (existsSync(CURRENCY_CONFIG_PATH)) {
      const config = JSON.parse(await readFile(CURRENCY_CONFIG_PATH, 'utf-8'));
      if (config.currency && CURRENCIES[config.currency]) {
        currentCurrency = config.currency;
      }
    }
  } catch { /* use defaults */ }

  // Load cached rates
  try {
    if (existsSync(RATES_CACHE_PATH)) {
      const cached = JSON.parse(await readFile(RATES_CACHE_PATH, 'utf-8'));
      if (cached.rates && cached.timestamp) {
        exchangeRates = { ...FALLBACK_RATES, ...cached.rates };
        ratesFetchedAt = cached.timestamp;
      }
    }
  } catch { /* use fallbacks */ }

  // Refresh rates if stale
  if (Date.now() - ratesFetchedAt > RATES_TTL_MS) {
    refreshRates().catch(() => {}); // Fire and forget
  }
}

export async function saveCurrencyConfig(currency) {
  if (!CURRENCIES[currency]) {
    throw new Error(`Unsupported currency: ${currency}. Supported: ${Object.keys(CURRENCIES).join(', ')}`);
  }
  currentCurrency = currency;
  try {
    await mkdir(AG_DIR, { recursive: true });
    await writeFile(CURRENCY_CONFIG_PATH, JSON.stringify({ currency, updatedAt: new Date().toISOString() }));
    auditLog('currency_changed', { currency });
  } catch (err) {
    auditLog('currency_save_error', { error: err.message, level: 'error' });
  }
}

// ─── Exchange Rate Fetching ────────────────────────────────────────────────────

async function refreshRates() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(ECB_API_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    if (data.rates && typeof data.rates === 'object') {
      exchangeRates = { USD: 1.0, ...data.rates };
      ratesFetchedAt = Date.now();

      // Cache rates
      await mkdir(AG_DIR, { recursive: true });
      await writeFile(RATES_CACHE_PATH, JSON.stringify({
        timestamp: ratesFetchedAt,
        rates: exchangeRates,
        source: 'frankfurter.app (ECB)',
      }));
      auditLog('exchange_rates_updated', { currencies: Object.keys(data.rates).length });
    }
  } catch (err) {
    // Non-critical — use cached or fallback rates
    auditLog('exchange_rate_fetch_error', { error: err.message, level: 'warn' });
  }
}

// ─── Conversion API ────────────────────────────────────────────────────────────

/**
 * Convert a USD amount to the current configured currency.
 * @param {number} usd - Amount in USD
 * @returns {{ value: number, formatted: string, currency: string, symbol: string }}
 */
export function convertFromUSD(usd) {
  const rate = exchangeRates[currentCurrency] || 1;
  const value = usd * rate;
  const info = CURRENCIES[currentCurrency] || CURRENCIES.USD;

  return {
    value: Math.round(value * Math.pow(10, info.decimals)) / Math.pow(10, info.decimals),
    formatted: formatCurrency(value, currentCurrency),
    currency: currentCurrency,
    symbol: info.symbol,
    rate,
  };
}

/**
 * Convert a USD amount to a specific currency.
 */
export function convertToSpecific(usd, target) {
  const rate = exchangeRates[target] || 1;
  const value = usd * rate;
  const info = CURRENCIES[target] || CURRENCIES.USD;

  return {
    value: Math.round(value * Math.pow(10, info.decimals)) / Math.pow(10, info.decimals),
    formatted: formatCurrency(value, target),
    currency: target,
    symbol: info.symbol,
    rate,
  };
}

/**
 * Format a value in a specific currency.
 */
function formatCurrency(amount, code) {
  const info = CURRENCIES[code];
  if (!info) return `$${amount.toFixed(2)}`;

  try {
    return new Intl.NumberFormat(info.locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: info.decimals,
      maximumFractionDigits: info.decimals,
    }).format(amount);
  } catch {
    return `${info.symbol}${amount.toFixed(info.decimals)}`;
  }
}

/**
 * Get all available currencies with current rates.
 */
export function getAvailableCurrencies() {
  return Object.entries(CURRENCIES).map(([code, info]) => ({
    code,
    ...info,
    rate: exchangeRates[code] || null,
    selected: code === currentCurrency,
  }));
}

/**
 * Get the current currency code.
 */
export function getCurrentCurrency() {
  return currentCurrency;
}

/**
 * Get exchange rates metadata.
 */
export function getRatesInfo() {
  return {
    current: currentCurrency,
    lastUpdated: ratesFetchedAt ? new Date(ratesFetchedAt).toISOString() : null,
    source: 'ECB via frankfurter.app',
    fallback: ratesFetchedAt === 0,
    rateCount: Object.keys(exchangeRates).length,
  };
}
