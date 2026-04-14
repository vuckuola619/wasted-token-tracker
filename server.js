/**
 * AG-Code Token — Universal AI Token Monitor Server
 * 
 * Zero-dependency HTTP server serving:
 *   - GET /                → Dashboard (web UI)
 *   - GET /api/summary     → Aggregate summary for a period
 *   - GET /api/providers   → Active providers on this machine
 *   - GET /api/projects    → Per-project breakdown
 *   - GET /api/health      → Health check
 * 
 * No npm install needed — uses only Node.js built-ins.
 */

import http from 'http';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadPricing } from './models.js';
import { getAggregateSummary, parseAllSessions, getDateRange } from './parser.js';
import { getActiveProviders, getProviderNames } from './providers/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3777;

// ─── MIME Types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ─── API Routes ────────────────────────────────────────────────────────────────
async function handleAPI(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    if (path === '/api/health') {
      return json(res, { status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
    }

    if (path === '/api/providers') {
      const active = await getActiveProviders();
      const all = getProviderNames();
      return json(res, { active, all });
    }

    if (path === '/api/summary') {
      const period = url.searchParams.get('period') || 'week';
      const provider = url.searchParams.get('provider') || 'all';
      const summary = await getAggregateSummary(period, provider);
      return json(res, summary);
    }

    if (path === '/api/projects') {
      const period = url.searchParams.get('period') || 'week';
      const provider = url.searchParams.get('provider') || 'all';
      const { range } = getDateRange(period);
      const projects = await parseAllSessions(range, provider);
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
      const provider = url.searchParams.get('provider') || 'all';
      const periods = ['today', 'week', '30days', 'month'];
      const results = {};
      for (const period of periods) {
        results[period] = await getAggregateSummary(period, provider);
      }
      return json(res, results);
    }

    res.statusCode = 404;
    return json(res, { error: 'Not found' });
  } catch (err) {
    console.error('[API Error]', err);
    res.statusCode = 500;
    return json(res, { error: err.message });
  }
}

function json(res, data) {
  res.end(JSON.stringify(data));
}

// ─── Static File Serving ───────────────────────────────────────────────────────
async function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  const fullPath = join(__dirname, 'public', filePath);
  const ext = filePath.substring(filePath.lastIndexOf('.'));

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
  if (req.url.startsWith('/api/')) {
    return handleAPI(req, res);
  }
  return serveStatic(req, res);
});

// ─── Startup ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n  ⚡ AG-Code Token — Universal AI Token Monitor');
  console.log('  ─────────────────────────────────────────────\n');

  // Load model pricing
  console.log('  [1/3] Loading LLM pricing data...');
  await loadPricing();

  // Discover providers
  console.log('  [2/3] Discovering AI coding tools...');
  const active = await getActiveProviders();
  if (active.length === 0) {
    console.log('  ⚠  No AI coding tools detected on this machine.');
    console.log('  Supported: Antigravity, Claude Code, Codex, Cursor, Windsurf, Cline, Copilot, Continue.dev, Aider\n');
  } else {
    for (const p of active) {
      console.log(`  ✓  ${p.displayName} — ${p.sessionCount} sessions found`);
    }
  }

  // Start server
  console.log(`\n  [3/3] Starting dashboard server...`);
  server.listen(PORT, () => {
    console.log(`\n  🔥 Dashboard: http://localhost:${PORT}`);
    console.log(`  📊 API:       http://localhost:${PORT}/api/summary`);
    console.log(`  🔌 Providers: http://localhost:${PORT}/api/providers\n`);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
