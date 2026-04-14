/**
 * Aider Provider
 * 
 * Aider stores session data in:
 *   - .aider.chat.history.md (per-project conversation history)
 *   - .aider.input.history (input history)
 *   - .aider.tags.cache.v3/ (code context cache)
 *   - ~/.aider/analytics.jsonl (usage analytics if enabled)
 *   - ~/.aider/history/ (global history)
 * 
 * Aider also logs token usage per-request in its analytics.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { calculateCost } from '../models.js';

function getAiderDirs() {
  return [
    join(homedir(), '.aider'),
    join(homedir(), '.aider', 'history'),
  ];
}

/** @type {import('./types.js').Provider} */
export const aider = {
  name: 'aider',
  displayName: 'Aider',

  modelDisplayName(model) {
    return model;
  },

  toolDisplayName(rawTool) {
    const map = { edit: 'Edit', search: 'Search', run: 'Bash', diff: 'Edit' };
    return map[rawTool] ?? rawTool;
  },

  async discoverSessions() {
    const sources = [];

    for (const dir of getAiderDirs()) {
      try {
        const entries = await readdir(dir);
        for (const entry of entries) {
          if (entry.endsWith('.jsonl') || entry.endsWith('.json')) {
            const full = join(dir, entry);
            const s = await stat(full).catch(() => null);
            if (s?.isFile()) {
              sources.push({ path: full, project: 'aider-global', provider: 'aider' });
            }
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
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (!entry.model && !entry.tokens) continue;

            const model = entry.model || 'unknown';
            const inputTokens = entry.tokens?.prompt || entry.prompt_tokens || entry.input_tokens || 0;
            const outputTokens = entry.tokens?.completion || entry.completion_tokens || entry.output_tokens || 0;
            const timestamp = entry.timestamp || entry.time || new Date().toISOString();

            if (inputTokens === 0 && outputTokens === 0) continue;

            const dedupKey = `aider:${source.path}:${timestamp}:${inputTokens}:${outputTokens}`;
            if (seenKeys.has(dedupKey)) continue;
            seenKeys.add(dedupKey);

            yield {
              provider: 'aider',
              model,
              inputTokens,
              outputTokens,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              cachedInputTokens: 0,
              reasoningTokens: 0,
              webSearchRequests: 0,
              costUSD: entry.cost || calculateCost(model, inputTokens, outputTokens),
              tools: entry.tools || [],
              timestamp,
              speed: 'standard',
              deduplicationKey: dedupKey,
              userMessage: entry.message || entry.prompt || '',
              sessionId: entry.session_id || basename(source.path, '.jsonl'),
            };
          } catch {}
        }
      },
    };
  },
};
