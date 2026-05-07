/**
 * Amp (formerly Codegen) Provider
 *
 * Amp stores conversation history as JSON files:
 *   Windows: %APPDATA%\Amp\threads\  or  %LOCALAPPDATA%\Amp\threads\
 *   macOS:   ~/Library/Application Support/Amp/threads/
 *            ~/.local/share/amp/threads/  (older versions)
 *   Linux:   ~/.local/share/amp/threads/
 *            ~/.amp/threads/
 *
 * Each thread file is a JSON array of message objects:
 *   [{ "role": "user"|"assistant", "content": "...",
 *      "usage": { "input_tokens": N, "output_tokens": N },
 *      "model": "claude-sonnet-4-5", "timestamp": "..." }]
 *
 * Default model: claude-sonnet-4-5
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { calculateCost } from '../models.js';

const DEFAULT_MODEL = 'claude-sonnet-4-5';

function getAmpDirs() {
  const dirs = [];
  const home = homedir();

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    dirs.push(join(appData, 'Amp', 'threads'));
    dirs.push(join(appData, 'Amp', 'conversations'));
    dirs.push(join(localAppData, 'Amp', 'threads'));
    dirs.push(join(localAppData, 'Amp', 'conversations'));
    dirs.push(join(home, '.amp', 'threads'));
  } else if (process.platform === 'darwin') {
    dirs.push(join(home, 'Library', 'Application Support', 'Amp', 'threads'));
    dirs.push(join(home, '.local', 'share', 'amp', 'threads'));
    dirs.push(join(home, '.amp', 'threads'));
  } else {
    dirs.push(join(home, '.local', 'share', 'amp', 'threads'));
    dirs.push(join(home, '.amp', 'threads'));
  }

  return dirs;
}

/** @type {import('./types.js').Provider} */
export const amp = {
  name: 'amp',
  displayName: 'Amp',

  modelDisplayName(model) {
    return model;
  },

  toolDisplayName(rawTool) {
    return rawTool;
  },

  async discoverSessions() {
    const sources = [];

    for (const dir of getAmpDirs()) {
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
              provider: 'amp',
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

        // Try parsing as a single JSON array (Amp's thread format)
        let messages;
        try {
          messages = JSON.parse(content);
        } catch {
          // Fall back to JSONL
          messages = content.split('\n').filter(l => l.trim()).map(line => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);
        }

        if (!Array.isArray(messages)) messages = [messages].filter(Boolean);

        let currentUserMessage = '';

        for (const msg of messages) {
          if (!msg) continue;

          // Handle nested message arrays (e.g., thread wrapper)
          const items = Array.isArray(msg.messages) ? msg.messages :
            Array.isArray(msg.turns) ? msg.turns : [msg];

          for (const item of items) {
            if (item.role === 'user') {
              if (typeof item.content === 'string') {
                currentUserMessage = item.content;
              } else if (Array.isArray(item.content)) {
                currentUserMessage = item.content
                  .filter(b => b.type === 'text')
                  .map(b => b.text || '')
                  .join(' ');
              }
              continue;
            }

            if (item.role !== 'assistant') continue;

            const usage = item.usage || item.token_usage || item.tokens || {};
            const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
            const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
            const cacheCreation = usage.cache_creation_input_tokens || 0;
            const cacheRead = usage.cache_read_input_tokens || 0;

            if (inputTokens === 0 && outputTokens === 0) continue;

            const model = item.model || msg.model || DEFAULT_MODEL;
            const timestamp = item.timestamp || item.created_at || msg.created_at || new Date().toISOString();

            const dedupKey = `amp:${source.path}:${timestamp}:${inputTokens}:${outputTokens}`;
            if (seenKeys.has(dedupKey)) continue;
            seenKeys.add(dedupKey);

            const costUSD = item.cost || calculateCost(model, inputTokens, outputTokens, cacheCreation, cacheRead);

            // Extract tool calls
            const tools = [];
            if (Array.isArray(item.content)) {
              for (const block of item.content) {
                if (block.type === 'tool_use') tools.push(block.name || block.tool || '');
              }
            }
            if (Array.isArray(item.tool_calls)) {
              for (const tc of item.tool_calls) {
                tools.push(tc.function?.name || tc.name || '');
              }
            }

            yield {
              provider: 'amp',
              model,
              inputTokens,
              outputTokens,
              cacheCreationInputTokens: cacheCreation,
              cacheReadInputTokens: cacheRead,
              cachedInputTokens: usage.cached_tokens || 0,
              reasoningTokens: usage.reasoning_tokens || 0,
              webSearchRequests: 0,
              costUSD,
              tools,
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
