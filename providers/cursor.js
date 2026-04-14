/**
 * Cursor IDE Provider
 * 
 * Cursor stores conversation/session data in its config directory.
 * Locations:
 *   macOS:   ~/Library/Application Support/Cursor/User/globalStorage/
 *   Windows: %APPDATA%/Cursor/User/globalStorage/
 *   Linux:   ~/.config/Cursor/User/globalStorage/
 * 
 * Cursor also stores usage in SQLite databases.
 * We scan for known log files and usage databases.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { calculateCost } from '../models.js';

function getCursorDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Cursor');
  if (process.platform === 'win32') return join(homedir(), 'AppData', 'Roaming', 'Cursor');
  return join(homedir(), '.config', 'Cursor');
}

function getCursorStorageDirs() {
  const base = getCursorDir();
  return [
    join(base, 'User', 'globalStorage'),
    join(base, 'User', 'workspaceStorage'),
    join(base, 'logs'),
  ];
}

/** @type {import('./types.js').Provider} */
export const cursor = {
  name: 'cursor',
  displayName: 'Cursor',

  modelDisplayName(model) {
    const map = {
      'claude-3.5-sonnet': 'Sonnet 3.5',
      'claude-sonnet-4': 'Sonnet 4',
      'gpt-4o': 'GPT-4o',
      'gpt-4': 'GPT-4',
      'cursor-small': 'Cursor Small',
      'cursor-fast': 'Cursor Fast',
    };
    for (const [key, name] of Object.entries(map)) {
      if (model.includes(key)) return name;
    }
    return model;
  },

  toolDisplayName(rawTool) {
    const map = {
      code_edit: 'Edit',
      file_read: 'Read',
      terminal: 'Bash',
      search: 'Search',
      codebase_search: 'Search',
    };
    return map[rawTool] ?? rawTool;
  },

  async discoverSessions() {
    const sources = [];
    const dirs = getCursorStorageDirs();

    for (const dir of dirs) {
      try {
        const entries = await readdir(dir);
        for (const entry of entries) {
          const fullPath = join(dir, entry);
          const s = await stat(fullPath).catch(() => null);
          if (!s) continue;

          // Look for conversation logs (JSON/JSONL files)
          if (s.isFile() && (entry.endsWith('.json') || entry.endsWith('.jsonl'))) {
            sources.push({ path: fullPath, project: 'cursor-workspace', provider: 'cursor' });
          }

          // Look in subdirectories for workspace-specific data
          if (s.isDirectory()) {
            const subFiles = await readdir(fullPath).catch(() => []);
            for (const sf of subFiles) {
              if (sf.endsWith('.json') || sf.endsWith('.jsonl') || sf === 'usage.db') {
                sources.push({ path: join(fullPath, sf), project: entry, provider: 'cursor' });
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

        // Try to parse as JSON array of conversations
        let data;
        try {
          data = JSON.parse(content);
        } catch {
          // Try JSONL
          const lines = content.split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              const call = parseCursorEntry(entry, source, seenKeys);
              if (call) yield call;
            } catch {}
          }
          return;
        }

        // If it's an array, iterate
        if (Array.isArray(data)) {
          for (const entry of data) {
            const call = parseCursorEntry(entry, source, seenKeys);
            if (call) yield call;
          }
        } else if (data && typeof data === 'object') {
          const call = parseCursorEntry(data, source, seenKeys);
          if (call) yield call;
        }
      },
    };
  },
};

function parseCursorEntry(entry, source, seenKeys) {
  if (!entry) return null;

  // Cursor logs usage in various formats; attempt to extract token info
  const model = entry.model || entry.modelId || entry.model_id || 'cursor-unknown';
  const usage = entry.usage || entry.token_usage || {};
  const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
  const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
  const timestamp = entry.timestamp || entry.created_at || entry.createdAt || new Date().toISOString();

  if (inputTokens === 0 && outputTokens === 0) return null;

  const dedupKey = `cursor:${source.path}:${timestamp}:${inputTokens}:${outputTokens}`;
  if (seenKeys.has(dedupKey)) return null;
  seenKeys.add(dedupKey);

  const costUSD = calculateCost(model, inputTokens, outputTokens);

  return {
    provider: 'cursor',
    model,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: usage.cached_tokens || 0,
    reasoningTokens: usage.reasoning_tokens || 0,
    webSearchRequests: 0,
    costUSD,
    tools: entry.tools || [],
    timestamp,
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage: entry.prompt || entry.user_message || '',
    sessionId: entry.session_id || entry.sessionId || basename(source.path, '.json'),
  };
}
