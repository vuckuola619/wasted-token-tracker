/**
 * Claude 5-Hour Billing Window Tracker
 *
 * Computes Claude 5-hour billing windows from parsed session data.
 * A window starts at the first call timestamp and lasts 5 hours.
 * If 5+ hours have passed since window start, a new window begins.
 */

import { parseAllSessions, getDateRange } from './parser.js';

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours in ms
const MAX_HISTORY = 5;

/**
 * Format milliseconds remaining as "Xh Ym".
 * Returns "Expired" if ms <= 0, "No data" if ms is null.
 */
function formatResetIn(ms) {
  if (ms === null) return 'No data';
  if (ms <= 0) return 'Expired';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Group Claude API calls into 5-hour billing windows.
 *
 * Rules:
 * - First call starts window 1.
 * - Any subsequent call whose timestamp is >= windowStart + 5h starts a new window.
 * - Calls are processed in ascending timestamp order.
 *
 * @param {Array} calls - All Claude calls sorted by timestamp ascending.
 * @returns {Array} Array of window objects.
 */
function groupIntoWindows(calls) {
  if (!calls.length) return [];

  const windows = [];
  let currentWindow = null;

  for (const call of calls) {
    if (!call.timestamp) continue;

    const ts = new Date(call.timestamp).getTime();
    if (!Number.isFinite(ts)) continue;

    if (!currentWindow || ts >= currentWindow.startMs + WINDOW_MS) {
      currentWindow = {
        startMs: ts,
        endMs: ts + WINDOW_MS,
        calls: [],
        tokensUsed: 0,
        costUSD: 0,
        apiCalls: 0,
      };
      windows.push(currentWindow);
    }

    currentWindow.calls.push(call);
    currentWindow.tokensUsed +=
      (call.inputTokens || 0) +
      (call.outputTokens || 0) +
      (call.cacheReadInputTokens || 0) +
      (call.cacheCreationInputTokens || 0) +
      (call.reasoningTokens || 0);
    currentWindow.costUSD += call.costUSD || 0;
    currentWindow.apiCalls += 1;
  }

  return windows;
}

/**
 * Get the current Claude 5-hour billing window.
 *
 * @returns {Promise<Object>} Current window object.
 */
export async function getBillingWindow() {
  const { range } = getDateRange('all');
  const projects = await parseAllSessions(range, 'claude');

  const allCalls = [];
  for (const proj of projects) {
    for (const call of proj.calls) {
      if (call.timestamp) {
        allCalls.push(call);
      }
    }
  }

  allCalls.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    return ta - tb;
  });

  if (!allCalls.length) {
    return {
      windowStart: null,
      windowEnd: null,
      resetIn: 0,
      resetInFormatted: 'No data',
      tokensUsed: 0,
      costUSD: 0,
      apiCalls: 0,
      isActive: false,
      previousWindows: [],
    };
  }

  const windows = groupIntoWindows(allCalls);

  if (!windows.length) {
    return {
      windowStart: null,
      windowEnd: null,
      resetIn: 0,
      resetInFormatted: 'No data',
      tokensUsed: 0,
      costUSD: 0,
      apiCalls: 0,
      isActive: false,
      previousWindows: [],
    };
  }

  const now = Date.now();
  const current = windows[windows.length - 1];
  const isActive = now >= current.startMs && now < current.endMs;
  const resetIn = isActive ? current.endMs - now : 0;

  const previousWindows = windows
    .slice(0, -1)
    .slice(-MAX_HISTORY)
    .map(w => ({
      windowStart: new Date(w.startMs).toISOString(),
      windowEnd: new Date(w.endMs).toISOString(),
      tokensUsed: w.tokensUsed,
      costUSD: w.costUSD,
      apiCalls: w.apiCalls,
    }));

  return {
    windowStart: new Date(current.startMs).toISOString(),
    windowEnd: new Date(current.endMs).toISOString(),
    resetIn,
    resetInFormatted: isActive ? formatResetIn(resetIn) : 'Expired',
    tokensUsed: current.tokensUsed,
    costUSD: current.costUSD,
    apiCalls: current.apiCalls,
    isActive,
    previousWindows,
  };
}
