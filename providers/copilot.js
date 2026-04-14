/**
 * GitHub Copilot Provider
 * 
 * GitHub Copilot stores telemetry and conversation data in:
 *   VS Code extension:
 *     macOS:   ~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/
 *     Windows: %APPDATA%/Code/User/globalStorage/github.copilot-chat/
 *     Linux:   ~/.config/Code/User/globalStorage/github.copilot-chat/
 * 
 * Copilot Chat stores conversations in IndexedDB or JSON files.
 * Note: Copilot does not expose per-token usage to end users,
 * so this provider tracks conversation volume and estimates costs.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { calculateCost } from '../models.js';

function getCopilotDirs() {
  const extensionId = 'github.copilot-chat';
  const dirs = [];

  if (process.platform === 'darwin') {
    dirs.push(join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', extensionId));
  } else if (process.platform === 'win32') {
    dirs.push(join(homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', extensionId));
  } else {
    dirs.push(join(homedir(), '.config', 'Code', 'User', 'globalStorage', extensionId));
  }

  return dirs;
}

/** @type {import('./types.js').Provider} */
export const copilot = {
  name: 'copilot',
  displayName: 'GitHub Copilot',

  modelDisplayName(model) {
    const map = {
      'gpt-4o': 'GPT-4o',
      'gpt-4': 'GPT-4',
      'claude-sonnet': 'Sonnet',
      'gemini': 'Gemini',
      'o3-mini': 'o3-mini',
      'o4-mini': 'o4-mini',
    };
    for (const [key, name] of Object.entries(map)) {
      if (model.includes(key)) return name;
    }
    return model;
  },

  toolDisplayName(rawTool) {
    return rawTool;
  },

  async discoverSessions() {
    const sources = [];

    for (const dir of getCopilotDirs()) {
      try {
        const entries = await readdir(dir);
        for (const entry of entries) {
          const full = join(dir, entry);
          const s = await stat(full).catch(() => null);
          if (!s) continue;
          if (s.isFile() && (entry.endsWith('.json') || entry.endsWith('.jsonl'))) {
            sources.push({ path: full, project: 'copilot-chat', provider: 'copilot' });
          }
          if (s.isDirectory()) {
            const subFiles = await readdir(full).catch(() => []);
            for (const sf of subFiles) {
              if (sf.endsWith('.json') || sf.endsWith('.jsonl')) {
                sources.push({ path: join(full, sf), project: entry, provider: 'copilot' });
              }
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

        let data;
        try {
          data = JSON.parse(content);
        } catch {
          // Try JSONL
          const lines = content.split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              const call = parseCopilotEntry(entry, source, seenKeys);
              if (call) yield call;
            } catch {}
          }
          return;
        }

        const items = Array.isArray(data) ? data : [data];
        for (const entry of items) {
          const call = parseCopilotEntry(entry, source, seenKeys);
          if (call) yield call;
        }
      },
    };
  },
};

function parseCopilotEntry(entry, source, seenKeys) {
  if (!entry) return null;
  const model = entry.model || entry.engine || 'gpt-4o';
  const usage = entry.usage || {};
  const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
  const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
  const timestamp = entry.timestamp || entry.createdAt || '';

  if (inputTokens === 0 && outputTokens === 0) return null;

  const dedupKey = `copilot:${source.path}:${timestamp}:${inputTokens}:${outputTokens}`;
  if (seenKeys.has(dedupKey)) return null;
  seenKeys.add(dedupKey);

  return {
    provider: 'copilot',
    model,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: calculateCost(model, inputTokens, outputTokens),
    tools: [],
    timestamp,
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage: entry.prompt || '',
    sessionId: basename(source.path, '.json'),
  };
}
