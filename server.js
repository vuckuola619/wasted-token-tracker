/**
 * Wasted Token Tracker — Universal AI Token Monitor Server (v1.3.0)
 * 
 * Zero-dependency HTTP server with real-time file watching,
 * ISO 27001 / GDPR / SOC 2 security hardening, budget alerts,
 * webhook integrations, multi-currency support, and system tray.
 * 
 * Endpoints:
 *   - GET /                → Dashboard (web UI)
 *   - GET /api/summary     → Aggregate summary for a period
 *   - GET /api/trends      → Historical cost/token timeseries
 *   - GET /api/providers   → Active providers on this machine
 *   - GET /api/projects    → Per-project breakdown
 *   - GET /api/export      → CSV/JSON export
 *   - GET /api/tips        → Token saving recommendations
 *   - GET /api/budget      → Budget config + status
 *   - PUT /api/budget      → Update budget thresholds
 *   - GET /api/webhooks    → Webhook config
 *   - PUT /api/webhooks    → Update webhook config
 *   - POST /api/webhooks/test → Test a webhook
 *   - GET /api/currency    → Currency config + rates
 *   - PUT /api/currency    → Change currency
 *   - GET /api/events      → Server-Sent Events (real-time)
 *   - GET /api/health      → Health check (with watcher status)
 *   - DELETE /api/cache    → Purge all cached data (GDPR erasure)
 * 
 * No npm install needed — uses only Node.js built-ins.
 */

import http from 'http';
import { readFile } from 'fs/promises';
import { join, dirname, extname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { loadPricing, getContextWindow } from './models.js';
import { getAggregateSummary, parseAllSessions, getDateRange, invalidateCache } from './parser.js';
import { getActiveProviders, getProviderNames, getProviderWatchPaths } from './providers/index.js';
import { getModelHintsPath, saveModelHints, invalidateModelHintsCache } from './providers/antigravity.js';
import { FileWatcher, SSEManager } from './watcher.js';
import {
  applySecurityHeaders, checkRateLimit, validateQueryParams,
  ValidationError, isPathSafe, csvSafe, auditLog,
  initSecurity, shutdownSecurity, canAcceptSSE, incrementSSE,
  decrementSSE, getSSECount, isURLLengthValid, validateTokenCounts,
  validateAuth, isAuthRequired, getAuthToken, redactProjectName,
} from './security.js';
import {
  loadBudgetConfig, saveBudgetConfig, getBudgetConfig,
  checkBudgets, processAlerts, onBudgetAlert,
  getBreachHistory, computeSpending,
} from './budget.js';
import {
  loadWebhookConfig, saveWebhookConfig, getWebhookConfig,
  sendWebhookNotification, testWebhook,
} from './webhooks.js';
import {
  loadCurrencyConfig, saveCurrencyConfig,
  convertFromUSD, getAvailableCurrencies, getCurrentCurrency,
  getRatesInfo,
} from './currency.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3777;
const HOST = process.env.WASTED_TOKEN_HOST || '127.0.0.1';
const VERSION = '1.4.0';
const VALID_PERIODS = new Set(['today', 'week', '30days', 'month', 'all']);

// ─── MIME Types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ─── Real-Time Monitoring ──────────────────────────────────────────────────────
const fileWatcher = new FileWatcher();
const sseManager = new SSEManager();
let serverStartTime = Date.now();

// ─── API Routes ────────────────────────────────────────────────────────────────
async function handleAPI(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // URL length check
  if (!isURLLengthValid(req.url)) {
    res.statusCode = 414;
    return json(res, { error: 'URL too long' });
  }

  // Rate limiting
  const rateCheck = checkRateLimit(req);
  res.setHeader('X-RateLimit-Remaining', rateCheck.remaining);
  if (!rateCheck.allowed) {
    res.statusCode = 429;
    res.setHeader('Retry-After', Math.ceil(rateCheck.resetMs / 1000));
    auditLog('rate_limited', { path });
    return json(res, { error: 'Too many requests. Try again later.' });
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    // ─── Health Check ──────────────────────────────────────────────────
    if (path === '/api/health') {
      return json(res, {
        status: 'ok',
        version: VERSION,
        timestamp: new Date().toISOString(),
        uptime: Math.round((Date.now() - serverStartTime) / 1000),
        watchers: fileWatcher.getStats(),
        sseClients: sseManager.getClientCount(),
      });
    }

    // ─── SSE Stream (Real-Time Events) ─────────────────────────────────
    if (path === '/api/events') {
      if (!canAcceptSSE()) {
        res.statusCode = 503;
        return json(res, { error: 'Too many streaming connections' });
      }
      incrementSSE();
      const count = sseManager.addClient(res);
      auditLog('sse_connect', { clients: count });
      res.on('close', () => {
        decrementSSE();
        auditLog('sse_disconnect', { clients: sseManager.getClientCount() });
      });
      return; // Keep connection open
    }

    // ─── GDPR Right to Erasure ─────────────────────────────────────────
    if (path === '/api/cache' && req.method === 'DELETE') {
      invalidateCache();
      auditLog('cache_purged', { reason: 'user_request' });
      return json(res, { status: 'ok', message: 'All cached data purged' });
    }

    // Validate query params for data endpoints
    let params;
    try {
      params = validateQueryParams(url);
    } catch (err) {
      if (err instanceof ValidationError) {
        res.statusCode = 400;
        return json(res, { error: err.message });
      }
      throw err;
    }

    if (path === '/api/providers') {
      const active = await getActiveProviders();
      const all = getProviderNames();
      return json(res, { active, all });
    }

    if (path === '/api/summary') {
      const summary = await getAggregateSummary(params.period, params.provider);
      if (params.redact && summary.projects) {
        summary.projects = summary.projects.map(p => ({
          ...p,
          project: redactProjectName(p.project),
        }));
      }
      // Attach context window limit to each model entry (use raw modelId for accurate lookup)
      if (summary.models) {
        summary.models = summary.models.map(m => ({
          ...m,
          contextWindow: getContextWindow(m.model) ?? getContextWindow(m.name),
        }));
      }
      return json(res, summary);
    }

    if (path === '/api/projects') {
      const { range } = getDateRange(params.period);
      const projects = await parseAllSessions(range, params.provider);
      return json(res, projects.map(p => ({
        project: params.redact ? redactProjectName(p.project) : p.project,
        provider: p.provider,
        providerDisplayName: p.providerDisplayName,
        costUSD: p.totalCostUSD,
        apiCalls: p.totalApiCalls,
        inputTokens: p.totalInputTokens,
        outputTokens: p.totalOutputTokens,
        cacheReadTokens: p.totalCacheReadTokens,
        reasoningTokens: p.totalReasoningTokens,
        models: p.modelBreakdown,
        tools: p.toolBreakdown,
      })));
    }

    // ─── Historical Cost Trends API ────────────────────────────────────
    if (path === '/api/trends') {
      const granularity = url.searchParams.get('granularity') || 'daily';
      const targetPeriod = VALID_PERIODS.has(params.period) ? params.period : '30days';
      const { range } = getDateRange(targetPeriod);
      const projects = await parseAllSessions(range, params.provider);

      // Build daily cost + token timeseries
      const dailyMap = {};
      for (const proj of projects) {
        for (const call of proj.calls) {
          if (!call.timestamp) continue;
          const day = call.timestamp.slice(0, 10);
          if (!dailyMap[day]) dailyMap[day] = { date: day, cost: 0, tokens: 0, calls: 0 };
          dailyMap[day].cost += call.costUSD || 0;
          dailyMap[day].tokens += (call.inputTokens || 0) + (call.outputTokens || 0);
          dailyMap[day].calls += 1;
        }
      }

      let timeseries = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

      // Weekly aggregation
      if (granularity === 'weekly') {
        const weeklyMap = {};
        for (const d of timeseries) {
          const dt = new Date(d.date);
          const weekStart = new Date(dt);
          weekStart.setDate(dt.getDate() - dt.getDay());
          const key = weekStart.toISOString().slice(0, 10);
          if (!weeklyMap[key]) weeklyMap[key] = { date: key, cost: 0, tokens: 0, calls: 0 };
          weeklyMap[key].cost += d.cost;
          weeklyMap[key].tokens += d.tokens;
          weeklyMap[key].calls += d.calls;
        }
        timeseries = Object.values(weeklyMap).sort((a, b) => a.date.localeCompare(b.date));
      }

      // Add currency conversion
      const currency = getCurrentCurrency();
      for (const entry of timeseries) {
        const converted = convertFromUSD(entry.cost);
        entry.costLocal = converted.value;
        entry.currency = converted.currency;
        entry.costFormatted = converted.formatted;
      }

      // Compute running total
      let runningCost = 0;
      for (const entry of timeseries) {
        runningCost += entry.cost;
        entry.cumulativeCost = Math.round(runningCost * 100) / 100;
      }

      return json(res, {
        period: targetPeriod,
        granularity,
        currency,
        timeseries,
        summary: {
          totalDays: timeseries.length,
          avgDailyCost: timeseries.length > 0 ? runningCost / timeseries.length : 0,
          maxDailyCost: timeseries.length > 0 ? Math.max(...timeseries.map(t => t.cost)) : 0,
          totalCost: runningCost,
        },
      });
    }

    // ─── Budget API ───────────────────────────────────────────────────────
    if (path === '/api/budget') {
      if (req.method === 'GET') {
        const config = getBudgetConfig();
        // Compute current spending
        const summaries = {};
        for (const p of ['today', 'week', 'month']) {
          summaries[p] = await getAggregateSummary(p, 'all');
        }
        const spending = computeSpending(summaries);
        const alerts = checkBudgets(spending);
        const breaches = getBreachHistory(10);
        const currency = getCurrentCurrency();

        return json(res, {
          config,
          spending: {
            daily: { spent: spending.daily, budget: config.daily, ...convertFromUSD(spending.daily) },
            weekly: { spent: spending.weekly, budget: config.weekly, ...convertFromUSD(spending.weekly) },
            monthly: { spent: spending.monthly, budget: config.monthly, ...convertFromUSD(spending.monthly) },
          },
          alerts: alerts.filter(a => !a.coolingDown),
          breaches,
          currency,
        });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readRequestBody(req);
        const config = JSON.parse(body);
        await saveBudgetConfig(config);
        return json(res, { status: 'ok', config: getBudgetConfig() });
      }
    }

    // ─── Webhook API ──────────────────────────────────────────────────────
    if (path === '/api/webhooks') {
      if (req.method === 'GET') {
        return json(res, getWebhookConfig());
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readRequestBody(req);
        const config = JSON.parse(body);
        await saveWebhookConfig(config);
        return json(res, { status: 'ok', config: getWebhookConfig() });
      }
    }
    if (path === '/api/webhooks/test') {
      if (req.method === 'POST') {
        const body = await readRequestBody(req);
        const hook = JSON.parse(body);
        const result = await testWebhook(hook);
        return json(res, result);
      }
    }

    // ─── Currency API ─────────────────────────────────────────────────────
    if (path === '/api/currency') {
      if (req.method === 'GET') {
        return json(res, {
          current: getCurrentCurrency(),
          currencies: getAvailableCurrencies(),
          rates: getRatesInfo(),
        });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readRequestBody(req);
        const { currency } = JSON.parse(body);
        await saveCurrencyConfig(currency);
        return json(res, { status: 'ok', currency: getCurrentCurrency() });
      }
    }

    if (path === '/api/multi-period') {
      const periods = ['today', 'week', '30days', 'month'];
      const results = {};
      for (const period of periods) {
        results[period] = await getAggregateSummary(period, params.provider);
      }
      return json(res, results);
    }

    if (path === '/api/wrapped') {
      const summary = await getAggregateSummary('all', params.provider);
      const totalTokens = summary.totalInputTokens + summary.totalOutputTokens + summary.totalCacheReadTokens;
      
      let rank = 'Type 0 (Local Scripter)';
      if (totalTokens > 10_000_000) rank = 'Type III (Galactic Architect)';
      else if (totalTokens > 1_000_000) rank = 'Type II (Stellar Developer)';
      else if (totalTokens > 100_000) rank = 'Type I (Planetary Coder)';

      return json(res, {
        totalTokens,
        totalCostUSD: summary.totalCostUSD,
        rank,
        topModels: summary.models.sort((a,b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)).slice(0, 3)
      });
    }

    if (path === '/api/billing-window') {
      const { getBillingWindow } = await import('./billing-window.js');
      return json(res, await getBillingWindow());
    }

    // ─── Export API (CSV + JSON) with CSV injection protection ────────
    if (path === '/api/export') {
      const { range } = getDateRange(params.period);
      const projectsRaw = await parseAllSessions(range, params.provider);
      const rows = projectsRaw.map(p => ({
        project: p.project,
        provider: p.provider,
        providerDisplayName: p.providerDisplayName,
        costUSD: p.totalCostUSD,
        apiCalls: p.totalApiCalls,
        inputTokens: p.totalInputTokens,
        outputTokens: p.totalOutputTokens,
        cacheReadTokens: p.totalCacheReadTokens,
        cacheWriteTokens: p.totalCacheWriteTokens,
        reasoningTokens: p.totalReasoningTokens,
      }));
      if (params.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="wasted-token-tracker-${params.period}.csv"`);
        const head = Object.keys(rows[0] || {}).map(csvSafe).join(',');
        const body = rows.map(r => Object.values(r).map(csvSafe).join(',')).join('\n');
        auditLog('data_export', { format: 'csv', period: params.period, rows: rows.length });
        return res.end(head + '\n' + body);
      }
      auditLog('data_export', { format: 'json', period: params.period, rows: rows.length });
      return json(res, { period: params.period, rows });
    }

    // ─── Token Saving Tips API ───────────────────────────────────────
    if (path === '/api/tips') {
      const summary = await getAggregateSummary('week', 'all');
      const tips = generateTokenSavingTips(summary);
      return json(res, { tips });
    }

    // ─── Model Hints Config API ─────────────────────────────────────
    if (path === '/api/model-hints') {
      if (req.method === 'GET') {
        const { readFile: rf } = await import('fs/promises');
        const hintsPath = getModelHintsPath();
        try {
          const raw = await rf(hintsPath, 'utf-8');
          return json(res, {
            hints: JSON.parse(raw),
            path: hintsPath,
            availableModels: [
              { id: 'claude-opus-4-6', name: 'Claude Opus 4.6 (Thinking)' },
              { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
              { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
              { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
              { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
              { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
              { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
              { id: 'gpt-oss-120b', name: 'GPT-OSS 120B' },
            ],
          });
        } catch {
          return json(res, {
            hints: { defaultModel: 'gemini-3.1-pro', conversations: {} },
            path: hintsPath,
            note: 'No config file found. Using defaults.',
          });
        }
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readRequestBody(req);
        const hints = JSON.parse(body);
        // Validate structure
        if (!hints.defaultModel || typeof hints.defaultModel !== 'string') {
          res.statusCode = 400;
          return json(res, { error: 'defaultModel is required and must be a string' });
        }
        await saveModelHints(hints);
        invalidateCache(); // Force re-parse with new model hints
        auditLog('model_hints_updated', { defaultModel: hints.defaultModel });
        return json(res, { status: 'ok', hints });
      }
    }

    res.statusCode = 404;
    return json(res, { error: 'Not found' });
  } catch (err) {
    auditLog('api_error', { path, error: err.message, level: 'error' });
    res.statusCode = 500;
    // Don't leak internal error details in production
    return json(res, { error: 'Internal server error' });
  }
}

function json(res, data) {
  if (!res.writableEnded) {
    res.end(JSON.stringify(data));
  }
}

/** Read request body with size limit (64KB). */
function readRequestBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ─── Token Saving Advisor Engine ───────────────────────────────────────────────
function generateTokenSavingTips(summary) {
  const tips = [];
  const { totalInputTokens = 0, totalOutputTokens = 0, totalCacheReadTokens = 0,
          totalCacheWriteTokens = 0, totalCostUSD = 0, totalApiCalls = 0 } = summary;
  const total = totalInputTokens + totalOutputTokens;

  // RTK tip: if high token usage, recommend RTK
  if (total > 500_000) {
    tips.push({
      id: 'rtk-proxy',
      severity: 'high',
      title: 'Reduce tokens by 60-90% with RTK',
      description: 'RTK (github.com/rtk-ai/rtk) is a CLI proxy that compresses command outputs before they reach your LLM context. Run `rtk init -g` to auto-hook your shell commands.',
      savings: '60-90% on bash/terminal output tokens',
      link: 'https://github.com/rtk-ai/rtk',
    });
  }

  // Cache efficiency
  const cacheTotal = totalCacheReadTokens + totalCacheWriteTokens;
  if (cacheTotal === 0 && total > 100_000) {
    tips.push({
      id: 'enable-caching',
      severity: 'high',
      title: 'Enable prompt caching',
      description: 'Your sessions have 0 cached tokens. Enabling prompt caching can reduce input costs by up to 90%. Set system prompts and project context as cacheable prefixes.',
      savings: 'Up to 90% on repeated input tokens',
    });
  } else if (cacheTotal > 0) {
    const hitRate = totalCacheReadTokens / Math.max(cacheTotal, 1) * 100;
    if (hitRate < 50) {
      tips.push({
        id: 'improve-cache-hits',
        severity: 'medium',
        title: `Cache hit rate is only ${hitRate.toFixed(0)}%`,
        description: 'Too many cache writes vs reads. Keep session context stable to maximize cache hits. Avoid changing system prompts mid-conversation.',
        savings: `Could save ~${((cacheTotal * 0.5) / 1000).toFixed(0)}K tokens with better caching`,
      });
    }
  }

  // Karpathy Wiki pattern
  if (totalApiCalls > 3 && totalInputTokens > 1_000_000) {
    tips.push({
      id: 'llm-wiki',
      severity: 'medium',
      title: 'Use a persistent context file (LLM-Wiki pattern)',
      description: 'You\'re feeding 1M+ input tokens per week. Create a CLAUDE.md or AGENTS.md with project context so the LLM doesn\'t re-discover your codebase each session. (Karpathy\'s LLM-Wiki pattern)',
      savings: 'Reduce per-session bootstrap tokens by 30-50%',
      link: 'https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f',
    });
  }

  // Model selection
  if (summary.models?.length > 0) {
    const expensiveModels = summary.models.filter(m =>
      m.name.includes('Opus') || m.name.includes('GPT-5') || m.name.includes('o3')
    );
    if (expensiveModels.length > 0 && totalCostUSD > 50) {
      const expCost = expensiveModels.reduce((s, m) => s + m.costUSD, 0);
      tips.push({
        id: 'model-tiering',
        severity: 'medium',
        title: `$${expCost.toFixed(0)} spent on premium models this week`,
        description: 'Consider using Sonnet/Haiku/Flash for simpler tasks (reading, searching, scaffolding). Reserve Opus/GPT-5/o3 for complex reasoning only.',
        savings: `Potential 40-70% cost reduction (~$${(expCost * 0.5).toFixed(0)} savings)`,
      });
    }
  }

  // Cost per call
  if (totalApiCalls > 0) {
    const costPerCall = totalCostUSD / totalApiCalls;
    if (costPerCall > 5) {
      tips.push({
        id: 'break-up-sessions',
        severity: 'low',
        title: `Avg $${costPerCall.toFixed(2)} per API call`,
        description: 'Very long sessions accumulate large context windows. Break complex tasks into smaller sub-tasks to reduce per-call token counts.',
        savings: 'Smaller context = faster responses + lower cost',
      });
    }
  }

  // Tool config
  tips.push({
    id: 'config-tuning',
    severity: 'info',
    title: 'Config tuning checklist',
    description: 'Set .cursorrules / .clinerules to limit file exploration scope. Use .gitignore-aware tools. Disable auto-indexing of node_modules and dist folders.',
    savings: 'Prevents unnecessary file reads (10-30% input savings)',
  });

  return tips;
}

// ─── Static File Serving (with path traversal protection) ──────────────────────
async function serveStatic(req, res) {
  const rawPath = req.url === '/' ? '/index.html' : req.url.split('?')[0]; // Strip query string

  // Step 1: Fully decode the URL before any path operations.
  // This defeats %2e%2e%2f and double-encoding bypasses.
  let filePath;
  try {
    filePath = decodeURIComponent(rawPath);
  } catch {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('Bad Request');
  }

  // Step 2: Regex/heuristic check on the decoded path
  if (!isPathSafe(filePath)) {
    auditLog('path_traversal_blocked', { path: filePath, level: 'warn' });
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('Forbidden');
  }

  // Step 3: Resolve to absolute path and verify containment.
  // Strip leading slashes to prevent resolve() treating it as an absolute path.
  const publicDir = resolve(__dirname, 'public');
  const fullPath = resolve(publicDir, filePath.replace(/^\/+/, ''));

  // Belt-and-suspenders: resolved path must be inside publicDir
  if (!fullPath.startsWith(publicDir + sep) && fullPath !== publicDir) {
    auditLog('path_escape_blocked', { path: filePath, resolved: fullPath, level: 'warn' });
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('Forbidden');
  }

  const ext = extname(fullPath);

  try {
    let content = await readFile(fullPath);

    // Inject auth token into HTML via <meta> tag (CSP-safe, no inline script)
    if (ext === '.html') {
      const token = getAuthToken();
      if (token) {
        let html = content.toString('utf-8');
        html = html.replace(
          '<meta charset="UTF-8">',
          `<meta charset="UTF-8">\n  <meta name="ag-auth-token" content="${token}">`
        );
        res.setHeader('Content-Type', MIME[ext]);
        return res.end(html);
      }
    }

    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Not Found');
  }
}

// ─── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Apply security headers to ALL responses
  applySecurityHeaders(res);

  // Only allow specific methods
  const allowedMethods = ['GET', 'DELETE', 'PUT', 'POST', 'OPTIONS'];
  if (!allowedMethods.includes(req.method)) {
    res.statusCode = 405;
    res.setHeader('Allow', allowedMethods.join(', '));
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.statusCode = 204;
    return res.end();
  }

  // Authentication check for API endpoints (except health)
  if (req.url.startsWith('/api/')) {
    const apiPath = new URL(req.url, `http://localhost:${PORT}`).pathname;
    if (apiPath !== '/api/health' && isAuthRequired() && !validateAuth(req)) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('WWW-Authenticate', 'Bearer');
      auditLog('auth_rejected', { path: apiPath, ip: req.socket?.remoteAddress, level: 'warn' });
      return res.end(JSON.stringify({ error: 'Authentication required' }));
    }
    return handleAPI(req, res);
  }
  return serveStatic(req, res);
});

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  auditLog('shutdown_start', { signal, uptime: Math.round((Date.now() - serverStartTime) / 1000) });
  console.log(`\n  ⏹  Received ${signal}, shutting down gracefully...`);

  // 1. Stop accepting new connections
  server.close(() => {
    auditLog('http_closed');
  });

  // 2. Close SSE connections
  sseManager.closeAll();

  // 3. Stop file watchers
  fileWatcher.stop();

  // 4. Cleanup security module
  shutdownSecurity();

  auditLog('shutdown_complete');
  console.log('  ✓  All resources released. Goodbye.\n');

  // Give logs time to flush
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  auditLog('uncaught_exception', { message: err.message, stack: err.stack?.slice(0, 500), level: 'error' });
  console.error('[FATAL]', err);
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  auditLog('unhandled_rejection', { reason: String(reason).slice(0, 500), level: 'error' });
  console.error('[FATAL] Unhandled rejection:', reason);
});

// ─── Startup ───────────────────────────────────────────────────────────────────
async function main() {
  serverStartTime = Date.now();

  console.log('\n  ⚡ Wasted Token Tracker — Universal AI Token Monitor (v' + VERSION + ')');
  console.log('  ─────────────────────────────────────────────────────\n');

  // Initialize security module
  initSecurity();
  auditLog('server_start', { version: VERSION, port: PORT });

  // Load model pricing
  console.log('  [1/7] Loading LLM pricing data...');
  await loadPricing();

  // Discover providers
  console.log('  [2/7] Discovering AI coding tools...');
  const active = await getActiveProviders();
  if (active.length === 0) {
    console.log('  ⚠  No AI coding tools detected on this machine.');
    console.log('  Supported: Antigravity, Claude Code, Codex, Cursor, Windsurf, Cline, Copilot, Continue.dev, Aider\n');
  } else {
    for (const p of active) {
      console.log(`  ✓  ${p.displayName} — ${p.sessionCount} sessions found`);
    }
  }

  // Start file watchers
  console.log('\n  [3/7] Starting real-time file watchers...');
  try {
    const watchPaths = await getProviderWatchPaths();
    for (const { provider, paths } of watchPaths) {
      for (const watchPath of paths) {
        fileWatcher.watchDirectory(watchPath, provider);
      }
    }
    const stats = fileWatcher.getStats();
    console.log(`  ✓  ${stats.active} directories being watched`);
  } catch (err) {
    console.log(`  ⚠  File watching unavailable: ${err.message}`);
    console.log('  Falling back to 60-second polling.');
  }

  // Wire watcher → SSE broadcast + cache invalidation
  fileWatcher.on('change', (event) => {
    invalidateCache();
    sseManager.broadcast('session-update', {
      provider: event.provider,
      type: event.type,
      timestamp: event.timestamp,
    });
  });

  // Initialize budget, webhooks, currency
  console.log('\n  [4/7] Loading budget configuration...');
  await loadBudgetConfig();
  const budgetCfg = getBudgetConfig();
  if (budgetCfg.daily || budgetCfg.weekly || budgetCfg.monthly) {
    console.log(`  ✓  Budget thresholds active (daily: $${budgetCfg.daily || '∞'}, weekly: $${budgetCfg.weekly || '∞'}, monthly: $${budgetCfg.monthly || '∞'})`);
  } else {
    console.log('  ○  No budget thresholds set. Configure at /api/budget or ~/.wasted-token-tracker/budgets.json');
  }

  console.log('\n  [5/7] Loading webhook configuration...');
  await loadWebhookConfig();
  const webhookCfg = getWebhookConfig();
  const enabledHooks = webhookCfg.webhooks?.filter(w => w.enabled) || [];
  if (enabledHooks.length > 0) {
    console.log(`  ✓  ${enabledHooks.length} webhook(s) active: ${enabledHooks.map(w => w.type).join(', ')}`);
  } else {
    console.log('  ○  No webhooks configured. See /api/webhooks');
  }

  // Wire budget alerts → webhooks
  onBudgetAlert(async (alerts) => {
    await sendWebhookNotification('budget_alert', alerts);
    // Broadcast to SSE clients
    sseManager.broadcast('budget-alert', { alerts });
  });

  console.log('\n  [6/7] Loading currency configuration...');
  await loadCurrencyConfig();
  console.log(`  ✓  Currency: ${getCurrentCurrency()}`);

  // Wire file watcher → budget checking
  fileWatcher.on('change', async () => {
    try {
      const summaries = {};
      for (const p of ['today', 'week', 'month']) {
        summaries[p] = await getAggregateSummary(p, 'all');
      }
      const spending = computeSpending(summaries);
      const alerts = checkBudgets(spending);
      if (alerts.length > 0) {
        await processAlerts(alerts);
      }
    } catch { /* non-critical */ }
  });

  // Daily summary webhook (fires at midnight)
  scheduleDailySummary();

  // Start server
  console.log(`\n  [7/7] Starting dashboard server...`);
  server.listen(PORT, HOST, () => {
    console.log(`\n  🔥 Dashboard:  http://${HOST}:${PORT}`);
    console.log(`  📊 API:        http://${HOST}:${PORT}/api/summary`);
    console.log(`  📈 Trends:     http://${HOST}:${PORT}/api/trends`);
    console.log(`  🔌 Providers:  http://${HOST}:${PORT}/api/providers`);
    console.log(`  📡 Events:     http://${HOST}:${PORT}/api/events`);
    console.log(`  💰 Budget:     http://${HOST}:${PORT}/api/budget`);
    console.log(`  🔗 Webhooks:   http://${HOST}:${PORT}/api/webhooks`);
    console.log(`  💱 Currency:   http://${HOST}:${PORT}/api/currency`);
    console.log(`  🔒 Security:   Rate limiting (${120}/min), CSP, Auth, localhost-only`);
    if (isAuthRequired()) {
      const token = getAuthToken();
      console.log(`  🔑 Auth Token: ${token?.slice(0, 8)}...${token?.slice(-4)} (full token in ~/.wasted-token-tracker/auth-secret)`);
    } else {
      console.log(`  🔑 Auth:       Not enforced (localhost binding). Set WASTED_TOKEN_AUTH=required to enable.`);
    }
    console.log('');
    auditLog('server_ready', { port: PORT, host: HOST, authRequired: isAuthRequired(), features: ['trends', 'budget', 'webhooks', 'currency'] });
  });
}

// ─── Daily Summary Scheduler ──────────────────────────────────────────────────
function scheduleDailySummary() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0); // 00:05 tomorrow
  const ms = next.getTime() - now.getTime();

  setTimeout(async () => {
    try {
      const summary = await getAggregateSummary('today', 'all');
      await sendWebhookNotification('daily_summary', summary);
      auditLog('daily_summary_sent', { cost: summary.totalCostUSD });
    } catch (err) {
      auditLog('daily_summary_error', { error: err.message, level: 'error' });
    }
    // Reschedule
    scheduleDailySummary();
  }, ms).unref();
}



main().catch(err => {
  auditLog('fatal_startup', { error: err.message, level: 'error' });
  console.error('Fatal:', err);
  process.exit(1);
});
