# Changelog

All notable changes to AG-Code Token are documented in this file.

## [1.3.0] - 2026-04-18

### Added
- **Historical Cost Trends** -- Interactive ECharts bar+line chart with daily/weekly granularity toggle
- **Budget Alerts** -- Configurable daily/weekly/monthly spending thresholds with real-time breach detection
- **Webhook Integrations** -- Slack, Discord, Telegram, and Generic HTTP webhook support with retry logic
- **Multi-Currency Support** -- 12 currencies via ECB exchange rate API with 24h cache and offline fallback
- **3D Token Skyline** -- ECharts-GL 3D bar visualization of weekly token consumption
- **Token-Based Auth** -- Auto-generated Bearer token with persistent storage at `~/.ag-code-token/auth-secret`
- **HMAC-Chained Audit Logs** -- Tamper-evident SHA-256 hash chain for all security events
- **System Tray Mode** -- Background server runner with PID management (`cli.js tray`)
- **Docker Support** -- Multi-stage Alpine Dockerfile and docker-compose.yml
- **npm Programmatic API** -- `index.js` exports for CI/CD integration
- **Daily Summary Scheduler** -- Automatic webhook notification at midnight with spending report
- **Tokscale Rank** -- Gamified leaderboard ranking based on lifetime token consumption
- **GDPR Right to Erasure** -- `DELETE /api/cache` endpoint for in-memory data purge
- **Graceful Shutdown** -- SIGTERM/SIGINT handler with orderly resource cleanup

### Fixed
- **Resize event listener memory leak** -- Chart resize handlers were stacking on every re-render via SSE updates
- **VALID_PERIODS temporal dead zone** -- Moved const declaration to module top to prevent potential initialization errors
- **Chart DOM detachment race condition** -- Added `document.body.contains()` guard to prevent stale ECharts instances
- **Chart rendering race condition** -- Implemented 250ms debounced rendering with `renderId` counter

### Changed
- Frontend split from single `index.html` to `index.html` (shell) + `app.js` (logic)
- Security module now handles authentication, rate limiting, and audit logging as a unified system
- CSP updated to allow `cdn.jsdelivr.net` for ECharts and ECharts-GL CDN scripts
- Server startup sequence now shows 7-step initialization progress

## [1.2.0] - 2026-04-14

### Added
- Real-time file watching with SSE push notifications
- Rate limiting (120 req/min sliding window)
- Content Security Policy headers
- Input validation and path traversal protection
- Structured JSON audit logging
- Token Saving Advisor engine (RTK, LLM-Wiki, model tiering, caching)
- CSV and JSON data export
- GitHub-style token heatmap (2D)
- Extended provider support (OpenCode, Gemini CLI, AmpCode, Roo Code, and 9 more)
- SQLite heuristic scanner for database-backed providers

### Changed
- Migrated from Express to zero-dependency Node.js HTTP server
- Provider architecture refactored to async generator pattern

## [1.1.0] - 2026-04-10

### Added
- Multi-period summary API (`/api/multi-period`)
- Provider filtering across all endpoints
- CLI interface with terminal-based usage summary

## [1.0.0] - 2026-04-07

### Added
- Initial release
- Core providers: Antigravity, Claude Code, Codex, Cursor, Windsurf, Cline, Copilot, Continue.dev, Aider
- LLM pricing engine with LiteLLM integration and hardcoded fallbacks
- Single-file dashboard with dark theme
- Session deduplication pipeline
