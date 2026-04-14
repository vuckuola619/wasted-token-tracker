/**
 * Cline (VS Code Extension) Provider
 * 
 * Cline stores task/session data in the VS Code extension's globalStorage:
 *   macOS:   ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/
 *   Windows: %APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/
 *   Linux:   ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/
 * 
 * Each task is stored as a directory with:
 *   - api_conversation_history.json — full conversation with token usage
 *   - ui_messages.json — UI state
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { calculateCost } from '../models.js';

function getClineDirs() {
  const dirs = [];
  const extensionId = 'saoudrizwan.claude-dev';

  if (process.platform === 'darwin') {
    dirs.push(join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', extensionId));
    dirs.push(join(homedir(), 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', extensionId));
    dirs.push(join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', extensionId));
  } else if (process.platform === 'win32') {
    dirs.push(join(homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', extensionId));
    dirs.push(join(homedir(), 'AppData', 'Roaming', 'Code - Insiders', 'User', 'globalStorage', extensionId));
    dirs.push(join(homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', extensionId));
  } else {
    dirs.push(join(homedir(), '.config', 'Code', 'User', 'globalStorage', extensionId));
    dirs.push(join(homedir(), '.config', 'Code - Insiders', 'User', 'globalStorage', extensionId));
  }

  return dirs;
}

/** @type {import('./types.js').Provider} */
export const cline = {
  name: 'cline',
  displayName: 'Cline',

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
    };
    return map[rawTool] ?? rawTool;
  },

  async discoverSessions() {
    const sources = [];

    for (const baseDir of getClineDirs()) {
      const tasksDir = join(baseDir, 'tasks');
      try {
        const taskIds = await readdir(tasksDir);
        for (const taskId of taskIds) {
          const taskDir = join(tasksDir, taskId);
          const s = await stat(taskDir).catch(() => null);
          if (!s?.isDirectory()) continue;

          const apiHistory = join(taskDir, 'api_conversation_history.json');
          const hs = await stat(apiHistory).catch(() => null);
          if (hs?.isFile()) {
            sources.push({ path: apiHistory, project: `cline-task-${taskId.slice(0, 8)}`, provider: 'cline' });
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
            if (typeof msg.content === 'string') currentUserMessage = msg.content;
            else if (Array.isArray(msg.content)) {
              currentUserMessage = msg.content
                .filter(b => b.type === 'text')
                .map(b => b.text || '')
                .join(' ');
            }
            continue;
          }

          if (msg.role !== 'assistant') continue;

          // Extract usage from Cline's API response metadata
          const usage = msg.usage || {};
          const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
          const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
          const model = msg.model || 'claude-sonnet-4';
          const timestamp = msg.ts || msg.timestamp || '';
          const cacheWrite = usage.cache_creation_input_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;

          if (inputTokens === 0 && outputTokens === 0) continue;

          const dedupKey = `cline:${source.path}:${timestamp}:${inputTokens}:${outputTokens}`;
          if (seenKeys.has(dedupKey)) continue;
          seenKeys.add(dedupKey);

          // Extract tools from content
          const tools = [];
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'tool_use') tools.push(block.name || '');
            }
          }

          yield {
            provider: 'cline',
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
