<p align="center">
  <img src="public/screenshot.png" alt="AG-Code Token Dashboard" width="800" />
</p>

<h1 align="center">🔥 AG-Code Token</h1>

<p align="center">
  <strong>Universal AI Token Monitor for Every Coding IDE</strong>
</p>

<p align="center">
  See where your AI coding tokens go.<br/>
  Track costs across <strong>Claude Code</strong>, <strong>Codex</strong>, <strong>Cursor</strong>, <strong>Windsurf</strong>, <strong>Cline</strong>, <strong>Copilot</strong>, <strong>Continue.dev</strong>, <strong>Aider</strong>, and <strong>Antigravity</strong> — from a single dashboard.
</p>

<p align="center">
  <a href="#quick-start"><img src="https://img.shields.io/badge/get_started-30s_setup-blue?style=for-the-badge" alt="Get Started" /></a>
  <a href="#supported-ides"><img src="https://img.shields.io/badge/IDEs-9_supported-green?style=for-the-badge" alt="9 IDEs" /></a>
  <a href="#supported-models"><img src="https://img.shields.io/badge/models-50+-purple?style=for-the-badge" alt="50+ Models" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-orange?style=for-the-badge" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#features">Features</a> •
  <a href="#supported-ides">Supported IDEs</a> •
  <a href="#supported-models">Supported Models</a> •
  <a href="#api-reference">API</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#contributing">Contributing</a>
</p>

---

## Why?

You're using AI coding tools daily — Claude Code, Codex, Cursor, maybe Copilot. Each burns through tokens. But there's **no single place** to see your total spend. Until now.

**AG-Code Token** reads the session files your AI tools already write to disk, parses them into a unified format, and shows you a beautiful real-time dashboard. No API keys required. No data leaves your machine.

---

## Quick Start

```bash
# Clone
git clone https://github.com/vuckuola619/ag-code-token.git
cd ag-code-token

# Run (zero dependencies — no npm install needed!)
node server.js

# Open
# → http://localhost:3777
```

That's it. The server auto-discovers any installed AI coding tools and starts parsing their session data.

> **Requirements:** Node.js 18+ (uses ES modules and `fetch`). No `npm install` needed — the entire project uses only Node.js built-in modules.

---

## Features

### 🎯 Cross-Platform Observability
Monitor token usage across **9 AI coding IDEs** from a single dashboard. See which tool is burning the most tokens and how much it costs.

### 💰 Real-Time Cost Tracking
Automatic cost calculation using live pricing from [LiteLLM](https://github.com/BerriAI/litellm) (cached 24h) with comprehensive hardcoded fallbacks for 50+ models.

### 🔌 Plugin Architecture
Every AI tool is a provider plugin. Each file in `providers/` implements a standard interface for session discovery, parsing, and normalization. Adding a new tool = adding one file.

### 📊 Rich Dashboard
- **Hero Stats:** Total cost, tokens, API calls, active IDEs
- **Model Breakdown:** See which LLMs you use most — Claude Opus, GPT-5, Gemini Pro
- **Provider Breakdown:** Compare Cursor vs Claude Code vs Codex spend
- **Token Breakdown:** Input, output, cache read/write, reasoning tokens
- **Tool Usage:** Which agent tools (Read, Edit, Bash, Search) get called most
- **Project Table:** Per-project cost and usage with provider badges
- **Token Saving Advisor:** Smart recommendations to reduce token consumption

### 💡 Token Saving Advisor
Built-in intelligence that analyzes your usage and suggests actionable optimizations:
- **[RTK](https://github.com/rtk-ai/rtk) integration** — Recommends the CLI proxy that cuts tokens 60-90%
- **Prompt caching detection** — Flags sessions with 0% cache hits
- **[LLM-Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — Karpathy’s persistent context strategy
- **Model tiering** — Detects expensive model usage, suggests cheaper alternatives
- **Cost-per-call alerts** — Warns about oversized context windows
- **Config tuning** — `.cursorrules`, `.clinerules`, `.gitignore` optimizations

### 📤 CSV/JSON Export
Export your usage data via the dashboard button or API:
```bash
curl http://localhost:3777/api/export?period=week&format=csv
curl http://localhost:3777/api/export?period=month&format=json
```

### 🏠 Fully Local & Private
All data stays on your machine. AG-Code Token reads session files from disk — it never phones home, never touches your API keys, never sends telemetry.

### ⚡ Zero Dependencies
No `npm install`. No `node_modules`. The entire server runs on Node.js built-in modules (`http`, `fs`, `path`, `os`). The dashboard is a single HTML file with inline CSS and JS.

### 🔄 Auto-Refresh & Caching
Dashboard auto-refreshes every 5 minutes. Server-side parsing results are cached for 60 seconds to keep the UI snappy even with hundreds of session files.


## Supported IDEs

| IDE | Status | Data Source | Session Format |
|-----|--------|-------------|----------------|
| **[Antigravity](https://deepmind.google/)** (Google DeepMind) | ✅ Full | `~/.gemini/antigravity/` | Protobuf `.pb` + brain steps |
| **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** (Anthropic CLI) | ✅ Full | `~/.claude/projects/` | JSONL transcripts |
| **[Codex](https://openai.com/codex)** (OpenAI CLI) | ✅ Full | `~/.codex/sessions/` | JSONL rollouts |
| **[Cursor](https://cursor.sh/)** | ✅ Full | `~/.config/Cursor/` | JSON/JSONL logs |
| **[Windsurf](https://codeium.com/windsurf)** (Codeium) | ✅ Full | `~/.config/Windsurf/` | JSON/JSONL logs |
| **[Cline](https://github.com/cline/cline)** (VS Code) | ✅ Full | VS Code `globalStorage` | JSON conversation history |
| **[GitHub Copilot](https://github.com/features/copilot)** | ✅ Full | VS Code `globalStorage` | JSON/JSONL |
| **[Continue.dev](https://continue.dev/)** | ✅ Full | `~/.continue/sessions/` | JSON session files |
| **[Aider](https://aider.chat/)** | ✅ Full | `~/.aider/` | JSONL analytics |

All providers support **Windows**, **macOS**, and **Linux** path conventions.

---

## Supported Models

AG-Code Token includes pricing for **50+ models** across 9 providers, auto-updated from LiteLLM:

| Provider | Models |
|----------|--------|
| **Anthropic** | Claude Opus 4.6, Opus 4.5, Opus 4.1, Sonnet 4.6, Sonnet 4.5, Sonnet 4, Sonnet 3.7, Sonnet 3.5, Haiku 4.5, Haiku 3.5 |
| **OpenAI** | GPT-5.4, GPT-5, GPT-4.1, GPT-4o, o4-mini, o3, o1 |
| **Google** | Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 2.0 Flash, Gemini 1.5 Pro |
| **DeepSeek** | V3, R1, Coder |
| **Mistral** | Large, Medium, Small, Codestral |
| **Meta** | Llama 4 Maverick, Llama 4 Scout, Llama 3.3 70B, Llama 3.1 405B |
| **Qwen** | 2.5 Coder 32B, 2.5 72B, Max |
| **Cohere** | Command R+, Command R |
| **xAI** | Grok 3, Grok 3 Mini, Grok 2 |
| **Local** | Ollama, LM Studio, vLLM (free) |

---

## API Reference

All endpoints return JSON with `Access-Control-Allow-Origin: *`.

### `GET /api/health`
```json
{ "status": "ok", "version": "1.0.0", "timestamp": "2026-04-14T12:00:00.000Z" }
```

### `GET /api/providers`
Returns all registered and currently active providers.
```json
{
  "active": [{ "name": "claude", "displayName": "Claude Code", "sessionCount": 42 }],
  "all": [{ "name": "claude", "displayName": "Claude Code" }, ...]
}
```

### `GET /api/summary?period=week&provider=all`
Aggregate summary for a period. Periods: `today`, `week`, `30days`, `month`, `all`.
```json
{
  "period": "Last 7 Days",
  "totalCostUSD": 206.19,
  "totalInputTokens": 13900000,
  "totalOutputTokens": 5960000,
  "totalApiCalls": 8,
  "projectCount": 8,
  "models": [{ "name": "Opus 4.6", "calls": 5, "costUSD": 171.98 }],
  "tools": [{ "name": "WebFetch", "calls": 3 }],
  "providers": [{ "name": "antigravity", "displayName": "Antigravity", "costUSD": 206.19 }],
  "projects": [{ "project": "my-app", "provider": "claude", "costUSD": 42.00 }]
}
```

### `GET /api/projects?period=week&provider=all`
Per-project breakdown with model and tool details.

### `GET /api/multi-period`
Summary across all periods in a single call (`today`, `week`, `30days`, `month`).

### `GET /api/export?period=week&format=csv`
Export data as CSV or JSON. Supports all periods and provider filters.

### `GET /api/tips`
Returns smart token-saving recommendations based on your current usage patterns.

---

## Architecture

```
ag-code-token/
├── server.js              # Zero-dependency HTTP server (Node.js built-ins only)
├── models.js              # Universal LLM pricing engine (50+ models, LiteLLM + fallbacks)
├── parser.js              # Orchestration pipeline: discover → parse → deduplicate → aggregate
├── providers/
│   ├── index.js           # Provider registry and discovery
│   ├── types.js           # TypeScript-style JSDoc interfaces
│   ├── antigravity.js     # Google DeepMind Antigravity IDE
│   ├── claude.js          # Anthropic Claude Code CLI + Desktop
│   ├── codex.js           # OpenAI Codex CLI
│   ├── cursor.js          # Cursor IDE
│   ├── windsurf.js        # Windsurf (Codeium)
│   ├── cline.js           # Cline VS Code extension
│   ├── copilot.js         # GitHub Copilot
│   ├── continuedev.js     # Continue.dev
│   └── aider.js           # Aider CLI
├── public/
│   └── index.html         # Single-file dashboard (HTML + CSS + JS)
└── package.json
```

### Data Flow

```
Session Files on Disk
        │
        ▼
┌─────────────────┐
│  Provider Plugins │ ── Each provider knows where to find its tool's data
│  (9 adapters)     │    and how to parse it (JSONL, JSON, Protobuf)
└────────┬──────────┘
         │
         ▼
┌─────────────────┐
│  Parser Pipeline  │ ── Deduplication, date filtering, token normalization
│  (parser.js)      │    (e.g., OpenAI cached-in-input → Anthropic semantics)
└────────┬──────────┘
         │
         ▼
┌─────────────────┐
│  Pricing Engine   │ ── LiteLLM (live) + 56 hardcoded fallbacks
│  (models.js)      │    Cache write, cache read, reasoning, web search costs
└────────┬──────────┘
         │
         ▼
┌─────────────────┐
│  HTTP API + UI    │ ── 5 JSON endpoints + responsive dashboard
│  (server.js)      │
└───────────────────┘
```

---

## Adding a New Provider

1. Create `providers/yourprovider.js`
2. Implement the `Provider` interface:

```javascript
export const yourprovider = {
  name: 'yourprovider',
  displayName: 'Your Provider',
  
  modelDisplayName(model) { return model; },
  toolDisplayName(rawTool) { return rawTool; },
  
  async discoverSessions() {
    // Return SessionSource[] — paths to session files
    return [{ path: '/path/to/sessions', project: 'my-project', provider: 'yourprovider' }];
  },
  
  createSessionParser(source, seenKeys) {
    return {
      async *parse() {
        // Yield ParsedProviderCall objects
        yield {
          provider: 'yourprovider',
          model: 'gpt-4o',
          inputTokens: 1000,
          outputTokens: 500,
          costUSD: 0.0075,
          tools: ['edit', 'read'],
          timestamp: new Date().toISOString(),
          // ... see providers/types.js for full shape
        };
      },
    };
  },
};
```

3. Import and register in `providers/index.js`

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3777` | HTTP server port |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code configuration directory |
| `CODEX_HOME` | `~/.codex` | Codex CLI home directory |
| `ANTIGRAVITY_DIR` | `~/.gemini/antigravity` | Antigravity data directory |

```bash
PORT=8080 node server.js
```

---

## FAQ

<details>
<summary><strong>Do I need to install any npm packages?</strong></summary>

No. AG-Code Token uses only Node.js built-in modules. Just `node server.js`.
</details>

<details>
<summary><strong>Does it send my data anywhere?</strong></summary>

No. Everything runs locally. The only external request is fetching model pricing from LiteLLM's GitHub (a public JSON file), cached for 24 hours. If it fails, hardcoded fallback pricing is used.
</details>

<details>
<summary><strong>How does it find my AI tool sessions?</strong></summary>

Each provider plugin knows the default filesystem paths where its tool stores data (e.g., `~/.claude/projects/` for Claude Code). It scans those directories for session files and parses them.
</details>

<details>
<summary><strong>Can I run it permanently?</strong></summary>

Yes. Use a process manager like `pm2`:
```bash
npx pm2 start server.js --name ag-code-token
```
</details>

<details>
<summary><strong>How accurate is the cost calculation?</strong></summary>

Very. For tools that log per-token usage (Claude Code, Codex, Cline), costs are calculated using exact token counts and current model pricing. For tools with less granular data, estimation heuristics are used with clear documentation.
</details>

---

## Roadmap

- [x] 📤 Export to CSV/JSON
- [x] 💡 Token saving recommendations (RTK, Karpathy LLM-Wiki)
- [x] 🎨 Radix Colors design system (dark mode, WCAG AA)
- [ ] 📈 Historical cost charts (daily/weekly trends)
- [ ] 🔔 Budget alerts and notifications
- [ ] 📦 npm package for programmatic usage
- [ ] 🐳 Docker image
- [ ] 🖥️ System tray app (Electron/Tauri)
- [ ] 📱 Mobile-friendly responsive redesign
- [ ] 🔗 Webhook integration (Slack, Discord)
- [ ] 💱 Multi-currency support

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

The easiest way to contribute is **adding a new provider** — if you use an AI coding tool that isn't supported yet, open a PR!

---

## License

[MIT](LICENSE) — use it however you like.

---

<p align="center">
  <strong>Built with 🔥 by <a href="https://github.com/vuckuola619">vuckuola619</a></strong><br/>
  <sub>Stop guessing. Start tracking.</sub>
</p>
