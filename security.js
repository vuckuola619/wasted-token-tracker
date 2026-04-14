/**
 * AG-Code Token — Security Module
 *
 * Implements ISO 27001 / GDPR / SOC 2 controls:
 *   - HTTP security headers (OWASP recommended)
 *   - Rate limiting (sliding window per IP)
 *   - Input validation & sanitization
 *   - Audit logging (structured, append-only)
 *   - Path traversal protection
 *   - CSV injection prevention
 *   - Network egress allowlist
 *
 * Zero dependencies — uses only Node.js built-ins.
 */

import { basename } from 'path';

// ─── Configuration ─────────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000;  // 1 minute
const RATE_LIMIT_MAX = 120;           // requests per window per IP
const MAX_SSE_CONNECTIONS = 50;       // prevent SSE connection flooding
const MAX_URL_LENGTH = 2048;          // prevent oversized URLs
const MAX_BODY_SIZE = 0;              // GET-only API — reject all bodies

// ─── Allowed Values (Whitelist) ────────────────────────────────────────────────
const VALID_PERIODS = new Set(['today', 'week', '30days', 'month', 'all']);
const VALID_FORMATS = new Set(['json', 'csv']);
const ALLOWED_EGRESS = ['https://raw.githubusercontent.com/BerriAI/litellm/'];

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

  // Content Security Policy — strict but functional
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "script-src 'self' 'unsafe-inline'",  // inline JS in single-file dashboard
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
 * Returns true if the path is safe, false if it should be rejected.
 */
export function isPathSafe(filePath) {
  // Reject null bytes (poison null byte attack)
  if (filePath.includes('\0')) return false;

  // Reject directory traversal
  if (filePath.includes('..')) return false;

  // Reject backslash (Windows path traversal)
  if (filePath.includes('\\')) return false;

  // Reject encoded traversal
  if (decodeURIComponent(filePath).includes('..')) return false;

  // Reject absolute paths
  if (filePath.startsWith('/') && filePath.length > 1 && filePath[1] === '/') return false;

  // Reject protocol handlers
  if (/^[a-zA-Z]+:/.test(filePath)) return false;

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

// ─── Audit Logging (ISO 27001 A.12.4 / SOC 2 CC7.2) ──────────────────────────

/**
 * Structured audit log — append-only, no PII.
 * Outputs JSON lines to stdout for log aggregation.
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
  console.log(`[audit] ${JSON.stringify(entry)}`);
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
  startRateLimitCleanup();
  auditLog('security_init', { rateLimit: RATE_LIMIT_MAX, sseMax: MAX_SSE_CONNECTIONS });
}

export function shutdownSecurity() {
  stopRateLimitCleanup();
  rateLimitMap.clear();
}
