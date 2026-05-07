/**
 * Zed Editor Provider
 *
 * Zed stores AI assistant conversation data in:
 *   macOS:   ~/Library/Application Support/Zed/conversations/
 *   Windows: %APPDATA%\Zed\conversations\
 *            %LOCALAPPDATA%\Zed\conversations\
 *   Linux:   ~/.config/zed/conversations/
 *            ~/.local/share/zed/conversations/
 *
 * Zed saves conversations as JSON files:
 *   { "id": "...", "messages": [
 *       { "id": "...", "role": "user"|"assistant", "content": [...],
 *         "model": {...}, "usage": { "input_tokens": N, "output_tokens": N } }
 *     ], "summary": "...", "updated_at": "..." }
 *
 * Alternatively, Zed may store an SQLite database.
 * This provider handles the JSON conversation format.
 *
 * Default model: claude-sonnet-4-5
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { calculateCost } from '../models.js';

const DEFAULT_MODEL = 'claude-sonnet-4-5';

function getZedDirs() {
  const dirs = [];
  const home = homedir();

  if (process.platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support', 'Zed');
    dirs.push(join(base, 'conversations'));
    dirs.push(join(base, 'db'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    dirs.push(join(appData, 'Zed', 'conversations'));
    dirs.push(join(appData, 'Zed', 'db'));
    dirs.push(join(localAppData, 'Zed', 'conversations'));
    dirs.push(join(localAppData, 'Zed', 'db'));
  } else {
    dirs.push(join(home, '.config', 'zed', 'conversations'));
    dirs.push(join(home, '.local', 'share', 'zed', 'conversations'));
  }

  return dirs;
}

/** @type {import('./types.js').Provider} */
export const zed = {
  name: 'zed',
  displayName: 'Zed',

  modelDisplayName(model) {
    return model;
  },

  toolDisplayName(rawTool) {
    return rawTool;
  },

  async discoverSessions() {
    const sources = [];

    for (const dir of getZedDirs()) {
      try {
        const s = await stat(dir).catch(() => null);
        if (!s?.isDirectory()) continue;

        const files = await readdir(dir, { recursive: true }).catch(() => []);
        for (const file of (Array.isArray(files) ? files : [])) {
          const name = typeof file === 'string' ? file : file.name;
          if (!name) continue;
          // Only pick up JSON conversation files (skip .db SQLite files for now)
          if (name.endsWith('.json') || name.endsWith('.jsonl')) {
            const fullPath = join(dir, name);
            sources.push({
              path: fullPath,
              project: basename(name, name.endsWith('.jsonl') ? '.jsonl' : '.json'),
              provider: 'zed',
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

        // Zed stores conversations as a single JSON object with a messages array
        let conversation;
        try {
          conversation = JSON.parse(content);
        } catch {
          // Fallback: try JSONL
          const lines = content.split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              yield* parseZedMessages([entry], source, seenKeys);
            } catch {}
          }
          return;
        }

        if (Array.isArray(conversation)) {
          yield* parseZedMessages(conversation, source, seenKeys);
        } else if (conversation && typeof conversation === 'object') {
          const messages = conversation.messages || conversation.turns || [];
          yield* parseZedMessages(messages, source, seenKeys, conversation);
        }
      },
    };
  },
};

function* parseZedMessages(messages, source, seenKeys, container) {
  if (!Array.isArray(messages)) return;

  let currentUserMessage = '';

  for (const msg of messages) {
    if (!msg) continue;

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        currentUserMessage = msg.content;
      } else if (Array.isArray(msg.content)) {
        currentUserMessage = msg.content
          .filter(b => b.type === 'text' || typeof b === 'string')
          .map(b => (typeof b === 'string' ? b : b.text || ''))
          .join(' ');
      }
      continue;
    }

    if (msg.role !== 'assistant') continue;

    const usage = msg.usage || {};
    const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
    const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;

    if (inputTokens === 0 && outputTokens === 0) continue;

    // Zed model can be in msg.model as object { name: "..." } or string
    let model = DEFAULT_MODEL;
    if (msg.model) {
      model = typeof msg.model === 'string' ? msg.model :
        (msg.model.model || msg.model.name || msg.model.id || DEFAULT_MODEL);
    } else if (container?.model) {
      model = typeof container.model === 'string' ? container.model :
        (container.model.model || container.model.name || DEFAULT_MODEL);
    }

    const timestamp = msg.created_at || msg.timestamp || container?.updated_at || new Date().toISOString();
    const msgId = msg.id || '';
    const dedupKey = msgId
      ? `zed:${msgId}`
      : `zed:${source.path}:${timestamp}:${inputTokens}:${outputTokens}`;

    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);

    // Extract tool calls
    const tools = [];
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') tools.push(block.name || '');
        if (block.type === 'tool_result' && block.tool_name) tools.push(block.tool_name);
      }
    }

    yield {
      provider: 'zed',
      model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: cacheWrite,
      cacheReadInputTokens: cacheRead,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD: calculateCost(model, inputTokens, outputTokens, cacheWrite, cacheRead),
      tools,
      timestamp,
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: currentUserMessage,
      sessionId: basename(source.path, '.json'),
    };

    currentUserMessage = '';
  }
}
