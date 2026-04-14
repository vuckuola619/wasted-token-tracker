/**
 * Claude Code Provider
 * 
 * Reads session transcripts from:
 *   - ~/.claude/projects/<sanitized-path>/<session-id>.jsonl  (CLI)
 *   - ~/Library/Application Support/Claude/local-agent-mode-sessions/  (Desktop, macOS)
 *   - ~/AppData/Roaming/Claude/local-agent-mode-sessions/  (Desktop, Windows)
 * 
 * Each JSONL line is a JournalEntry with type 'user' or 'assistant'.
 * Assistant entries contain model, token usage, tool_use blocks, and timestamps.
 * Deduplication by API message ID.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { calculateCost } from '../models.js';

const SHORT_NAMES = {
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-5': 'Opus 4.5',
  'claude-opus-4-1': 'Opus 4.1',
  'claude-opus-4': 'Opus 4',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4': 'Sonnet 4',
  'claude-3-7-sonnet': 'Sonnet 3.7',
  'claude-3-5-sonnet': 'Sonnet 3.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-3-5-haiku': 'Haiku 3.5',
};

function getClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function getProjectsDir() {
  return join(getClaudeDir(), 'projects');
}

function getDesktopSessionsDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
  if (process.platform === 'win32') return join(homedir(), 'AppData', 'Roaming', 'Claude', 'local-agent-mode-sessions');
  return join(homedir(), '.config', 'Claude', 'local-agent-mode-sessions');
}

async function findDesktopProjectDirs(base) {
  const results = [];
  async function walk(dir, depth) {
    if (depth > 8) return;
    const entries = await readdir(dir).catch(() => []);
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git') continue;
      const full = join(dir, entry);
      const s = await stat(full).catch(() => null);
      if (!s?.isDirectory()) continue;
      if (entry === 'projects') {
        const projectDirs = await readdir(full).catch(() => []);
        for (const pd of projectDirs) {
          const pdFull = join(full, pd);
          const pdStat = await stat(pdFull).catch(() => null);
          if (pdStat?.isDirectory()) results.push(pdFull);
        }
      } else {
        await walk(full, depth + 1);
      }
    }
  }
  await walk(base, 0);
  return results;
}

function extractToolNames(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b.type === 'tool_use')
    .map(b => b.name);
}

function getUserMessageText(entry) {
  if (!entry.message || entry.message.role !== 'user') return '';
  const content = entry.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join(' ');
  }
  return '';
}

/** @type {import('./types.js').Provider} */
export const claude = {
  name: 'claude',
  displayName: 'Claude Code',

  modelDisplayName(model) {
    const canonical = model.replace(/@.*$/, '').replace(/-\d{8}$/, '');
    for (const [key, name] of Object.entries(SHORT_NAMES)) {
      if (canonical.startsWith(key)) return name;
    }
    return canonical;
  },

  toolDisplayName(rawTool) {
    return rawTool;
  },

  async discoverSessions() {
    const sources = [];

    // CLI sessions
    const projectsDir = getProjectsDir();
    try {
      const entries = await readdir(projectsDir);
      for (const dirName of entries) {
        const dirPath = join(projectsDir, dirName);
        const dirStat = await stat(dirPath).catch(() => null);
        if (dirStat?.isDirectory()) {
          sources.push({ path: dirPath, project: dirName, provider: 'claude' });
        }
      }
    } catch {}

    // Desktop sessions
    const desktopDirs = await findDesktopProjectDirs(getDesktopSessionsDir());
    for (const dirPath of desktopDirs) {
      sources.push({ path: dirPath, project: basename(dirPath), provider: 'claude' });
    }

    return sources;
  },

  createSessionParser(source, seenKeys) {
    return {
      async *parse() {
        // Collect all .jsonl files from this source directory
        let files;
        try {
          const allEntries = await readdir(source.path);
          files = allEntries.filter(f => f.endsWith('.jsonl'));
        } catch {
          return;
        }

        for (const file of files) {
          const filePath = join(source.path, file);
          let content;
          try {
            content = await readFile(filePath, 'utf-8');
          } catch { continue; }

          const lines = content.split('\n').filter(l => l.trim());
          let currentUserMessage = '';

          for (const line of lines) {
            let entry;
            try {
              entry = JSON.parse(line);
            } catch { continue; }

            // Track user messages
            if (entry.type === 'user') {
              const text = getUserMessageText(entry);
              if (text.trim()) currentUserMessage = text;
              continue;
            }

            // Process assistant entries
            if (entry.type !== 'assistant') continue;
            const msg = entry.message;
            if (!msg?.usage || !msg?.model) continue;

            // Deduplication by message ID
            const msgId = msg.id;
            if (msgId && seenKeys.has(msgId)) continue;
            if (msgId) seenKeys.add(msgId);

            const usage = msg.usage;
            const inputTokens = usage.input_tokens ?? 0;
            const outputTokens = usage.output_tokens ?? 0;
            const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
            const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
            const webSearchRequests = usage.server_tool_use?.web_search_requests ?? 0;
            const speed = usage.speed ?? 'standard';

            const tools = extractToolNames(msg.content ?? []);
            const costUSD = calculateCost(
              msg.model,
              inputTokens,
              outputTokens,
              cacheCreationInputTokens,
              cacheReadInputTokens,
              webSearchRequests,
              speed,
            );

            const sessionId = basename(file, '.jsonl');
            const dedupKey = msgId || `claude:${entry.timestamp}:${sessionId}`;

            yield {
              provider: 'claude',
              model: msg.model,
              inputTokens,
              outputTokens,
              cacheCreationInputTokens,
              cacheReadInputTokens,
              cachedInputTokens: 0,
              reasoningTokens: 0,
              webSearchRequests,
              costUSD,
              tools,
              timestamp: entry.timestamp ?? '',
              speed,
              deduplicationKey: dedupKey,
              userMessage: currentUserMessage,
              sessionId,
            };

            currentUserMessage = '';
          }
        }

        // Also check subagents directories
        try {
          const entries = await readdir(source.path);
          for (const entry of entries) {
            const subagentsPath = join(source.path, entry, 'subagents');
            const subFiles = await readdir(subagentsPath).catch(() => []);
            for (const sf of subFiles) {
              if (!sf.endsWith('.jsonl')) continue;
              const filePath = join(subagentsPath, sf);
              let content;
              try {
                content = await readFile(filePath, 'utf-8');
              } catch { continue; }

              const lines = content.split('\n').filter(l => l.trim());
              let currentUserMessage2 = '';

              for (const line of lines) {
                let entry2;
                try { entry2 = JSON.parse(line); } catch { continue; }
                if (entry2.type === 'user') {
                  const text = getUserMessageText(entry2);
                  if (text.trim()) currentUserMessage2 = text;
                  continue;
                }
                if (entry2.type !== 'assistant') continue;
                const msg = entry2.message;
                if (!msg?.usage || !msg?.model) continue;
                const msgId = msg.id;
                if (msgId && seenKeys.has(msgId)) continue;
                if (msgId) seenKeys.add(msgId);

                const usage = msg.usage;
                const tools = extractToolNames(msg.content ?? []);
                const costUSD = calculateCost(
                  msg.model,
                  usage.input_tokens ?? 0,
                  usage.output_tokens ?? 0,
                  usage.cache_creation_input_tokens ?? 0,
                  usage.cache_read_input_tokens ?? 0,
                  usage.server_tool_use?.web_search_requests ?? 0,
                  usage.speed ?? 'standard',
                );
                yield {
                  provider: 'claude',
                  model: msg.model,
                  inputTokens: usage.input_tokens ?? 0,
                  outputTokens: usage.output_tokens ?? 0,
                  cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
                  cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
                  cachedInputTokens: 0,
                  reasoningTokens: 0,
                  webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
                  costUSD,
                  tools,
                  timestamp: entry2.timestamp ?? '',
                  speed: usage.speed ?? 'standard',
                  deduplicationKey: msgId || `claude:${entry2.timestamp}:${basename(sf, '.jsonl')}`,
                  userMessage: currentUserMessage2,
                  sessionId: basename(sf, '.jsonl'),
                };
                currentUserMessage2 = '';
              }
            }
          }
        } catch {}
      },
    };
  },
};
