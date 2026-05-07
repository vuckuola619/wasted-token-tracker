/**
 * Gemini CLI Provider
 *
 * Gemini CLI (@google/gemini-cli) stores session data in:
 *   Windows: %USERPROFILE%\.gemini\tmp\  (JSONL checkpoint files)
 *   macOS:   ~/.gemini/tmp/
 *   Linux:   ~/.gemini/tmp/
 *
 * Each JSONL file contains conversation turns with token usage.
 * The root ~/.gemini/ directory is shared with Antigravity IDE —
 * only the tmp/ subdirectory belongs to the Gemini CLI tool.
 *
 * Data format (JSONL lines):
 *   { "type": "user"|"model", "parts": [...], "usageMetadata": {
 *       "promptTokenCount": N, "candidatesTokenCount": N,
 *       "totalTokenCount": N, "cachedContentTokenCount": N } }
 *
 * Default model: gemini-2.5-pro (unless overridden in entry)
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { calculateCost } from '../models.js';

const DEFAULT_MODEL = 'gemini-2.5-pro';

function getGeminiCliDirs() {
  // Gemini CLI stores checkpoints in ~/.gemini/tmp/ on all platforms
  const base = join(homedir(), '.gemini', 'tmp');
  return [base];
}

/** @type {import('./types.js').Provider} */
export const geminiCli = {
  name: 'geminicli',
  displayName: 'Gemini CLI',

  modelDisplayName(model) {
    const m = model.toLowerCase();
    if (m.includes('2.5-pro') || m.includes('2.5_pro')) return 'Gemini 2.5 Pro';
    if (m.includes('2.5-flash') || m.includes('2.5_flash')) return 'Gemini 2.5 Flash';
    if (m.includes('2.0-flash') || m.includes('2.0_flash')) return 'Gemini 2.0 Flash';
    if (m.includes('1.5-pro') || m.includes('1.5_pro')) return 'Gemini 1.5 Pro';
    if (m.includes('1.5-flash') || m.includes('1.5_flash')) return 'Gemini 1.5 Flash';
    return model;
  },

  toolDisplayName(rawTool) {
    return rawTool;
  },

  async discoverSessions() {
    const sources = [];
    for (const dir of getGeminiCliDirs()) {
      try {
        const s = await stat(dir).catch(() => null);
        if (!s?.isDirectory()) continue;
        const files = await readdir(dir, { recursive: true }).catch(() => []);
        for (const file of (Array.isArray(files) ? files : [])) {
          const name = typeof file === 'string' ? file : file.name;
          if (name && (name.endsWith('.json') || name.endsWith('.jsonl'))) {
            const fullPath = join(dir, name);
            sources.push({
              path: fullPath,
              project: basename(name, name.endsWith('.jsonl') ? '.jsonl' : '.json'),
              provider: 'geminicli',
            });
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
        try {
          content = await readFile(source.path, 'utf-8');
        } catch { return; }

        const lines = content.split('\n').filter(l => l.trim());
        let currentUserMessage = '';

        for (const line of lines) {
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }

          // Handle arrays (some files wrap entries in an array)
          const entries = Array.isArray(entry) ? entry : [entry];

          for (const e of entries) {
            // Track user messages
            if (e.type === 'user' || e.role === 'user') {
              const parts = e.parts || e.content || [];
              if (Array.isArray(parts)) {
                currentUserMessage = parts
                  .filter(p => typeof p === 'string' || p.text)
                  .map(p => (typeof p === 'string' ? p : p.text || ''))
                  .join(' ');
              } else if (typeof parts === 'string') {
                currentUserMessage = parts;
              }
              continue;
            }

            if (e.type !== 'model' && e.role !== 'assistant' && e.role !== 'model') continue;

            // Extract usage metadata (Gemini CLI uses usageMetadata)
            const usage = e.usageMetadata || e.usage || {};
            const inputTokens = usage.promptTokenCount || usage.prompt_tokens || usage.input_tokens || 0;
            const outputTokens = usage.candidatesTokenCount || usage.candidates_token_count ||
              usage.completion_tokens || usage.output_tokens || 0;
            const cachedInputTokens = usage.cachedContentTokenCount || usage.cached_content_token_count || 0;

            if (inputTokens === 0 && outputTokens === 0) continue;

            const model = e.model || e.modelVersion || DEFAULT_MODEL;
            const timestamp = e.timestamp || e.created_at || e.time || new Date().toISOString();

            const dedupKey = `geminicli:${source.path}:${timestamp}:${inputTokens}:${outputTokens}`;
            if (seenKeys.has(dedupKey)) continue;
            seenKeys.add(dedupKey);

            const costUSD = calculateCost(model, inputTokens, outputTokens, 0, 0);

            yield {
              provider: 'geminicli',
              model,
              inputTokens,
              outputTokens,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              cachedInputTokens,
              reasoningTokens: usage.thinkingTokenCount || usage.thinking_token_count || 0,
              webSearchRequests: 0,
              costUSD,
              tools: [],
              timestamp,
              speed: 'standard',
              deduplicationKey: dedupKey,
              userMessage: currentUserMessage,
              sessionId: basename(source.path),
            };

            currentUserMessage = '';
          }
        }
      },
    };
  },
};
