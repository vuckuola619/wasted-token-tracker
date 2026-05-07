/**
 * Wasted Token Tracker — Security Module (v2.0)
 *
 * Implements ISO 27001 / GDPR / SOC 2 controls:
 *   - HTTP security headers (OWASP recommended)
 *   - Rate limiting (sliding window per IP, file-backed persistence)
 *   - Input validation & sanitization
 *   - HMAC-chained audit logging with file persistence & rotation
 *   - Path traversal protection (full URL decoding)
 *   - CSV injection prevention
 *   - Network egress allowlist
 *   - Token-based API authentication
 *
 * Zero npm dependencies — uses only Node.js built-ins.
 */

import { basename, join } from 'path';
import { createHmac, randomBytes } from 'crypto';
import {
  mkdirSync, readFileSync, writeFileSync, appendFileSync,
  readdirSync, unlinkSync, existsSync,
} from 'fs';
import { homedir } from 'os';

// ─── Configuration ─────────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000;  // 1 minute
const RATE_LIMIT_MAX = 120;           // requests per window per IP
const MAX_SSE_CONNECTIONS = 50;       // prevent SSE connection flooding
const MAX_URL_LENGTH = 2048;          // prevent oversized URLs
const MAX_BODY_SIZE = 0;              // GET-only API — reject all bodies

// ─── Security Directories ──────────────────────────────────────────────────────
const AG_DIR = join(homedir(), '.wasted-token-tracker');
const AUTH_SECRET_PATH = join(AG_DIR, 'auth-secret');
const HMAC_KEY_PATH = join(AG_DIR, 'hmac-key');
const AUDIT_LOG_DIR = join(AG_DIR, 'audit');
const RATE_LIMIT_PATH = join(AG_DIR, 'rate-limits.json');
const MAX_AUDIT_LOG_FILES = 7;                // 7-day retention

// ─── Allowed Values (Whitelist) ────────────────────────────────────────────────
const VALID_PERIODS = new Set(['today', 'week', '30days', 'month', 'all']);
const VALID_FORMATS = new Set(['json', 'csv']);
const ALLOWED_EGRESS = ['https://raw.githubusercontent.com/BerriAI/litellm/'];

// ─── Authentication (ISO 27001 A.9.4 / SOC 2 CC6.1) ──────────────────────────
let authToken = null;

/**
 * Initialize authentication — generate or load a persistent auth secret.
 * The secret is stored at ~/.wasted-token-tracker/auth-secret.
 */
export function initAuth() {
  try {
    mkdirSync(AG_DIR, { recursive: true });
    if (existsSync(AUTH_SECRET_PATH)) {
      authToken = readFileSync(AUTH_SECRET_PATH, 'utf-8').trim();
      if (authToken.length < 32) {
        // Regenerate if suspiciously short
        authToken = randomBytes(32).toString('hex');
        writeFileSync(AUTH_SECRET_PATH, authToken + '\n', { mode: 0o600 });
      }
    } else {
      authToken = randomBytes(32).toString('hex');
      writeFileSync(AUTH_SECRET_PATH, authToken + '\n', { mode: 0o600 });
    }
  } catch (err) {
    authToken = randomBytes(32).toString('hex');
    console.warn(`[security] Could not persist auth token: ${err.message}`);
  }
  return authToken;
}

/**
 * Retrieve the current auth token.
 */
export function getAuthToken() {
  return authToken;
}

/**
 * Validate an incoming request's authentication.
 * Accepts: Authorization: Bearer <token> OR ?token=<token> (for SSE/EventSource).
 * Returns true if valid, false if not.
 */
export function validateAuth(req) {
  if (!authToken) return true; // Auth not initialized — allow

  // Check Authorization header (primary mechanism)
  const authHeader = req.headers?.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer' && parts[1] === authToken) {
      return true;
    }
  }

  // Check query parameter (fallback for SSE/EventSource which can't set headers)
  try {
    const url = new URL(req.url, 'http://localhost');
    const qToken = url.searchParams.get('token');
    if (qToken && qToken === authToken) return true;
  } catch { /* malformed URL */ }

  return false;
}

/**
 * Check if auth requirement should be enforced.
 * Auth is required when the server is bound to non-localhost addresses,
 * or when WASTED_TOKEN_AUTH=required is set.
 */
export function isAuthRequired() {
  if (process.env.WASTED_TOKEN_NO_AUTH === '1') return false;
  if (process.env.WASTED_TOKEN_AUTH === 'required') return true;
  // If bound to non-localhost, auth is required
  const host = process.env.WASTED_TOKEN_HOST || '127.0.0.1';
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
}

// ─── Rate Limiting (Sliding Window, ISO 27001 A.13.1 / SOC 2 CC6.6) ──────────
const rateLimitMap = new Map();
const CLEANUP_INTERVAL_MS = 5 * 60_000; // cleanup stale entries every 5 min

// Periodic cleanup to prevent memory leak from abandoned IPs
let cleanupTimer = null;
function startRateLimitCleanup() {
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of rateLimitMap) {
      const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
      if (recent.length === 0) {
        rateLimitMap.delete(ip);
      } else {
        rateLimitMap.set(ip, recent);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref(); // don't keep process alive
}

function stopRateLimitCleanup() {
  if (cleanupTimer) clearInterval(cleanupTimer);
}

/**
 * Persist rate-limit counters to disk (called on shutdown).
 * Survives server restarts so counters are not reset.
 */
function persistRateLimits() {
  try {
    const now = Date.now();
    const data = {};
    for (const [ip, timestamps] of rateLimitMap) {
      const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
      if (recent.length > 0) data[ip] = recent;
    }
    mkdirSync(AG_DIR, { recursive: true });
    writeFileSync(RATE_LIMIT_PATH, JSON.stringify({ ts: now, data }));
  } catch { /* non-critical — counters will reset */ }
}

/**
 * Load persisted rate-limit counters (called on startup).
 */
function loadRateLimits() {
  try {
    if (!existsSync(RATE_LIMIT_PATH)) return;
    const raw = readFileSync(RATE_LIMIT_PATH, 'utf-8');
    const { ts, data } = JSON.parse(raw);
    const now = Date.now();
    // Only load entries that are still within the window
    if (now - ts > RATE_LIMIT_WINDOW_MS * 2) return; // stale file
    for (const [ip, timestamps] of Object.entries(data)) {
      const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
      if (recent.length > 0) rateLimitMap.set(ip, recent);
    }
  } catch { /* corrupted file — start fresh */ }
}

/**
 * Check rate limit for a request.
 * Returns { allowed: boolean, remaining: number, resetMs: number }
 */
export function checkRateLimit(req) {
  const ip = req.socket?.remoteAddress || '127.0.0.1';
  const now = Date.now();
  const timestamps = rateLimitMap.get(ip) || [];
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX) {
    const oldest = recent[0];
    const resetMs = RATE_LIMIT_WINDOW_MS - (now - oldest);
    return { allowed: false, remaining: 0, resetMs };
  }

  recent.push(now);
  rateLimitMap.set(ip, recent);
  return { allowed: true, remaining: RATE_LIMIT_MAX - recent.length, resetMs: 0 };
}

// ─── Security Headers (OWASP Best Practices) ──────────────────────────────────

/**
 * Apply security headers to every HTTP response.
 * Covers: X-Content-Type-Options, X-Frame-Options, CSP, Referrer-Policy, etc.
 *
 * @param {import('http').ServerResponse} res
 */
export function applySecurityHeaders(res) {
  // Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // Modern browsers should use CSP, not XSS-Protection
  res.setHeader('X-XSS-Protection', '0');

  // Control referrer information
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Disable unnecessary browser features
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  // Content Security Policy — strict, NO 'unsafe-inline' for scripts
  // All JS is served from external app.js; ECharts from CDN
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "script-src 'self' https://cdn.jsdelivr.net",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));

  // Cache control for API responses
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  // Prevent information leakage
  res.setHeader('X-Powered-By', '');
}

// ─── Input Validation (ISO 27001 A.14.2 / SOC 2 CC6.1) ───────────────────────

/**
 * Validate and sanitize query parameters.
 * Returns sanitized values or throws with details.
 */
export function validateQueryParams(url) {
  const params = {};

  // Period validation
  const period = url.searchParams.get('period');
  if (period !== null) {
    if (!VALID_PERIODS.has(period)) {
      throw new ValidationError(`Invalid period: "${period}". Allowed: ${[...VALID_PERIODS].join(', ')}`);
    }
    params.period = period;
  } else {
    params.period = 'week'; // safe default
  }

  // Provider validation (alphanumeric + underscore/dash only)
  const provider = url.searchParams.get('provider');
  if (provider !== null) {
    if (!/^[a-zA-Z0-9_-]{1,30}$/.test(provider) && provider !== 'all') {
      throw new ValidationError(`Invalid provider: "${provider}"`);
    }
    params.provider = provider;
  } else {
    params.provider = 'all';
  }

  // Format validation
  const format = url.searchParams.get('format');
  if (format !== null) {
    if (!VALID_FORMATS.has(format)) {
      throw new ValidationError(`Invalid format: "${format}". Allowed: json, csv`);
    }
    params.format = format;
  } else {
    params.format = 'json';
  }

  // Redact mode (privacy)
  const redact = url.searchParams.get('redact');
  params.redact = redact === '1' || redact === 'true';

  return params;
}

/**
 * Custom validation error class
 */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

// ─── Path Traversal Protection (ISO 27001 A.14.2) ─────────────────────────────

/**
 * Validate a static file path — reject path traversal attempts.
 * Fully decodes the URL (looping to defeat double/triple encoding)
 * before checking for traversal patterns.
 * Returns true if the path is safe, false if it should be rejected.
 */
export function isPathSafe(filePath) {
  // Fully decode — loop until stable to defeat double-encoding (%252e%252e)
  let decoded = filePath;
  try {
    let prev = '';
    let iterations = 0;
    while (decoded !== prev && iterations < 10) {
      prev = decoded;
      decoded = decodeURIComponent(decoded);
      iterations++;
    }
  } catch {
    return false; // Malformed encoding — reject
  }

  // Reject null bytes (poison null byte attack)
  if (decoded.includes('\0')) return false;

  // Reject directory traversal
  if (decoded.includes('..')) return false;

  // Reject backslash (Windows path traversal)
  if (decoded.includes('\\')) return false;

  // Reject absolute paths (double-slash)
  if (decoded.startsWith('/') && decoded.length > 1 && decoded[1] === '/') return false;

  // Reject protocol handlers
  if (/^[a-zA-Z]+:/.test(decoded)) return false;

  return true;
}

// ─── URL Length Validation ─────────────────────────────────────────────────────

export function isURLLengthValid(url) {
  return url.length <= MAX_URL_LENGTH;
}

// ─── Data Sanitization (GDPR Art 5 — Data Minimization) ───────────────────────

/**
 * Sanitize project names to remove filesystem paths (GDPR data minimization).
 * Only expose the basename, never full directory structure.
 */
export function sanitizeProjectName(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return 'unknown';
  const name = basename(rawPath);
  // Remove any non-printable or control characters
  return name.replace(/[^\x20-\x7E]/g, '').slice(0, 100);
}

/**
 * Sanitize a string field — remove control characters, limit length.
 */
export function sanitizeString(value, maxLength = 200) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\x00-\x1F\x7F]/g, '') // strip control chars
    .slice(0, maxLength);
}

// ─── Token Count Validation (SOC 2 CC8.1 — Data Integrity) ───────────────────

/**
 * Validate and clamp token counts to sane ranges.
 * Protects against corrupted session files producing absurd values.
 */
export function validateTokenCounts(call) {
  const MAX_TOKENS = 100_000_000;  // 100M tokens per call is absurd
  const MAX_COST = 10_000;         // $10K per call is absurd
  const numericFields = [
    'inputTokens', 'outputTokens', 'cacheCreationInputTokens',
    'cacheReadInputTokens', 'cachedInputTokens', 'reasoningTokens',
    'webSearchRequests'
  ];

  for (const field of numericFields) {
    if (call[field] === undefined || call[field] === null) {
      call[field] = 0;
    }
    if (!Number.isFinite(call[field]) || call[field] < 0) {
      auditLog('data_validation_fail', { field, value: call[field], provider: call.provider });
      call[field] = 0;
    }
    if (call[field] > MAX_TOKENS) {
      auditLog('data_validation_clamp', { field, value: call[field], max: MAX_TOKENS, provider: call.provider });
      call[field] = 0; // Zero out rather than clamp — likely data corruption
    }
  }

  // Cost validation
  if (!Number.isFinite(call.costUSD) || call.costUSD < 0) {
    call.costUSD = 0;
  }
  if (call.costUSD > MAX_COST) {
    auditLog('data_validation_clamp', { field: 'costUSD', value: call.costUSD, max: MAX_COST, provider: call.provider });
    call.costUSD = 0;
  }

  return call;
}

// ─── Timestamp Validation ──────────────────────────────────────────────────────

/**
 * Validate a timestamp string.
 * Returns ISO string if valid, null if invalid.
 * Rejects dates before 2023 or more than 24h in the future.
 */
export function validateTimestamp(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  if (d.getFullYear() < 2023) return null;
  if (d.getTime() > Date.now() + 86_400_000) return null; // 24h future max
  return d.toISOString();
}

// ─── CSV Injection Protection ──────────────────────────────────────────────────

/**
 * Redact a project name for privacy mode — keeps first 3 chars, masks rest.
 */
export function redactProjectName(name) {
  if (!name || name.length <= 3) return '***';
  return name.slice(0, 3) + '*'.repeat(Math.min(name.length - 3, 5));
}

/**
 * Escape CSV values to prevent formula injection.
 * Characters =, +, -, @, \t, \r at the start can trigger Excel/Sheets formulas.
 */
export function csvSafe(val) {
  const s = String(val);
  if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
  // Escape double quotes and wrap in quotes if contains comma
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ─── Network Egress Validation (SOC 2 CC6.1) ──────────────────────────────────

/**
 * Check if an outgoing URL is in the allowed egress list.
 * Only LiteLLM pricing is allowed to be fetched.
 */
export function isAllowedEgressURL(url) {
  return ALLOWED_EGRESS.some(prefix => url.startsWith(prefix));
}

// ─── HMAC-Chained Audit Logging (ISO 27001 A.12.4 / SOC 2 CC7.2) ─────────────

let hmacKey = null;
let previousHmac = '0'.repeat(64); // genesis block

/**
 * Initialize the HMAC key for audit log integrity.
 * The key is generated once and persisted at ~/.wasted-token-tracker/hmac-key.
 */
function initHmacKey() {
  try {
    mkdirSync(AG_DIR, { recursive: true });
    if (existsSync(HMAC_KEY_PATH)) {
      hmacKey = readFileSync(HMAC_KEY_PATH, 'utf-8').trim();
      if (hmacKey.length < 32) {
        hmacKey = randomBytes(32).toString('hex');
        writeFileSync(HMAC_KEY_PATH, hmacKey + '\n', { mode: 0o600 });
      }
    } else {
      hmacKey = randomBytes(32).toString('hex');
      writeFileSync(HMAC_KEY_PATH, hmacKey + '\n', { mode: 0o600 });
    }
  } catch {
    hmacKey = randomBytes(32).toString('hex');
  }
}

/**
 * Compute HMAC-SHA256 chain hash for an audit entry.
 * Each entry's HMAC depends on the previous entry's HMAC,
 * creating a tamper-evident chain.
 */
function computeEntryHmac(entryJson, prevHmac) {
  return createHmac('sha256', hmacKey)
    .update(prevHmac + entryJson)
    .digest('hex');
}

/**
 * Rotate audit log files — keep only MAX_AUDIT_LOG_FILES days.
 */
function rotateAuditLogs() {
  try {
    if (!existsSync(AUDIT_LOG_DIR)) return;
    const files = readdirSync(AUDIT_LOG_DIR)
      .filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();
    for (let i = MAX_AUDIT_LOG_FILES; i < files.length; i++) {
      try { unlinkSync(join(AUDIT_LOG_DIR, files[i])); } catch { /* ignore */ }
    }
  } catch { /* non-critical */ }
}

/**
 * Structured audit log — HMAC-chained, file-persisted, tamper-evident.
 * Outputs JSON lines to stdout and appends to daily log files.
 *
 * Each entry contains:
 *   - _prevHmac: HMAC of the previous entry (chain link)
 *   - _hmac: HMAC-SHA256 of this entry's content + previous HMAC
 *
 * Verification: replay from genesis and recompute each HMAC to detect tampering.
 */
export function auditLog(event, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level: details.level || 'info',
    event,
    ...details,
  };
  // Remove level from nested details to avoid duplication
  delete entry.details;

  // HMAC chain for tamper detection
  if (hmacKey) {
    entry._prevHmac = previousHmac;
    const entryJson = JSON.stringify(entry);
    const hmac = computeEntryHmac(entryJson, previousHmac);
    entry._hmac = hmac;
    previousHmac = hmac;
  }

  const line = JSON.stringify(entry);
  console.log(`[audit] ${line}`);

  // Persist to daily log file
  try {
    mkdirSync(AUDIT_LOG_DIR, { recursive: true });
    const today = new Date().toISOString().split('T')[0];
    appendFileSync(join(AUDIT_LOG_DIR, `audit-${today}.jsonl`), line + '\n');
  } catch { /* non-critical — stdout logging is the primary channel */ }
}

// ─── SSE Connection Tracking ───────────────────────────────────────────────────

let sseConnectionCount = 0;

export function canAcceptSSE() {
  return sseConnectionCount < MAX_SSE_CONNECTIONS;
}

export function incrementSSE() {
  sseConnectionCount++;
  return sseConnectionCount;
}

export function decrementSSE() {
  sseConnectionCount = Math.max(0, sseConnectionCount - 1);
  return sseConnectionCount;
}

export function getSSECount() {
  return sseConnectionCount;
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────────

export function initSecurity() {
  initHmacKey();
  initAuth();
  loadRateLimits();
  startRateLimitCleanup();
  rotateAuditLogs();
  auditLog('security_init', {
    rateLimit: RATE_LIMIT_MAX,
    sseMax: MAX_SSE_CONNECTIONS,
    authEnabled: !!authToken,
    authRequired: isAuthRequired(),
  });
}

export function shutdownSecurity() {
  persistRateLimits();
  stopRateLimitCleanup();
  rateLimitMap.clear();
}
