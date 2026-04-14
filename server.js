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

    // ─── Export API (CSV + JSON) ─────────────────────────────────────────
    if (path === '/api/export') {
      const period = url.searchParams.get('period') || 'week';
      const provider = url.searchParams.get('provider') || 'all';
      const fmt = url.searchParams.get('format') || 'json';
      const { range } = getDateRange(period);
      const projectsRaw = await parseAllSessions(range, provider);
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
      if (fmt === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="ag-code-token-${period}.csv"`);
        const head = Object.keys(rows[0] || {}).join(',');
        const body = rows.map(r => Object.values(r).join(',')).join('\n');
        return res.end(head + '\n' + body);
      }
      return json(res, { period, rows });
    }

    // ─── Token Saving Tips API ───────────────────────────────────────────
    if (path === '/api/tips') {
      const summary = await getAggregateSummary('week', 'all');
      const tips = generateTokenSavingTips(summary);
      return json(res, { tips });
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
