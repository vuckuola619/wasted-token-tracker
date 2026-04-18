'use strict';

// ─── XSS Protection ─────────────────────────────────────────────────────────────
/** HTML-escape user-controlled strings to prevent stored XSS via innerHTML. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Validate link targets — only allow https: protocol to prevent javascript: URIs. */
function safeHref(url) {
  if (!url || typeof url !== 'string') return '';
  try { return new URL(url).protocol === 'https:' ? url : ''; }
  catch { return ''; }
}

// ─── Auth ────────────────────────────────────────────────────────────────────────
const AUTH_TOKEN = document.querySelector('meta[name="ag-auth-token"]')?.content || '';
const AUTH_HEADERS = AUTH_TOKEN ? { 'Authorization': 'Bearer ' + AUTH_TOKEN } : {};

// ─── State ──────────────────────────────────────────────────────────────────────
let currentPeriod = 'today';
let currentProvider = 'all';
let currentCurrency = 'USD';
let summaryData = null;
let providersData = null;
let tipsData = null;
let wrappedData = null;
let budgetData = null;
let trendsData = null;
let currencyData = null;
let trendGranularity = 'daily';
let renderId = 0;
let chartTimer = null;

// Single global resize handler — prevents listener leak on re-renders
window.addEventListener('resize', () => {
  clearTimeout(window._chartResizeTimer);
  window._chartResizeTimer = setTimeout(() => {
    if (trendChart) try { trendChart.resize(); } catch {}
    if (heatmapChart) try { heatmapChart.resize(); } catch {}
    if (skylineChart) try { skylineChart.resize(); } catch {}
  }, 100);
});

const FILL = ['fill-a','fill-b','fill-c','fill-d','fill-e','fill-f','fill-g','fill-h'];
const TK_COLORS = ['hsl(217 91% 60%)','hsl(258 90% 66%)','hsl(189 94% 43%)','hsl(38 92% 50%)','hsl(330 81% 60%)'];

// ─── Icons (Lucide inline SVGs — 16×16) ─────────────────────────────────────────
const I = {
  dollar:   '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  coins:    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/></svg>',
  zap:      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>',
  monitor:  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  brain:    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/></svg>',
  plug:     '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z"/></svg>',
  chart:    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 16l4-8 4 4 4-10"/></svg>',
  wrench:   '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  folder:   '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  lightbulb:'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>',
  warn:     '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  extLink:  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  search:   '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  alertBig: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  trendDown:'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></svg>',
  trendUp:  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>',
  shield:   '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>',
};

// ─── Formatting ─────────────────────────────────────────────────────────────────
function fmtCost(v) {
  if (!v) return '$0.00';
  if (v < 0.01) return '$' + v.toFixed(4);
  if (v < 1) return '$' + v.toFixed(3);
  return '$' + v.toFixed(2);
}
function fmtTok(n) { if (!n) return '0'; if (n < 1e3) return n.toString(); if (n < 1e6) return (n / 1e3).toFixed(1) + 'K'; if (n < 1e9) return (n / 1e6).toFixed(2) + 'M'; return (n / 1e9).toFixed(2) + 'B'; }
function fmtNum(n) { return (n || 0).toLocaleString(); }

// ─── API ────────────────────────────────────────────────────────────────────────
async function fetchJSON(url) { const r = await fetch(url, { headers: AUTH_HEADERS }); return r.json(); }

async function loadProviders() {
  providersData = await fetchJSON('/api/providers');
  const s = document.getElementById('providerFilter');
  s.innerHTML = '<option value="all">All Providers</option>';
  for (const p of providersData.all) {
    const a = providersData.active.find(x => x.name === p.name);
    const o = document.createElement('option');
    o.value = p.name; o.textContent = a ? `${p.displayName} (${a.sessionCount})` : p.displayName;
    if (!a) o.disabled = true; s.appendChild(o);
  }
}

async function loadCurrencies() {
  try {
    currencyData = await fetchJSON('/api/currency');
    currentCurrency = currencyData.current || 'USD';
    const sel = document.getElementById('currencySelect');
    sel.innerHTML = '';
    for (const c of currencyData.currencies) {
      const o = document.createElement('option');
      o.value = c.code;
      o.textContent = c.code;
      o.selected = c.selected;
      sel.appendChild(o);
    }
  } catch { /* use defaults */ }
}

async function loadSummary() {
  const [summary] = await Promise.all([
    fetchJSON(`/api/summary?period=${currentPeriod}&provider=${currentProvider}`),
    loadTrends(),
    loadBudget(),
  ]);
  summaryData = summary;
  render();
}

async function loadBudget() {
  try { budgetData = await fetchJSON('/api/budget'); } catch { budgetData = null; }
}

async function loadTrends() {
  try {
    trendsData = await fetchJSON(`/api/trends?period=${currentPeriod}&provider=${currentProvider}&granularity=${trendGranularity}`);
  } catch { trendsData = null; }
}

// ─── Budget Alert Banners ───────────────────────────────────────────────────────
function renderBudgetAlerts() {
  if (!budgetData?.alerts?.length) return '';
  return budgetData.alerts
    .filter(a => a.percent >= 80)
    .slice(0, 3)
    .map(a => {
      const emoji = a.level === 'critical' || a.level === 'emergency' ? I.warn : I.shield;
      return `<div class="budget-banner level-${esc(a.level)}">
        ${emoji}
        <div class="budget-banner-text">
          ${esc(a.label)}
          <div class="budget-banner-sub">${esc(a.period)}: ${fmtCost(a.spent)} / ${fmtCost(a.budget)} (${a.percent}%)</div>
        </div>
      </div>`;
    })
    .join('');
}

// ─── Budget Card ────────────────────────────────────────────────────────────────
function renderBudgetCard() {
  if (!budgetData?.spending) return '';

  const periods = ['daily', 'weekly', 'monthly'];
  const rows = periods.map(period => {
    const s = budgetData.spending[period];
    if (!s || !s.budget) {
      return `<div class="no-budget">${esc(period)} — no budget set</div>`;
    }
    const pct = s.budget > 0 ? Math.round((s.spent / s.budget) * 100) : 0;
    const level = pct >= 100 ? 'critical' : pct >= 80 ? 'warning' : 'safe';
    return `<div class="budget-row">
      <div class="budget-period">${esc(period)}</div>
      <div class="budget-track"><div class="budget-fill ${level}" style="width:${Math.min(pct, 100)}%"></div></div>
      <div class="budget-vals">${fmtCost(s.spent)} / ${fmtCost(s.budget)} <span class="budget-pct ${level}">${pct}%</span></div>
    </div>`;
  }).join('');

  const hasBudget = periods.some(p => budgetData.spending[p]?.budget);
  return `<div class="card">
    <div class="card-hd"><h3>${I.shield} Budget Status</h3></div>
    ${hasBudget ? rows : '<div class="no-budget">No budgets configured. Set via CLI: <code style="background:hsl(var(--secondary));padding:2px 6px;border-radius:4px;font-size:11px">ag-token budget --set-daily 10</code></div>'}
  </div>`;
}

// ─── Render ─────────────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  if (!summaryData) return;
  const d = summaryData;

  if (d.totalApiCalls === 0 && d.projectCount === 0) {
    app.innerHTML = `<div class="empty-state">${I.search}<div class="empty-title">No usage data for this period</div><div class="empty-desc">No AI coding sessions found for "${esc(d.period)}". Try selecting a longer time range.</div></div>`;
    return;
  }

  const totalTok = d.totalInputTokens + d.totalOutputTokens + d.totalCacheReadTokens + d.totalCacheWriteTokens + d.totalReasoningTokens;

  app.innerHTML = `
    <!-- Budget Alerts -->
    ${renderBudgetAlerts()}

    <!-- Metrics -->
    <div class="grid-4">
      <div class="card">
        <div class="metric-label">${I.dollar} Total Cost</div>
        <div class="metric-value">${fmtCost(d.totalCostUSD)}</div>
        <div class="metric-sub">${esc(d.period)}${d.totalCostLocal ? ' · ' + esc(d.totalCostLocal.formatted) : ''}</div>
      </div>
      <div class="card">
        <div class="metric-label">${I.coins} Total Tokens</div>
        <div class="metric-value">${fmtTok(totalTok)}</div>
        <div class="metric-sub">${fmtTok(d.totalInputTokens)} in · ${fmtTok(d.totalOutputTokens)} out</div>
      </div>
      <div class="card">
        <div class="metric-label" style="color: hsl(var(--magenta, 290 80% 60%))">${I.zap} Tokscale Rank</div>
        <div class="metric-value" style="font-size: 18px; display:flex; align-items:center; height: 28px; color: hsl(var(--magenta, 290 80% 60%))">${esc(wrappedData?.rank || 'Unknown')}</div>
        <div class="metric-sub">Lifetime Leaderboard Standing</div>
      </div>
      <div class="card">
        <div class="metric-label">${I.zap} API Calls</div>
        <div class="metric-value">${fmtNum(d.totalApiCalls)}</div>
        <div class="metric-sub">across ${d.projectCount} project${d.projectCount !== 1 ? 's' : ''}</div>
      </div>
      <div class="card">
        <div class="metric-label">${I.monitor} Active IDEs</div>
        <div class="metric-value">${d.providers?.length || 0}</div>
        <div class="metric-sub">${d.providers?.map(p => esc(p.displayName)).join(', ') || 'None'}</div>
      </div>
    </div>

    <!-- Cost Trend Chart + Budget Status -->
    <div class="grid-2">
      <div class="card">
        <div class="card-hd">
          <h3>${I.trendUp} Cost Trend</h3>
          <div class="trend-toggle">
            <button class="trend-toggle-btn ${trendGranularity === 'daily' ? 'active' : ''}" data-gran="daily">Daily</button>
            <button class="trend-toggle-btn ${trendGranularity === 'weekly' ? 'active' : ''}" data-gran="weekly">Weekly</button>
          </div>
        </div>
        <div id="trendChart" class="trend-chart"></div>
      </div>
      ${renderBudgetCard()}
    </div>

    <!-- Model + Provider -->
    <div class="grid-2">
      <div class="card">
        <div class="card-hd"><h3>${I.brain} Model Breakdown</h3></div>
        ${d.models?.length > 0 ? d.models.map((m, i) => {
          const pct = d.totalCostUSD > 0 ? (m.costUSD / d.totalCostUSD * 100) : 0;
          return `<div class="bar-row"><div class="bar-name">${esc(m.name)}</div><div class="bar-track"><div class="bar-fill ${FILL[i % FILL.length]}" style="width:${Math.max(pct, 2)}%"></div></div><div class="bar-val">${fmtCost(m.costUSD)}</div></div>`;
        }).join('') : '<div class="empty-desc muted">No model data</div>'}
      </div>
      <div class="card">
        <div class="card-hd"><h3>${I.plug} Provider Breakdown</h3></div>
        ${d.providers?.length > 0 ? d.providers.map((p, i) => {
          const pct = d.totalCostUSD > 0 ? (p.costUSD / d.totalCostUSD * 100) : 0;
          return `<div class="bar-row"><div class="bar-name">${esc(p.displayName)}</div><div class="bar-track"><div class="bar-fill ${FILL[i % FILL.length]}" style="width:${Math.max(pct, 2)}%"></div></div><div class="bar-val">${fmtCost(p.costUSD)}</div></div>`;
        }).join('') : '<div class="empty-desc muted">No provider data</div>'}
      </div>
    </div>

    <!-- 2D / 3D Contribution Graphs -->
    <div class="grid-2">
      <div class="card">
        <div class="card-hd"><h3>${I.chart} Token Heatmap (2D)</h3></div>
        <div id="heatmap2d" style="height:180px;width:100%"></div>
      </div>
      <div class="card">
        <div class="card-hd"><h3>${I.chart} Token Skyline (3D)</h3></div>
        <div id="graph3d" style="height:250px;width:100%"></div>
      </div>
    </div>

    <!-- Tokens + Tools -->
    <div class="grid-2">
      <div class="card">
        <div class="card-hd"><h3>${I.chart} Token Breakdown</h3></div>
        ${[['Input Tokens', d.totalInputTokens, 0], ['Output Tokens', d.totalOutputTokens, 1], ['Cache Read', d.totalCacheReadTokens, 2], ['Cache Write', d.totalCacheWriteTokens, 3], ['Reasoning', d.totalReasoningTokens, 4]].map(([name, val, ci]) => `
        <div class="tk-row"><div class="tk-left"><div class="tk-dot" style="background:${TK_COLORS[ci]}"></div>${esc(name)}</div><div class="tk-val">${fmtTok(val)}</div></div>`).join('')}
      </div>
      <div class="card">
        <div class="card-hd"><h3>${I.wrench} Tool Usage</h3></div>
        ${d.tools?.length > 0 ? d.tools.slice(0, 10).map((t, i) => {
          const pct = d.tools[0].calls > 0 ? (t.calls / d.tools[0].calls * 100) : 0;
          return `<div class="bar-row"><div class="bar-name">${esc(t.name)}</div><div class="bar-track"><div class="bar-fill ${FILL[i % FILL.length]}" style="width:${Math.max(pct, 2)}%"></div></div><div class="bar-val">${fmtNum(t.calls)}</div></div>`;
        }).join('') : '<div class="empty-desc muted">No tool data</div>'}
      </div>
    </div>

    <!-- Projects -->
    <div class="card" style="margin-bottom:24px">
      <div class="card-hd"><h3>${I.folder} Projects</h3></div>
      ${d.projects?.length > 0 ? `
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Project</th><th>IDE</th><th>Cost</th><th>API Calls</th><th>Input</th><th>Output</th></tr></thead>
          <tbody>${d.projects.slice(0, 20).map(p => `
            <tr>
              <td style="font-weight:600">${esc(p.project)}</td>
              <td><span class="badge">${esc(p.providerDisplayName)}</span></td>
              <td class="mono">${fmtCost(p.costUSD)}</td>
              <td class="mono">${fmtNum(p.apiCalls)}</td>
              <td class="mono">${fmtTok(p.inputTokens)}</td>
              <td class="mono">${fmtTok(p.outputTokens)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<div class="empty-desc muted">No projects</div>'}
    </div>

    <!-- Token Saving Advisor -->
    ${tipsData?.tips?.length > 0 ? `
    <div class="card" style="margin-bottom:24px">
      <div class="card-hd"><h3>${I.lightbulb} Token Saving Advisor</h3></div>
      ${tipsData.tips.map(tip => {
        const href = safeHref(tip.link);
        return `
      <div class="tip sev-${esc(tip.severity)}">
        <div class="tip-icon">${tip.severity === 'high' ? I.warn : tip.severity === 'medium' ? I.lightbulb : I.chart}</div>
        <div class="tip-body">
          <div class="tip-title">${esc(tip.title)}</div>
          <div class="tip-desc">${esc(tip.description)}</div>
          <div class="tip-meta">
            ${tip.savings ? `<span class="tip-pill">${I.trendDown} ${esc(tip.savings)}</span>` : ''}
            ${href ? `<a class="tip-link" href="${esc(href)}" target="_blank" rel="noopener">${I.extLink} Learn more</a>` : ''}
          </div>
        </div>
      </div>`; }).join('')}
    </div>` : ''}

    <footer class="footer">
      AG-Code Token v1.3.0 ·
      <a href="https://github.com/vuckuola619/wasted-token-tracker" target="_blank" rel="noopener">GitHub</a> ·
      <a href="#" id="footerExport">Export CSV</a> ·
      Currency: ${esc(currentCurrency)}
    </footer>
  `;

  // Bind footer export link
  const footerLink = document.getElementById('footerExport');
  if (footerLink) {
    footerLink.addEventListener('click', (e) => { e.preventDefault(); doExport(); });
  }

  // Bind trend granularity toggles
  document.querySelectorAll('.trend-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      trendGranularity = btn.dataset.gran;
      loadTrends().then(() => renderTrendChart());
    });
  });

  if (chartTimer) clearTimeout(chartTimer);
  chartTimer = setTimeout(() => {
    try { renderCharts(d.timeseries); } catch (e) { /* chart render error */ }
    try { renderTrendChart(); } catch (e) { /* trend chart error */ }
  }, 250);
}

// ─── Cost Trend Chart ───────────────────────────────────────────────────────────
let trendChart = null;

async function renderTrendChart() {
  const dom = document.getElementById('trendChart');
  if (!dom || typeof echarts === 'undefined') return;

  // Self-load trends data if not available
  if (!trendsData?.timeseries?.length) {
    try {
      trendsData = await fetchJSON(`/api/trends?period=${currentPeriod}&provider=${currentProvider}&granularity=${trendGranularity}`);
    } catch { return; }
  }
  if (!trendsData?.timeseries?.length) return;

  // Guard: ensure DOM is still attached (not replaced by another render)
  if (!document.body.contains(dom)) return;

  if (trendChart) { try { trendChart.dispose(); } catch(e) { /* stale ref */ } }
  trendChart = echarts.init(dom);

  const ts = trendsData.timeseries;
  const dates = ts.map(t => t.date);
  const costs = ts.map(t => Math.round(t.cost * 100) / 100);
  const cumulative = ts.map(t => Math.round(t.cumulativeCost * 100) / 100);

  trendChart.setOption({
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'hsl(240 10% 8%)',
      borderColor: 'hsl(240 3.7% 20%)',
      textStyle: { color: '#e4e4e7', fontSize: 12 },
      formatter: params => {
        const date = params[0].axisValue;
        const lines = params.map(p => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>${p.seriesName}: $${p.value.toFixed(2)}`);
        return `<strong>${date}</strong><br>${lines.join('<br>')}`;
      },
    },
    legend: {
      data: ['Daily Cost', 'Cumulative'],
      textStyle: { color: '#a1a1aa', fontSize: 11 },
      top: 0, right: 0,
    },
    grid: { left: 50, right: 16, top: 30, bottom: 24 },
    xAxis: {
      type: 'category', data: dates,
      axisLabel: { color: '#71717a', fontSize: 10, rotate: dates.length > 14 ? 45 : 0 },
      axisLine: { lineStyle: { color: '#27272a' } },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: 'value', name: '',
        axisLabel: { color: '#71717a', fontSize: 10, formatter: v => '$' + v.toFixed(v < 1 ? 2 : 0) },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: '#1e1e24' } },
      },
      {
        type: 'value', name: '',
        axisLabel: { color: '#71717a', fontSize: 10, formatter: v => '$' + v.toFixed(0) },
        axisLine: { show: false },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: 'Daily Cost', type: 'bar', data: costs,
        itemStyle: { color: 'hsl(217, 91%, 60%)', borderRadius: [3, 3, 0, 0] },
        barMaxWidth: 24,
      },
      {
        name: 'Cumulative', type: 'line', data: cumulative, yAxisIndex: 1,
        smooth: true, symbol: 'none', lineStyle: { color: 'hsl(142, 76%, 46%)', width: 2 },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'hsla(142, 76%, 46%, 0.15)' }, { offset: 1, color: 'hsla(142, 76%, 46%, 0)' }] } },
      },
    ],
  });


}

// ─── Heatmap / 3D Charts ────────────────────────────────────────────────────────
let heatmapChart = null;
let skylineChart = null;

function renderCharts(ts) {
  if (!ts || ts.length === 0) return;
  const dom2d = document.getElementById('heatmap2d');
  const dom3d = document.getElementById('graph3d');
  if (!dom2d || !dom3d || typeof echarts === 'undefined') return;

  if (heatmapChart) heatmapChart.dispose();
  if (skylineChart) skylineChart.dispose();

  heatmapChart = echarts.init(dom2d);
  skylineChart = echarts.init(dom3d);

  let maxVal = 0;
  ts.forEach(item => { if (item[1] > maxVal) maxVal = item[1]; });

  const lastDate = ts[ts.length - 1][0];
  const year = lastDate.split('-')[0];

  heatmapChart.setOption({
    tooltip: { position: 'top', formatter: p => `${p.data[0]}: ${fmtTok(p.data[1])} tokens` },
    visualMap: { min: 0, max: maxVal, show: false, inRange: { color: ['#18181b', '#10b981'] } },
    calendar: {
      top: 20, right: 10, left: 30, bottom: 20,
      range: year,
      cellSize: ['auto', 16],
      itemStyle: { color: '#27272a', borderWidth: 3, borderColor: '#09090b', borderRadius: 2 },
      splitLine: { show: false }, yearLabel: { show: false },
      dayLabel: { color: '#a1a1aa', nameMap: 'EN' },
      monthLabel: { color: '#a1a1aa', nameMap: 'EN' }
    },
    series: { type: 'heatmap', coordinateSystem: 'calendar', data: ts }
  });

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weeks = [];
  for (let i = 0; i < 53; i++) weeks.push(`W${i}`);

  const data3d = [];
  ts.forEach(item => {
    const d = new Date(item[0]);
    const start = new Date(d.getFullYear(), 0, 1);
    const w = Math.floor((((d - start) / 86400000) + start.getDay() + 1) / 7);
    const wStr = weeks[w] || ('W' + w);
    const dStr = days[d.getDay()];
    data3d.push([wStr, dStr, item[1]]);
  });

  skylineChart.setOption({
    tooltip: {},
    visualMap: { min: 0, max: maxVal, show: false, inRange: { color: ['#27272a', '#a855f7'] } },
    xAxis3D: { type: 'category', data: weeks, name: '' },
    yAxis3D: { type: 'category', data: days, name: '' },
    zAxis3D: { type: 'value', name: '' },
    grid3D: {
      boxWidth: 200, boxDepth: 40, boxHeight: 40,
      viewControl: { alpha: 40, beta: 20, distance: 250 },
      axisLine: { lineStyle: { color: '#3f3f46' } },
      axisLabel: { textStyle: { color: '#a1a1aa', fontSize: 10 } },
      splitLine: { lineStyle: { color: '#27272a' } },
      axisPointer: { show: false },
      light: { main: { intensity: 1.2, shadow: false }, ambient: { intensity: 0.8, color: '#ffffff' } }
    },
    series: [{ type: 'bar3D', data: data3d, shading: 'color', label: { show: false } }]
  });


}

// ─── Export (fetch + blob for auth-safe download) ────────────────────────────────
async function doExport() {
  try {
    const r = await fetch(`/api/export?period=${currentPeriod}&provider=${currentProvider}&format=csv`, { headers: AUTH_HEADERS });
    if (!r.ok) throw new Error('Export failed');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ag-code-token-${currentPeriod}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Export failed:', err);
  }
}

// ─── Event Listeners ────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active'); btn.setAttribute('aria-selected', 'true');
    currentPeriod = btn.dataset.period;
    loadSummary();
  });
});
document.getElementById('providerFilter').addEventListener('change', e => {
  currentProvider = e.target.value;
  loadSummary();
});
document.getElementById('currencySelect').addEventListener('change', async e => {
  const currency = e.target.value;
  try {
    await fetch('/api/currency', {
      method: 'PUT',
      headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency }),
    });
    currentCurrency = currency;
    loadSummary();
  } catch { /* silent */ }
});
document.getElementById('exportBtn').addEventListener('click', () => doExport());

// ─── SSE ────────────────────────────────────────────────────────────────────────
let sse = null;
function setLive(on) {
  const el = document.getElementById('liveIndicator'), lb = document.getElementById('liveLabel');
  el.className = on ? 'live-badge on' : 'live-badge'; lb.textContent = on ? 'Live' : 'Offline';
}
function connectSSE() {
  if (sse) try { sse.close(); } catch {}
  try {
    const sseUrl = AUTH_TOKEN ? `/api/events?token=${encodeURIComponent(AUTH_TOKEN)}` : '/api/events';
    sse = new EventSource(sseUrl);
    sse.addEventListener('connected', () => setLive(true));
    sse.addEventListener('session-update', () => {
      loadSummary();
      loadBudget();
      loadTrends().then(() => renderTrendChart());
      fetchJSON('/api/tips').then(d => { tipsData = d; }).catch(() => {});
    });
    sse.addEventListener('budget-alert', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.alerts?.length) {
          loadBudget().then(() => render());
        }
      } catch { /* ignore */ }
    });
    sse.addEventListener('heartbeat', () => setLive(true));
    sse.addEventListener('shutdown', () => setLive(false));
    sse.onerror = () => { setLive(false); sse.close(); setTimeout(connectSSE, 5000); };
  } catch { setLive(false); setInterval(() => loadSummary(), 60000); }
}

// ─── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  try {
    await loadProviders();
    await loadCurrencies();
    fetchJSON('/api/tips').then(d => { tipsData = d; }).catch(() => {});
    fetchJSON('/api/wrapped').then(d => { wrappedData = d; render(); }).catch(() => {});
    await loadSummary();
    connectSSE();
  } catch {
    document.getElementById('app').innerHTML = `<div class="empty-state">${I.alertBig}<div class="empty-title">Connection Error</div><div class="empty-desc">Could not connect to the server. Make sure it is running on port 3777.</div></div>`;
    setLive(false);
  }
}
window.addEventListener('load', () => {
  init();
  setInterval(() => { if (!sse || sse.readyState === EventSource.CLOSED) loadSummary(); }, 300000);
});
