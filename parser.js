/**
 * Universal Parser Pipeline
 * 
 * Orchestrates session discovery → parsing → deduplication → 
 * date filtering → aggregation across ALL providers.
 * 
 * Output: ProjectSummary[] sorted by total cost descending.
 */

import { discoverAllSessions, getProvider } from './providers/index.js';
import { getShortModelName } from './models.js';

// ─── Caching ───────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60_000; // 60 seconds
const sessionCache = new Map();

function cacheKey(dateRange, providerFilter) {
  const s = dateRange ? `${dateRange.start.getTime()}:${dateRange.end.getTime()}` : 'none';
  return `${s}:${providerFilter ?? 'all'}`;
}

// ─── Date Range Helpers ────────────────────────────────────────────────────────
export function getDateRange(period) {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  switch (period) {
    case 'today': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { range: { start, end }, label: `Today (${start.toISOString().slice(0, 10)})` };
    }
    case 'week': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
      return { range: { start, end }, label: 'Last 7 Days' };
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { range: { start, end }, label: `${now.toLocaleString('default', { month: 'long' })} ${now.getFullYear()}` };
    }
    case '30days': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
      return { range: { start, end }, label: 'Last 30 Days' };
    }
    case 'all': {
      return { range: { start: new Date(0), end }, label: 'All Time' };
    }
    default: {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
      return { range: { start, end }, label: 'Last 7 Days' };
    }
  }
}

// ─── Core Pipeline ─────────────────────────────────────────────────────────────

/**
 * Parse all sessions across all providers.
 * 
 * Pipeline:
 *   1. discoverAllSessions(filter)
 *   2. For each provider, parse session files via async generator
 *   3. Apply date filter per parsed call
 *   4. Aggregate into ProjectSummary[]
 *   5. Cache result for 60 seconds
 * 
 * @param {Object} [dateRange] - { start: Date, end: Date }
 * @param {string} [providerFilter] - 'all', 'antigravity', 'claude', etc.
 * @returns {Promise<Object[]>} ProjectSummary array
 */
export async function parseAllSessions(dateRange, providerFilter) {
  const key = cacheKey(dateRange, providerFilter);
  const cached = sessionCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const seenKeys = new Set();
  const allSources = await discoverAllSessions(providerFilter);

  // Group sources by provider
  const providerGroups = new Map();
  for (const source of allSources) {
    const existing = providerGroups.get(source.provider) ?? [];
    existing.push(source);
    providerGroups.set(source.provider, existing);
  }

  // Parse all provider groups
  const projectMap = new Map();

  for (const [providerName, sources] of providerGroups) {
    const provider = getProvider(providerName);
    if (!provider) continue;

    for (const source of sources) {
      const parser = provider.createSessionParser(source, seenKeys);

      for await (const call of parser.parse()) {
        // Date filter
        if (dateRange && call.timestamp) {
          const ts = new Date(call.timestamp);
          if (ts < dateRange.start || ts > dateRange.end) continue;
        }

        // Aggregate into project
        const projectKey = `${providerName}:${source.project}`;
        if (!projectMap.has(projectKey)) {
          projectMap.set(projectKey, {
            project: source.project,
            provider: providerName,
            providerDisplayName: provider.displayName,
            sessions: [],
            calls: [],
            totalCostUSD: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
            totalReasoningTokens: 0,
            totalApiCalls: 0,
            modelBreakdown: {},
            toolBreakdown: {},
            providerBreakdown: {},
          });
        }

        const proj = projectMap.get(projectKey);
        proj.calls.push(call);
        proj.totalCostUSD += call.costUSD;
        proj.totalInputTokens += call.inputTokens;
        proj.totalOutputTokens += call.outputTokens;
        proj.totalCacheReadTokens += call.cacheReadInputTokens;
        proj.totalCacheWriteTokens += call.cacheCreationInputTokens;
        proj.totalReasoningTokens += call.reasoningTokens;
        proj.totalApiCalls++;

        // Model breakdown
        const modelName = getShortModelName(call.model);
        if (!proj.modelBreakdown[modelName]) {
          proj.modelBreakdown[modelName] = { calls: 0, costUSD: 0, inputTokens: 0, outputTokens: 0 };
        }
        proj.modelBreakdown[modelName].calls++;
        proj.modelBreakdown[modelName].costUSD += call.costUSD;
        proj.modelBreakdown[modelName].inputTokens += call.inputTokens;
        proj.modelBreakdown[modelName].outputTokens += call.outputTokens;

        // Tool breakdown
        for (const tool of call.tools) {
          const displayTool = provider.toolDisplayName(tool);
          if (!proj.toolBreakdown[displayTool]) {
            proj.toolBreakdown[displayTool] = { calls: 0 };
          }
          proj.toolBreakdown[displayTool].calls++;
        }

        // Provider breakdown
        if (!proj.providerBreakdown[providerName]) {
          proj.providerBreakdown[providerName] = { calls: 0, costUSD: 0, displayName: provider.displayName };
        }
        proj.providerBreakdown[providerName].calls++;
        proj.providerBreakdown[providerName].costUSD += call.costUSD;
      }
    }
  }

  const result = Array.from(projectMap.values()).sort((a, b) => b.totalCostUSD - a.totalCostUSD);

  // Cache
  sessionCache.set(key, { data: result, ts: Date.now() });
  // Evict old entries
  for (const [k, v] of sessionCache) {
    if (Date.now() - v.ts > CACHE_TTL_MS) sessionCache.delete(k);
  }

  return result;
}

/**
 * Get aggregate summary across all projects for a given period.
 */
export async function getAggregateSummary(period = 'week', providerFilter = 'all') {
  const { range, label } = getDateRange(period);
  const projects = await parseAllSessions(range, providerFilter);

  // Merge all breakdowns
  const modelTotals = {};
  const toolTotals = {};
  const providerTotals = {};
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalReasoning = 0;
  let totalCalls = 0;

  for (const proj of projects) {
    totalCost += proj.totalCostUSD;
    totalInput += proj.totalInputTokens;
    totalOutput += proj.totalOutputTokens;
    totalCacheRead += proj.totalCacheReadTokens;
    totalCacheWrite += proj.totalCacheWriteTokens;
    totalReasoning += proj.totalReasoningTokens;
    totalCalls += proj.totalApiCalls;

    for (const [model, data] of Object.entries(proj.modelBreakdown)) {
      if (!modelTotals[model]) modelTotals[model] = { calls: 0, costUSD: 0, inputTokens: 0, outputTokens: 0 };
      modelTotals[model].calls += data.calls;
      modelTotals[model].costUSD += data.costUSD;
      modelTotals[model].inputTokens += data.inputTokens;
      modelTotals[model].outputTokens += data.outputTokens;
    }

    for (const [tool, data] of Object.entries(proj.toolBreakdown)) {
      if (!toolTotals[tool]) toolTotals[tool] = { calls: 0 };
      toolTotals[tool].calls += data.calls;
    }

    for (const [prov, data] of Object.entries(proj.providerBreakdown)) {
      if (!providerTotals[prov]) providerTotals[prov] = { calls: 0, costUSD: 0, displayName: data.displayName };
      providerTotals[prov].calls += data.calls;
      providerTotals[prov].costUSD += data.costUSD;
    }
  }

  return {
    period: label,
    totalCostUSD: totalCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
    totalCacheWriteTokens: totalCacheWrite,
    totalReasoningTokens: totalReasoning,
    totalApiCalls: totalCalls,
    projectCount: projects.length,
    models: Object.entries(modelTotals).sort(([, a], [, b]) => b.costUSD - a.costUSD).map(([name, d]) => ({ name, ...d })),
    tools: Object.entries(toolTotals).sort(([, a], [, b]) => b.calls - a.calls).map(([name, d]) => ({ name, ...d })),
    providers: Object.entries(providerTotals).sort(([, a], [, b]) => b.costUSD - a.costUSD).map(([name, d]) => ({ name, ...d })),
    projects: projects.map(p => ({
      project: p.project,
      provider: p.provider,
      providerDisplayName: p.providerDisplayName,
      costUSD: p.totalCostUSD,
      apiCalls: p.totalApiCalls,
      inputTokens: p.totalInputTokens,
      outputTokens: p.totalOutputTokens,
    })),
  };
}
