/**
 * AG-Code Token — Webhook Integrations
 *
 * Supports:
 *   - Slack (Incoming Webhooks)
 *   - Discord (Webhook API)
 *   - Telegram (Bot API)
 *   - Generic HTTP (POST JSON)
 *
 * Config persisted at ~/.ag-code-token/webhooks.json.
 * Zero npm dependencies — uses only Node.js built-in fetch.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { auditLog } from './security.js';

// ─── Configuration ─────────────────────────────────────────────────────────────
const AG_DIR = join(homedir(), '.ag-code-token');
const WEBHOOKS_CONFIG_PATH = join(AG_DIR, 'webhooks.json');
const MAX_RETRIES = 2;
const TIMEOUT_MS = 10_000;

const DEFAULT_CONFIG = {
  webhooks: [],
  // Example webhook entry:
  // {
  //   id: 'slack-main',
  //   type: 'slack',       // 'slack' | 'discord' | 'telegram' | 'generic'
  //   url: 'https://hooks.slack.com/services/...',
  //   enabled: true,
  //   events: ['budget_alert', 'daily_summary', 'threshold_breach'],
  //   // Telegram-specific:
  //   chatId: '123456789',
  //   botToken: 'bot123:ABC...',
  // }
};

let webhookConfig = null;

// ─── Config Persistence ────────────────────────────────────────────────────────

export async function loadWebhookConfig() {
  try {
    if (existsSync(WEBHOOKS_CONFIG_PATH)) {
      webhookConfig = JSON.parse(await readFile(WEBHOOKS_CONFIG_PATH, 'utf-8'));
    } else {
      webhookConfig = { ...DEFAULT_CONFIG };
    }
  } catch {
    webhookConfig = { ...DEFAULT_CONFIG };
  }
  return webhookConfig;
}

export async function saveWebhookConfig(config) {
  try {
    await mkdir(AG_DIR, { recursive: true });
    webhookConfig = config;
    await writeFile(WEBHOOKS_CONFIG_PATH, JSON.stringify(config, null, 2));
    auditLog('webhooks_config_updated', { count: config.webhooks?.length || 0 });
  } catch (err) {
    auditLog('webhooks_save_error', { error: err.message, level: 'error' });
    throw err;
  }
}

export function getWebhookConfig() {
  return webhookConfig || DEFAULT_CONFIG;
}

// ─── Platform-Specific Formatters ──────────────────────────────────────────────

function formatSlackMessage(event, data) {
  const blocks = [];

  if (event === 'budget_alert') {
    for (const alert of data) {
      const emoji = alert.level === 'critical' || alert.level === 'emergency' ? ':rotating_light:' :
                    alert.level === 'warning' ? ':warning:' : ':information_source:';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *${alert.label}*\n${alert.period}: $${alert.spent.toFixed(2)} / $${alert.budget.toFixed(2)} (${alert.percent}%)`,
        },
      });
    }
  } else if (event === 'daily_summary') {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:chart_with_upwards_trend: *AG-Code Token Daily Summary*\n• Cost: $${data.totalCostUSD?.toFixed(2)}\n• Tokens: ${formatTokens(data.totalInputTokens + data.totalOutputTokens)}\n• API Calls: ${data.totalApiCalls}\n• Projects: ${data.projectCount}`,
      },
    });
  }

  return {
    text: event === 'budget_alert' ? 'Budget Alert' : 'Daily Summary',
    blocks: blocks.length > 0 ? blocks : undefined,
  };
}

function formatDiscordMessage(event, data) {
  const embeds = [];

  if (event === 'budget_alert') {
    for (const alert of data) {
      const color = alert.level === 'critical' || alert.level === 'emergency' ? 0xFF0000 :
                    alert.level === 'warning' ? 0xFFAA00 : 0x3B82F6;
      embeds.push({
        title: alert.label,
        description: `**${alert.period}**: $${alert.spent.toFixed(2)} / $${alert.budget.toFixed(2)} (${alert.percent}%)`,
        color,
        timestamp: new Date().toISOString(),
        footer: { text: 'AG-Code Token' },
      });
    }
  } else if (event === 'daily_summary') {
    embeds.push({
      title: 'Daily Token Usage Summary',
      color: 0x10B981,
      fields: [
        { name: 'Cost', value: `$${data.totalCostUSD?.toFixed(2)}`, inline: true },
        { name: 'Tokens', value: formatTokens(data.totalInputTokens + data.totalOutputTokens), inline: true },
        { name: 'API Calls', value: String(data.totalApiCalls || 0), inline: true },
        { name: 'Projects', value: String(data.projectCount || 0), inline: true },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'AG-Code Token' },
    });
  }

  return { embeds };
}

function formatTelegramMessage(event, data) {
  let text = '';

  if (event === 'budget_alert') {
    const lines = data.map(alert => {
      const emoji = alert.level === 'critical' ? '🚨' : alert.level === 'warning' ? '⚠️' : 'ℹ️';
      return `${emoji} *${escMd(alert.label)}*\n${alert.period}: $${alert.spent.toFixed(2)} / $${alert.budget.toFixed(2)} \\(${alert.percent}%\\)`;
    });
    text = lines.join('\n\n');
  } else if (event === 'daily_summary') {
    text = `📊 *AG\\-Code Token Daily Summary*\n\n💰 Cost: $${data.totalCostUSD?.toFixed(2)}\n🔢 Tokens: ${formatTokens(data.totalInputTokens + data.totalOutputTokens)}\n📡 API Calls: ${data.totalApiCalls}\n📁 Projects: ${data.projectCount}`;
  }

  return text;
}

function formatGenericMessage(event, data) {
  return {
    event,
    source: 'ag-code-token',
    timestamp: new Date().toISOString(),
    data,
  };
}

// ─── Sending Engine ────────────────────────────────────────────────────────────

/**
 * Send a webhook notification.
 * @param {string} event - Event type
 * @param {any} data - Event data (alerts array or summary)
 */
export async function sendWebhookNotification(event, data) {
  if (!webhookConfig?.webhooks?.length) return;

  const results = [];
  for (const hook of webhookConfig.webhooks) {
    if (!hook.enabled) continue;
    if (hook.events && !hook.events.includes(event)) continue;

    try {
      await sendToWebhook(hook, event, data);
      results.push({ id: hook.id, status: 'ok' });
    } catch (err) {
      results.push({ id: hook.id, status: 'error', message: err.message });
      auditLog('webhook_send_error', { id: hook.id, type: hook.type, error: err.message, level: 'warn' });
    }
  }

  if (results.length > 0) {
    auditLog('webhooks_sent', { event, results });
  }
}

async function sendToWebhook(hook, event, data) {
  let body, url, headers;

  switch (hook.type) {
    case 'slack':
      url = hook.url;
      body = JSON.stringify(formatSlackMessage(event, data));
      headers = { 'Content-Type': 'application/json' };
      break;

    case 'discord':
      url = hook.url;
      body = JSON.stringify(formatDiscordMessage(event, data));
      headers = { 'Content-Type': 'application/json' };
      break;

    case 'telegram': {
      const text = formatTelegramMessage(event, data);
      url = `https://api.telegram.org/bot${hook.botToken}/sendMessage`;
      body = JSON.stringify({
        chat_id: hook.chatId,
        text,
        parse_mode: 'MarkdownV2',
      });
      headers = { 'Content-Type': 'application/json' };
      break;
    }

    case 'generic':
    default:
      url = hook.url;
      body = JSON.stringify(formatGenericMessage(event, data));
      headers = {
        'Content-Type': 'application/json',
        ...(hook.headers || {}),
      };
      break;
  }

  // Validate URL
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      throw new Error('Only HTTP(S) webhook URLs are supported');
    }
  } catch (err) {
    throw new Error(`Invalid webhook URL: ${err.message}`);
  }

  // Send with retry
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      return; // Success
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // Backoff
      }
    }
  }
  throw lastError;
}

/**
 * Test a webhook configuration by sending a test message.
 */
export async function testWebhook(hook) {
  const testData = [{
    id: 'test',
    scope: 'global',
    period: 'daily',
    budget: 10.00,
    spent: 8.50,
    percent: 85,
    level: 'warning',
    label: 'Test Alert: 85% budget used',
    breached: false,
  }];

  await sendToWebhook(hook, 'budget_alert', testData);
  return { status: 'ok', message: 'Test message sent successfully' };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatTokens(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

/** Escape Telegram MarkdownV2 special characters */
function escMd(s) {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}
