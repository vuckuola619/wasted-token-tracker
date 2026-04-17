/**
 * AG-Code Token — Universal AI Token Monitor Server (v1.2.0)
 * 
 * Zero-dependency HTTP server with real-time file watching and
 * ISO 27001 / GDPR / SOC 2 security hardening.
 * 
 * Endpoints:
 *   - GET /                → Dashboard (web UI)
 *   - GET /api/summary     → Aggregate summary for a period
 *   - GET /api/providers   → Active providers on this machine
 *   - GET /api/projects    → Per-project breakdown
 *   - GET /api/export      → CSV/JSON export
 *   - GET /api/tips        → Token saving recommendations
 *   - GET /api/events      → Server-Sent Events (real-time)
 *   - GET /api/health      → Health check (with watcher status)
 *   - DELETE /api/cache    → Purge all cached data (GDPR erasure)
 * 
 * No npm install needed — uses only Node.js built-ins.
 */

import http from 'http';
import { readFile } from 'fs/promises';
import { join, dirname, extname, resolve, normalize } from 'path';
import { fileURLToPath } from 'url';
import { loadPricing } from './models.js';
import { getAggregateSummary, parseAllSessions, getDateRange, invalidateCache } from './parser.js';
import { getActiveProviders, getProviderNames, getProviderWatchPaths } from './providers/index.js';
import { getModelHintsPath, saveModelHints, invalidateModelHintsCache } from './providers/antigravity.js';
import { FileWatcher, SSEManager } from './watcher.js';
import {
  applySecurityHeaders, checkRateLimit, validateQueryParams,
  ValidationError, isPathSafe, csvSafe, auditLog,
  initSecurity, shutdownSecurity, canAcceptSSE, incrementSSE,
  decrementSSE, getSSECount, isURLLengthValid, validateTokenCounts,
} from './security.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3777;
const VERSION = '1.2.0';

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
      return json(res, summary);
    }

    if (path === '/api/projects') {
      const { range } = getDateRange(params.period);
      const projects = await parseAllSessions(range, params.provider);
      return json(res, projects.map(p => ({
        project: p.project,
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
        topModels: summary.models.sort((a,b) => b.tokens - a.tokens).slice(0, 3)
      });
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
        res.setHeader('Content-Disposition', `attachment; filename="ag-code-token-${params.period}.csv"`);
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
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0]; // Strip query string

  // Security: path traversal protection
  if (!isPathSafe(filePath)) {
    auditLog('path_traversal_blocked', { path: filePath, level: 'warn' });
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('Forbidden');
  }

  const publicDir = join(__dirname, 'public');
  const fullPath = normalize(join(publicDir, filePath));

  // Ensure resolved path is within public directory (belt-and-suspenders)
  if (!fullPath.startsWith(normalize(publicDir))) {
    auditLog('path_escape_blocked', { path: filePath, level: 'warn' });
    res.statusCode = 403;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('Forbidden');
  }

  const ext = extname(filePath);

  try {
    const content = await readFile(fullPath);
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 204;
    return res.end();
  }

  if (req.url.startsWith('/api/')) {
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

  console.log('\n  ⚡ AG-Code Token — Universal AI Token Monitor (v' + VERSION + ')');
  console.log('  ─────────────────────────────────────────────────────\n');

  // Initialize security module
  initSecurity();
  auditLog('server_start', { version: VERSION, port: PORT });

  // Load model pricing
  console.log('  [1/4] Loading LLM pricing data...');
  await loadPricing();

  // Discover providers
  console.log('  [2/4] Discovering AI coding tools...');
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
  console.log('\n  [3/4] Starting real-time file watchers...');
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

  // Start server
  console.log(`\n  [4/4] Starting dashboard server...`);
  server.listen(PORT, () => {
    console.log(`\n  🔥 Dashboard:  http://localhost:${PORT}`);
    console.log(`  📊 API:        http://localhost:${PORT}/api/summary`);
    console.log(`  🔌 Providers:  http://localhost:${PORT}/api/providers`);
    console.log(`  📡 Events:     http://localhost:${PORT}/api/events`);
    console.log(`  🔒 Security:   Rate limiting (${120}/min), CSP, CORS\n`);
    auditLog('server_ready', { port: PORT });
  });
}

main().catch(err => {
  auditLog('fatal_startup', { error: err.message, level: 'error' });
  console.error('Fatal:', err);
  process.exit(1);
});
