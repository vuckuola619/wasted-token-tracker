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
 * Models used: Gemini 2.5 Pro (default), Claude Opus 4.x (via model selection)
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

/**
 * Try to detect which model was used from conversation metadata.
 * Antigravity supports model selection (Gemini, Claude Opus, etc.)
 * Default assumption is Gemini 2.5 Pro since it's the Google IDE.
 */
function detectModel(convId, pbSize) {
  // Larger conversations (>5MB) likely used an Opus-class model (heavier reasoning)
  // This is a heuristic — real detection would need protobuf parsing
  if (pbSize > 15_000_000) return 'claude-opus-4-6';
  if (pbSize > 8_000_000) return 'claude-opus-4-5';
  return 'gemini-2.5-pro';
}

/** @type {import('./types.js').Provider} */
export const antigravity = {
  name: 'antigravity',
  displayName: 'Antigravity',

  modelDisplayName(model) {
    const map = {
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'gemini-2.5-flash': 'Gemini 2.5 Flash',
      'gemini-2.0-flash': 'Gemini 2.0 Flash',
      'claude-opus-4-6': 'Opus 4.6',
      'claude-opus-4-5': 'Opus 4.5',
      'claude-sonnet-4-6': 'Sonnet 4.6',
      'claude-sonnet-4-5': 'Sonnet 4.5',
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

        const model = detectModel(convId, pbSize);
        const timestamp = pbStat.mtime.toISOString();

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

        const dedupKey = `antigravity:${convId}:${pbSize}`;
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
