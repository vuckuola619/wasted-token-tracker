# Security Policy

## Supported Versions

| Version | Supported          |
|---------|-------------------|
| 1.3.x   | Current release    |
| 1.2.x   | Security patches   |
| < 1.2   | Not supported      |

## Architecture Security Model

AG-Code Token is designed with **security-by-default** principles:

### Data Privacy (GDPR Compliant)
- **No PII Collection** -- Only reads token counts, model names, and file sizes
- **No External Transmission** -- All data stays on your machine
- **No API Keys Required** -- Reads session files directly from disk
- **No Telemetry** -- Zero tracking, zero analytics, zero call-home
- **Data Minimization** -- Project names are sanitized to basenames only
- **Right to Erasure** -- `DELETE /api/cache` purges all in-memory data

### Authentication
- **Bearer Token Auth** -- Auto-generated 32-byte hex token, persisted at `~/.ag-code-token/auth-secret`
- **Localhost Bypass** -- Auth not enforced when bound to localhost (configurable)
- **Environment Override** -- Set `AG_TOKEN_AUTH=required` for mandatory auth on all bindings
- **CSP-Safe Injection** -- Auth token injected via `<meta>` tag, no inline scripts

### Network Security
- **Single Egress Point** -- Only fetches LiteLLM pricing from `raw.githubusercontent.com` and ECB exchange rates from `api.frankfurter.dev`
- **Network Egress Allowlist** -- All outgoing URLs are validated against an allowlist
- **Localhost-Only Binding** -- Server binds to `127.0.0.1` by default
- **Rate Limiting** -- 120 requests/minute per IP (sliding window, persisted across restarts)
- **SSE Connection Limit** -- Maximum 50 concurrent streaming connections
- **Webhook URL Validation** -- Outbound webhook URLs limited to 512 characters, HTTPS required for production

### Input Validation
- **Parameter Allowlisting** -- All query params validated against known values
- **Path Traversal Protection** -- Triple-layered: full URL decode, regex check, `resolve()` containment
- **URL Length Limit** -- Maximum 2048 characters
- **Body Size Limit** -- 64KB max for PUT/POST request bodies
- **CSV Injection Prevention** -- Export data sanitized against formula injection (`=`, `+`, `-`, `@`)
- **Token Count Validation** -- SOC 2 CC8.1 data integrity gate clamps absurd values

### HTTP Security Headers
All responses include:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Content-Security-Policy` (strict policy: script-src 'self' cdn.jsdelivr.net)
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` (all features disabled)
- `Cache-Control: no-store` (API responses)

### Monitoring and Audit
- **HMAC-Chained Audit Logging** -- Every log entry is hash-chained with SHA-256 for tamper evidence
- **Log Rotation** -- Daily rotation with 7-day retention
- **No PII in Logs** -- Paths sanitized (home dir replaced with `~`), no IP addresses stored
- **Health Check** -- `/api/health` reports system status and watcher state
- **Graceful Shutdown** -- SIGTERM/SIGINT triggers orderly resource cleanup

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **DO NOT** open a public GitHub issue
2. Email: [Create a private security advisory](https://github.com/vuckuola619/wasted-token-tracker/security/advisories/new)
3. Include: description, reproduction steps, and impact assessment
4. Expected response: within 48 hours

## Compliance Mapping

| Standard | Control | Status |
|----------|---------|--------|
| GDPR Art 5 | Data minimization | Implemented |
| GDPR Art 25 | Privacy by design | Implemented |
| GDPR Art 32 | Security of processing | Implemented |
| ISO 27001 A.9 | Access control | Localhost-only + Bearer auth |
| ISO 27001 A.12.4 | Audit logging | HMAC-chained JSON logs |
| ISO 27001 A.13.1 | Network security | Rate limiting + egress allowlist |
| ISO 27001 A.14.2 | Input validation | Implemented |
| SOC 2 CC6.1 | Logical access | Token-based auth |
| SOC 2 CC6.6 | Boundary protection | Rate limiting + CSP |
| SOC 2 CC7.2 | System monitoring | HMAC audit logs |
| SOC 2 CC8.1 | Data integrity | Token count validation gates |
