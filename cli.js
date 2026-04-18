#!/usr/bin/env node
/**
 * AG-Code Token CLI — v1.3.0
 * 
 * Commands:
 *   ag-token              # Show usage summary in terminal
 *   ag-token summary      # Same as default
 *   ag-token submit       # Generate leaderboard profile
 *   ag-token tray         # Start server + open browser
 *   ag-token tray --detach # Start server in background
 *   ag-token tray --stop  # Stop background server
 *   ag-token tray --status # Check server status
 *   ag-token budget       # Show budget status
 *   ag-token budget --set-daily 10  # Set daily budget
 *   ag-token currency     # Show current currency
 *   ag-token currency EUR # Switch to Euro
 *   ag-token export       # Export data as JSON
 *   ag-token export --csv # Export data as CSV
 */

import { getAggregateSummary } from './parser.js';
import { getActiveProviders } from './providers/index.js';
import { loadPricing } from './models.js';
import { loadBudgetConfig, getBudgetConfig, saveBudgetConfig, checkBudgets, computeSpending } from './budget.js';
import { loadCurrencyConfig, saveCurrencyConfig, getCurrentCurrency, convertFromUSD, CURRENCIES } from './currency.js';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// Basic ANSI colors
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
  gray: '\x1b[90m', white: '\x1b[37m',
  bgRed: '\x1b[41m', bgGreen: '\x1b[42m', bgYellow: '\x1b[43m',
};

function fmtNum(num) {
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(2) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toString();
}

function fmtCost(usd) {
  const conv = convertFromUSD(usd);
  return conv.formatted;
}

function bar(pct, width = 30) {
  const filled = Math.round((Math.min(pct, 100) / 100) * width);
  const empty = width - filled;
  const color = pct >= 100 ? c.red : pct >= 80 ? c.yellow : c.green;
  return `${color}${'█'.repeat(filled)}${c.gray}${'░'.repeat(empty)}${c.reset}`;
}

/** Rank calculation based on Kardashev scale analogy */
function getTokscaleRank(totalTokens) {
  if (totalTokens > 10_000_000) return { rank: 'Type III (Galactic Architect)', color: c.magenta };
  if (totalTokens > 1_000_000) return { rank: 'Type II (Stellar Developer)', color: c.cyan };
  if (totalTokens > 100_000) return { rank: 'Type I (Planetary Coder)', color: c.yellow };
  return { rank: 'Type 0 (Local Scripter)', color: c.gray };
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdSummary() {
  console.log(`\n${c.bold}${c.cyan}⚡ AG-Code Token v1.3.0${c.reset}\n`);
  process.stdout.write(`${c.gray}Loading...${c.reset}\r`);

  await loadPricing();
  await loadCurrencyConfig();
  const active = await getActiveProviders();
  const summary = await getAggregateSummary('all', 'all');
  const today = await getAggregateSummary('today', 'all');
  const week = await getAggregateSummary('week', 'all');

  const totalTokens = summary.totalInputTokens + summary.totalOutputTokens + summary.totalCacheReadTokens;
  const { rank, color: rankColor } = getTokscaleRank(totalTokens);

  console.log(' '.repeat(40) + '\r');

  // Rank
  console.log(`  ${c.bold}TOKSCALE RANK${c.reset}  ${rankColor}${rank}${c.reset}\n`);

  // Cost overview
  console.log(`  ${c.bold}COST OVERVIEW${c.reset}   (${getCurrentCurrency()})`);
  console.log(`  Today:    ${c.green}${fmtCost(today.totalCostUSD)}${c.reset}  (${today.totalApiCalls} calls)`);
  console.log(`  This Week:${c.green} ${fmtCost(week.totalCostUSD)}${c.reset}  (${week.totalApiCalls} calls)`);
  console.log(`  All Time: ${c.green}${fmtCost(summary.totalCostUSD)}${c.reset}  (${summary.totalApiCalls} calls)\n`);

  // Token breakdown
  console.log(`  ${c.bold}TOKEN BREAKDOWN${c.reset}`);
  console.log(`  Input:     ${c.cyan}${fmtNum(summary.totalInputTokens)}${c.reset}`);
  console.log(`  Output:    ${c.green}${fmtNum(summary.totalOutputTokens)}${c.reset}`);
  if (summary.totalCacheReadTokens > 0) {
    console.log(`  Cached:    ${c.gray}${fmtNum(summary.totalCacheReadTokens)} (saved!)${c.reset}`);
  }
  if (summary.totalReasoningTokens > 0) {
    console.log(`  Reasoning: ${c.magenta}${fmtNum(summary.totalReasoningTokens)}${c.reset}`);
  }

  // Providers
  console.log(`\n  ${c.bold}ACTIVE PROVIDERS${c.reset}`);
  for (const p of active) {
    console.log(`  ${c.green}●${c.reset} ${p.displayName} (${p.sessionCount} sessions)`);
  }

  // Top models
  console.log(`\n  ${c.bold}TOP MODELS${c.reset}`);
  const topModels = summary.models.slice(0, 5);
  for (const m of topModels) {
    console.log(`  ${c.dim}·${c.reset} ${m.name}: ${fmtNum(m.inputTokens + m.outputTokens)} tokens (${fmtCost(m.costUSD)})`);
  }

  console.log(`\n  ${c.gray}Commands: ag-token budget | currency | tray | submit | export${c.reset}\n`);
}

async function cmdBudget(args) {
  await loadPricing();
  await loadBudgetConfig();
  await loadCurrencyConfig();

  // Handle --set flags
  if (args.includes('--set-daily') || args.includes('--set-weekly') || args.includes('--set-monthly')) {
    const config = getBudgetConfig();
    for (const period of ['daily', 'weekly', 'monthly']) {
      const flag = `--set-${period}`;
      const idx = args.indexOf(flag);
      if (idx !== -1 && args[idx + 1]) {
        config[period] = parseFloat(args[idx + 1]);
      }
    }
    await saveBudgetConfig(config);
    console.log(`\n${c.green}✓ Budget updated${c.reset}\n`);
  }

  const config = getBudgetConfig();
  const summaries = {};
  for (const p of ['today', 'week', 'month']) {
    summaries[p] = await getAggregateSummary(p, 'all');
  }
  const spending = computeSpending(summaries);
  const alerts = checkBudgets(spending);

  console.log(`\n${c.bold}${c.cyan}💰 Budget Status${c.reset}  (${getCurrentCurrency()})\n`);

  for (const period of ['daily', 'weekly', 'monthly']) {
    const budget = config[period];
    const spent = spending[period] || 0;
    if (budget) {
      const pct = Math.round((spent / budget) * 100);
      const costStr = fmtCost(spent);
      const budgetStr = fmtCost(budget);
      console.log(`  ${period.charAt(0).toUpperCase() + period.slice(1)}:  ${costStr} / ${budgetStr}  ${bar(pct)}  ${pct}%`);
    } else {
      console.log(`  ${period.charAt(0).toUpperCase() + period.slice(1)}:  ${fmtCost(spent)}  ${c.gray}(no budget set)${c.reset}`);
    }
  }

  if (alerts.length > 0) {
    console.log(`\n  ${c.bold}${c.red}ALERTS${c.reset}`);
    for (const a of alerts) {
      const emoji = a.level === 'critical' ? '🚨' : a.level === 'warning' ? '⚠️' : 'ℹ️';
      console.log(`  ${emoji}  ${a.label}`);
    }
  }

  console.log(`\n  ${c.gray}Set budgets: ag-token budget --set-daily 10 --set-weekly 50 --set-monthly 200${c.reset}\n`);
}

async function cmdCurrency(args) {
  await loadCurrencyConfig();

  if (args[0] && CURRENCIES[args[0].toUpperCase()]) {
    const code = args[0].toUpperCase();
    await saveCurrencyConfig(code);
    console.log(`\n${c.green}✓ Currency set to ${code} (${CURRENCIES[code].name})${c.reset}\n`);
    return;
  }

  console.log(`\n${c.bold}${c.cyan}💱 Currency${c.reset}  Current: ${c.green}${getCurrentCurrency()}${c.reset}\n`);
  console.log(`  ${c.bold}Available currencies:${c.reset}`);
  for (const [code, info] of Object.entries(CURRENCIES)) {
    const marker = code === getCurrentCurrency() ? `${c.green}●${c.reset}` : `${c.gray}○${c.reset}`;
    console.log(`  ${marker} ${code}  ${info.symbol}  ${info.name}`);
  }
  console.log(`\n  ${c.gray}Switch: ag-token currency EUR${c.reset}\n`);
}

async function cmdExport(args) {
  const format = args.includes('--csv') ? 'csv' : 'json';
  const period = args.find(a => ['today', 'week', '30days', 'month', 'all'].includes(a)) || 'week';

  await loadPricing();
  const { parseAllSessions, getDateRange } = await import('./parser.js');
  const { range } = getDateRange(period);
  const projects = await parseAllSessions(range, 'all');

  const rows = projects.map(p => ({
    project: p.project,
    provider: p.provider,
    costUSD: p.totalCostUSD,
    apiCalls: p.totalApiCalls,
    inputTokens: p.totalInputTokens,
    outputTokens: p.totalOutputTokens,
  }));

  if (format === 'csv') {
    const head = Object.keys(rows[0] || {}).join(',');
    const body = rows.map(r => Object.values(r).join(',')).join('\n');
    const outPath = join(process.cwd(), `ag-code-token-${period}.csv`);
    await writeFile(outPath, head + '\n' + body);
    console.log(`\n${c.green}✓ Exported to ${outPath}${c.reset}\n`);
  } else {
    const outPath = join(process.cwd(), `ag-code-token-${period}.json`);
    await writeFile(outPath, JSON.stringify({ period, rows }, null, 2));
    console.log(`\n${c.green}✓ Exported to ${outPath}${c.reset}\n`);
  }
}

async function cmdSubmit() {
  console.log(`\n${c.bold}${c.cyan}🏅 Generating Tokscale Profile...${c.reset}\n`);
  await loadPricing();
  const summary = await getAggregateSummary('all', 'all');
  const active = await getActiveProviders();

  const totalTokens = summary.totalInputTokens + summary.totalOutputTokens + summary.totalCacheReadTokens;
  const { rank } = getTokscaleRank(totalTokens);

  const payload = {
    username: process.env.USER || process.env.USERNAME || 'anonymous',
    tokscale_rank: rank,
    total_tokens: totalTokens,
    total_cost_usd: summary.totalCostUSD,
    top_models: summary.models.slice(0, 5).map(m => m.name),
    providers: active.map(p => p.displayName),
    generated_at: new Date().toISOString(),
  };

  const outPath = join(process.cwd(), 'ag-profile.json');
  await writeFile(outPath, JSON.stringify(payload, null, 2));
  console.log(`${c.green}✓ Profile saved: ${outPath}${c.reset}\n`);
}

async function cmdTray(args) {
  const { startTray, stopTray, trayStatus } = await import('./tray/launcher.js');
  if (args.includes('--stop')) return stopTray();
  if (args.includes('--status')) return trayStatus();
  return startTray({ detach: args.includes('--detach') });
}

function cmdHelp() {
  console.log(`
${c.bold}${c.cyan}AG-Code Token v1.3.0${c.reset} — Universal AI Token Monitor

${c.bold}USAGE${c.reset}
  ag-token                      Show usage summary
  ag-token summary              Same as default
  ag-token budget               Show budget status
  ag-token budget --set-daily N Set daily budget (USD)
  ag-token currency             Show/list currencies
  ag-token currency EUR         Switch to Euro
  ag-token export               Export data as JSON
  ag-token export --csv         Export data as CSV
  ag-token tray                 Start server + open browser
  ag-token tray --detach        Start server in background
  ag-token tray --stop          Stop background server
  ag-token tray --status        Check server status
  ag-token submit               Generate leaderboard profile
  ag-token help                 Show this help

${c.bold}PROGRAMMATIC USAGE${c.reset}
  import { getSummary } from 'ag-code-token';
  const data = await getSummary('today');

${c.bold}DOCKER${c.reset}
  docker compose up -d

${c.gray}Docs: https://github.com/vuckuola619/wasted-token-tracker${c.reset}
`);
}

// ─── Main Router ───────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'summary';

  try {
    switch (cmd) {
      case 'summary': case 'show': return await cmdSummary();
      case 'budget': return await cmdBudget(args.slice(1));
      case 'currency': return await cmdCurrency(args.slice(1));
      case 'export': return await cmdExport(args.slice(1));
      case 'submit': return await cmdSubmit();
      case 'tray': return await cmdTray(args.slice(1));
      case 'help': case '--help': case '-h': return cmdHelp();
      default:
        console.log(`${c.red}Unknown command: ${cmd}${c.reset}`);
        cmdHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n${c.red}${c.bold}Error:${c.reset} ${err.message}`);
    process.exit(1);
  }
}

main();
