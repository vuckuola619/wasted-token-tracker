#!/usr/bin/env node
/**
 * Wasted Token Tracker — MCP Server
 * Exposes token usage data as MCP tools for Claude Desktop, Cursor, etc.
 *
 * Usage: add to Claude Desktop config (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "wasted-token-tracker": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/mcp.js"]
 *       }
 *     }
 *   }
 *
 * Or via npx after installing globally:
 *   { "command": "wasted-token-mcp" }
 */

import { createInterface } from 'readline';
import { loadPricing } from './models.js';
import { getAggregateSummary, getDateRange, parseAllSessions } from './parser.js';
import { getActiveProviders } from './providers/index.js';

const SERVER_NAME = 'wasted-token-tracker';
const SERVER_VERSION = '1.3.0';
const VALID_PERIODS = new Set(['today', 'week', '30days', 'month', 'all']);

// ─── Formatting Helpers ────────────────────────────────────────────────────────

function formatCost(usd) {
  if (usd === 0) return '$0.00';
  if (usd < 0.001) return `$${usd.toFixed(6)}`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n) {
  if (n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── Tool Definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_summary',
    description:
      'Get aggregate token usage and cost summary for a given time period across all providers.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'week', '30days', 'month', 'all'],
          description: 'Time period to summarize. Defaults to "week".',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_providers',
    description:
      'List all AI coding tool providers that have session data on this machine, with session counts.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_projects',
    description:
      'Get per-project token usage breakdown, optionally filtered by period and/or provider.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'week', '30days', 'month', 'all'],
          description: 'Time period filter. Defaults to "week".',
        },
        provider: {
          type: 'string',
          description: 'Provider name filter (e.g. "claude", "cursor"). Omit for all providers.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_billing_window',
    description:
      'Get Claude Code 5-hour billing window status — shows spend within the current rolling 5-hour window and estimated reset time.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ─── Tool Implementations ──────────────────────────────────────────────────────

async function toolGetSummary(args) {
  const period = VALID_PERIODS.has(args?.period) ? args.period : 'week';
  const summary = await getAggregateSummary(period, 'all');

  const topModels = (summary.models || []).slice(0, 5).map(m => ({
    name: m.name,
    cost: formatCost(m.costUSD),
    calls: m.calls,
    inputTokens: formatTokens(m.inputTokens),
    outputTokens: formatTokens(m.outputTokens),
  }));

  const topProviders = (summary.providers || []).slice(0, 10).map(p => ({
    name: p.displayName || p.name,
    cost: formatCost(p.costUSD),
    calls: p.calls,
  }));

  return {
    period: summary.period,
    totalCost: formatCost(summary.totalCostUSD),
    totalCostUSD: summary.totalCostUSD,
    totalInputTokens: formatTokens(summary.totalInputTokens),
    totalOutputTokens: formatTokens(summary.totalOutputTokens),
    totalCacheReadTokens: formatTokens(summary.totalCacheReadTokens),
    totalCacheWriteTokens: formatTokens(summary.totalCacheWriteTokens),
    totalReasoningTokens: formatTokens(summary.totalReasoningTokens),
    totalApiCalls: summary.totalApiCalls,
    projectCount: summary.projectCount,
    topModels,
    topProviders,
  };
}

async function toolGetProviders() {
  const active = await getActiveProviders();
  return {
    providers: active.map(p => ({
      name: p.name,
      displayName: p.displayName,
      sessionCount: p.sessionCount,
    })),
    total: active.length,
  };
}

async function toolGetProjects(args) {
  const period = VALID_PERIODS.has(args?.period) ? args.period : 'week';
  const providerFilter = args?.provider || 'all';

  const { range, label } = getDateRange(period);
  const projects = await parseAllSessions(range, providerFilter);

  return {
    period: label,
    provider: providerFilter,
    projectCount: projects.length,
    projects: projects.map(p => ({
      project: p.project,
      provider: p.providerDisplayName || p.provider,
      cost: formatCost(p.totalCostUSD),
      costUSD: p.totalCostUSD,
      apiCalls: p.totalApiCalls,
      inputTokens: formatTokens(p.totalInputTokens),
      outputTokens: formatTokens(p.totalOutputTokens),
      topModels: Object.entries(p.modelBreakdown || {})
        .sort(([, a], [, b]) => b.costUSD - a.costUSD)
        .slice(0, 3)
        .map(([name, d]) => ({ name, cost: formatCost(d.costUSD), calls: d.calls })),
    })),
  };
}

async function toolGetBillingWindow() {
  // Claude Code uses a rolling 5-hour billing window.
  // We compute this from the parsed Claude sessions directly.
  const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours in ms
  const now = Date.now();
  const windowStart = new Date(now - WINDOW_MS);
  const windowEnd = new Date(now);

  const range = { start: windowStart, end: windowEnd };

  let windowCost = 0;
  let windowCalls = 0;
  let windowInput = 0;
  let windowOutput = 0;
  let earliestCallInWindow = null;

  try {
    const projects = await parseAllSessions(range, 'claude');
    for (const proj of projects) {
      windowCost += proj.totalCostUSD;
      windowCalls += proj.totalApiCalls;
      windowInput += proj.totalInputTokens;
      windowOutput += proj.totalOutputTokens;

      for (const call of proj.calls) {
        if (!call.timestamp) continue;
        const ts = new Date(call.timestamp);
        if (ts >= windowStart) {
          if (!earliestCallInWindow || ts < earliestCallInWindow) {
            earliestCallInWindow = ts;
          }
        }
      }
    }
  } catch (err) {
    return { error: `Failed to compute billing window: ${err.message}` };
  }

  // Estimate window reset: 5h after the earliest call in this window
  let resetAt = null;
  let resetInMinutes = null;
  if (earliestCallInWindow) {
    resetAt = new Date(earliestCallInWindow.getTime() + WINDOW_MS);
    resetInMinutes = Math.max(0, Math.round((resetAt.getTime() - now) / 60000));
  }

  return {
    windowDurationHours: 5,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    spend: formatCost(windowCost),
    spendUSD: windowCost,
    apiCalls: windowCalls,
    inputTokens: formatTokens(windowInput),
    outputTokens: formatTokens(windowOutput),
    resetAt: resetAt ? resetAt.toISOString() : null,
    resetInMinutes,
    note: 'Claude Code Pro plan has a $5 rolling 5-hour usage window. This shows actual API spend tracked by Wasted Token Tracker.',
  };
}

// ─── MCP Message Handlers ──────────────────────────────────────────────────────

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function makeResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return makeResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case 'notifications/initialized':
      // Notification — no response needed; return null to signal caller to skip
      return null;

    case 'tools/list':
      return makeResult(id, { tools: TOOLS });

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};

      let toolResult;
      try {
        switch (toolName) {
          case 'get_summary':
            toolResult = await toolGetSummary(toolArgs);
            break;
          case 'get_providers':
            toolResult = await toolGetProviders();
            break;
          case 'get_projects':
            toolResult = await toolGetProjects(toolArgs);
            break;
          case 'get_billing_window':
            toolResult = await toolGetBillingWindow();
            break;
          default:
            return makeError(id, -32601, `Unknown tool: ${toolName}`);
        }
      } catch (err) {
        // Return error as tool content, not a JSON-RPC error, so the LLM sees it
        return makeResult(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }

      return makeResult(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(toolResult, null, 2),
          },
        ],
      });
    }

    default:
      return makeError(id, -32601, `Method not found: ${method}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load pricing data once before handling any messages
  await loadPricing();

  const rl = createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      process.stderr.write(`[mcp] Malformed JSON: ${err.message}\n`);
      return;
    }

    // Validate minimal JSON-RPC structure
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || !msg.method) {
      process.stderr.write(`[mcp] Invalid JSON-RPC message\n`);
      return;
    }

    try {
      const response = await handleMessage(msg);
      // Notifications return null — no response to send
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (err) {
      process.stderr.write(`[mcp] Handler error: ${err.message}\n`);
      // Send a generic server error if we have an id to respond to
      if (msg.id !== undefined) {
        const errResponse = makeError(msg.id, -32603, `Internal error: ${err.message}`);
        process.stdout.write(JSON.stringify(errResponse) + '\n');
      }
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[mcp] Fatal startup error: ${err.message}\n`);
  process.exit(1);
});
