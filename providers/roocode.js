/**
 * Roo Code (Roo-Cline) VS Code Extension Provider
 *
 * Roo Code stores task/session data in the VS Code extension's globalStorage:
 *   macOS:   ~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/
 *   Windows: %APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\tasks\
 *   Linux:   ~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks/
 *
 * Also checks Cursor and VS Code Insiders.
 *
 * Each task directory contains:
 *   - api_conversation_history.json — full conversation with token usage
 *   - ui_messages.json — UI state (not parsed)
 *
 * Data format matches Cline's format:
 *   [{ "role": "user"|"assistant", "content": [...],
 *      "usage": { "input_tokens": N, "output_tokens": N,
 *                 "cache_creation_input_tokens": N, "cache_read_input_tokens": N },
 *      "model": "...", "ts": 1234567890 }]
 *
 * Default model: claude-sonnet-4-5
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { calculateCost } from '../models.js';

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const EXTENSION_ID = 'rooveterinaryinc.roo-cline';

function getRooCodeDirs() {
  const dirs = [];
  const home = homedir();

  if (process.platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support');
    dirs.push(join(base, 'Code', 'User', 'globalStorage', EXTENSION_ID, 'tasks'));
    dirs.push(join(base, 'Code - Insiders', 'User', 'globalStorage', EXTENSION_ID, 'tasks'));
    dirs.push(join(base, 'Cursor', 'User', 'globalStorage', EXTENSION_ID, 'tasks'));
    dirs.push(join(base, 'Windsurf', 'User', 'globalStorage', EXTENSION_ID, 'tasks'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    dirs.push(join(appData, 'Code', 'User', 'globalStorage', EXTENSION_ID, 'tasks'));
    dirs.push(join(appData, 'Code - Insiders', 'User', 'globalStorage', EXTENSION_ID, 'tasks'));
    dirs.push(join(appData, 'Cursor', 'User', 'globalStorage', EXTENSION_ID, 'tasks'));
    dirs.push(join(appData, 'Windsurf', 'User', 'globalStorage', EXTENSION_ID, 'tasks'));
  } else {
    const configBase = join(home, '.config');
    dirs.push(join(configBase, 'Code', 'User', 'globalStorage', EXTENSION_ID, 'tasks'));
    dirs.push(join(configBase, 'Code - Insiders', 'User', 'globalStorage', EXTENSION_ID, 'tasks'));
    dirs.push(join(configBase, 'Cursor', 'User', 'globalStorage', EXTENSION_ID, 'tasks'));
  }

  return dirs;
}

/** @type {import('./types.js').Provider} */
export const rooCode = {
  name: 'roocode',
  displayName: 'Roo Code',

  modelDisplayName(model) {
    return model;
  },

  toolDisplayName(rawTool) {
    const map = {
      write_to_file: 'Edit',
      read_file: 'Read',
      execute_command: 'Bash',
      search_files: 'Search',
      list_files: 'Glob',
      ask_followup_question: 'Ask',
      attempt_completion: 'Complete',
      replace_in_file: 'Edit',
      apply_diff: 'Edit',
      insert_content: 'Edit',
    };
    return map[rawTool] ?? rawTool;
  },

  async discoverSessions() {
    const sources = [];

    for (const tasksDir of getRooCodeDirs()) {
      try {
        const s = await stat(tasksDir).catch(() => null);
        if (!s?.isDirectory()) continue;

        const taskIds = await readdir(tasksDir).catch(() => []);
        for (const taskId of taskIds) {
          const taskDir = join(tasksDir, taskId);
          const ds = await stat(taskDir).catch(() => null);
          if (!ds?.isDirectory()) continue;

          const apiHistory = join(taskDir, 'api_conversation_history.json');
          const hs = await stat(apiHistory).catch(() => null);
          if (hs?.isFile()) {
            sources.push({
              path: apiHistory,
              project: `roo-task-${taskId.slice(0, 8)}`,
              provider: 'roocode',
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

        let messages;
        try {
          messages = JSON.parse(content);
        } catch { return; }

        if (!Array.isArray(messages)) return;

        let currentUserMessage = '';

        for (const msg of messages) {
          if (msg.role === 'user') {
            if (typeof msg.content === 'string') {
              currentUserMessage = msg.content;
            } else if (Array.isArray(msg.content)) {
              currentUserMessage = msg.content
                .filter(b => b.type === 'text')
                .map(b => b.text || '')
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

          const model = msg.model || DEFAULT_MODEL;
          // Roo Code stores ts as Unix milliseconds
          const tsRaw = msg.ts || msg.timestamp || '';
          const timestamp = tsRaw
            ? (typeof tsRaw === 'number' ? new Date(tsRaw).toISOString() : String(tsRaw))
            : new Date().toISOString();

          const dedupKey = `roocode:${source.path}:${tsRaw || timestamp}:${inputTokens}:${outputTokens}`;
          if (seenKeys.has(dedupKey)) continue;
          seenKeys.add(dedupKey);

          // Extract tool use blocks
          const tools = [];
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'tool_use') tools.push(block.name || '');
            }
          }

          yield {
            provider: 'roocode',
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: cacheWrite,
            cacheReadInputTokens: cacheRead,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD: msg.cost || calculateCost(model, inputTokens, outputTokens, cacheWrite, cacheRead),
            tools,
            timestamp,
            speed: 'standard',
            deduplicationKey: dedupKey,
            userMessage: currentUserMessage,
            sessionId: basename(source.path, '.json'),
          };

          currentUserMessage = '';
        }
      },
    };
  },
};
