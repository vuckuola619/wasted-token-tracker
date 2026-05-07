/**
 * Extended Universal Providers (JSON / JSONL based)
 *
 * Replicates support for the long tail of AI IDEs and agents found in Tokscale:
 * Factory Droid, Pi, Kimi CLI, Qwen CLI, Kilo, Mux, Crush
 *
 * Note: Gemini CLI, Amp, Roo Code, and Zed have dedicated provider files
 * (geminicli.js, amp.js, roocode.js, zed.js) with full Windows/macOS/Linux
 * path support and proper schema parsing.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { calculateCost } from '../models.js';

function createJsonProvider(id, name, pathsResolver) {
  return {
    name: id,
    displayName: name,

    modelDisplayName(model) { return model; },
    toolDisplayName(rawTool) { return rawTool; },

    async discoverSessions() {
      const sources = [];
      const dirs = pathsResolver();
      for (const dir of dirs) {
        try {
          const files = await readdir(dir, { recursive: true }).catch(() => []);
          for (const file of files) {
            if (file.endsWith('.json') || file.endsWith('.jsonl')) {
              sources.push({ path: join(dir, file), project: 'global', provider: id });
            }
          }
        } catch {}
      }
      return sources;
    },

    createSessionParser(source, seenKeys) {
      return {
        async *parse() {
          let content;
          try { content = await readFile(source.path, 'utf-8'); } catch { return; }

          const lines = content.split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              let entry = JSON.parse(line);
              // Handle top-level array
              if (Array.isArray(entry)) {
                 for (const item of entry) yield* processEntry(item, source, seenKeys);
              } else {
                 yield* processEntry(entry, source, seenKeys);
              }
            } catch {}
          }
        }
      };
    }
  };
}

function *processEntry(entry, source, seenKeys) {
  // Generic token extraction logic covering many schemas
  const model = entry.model || entry.model_id || 'unknown';
  const usage = entry.usage || entry.tokens || entry.token_usage || entry;
  const inputTokens = usage.prompt_tokens || usage.input_tokens || usage.prompt || 0;
  const outputTokens = usage.completion_tokens || usage.output_tokens || usage.completion || 0;
  const timestamp = entry.timestamp || entry.created_at || entry.time || new Date().toISOString();

  if (inputTokens === 0 && outputTokens === 0) return;

  const dedupKey = `${source.provider}:${source.path}:${timestamp}:${inputTokens}:${outputTokens}`;
  if (seenKeys.has(dedupKey)) return;
  seenKeys.add(dedupKey);

  const costUSD = entry.cost || calculateCost(model, inputTokens, outputTokens);

  yield {
    provider: source.provider,
    model: model,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
    cacheReadInputTokens: usage.cache_read_input_tokens || 0,
    cachedInputTokens: usage.cached_tokens || 0,
    reasoningTokens: usage.reasoning_tokens || 0,
    webSearchRequests: 0,
    costUSD,
    tools: entry.tools ? entry.tools.map(t => t.name || t) : [],
    timestamp,
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage: entry.prompt || entry.message || '',
    sessionId: source.path,
  };
}

function isWin() { return process.platform === 'win32'; }
function isMac() { return process.platform === 'darwin'; }
function globalStoragePath() {
  if (isMac()) return join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage');
  if (isWin()) return join(homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage');
  return join(homedir(), '.config', 'Code', 'User', 'globalStorage');
}

export const factoryDroid = createJsonProvider('factorydroid', 'Factory Droid', () => [join(homedir(), '.factory', 'sessions')]);
export const pi = createJsonProvider('pi', 'Pi Agent', () => [join(homedir(), '.pi', 'agent', 'sessions'), join(homedir(), '.omp', 'agent', 'sessions')]);
export const kimiCli = createJsonProvider('kimicli', 'Kimi CLI', () => [join(homedir(), '.kimi', 'sessions')]);
export const qwenCli = createJsonProvider('qwencli', 'Qwen CLI', () => [join(homedir(), '.qwen', 'projects')]);
export const kiloCode = createJsonProvider('kilocode', 'Kilo Code', () => [join(globalStoragePath(), 'kilocode.kilo-code', 'tasks')]);
export const mux = createJsonProvider('mux', 'Mux', () => [join(homedir(), '.mux', 'sessions')]);
export const crush = createJsonProvider('crush', 'Crush AI', () => [join(homedir(), '.local', 'share', 'crush')]);

export const extendedProviders = [
  factoryDroid, pi, kimiCli, qwenCli, kiloCode, mux, crush
];
