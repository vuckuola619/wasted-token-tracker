# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.2.x   | Current release     |
| < 1.2   | Not supported       |

## Architecture Security Model

AG-Code Token is designed with **security-by-default** principles:

### Data Privacy (GDPR Compliant)
- **No PII Collection** — Only reads token counts, model names, and file sizes
- **No External Transmission** — All data stays on your machine
- **No API Keys Required** — Reads session files directly from disk
- **No Telemetry** — Zero tracking, zero analytics, zero call-home
- **Data Minimization** — Project names are sanitized to basenames only
- **Right to Erasure** — `DELETE /api/cache` purges all in-memory data

### Network Security
- **Single Egress Point** — Only fetches LiteLLM pricing from `raw.githubusercontent.com`
- **Network Egress Allowlist** — All outgoing URLs are validated against an allowlist
- **Localhost-Only Binding** — Server binds to localhost by default
- **Rate Limiting** — 120 requests/minute per IP (sliding window)
- **SSE Connection Limit** — Maximum 50 concurrent streaming connections

### Input Validation
- **Parameter Allowlisting** — All query params validated against known values
- **Path Traversal Protection** — Static file serving rejects `..`, `\0`, backslashes
- **URL Length Limit** — Maximum 2048 characters
- **No Request Body** — GET-only API rejects all request bodies
- **CSV Injection Prevention** — Export data sanitized against formula injection

### HTTP Security Headers
All responses include:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Content-Security-Policy` (strict policy)
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` (all features disabled)
- `Cache-Control: no-store` (API responses)

### Monitoring & Audit
- **Structured Audit Logging** — All security events logged as JSON
- **No PII in Logs** — Paths sanitized, no IP addresses stored
- **Health Check** — `/api/health` reports system status and watcher state

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **DO NOT** open a public GitHub issue
2. Email: [Create a private security advisory](https://github.com/vuckuola619/ag-code-token/security/advisories/new)
3. Include: description, reproduction steps, and impact assessment
4. Expected response: within 48 hours

## Compliance Mapping

| Standard | Control | Status |
|----------|---------|--------|
| GDPR Art 5 | Data minimization | Yes Implemented |
| GDPR Art 25 | Privacy by design | Yes Implemented |
| GDPR Art 32 | Security of processing | Yes Implemented |
| ISO 27001 A.9 | Access control | Yes Localhost-only |
| ISO 27001 A.12.4 | Audit logging | Yes Implemented |
| ISO 27001 A.13.1 | Network security | Yes Rate limiting |
| ISO 27001 A.14.2 | Input validation | Yes Implemented |
| SOC 2 CC6.1 | Logical access | Yes Local-only |
| SOC 2 CC6.6 | Boundary protection | Yes Rate limiting |
| SOC 2 CC7.2 | System monitoring | Yes Audit logs |
| SOC 2 CC8.1 | Data integrity | Yes Validation gates |
