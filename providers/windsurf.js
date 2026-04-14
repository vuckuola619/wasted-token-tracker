/**
 * Windsurf (Codeium) Provider
 * 
 * Windsurf (formerly Codeium) stores session data in:
 *   macOS:   ~/Library/Application Support/Windsurf/
 *   Windows: %APPDATA%/Windsurf/
 *   Linux:   ~/.config/Windsurf/
 * 
 * Also checks legacy Codeium paths:
 *   ~/.codeium/
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { calculateCost } from '../models.js';

function getWindsurfDirs() {
  const dirs = [];
  if (process.platform === 'darwin') {
    dirs.push(join(homedir(), 'Library', 'Application Support', 'Windsurf'));
  } else if (process.platform === 'win32') {
    dirs.push(join(homedir(), 'AppData', 'Roaming', 'Windsurf'));
  } else {
    dirs.push(join(homedir(), '.config', 'Windsurf'));
  }
  dirs.push(join(homedir(), '.codeium'));
  dirs.push(join(homedir(), '.windsurf'));
  return dirs;
}

/** @type {import('./types.js').Provider} */
export const windsurf = {
  name: 'windsurf',
  displayName: 'Windsurf',

  modelDisplayName(model) {
    const map = {
      'claude-3.5-sonnet': 'Sonnet 3.5',
      'claude-sonnet-4': 'Sonnet 4',
      'gpt-4o': 'GPT-4o',
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
    };
    for (const [key, name] of Object.entries(map)) {
      if (model.includes(key)) return name;
    }
    return model;
  },

  toolDisplayName(rawTool) {
    const map = {
      write_to_file: 'Edit',
      read_from_file: 'Read',
      run_command: 'Bash',
      search_files: 'Search',
    };
    return map[rawTool] ?? rawTool;
  },

  async discoverSessions() {
    const sources = [];
    const dirs = getWindsurfDirs();

    for (const dir of dirs) {
      try {
        await scanDirForSessions(dir, sources, 0);
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

        // Try JSONL first
        const lines = content.split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const call = parseWindsurfEntry(entry, source, seenKeys);
            if (call) yield call;
          } catch {}
        }
      },
    };
  },
};

async function scanDirForSessions(dir, sources, depth) {
  if (depth > 5) return;
  const entries = await readdir(dir).catch(() => []);
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (s.isFile() && (entry.endsWith('.jsonl') || entry.endsWith('.json'))) {
      sources.push({ path: full, project: basename(dir), provider: 'windsurf' });
    } else if (s.isDirectory()) {
      await scanDirForSessions(full, sources, depth + 1);
    }
  }
}

function parseWindsurfEntry(entry, source, seenKeys) {
  if (!entry) return null;
  const model = entry.model || entry.modelId || 'windsurf-unknown';
  const usage = entry.usage || entry.tokenUsage || {};
  const inputTokens = usage.prompt_tokens || usage.input_tokens || usage.promptTokens || 0;
  const outputTokens = usage.completion_tokens || usage.output_tokens || usage.completionTokens || 0;
  const timestamp = entry.timestamp || entry.createdAt || new Date().toISOString();

  if (inputTokens === 0 && outputTokens === 0) return null;

  const dedupKey = `windsurf:${source.path}:${timestamp}:${inputTokens}:${outputTokens}`;
  if (seenKeys.has(dedupKey)) return null;
  seenKeys.add(dedupKey);

  return {
    provider: 'windsurf',
    model,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: calculateCost(model, inputTokens, outputTokens),
    tools: entry.tools || [],
    timestamp,
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage: entry.prompt || entry.userMessage || '',
    sessionId: entry.sessionId || basename(source.path, '.jsonl'),
  };
}
