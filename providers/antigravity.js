/**
 * Antigravity (Google DeepMind) IDE Provider
 * 
 * Antigravity stores data in:
 *   Windows: %USERPROFILE%\.gemini\antigravity\
 *   macOS:   ~/.gemini/antigravity/
 *   Linux:   ~/.gemini/antigravity/
 * 
 * Data structure:
 *   conversations/<uuid>.pb  — Protobuf conversation blobs (binary)
 *   brain/<uuid>/            — Per-conversation working data
 *     .system_generated/steps/<n>/content.md  — Cached tool outputs
 *     artifacts/             — Generated artifacts
 *   code_tracker/active/     — Tracked file snapshots
 *   daemon/ls_*.json         — Local server config (pid, ports, version)
 * 
 * Since conversations are protobuf (binary), we estimate usage from:
 *   1. File sizes of .pb conversation blobs (rough token estimate)
 *   2. Number of steps (tool calls) per conversation
 *   3. File modification timestamps for date filtering
 * 
 * Models used: Gemini 3.1 Pro (default), Claude Opus 4.x, Sonnet 4.x (via model selection)
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { calculateCost } from '../models.js';

// ─── Antigravity uses ~4 bytes per token on average in protobuf encoding ───
const BYTES_PER_TOKEN_ESTIMATE = 4;
// Rough input/output split: ~70% input (context), ~30% output (generation)
const INPUT_RATIO = 0.70;
const OUTPUT_RATIO = 0.30;

function getAntigravityDir() {
  return process.env.ANTIGRAVITY_DIR || join(homedir(), '.gemini', 'antigravity');
}

function getConversationsDir() {
  return join(getAntigravityDir(), 'conversations');
}

function getBrainDir() {
  return join(getAntigravityDir(), 'brain');
}

// ─── Model Hints Configuration ─────────────────────────────────────────────────
// Since Antigravity .pb files are fully binary-compressed (no readable model strings),
// model detection relies on a user-configurable hints file:
//   ~/.config/wasted-token-tracker/model_hints.json
//
// Format:
// {
//   "defaultModel": "claude-opus-4-6",
//   "conversations": {
//     "b58d57f9-...": "claude-opus-4-6",
//     "c000309d-...": "gemini-3.1-pro"
//   }
// }

const MODEL_HINTS_PATHS = [
  join(homedir(), '.config', 'wasted-token-tracker', 'model_hints.json'),
  join(homedir(), '.wasted-token-tracker', 'model_hints.json'),
];

let _hintsCache = null;
let _hintsCacheTime = 0;
const HINTS_CACHE_TTL = 30_000; // 30s cache

/**
 * Load model hints from config file.
 * Cached for 30 seconds to avoid disk thrashing during bulk parsing.
 */
async function loadModelHints() {
  const now = Date.now();
  if (_hintsCache && (now - _hintsCacheTime) < HINTS_CACHE_TTL) return _hintsCache;

  for (const hintsPath of MODEL_HINTS_PATHS) {
    try {
      const raw = await readFile(hintsPath, 'utf-8');
      _hintsCache = JSON.parse(raw);
      _hintsCacheTime = now;
      return _hintsCache;
    } catch {}
  }

  // No hints file found — return defaults
  _hintsCache = { defaultModel: 'gemini-3.1-pro', conversations: {} };
  _hintsCacheTime = now;
  return _hintsCache;
}

/**
 * Get the model hints file path (first writable location).
 */
export function getModelHintsPath() {
  return MODEL_HINTS_PATHS[0];
}

/**
 * Save model hints to config file.
 */
export async function saveModelHints(hints) {
  const hintsPath = MODEL_HINTS_PATHS[0];
  const { mkdir, writeFile: wf } = await import('fs/promises');
  await mkdir(join(homedir(), '.config', 'wasted-token-tracker'), { recursive: true });
  await wf(hintsPath, JSON.stringify(hints, null, 2) + '\n');
  _hintsCache = hints;
  _hintsCacheTime = Date.now();
}

/**
 * Invalidate the model hints cache (called when hints are updated via API).
 */
export function invalidateModelHintsCache() {
  _hintsCache = null;
  _hintsCacheTime = 0;
}

// ─── Model name normalizer (maps display names → internal IDs) ─────────────────
const MODEL_NAME_MAP = {
  // Gemini 3.x
  'gemini 3.1 pro': 'gemini-3.1-pro',
  'gemini 3.1 pro (high)': 'gemini-3.1-pro',
  'gemini 3.1 pro (low)': 'gemini-3.1-pro',
  'gemini 3 flash': 'gemini-3-flash',
  'gemini 3 pro': 'gemini-3.1-pro',
  // Gemini 2.x
  'gemini 2.5 pro': 'gemini-2.5-pro',
  'gemini 2.5 flash': 'gemini-2.5-flash',
  'gemini 2.0 flash': 'gemini-2.0-flash',
  // Claude
  'claude sonnet 4.6': 'claude-sonnet-4-6',
  'claude sonnet 4.6 (thinking)': 'claude-sonnet-4-6',
  'claude sonnet 4.5': 'claude-sonnet-4-5',
  'claude opus 4.6': 'claude-opus-4-6',
  'claude opus 4.6 (thinking)': 'claude-opus-4-6',
  'claude opus 4.5': 'claude-opus-4-5',
  // GPT-OSS
  'gpt-oss 120b': 'gpt-oss-120b',
  'gpt-oss 120b (medium)': 'gpt-oss-120b',
};

function normalizeModelName(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  if (MODEL_NAME_MAP[lower]) return MODEL_NAME_MAP[lower];
  // Try partial match
  for (const [key, val] of Object.entries(MODEL_NAME_MAP)) {
    if (lower.includes(key) || key.includes(lower)) return val;
  }
  return null;
}

/**
 * Auto-detect model from overview.txt JSONL log.
 * Reads USER_SETTINGS_CHANGE entries to find the last model selection.
 * Returns null if no model change found (caller should fall back to default).
 */
async function detectModelFromOverview(convId) {
  const overviewPath = join(getBrainDir(), convId, '.system_generated', 'logs', 'overview.txt');
  let raw;
  try {
    raw = await readFile(overviewPath, 'utf-8');
  } catch {
    return null; // No overview.txt — brain dir may not have logs
  }

  // Parse JSONL and find the LAST model selection in USER_SETTINGS_CHANGE blocks
  let detectedModel = null;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'USER_INPUT' && typeof entry.content === 'string') {
        // Antigravity embeds USER_SETTINGS_CHANGE in the content field as a tag block.
        // Pattern: `Model Selection` from X to Y. No need to comment...
        // We match "from X to Y" stopping at ". No" or end of model name.
        if (entry.content.includes('Model Selection')) {
          // Antigravity format: `Model Selection` from X to Y. No need to comment...
          const match = entry.content.match(
            /`Model Selection` from .+? to (.+?)\. (?:No|If)/i
          );
          if (match) {
            const normalized = normalizeModelName(match[1].trim());
            if (normalized) detectedModel = normalized;
          }
        }
      }
    } catch { /* malformed line — skip */ }
  }

  return detectedModel;
}

/**
 * Detect which model was used for a conversation.
 * 
 * Priority:
 *   1. Per-conversation override in model_hints.json
 *   2. Auto-detected from overview.txt USER_SETTINGS_CHANGE log (new!)
 *   3. Default model from model_hints.json
 *   4. Hardcoded fallback: gemini-3.1-pro
 */
async function detectModel(convId) {
  const hints = await loadModelHints();

  // 1. Per-conversation override (exact match or prefix match)
  if (hints.conversations) {
    if (hints.conversations[convId]) return hints.conversations[convId];
    const prefix = convId.slice(0, 8);
    for (const [key, model] of Object.entries(hints.conversations)) {
      if (key.startsWith(prefix) || convId.startsWith(key)) return model;
    }
  }

  // 2. Auto-detect from overview.txt log
  const autoDetected = await detectModelFromOverview(convId);
  if (autoDetected) return autoDetected;

  // 3. Default from hints file, or hardcoded fallback
  return hints.defaultModel || 'gemini-3.1-pro';
}

/** @type {import('./types.js').Provider} */
export const antigravity = {
  name: 'antigravity',
  displayName: 'Antigravity',

  modelDisplayName(model) {
    const map = {
      // Gemini 3.x (current)
      'gemini-3.1-pro': 'Gemini 3.1 Pro',
      'gemini-3-flash': 'Gemini 3 Flash',
      // Gemini 2.x (legacy)
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'gemini-2.5-flash': 'Gemini 2.5 Flash',
      'gemini-2.0-flash': 'Gemini 2.0 Flash',
      // Claude
      'claude-opus-4-6': 'Opus 4.6 (Thinking)',
      'claude-opus-4-5': 'Opus 4.5',
      'claude-sonnet-4-6': 'Sonnet 4.6 (Thinking)',
      'claude-sonnet-4-5': 'Sonnet 4.5',
      // GPT-OSS
      'gpt-oss-120b': 'GPT-OSS 120B',
    };
    for (const [key, name] of Object.entries(map)) {
      if (model.includes(key)) return name;
    }
    return model;
  },

  toolDisplayName(rawTool) {
    const map = {
      view_file: 'Read',
      write_to_file: 'Edit',
      replace_file_content: 'Edit',
      multi_replace_file_content: 'Edit',
      run_command: 'Bash',
      send_command_input: 'Bash',
      command_status: 'Bash',
      grep_search: 'Search',
      list_dir: 'Glob',
      search_web: 'WebSearch',
      read_url_content: 'WebFetch',
      browser_subagent: 'Browser',
      generate_image: 'Image',
    };
    return map[rawTool] ?? rawTool;
  },

  async discoverSessions() {
    const sources = [];
    const conversationsDir = getConversationsDir();
    const brainDir = getBrainDir();

    try {
      const files = await readdir(conversationsDir);
      for (const file of files) {
        if (!file.endsWith('.pb')) continue;
        const convId = basename(file, '.pb');
        const pbPath = join(conversationsDir, file);

        // Check if there's a corresponding brain directory (richer data)
        const brainPath = join(brainDir, convId);
        const brainStat = await stat(brainPath).catch(() => null);

        sources.push({
          path: brainStat?.isDirectory() ? brainPath : pbPath,
          project: `ag-${convId.slice(0, 8)}`,
          provider: 'antigravity',
          // Store extra metadata for parsing
          _pbPath: pbPath,
          _convId: convId,
        });
      }
    } catch {}

    return sources;
  },

  createSessionParser(source, seenKeys) {
    return {
      async *parse() {
        const convId = source._convId || basename(source.path, '.pb');
        const pbPath = source._pbPath || join(getConversationsDir(), `${convId}.pb`);

        // Get the .pb file size and mtime for estimation
        const pbStat = await stat(pbPath).catch(() => null);
        if (!pbStat?.isFile()) return;

        const pbSize = pbStat.size;
        if (pbSize < 100) return; // Skip empty/tiny conversations

        const model = await detectModel(convId);
        // Use birthtime (conversation creation) for accurate date filtering.
        // mtime updates on every write — all active sessions would appear as "today".
        const timestamp = (pbStat.birthtime || pbStat.mtime).toISOString();

        // ─── Estimate tokens from protobuf size ───
        const totalTokens = Math.round(pbSize / BYTES_PER_TOKEN_ESTIMATE);
        const inputTokens = Math.round(totalTokens * INPUT_RATIO);
        const outputTokens = Math.round(totalTokens * OUTPUT_RATIO);

        // ─── Count steps (tool calls) from brain directory ───
        const tools = [];
        const brainPath = join(getBrainDir(), convId);
        const stepsDir = join(brainPath, '.system_generated', 'steps');
        try {
          const stepDirs = await readdir(stepsDir);
          for (const stepNum of stepDirs) {
            const stepDir = join(stepsDir, stepNum);
            const stepStat = await stat(stepDir).catch(() => null);
            if (stepStat?.isDirectory()) {
              // Each step is a tool call (read_url_content, view_file, etc.)
              const files = await readdir(stepDir).catch(() => []);
              if (files.some(f => f.endsWith('.md'))) tools.push('WebFetch');
              else tools.push('Read');
            }
          }
        } catch {}

        // ─── Check for artifacts (indicates write operations) ───
        const artifactsDir = join(brainPath, 'artifacts');
        try {
          const artifacts = await readdir(artifactsDir);
          if (artifacts.length > 0) tools.push('Edit');
        } catch {}

        const dedupKey = `antigravity:${convId}`;
        if (seenKeys.has(dedupKey)) return;
        seenKeys.add(dedupKey);

        const costUSD = calculateCost(model, inputTokens, outputTokens);

        yield {
          provider: 'antigravity',
          model,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: Math.round(outputTokens * 0.3), // Gemini thinking tokens
          webSearchRequests: tools.filter(t => t === 'WebSearch' || t === 'WebFetch').length,
          costUSD,
          tools: [...new Set(tools)], // deduplicate tool names
          timestamp,
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: '',
          sessionId: convId,
        };
      },
    };
  },
};
