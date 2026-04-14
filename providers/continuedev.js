/**
 * Continue.dev Provider
 * 
 * Continue.dev stores session data in:
 *   ~/.continue/sessions/ (JSON files per session)
 *   ~/.continue/dev_data/ (usage analytics)
 *   ~/.continue/config.json (configuration)
 * 
 * Also checks VS Code extension globalStorage:
 *   saoudrizwan.continue or continue.continue
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { calculateCost } from '../models.js';

function getContinueDirs() {
  return [
    join(homedir(), '.continue', 'sessions'),
    join(homedir(), '.continue', 'dev_data'),
  ];
}

/** @type {import('./types.js').Provider} */
export const continuedev = {
  name: 'continue',
  displayName: 'Continue.dev',

  modelDisplayName(model) {
    return model;
  },

  toolDisplayName(rawTool) {
    return rawTool;
  },

  async discoverSessions() {
    const sources = [];

    for (const dir of getContinueDirs()) {
      try {
        const entries = await readdir(dir);
        for (const entry of entries) {
          if (!entry.endsWith('.json') && !entry.endsWith('.jsonl')) continue;
          const full = join(dir, entry);
          const s = await stat(full).catch(() => null);
          if (s?.isFile()) {
            sources.push({ path: full, project: 'continue-session', provider: 'continue' });
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

        // Try JSON first, then JSONL
        let data;
        try {
          data = JSON.parse(content);
        } catch {
          const lines = content.split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              const call = parseContinueEntry(entry, source, seenKeys);
              if (call) yield call;
            } catch {}
          }
          return;
        }

        // Session JSON with history array
        const history = data.history || data.messages || (Array.isArray(data) ? data : []);
        for (const entry of history) {
          const call = parseContinueEntry(entry, source, seenKeys);
          if (call) yield call;
        }
      },
    };
  },
};

function parseContinueEntry(entry, source, seenKeys) {
  if (!entry) return null;
  const model = entry.model || entry.modelTitle || 'unknown';
  const promptTokens = entry.promptTokens || entry.prompt_tokens || 0;
  const completionTokens = entry.completionTokens || entry.completion_tokens || 0;
  const timestamp = entry.timestamp || entry.createdAt || '';

  if (promptTokens === 0 && completionTokens === 0) return null;

  const dedupKey = `continue:${source.path}:${timestamp}:${promptTokens}:${completionTokens}`;
  if (seenKeys.has(dedupKey)) return null;
  seenKeys.add(dedupKey);

  return {
    provider: 'continue',
    model,
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: calculateCost(model, promptTokens, completionTokens),
    tools: [],
    timestamp,
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage: entry.content || entry.message || '',
    sessionId: basename(source.path, '.json'),
  };
}
