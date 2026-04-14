/**
 * Codex (OpenAI) Provider
 * 
 * Reads session transcripts from:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * 
 * Session format:
 *   - session_meta: Contains originator, model, session_id, cwd
 *   - response_item + function_call: Tool calls
 *   - response_item + message + role=user: User messages
 *   - event_msg + token_count: Token usage (per-call or cumulative)
 * 
 * Key normalization:
 *   OpenAI includes cached tokens inside input_tokens.
 *   We normalize to Anthropic semantics: inputTokens = non-cached only.
 * 
 * Deduplication by cumulative token total cross-check.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import { calculateCost } from '../models.js';

const MODEL_DISPLAY_NAMES = {
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5': 'GPT-5',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
  'o3-mini': 'o3-mini',
  'o3': 'o3',
};

const TOOL_NAME_MAP = {
  exec_command: 'Bash',
  read_file: 'Read',
  write_file: 'Edit',
  apply_diff: 'Edit',
  apply_patch: 'Edit',
  spawn_agent: 'Agent',
  close_agent: 'Agent',
  wait_agent: 'Agent',
  read_dir: 'Glob',
};

function getCodexDir() {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

function sanitizeProject(cwd) {
  return cwd.replace(/^\//, '').replace(/\//g, '-');
}

async function readFirstLine(filePath) {
  try {
    const content = await readFile(filePath, 'utf-8');
    const line = content.split('\n')[0];
    if (!line?.trim()) return null;
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function isValidCodexSession(filePath) {
  const entry = await readFirstLine(filePath);
  if (!entry) return { valid: false };
  const valid = entry.type === 'session_meta' &&
    typeof entry.payload?.originator === 'string' &&
    entry.payload.originator.startsWith('codex');
  return { valid, meta: valid ? entry : undefined };
}

/** @type {import('./types.js').Provider} */
export const codex = {
  name: 'codex',
  displayName: 'Codex',

  modelDisplayName(model) {
    for (const [key, name] of Object.entries(MODEL_DISPLAY_NAMES)) {
      if (model.startsWith(key)) return name;
    }
    return model;
  },

  toolDisplayName(rawTool) {
    return TOOL_NAME_MAP[rawTool] ?? rawTool;
  },

  async discoverSessions() {
    const sessionsDir = join(getCodexDir(), 'sessions');
    const sources = [];

    let years;
    try {
      years = await readdir(sessionsDir);
    } catch {
      return sources;
    }

    for (const year of years) {
      if (!/^\d{4}$/.test(year)) continue;
      const yearDir = join(sessionsDir, year);
      const months = await readdir(yearDir).catch(() => []);

      for (const month of months) {
        if (!/^\d{2}$/.test(month)) continue;
        const monthDir = join(yearDir, month);
        const days = await readdir(monthDir).catch(() => []);

        for (const day of days) {
          if (!/^\d{2}$/.test(day)) continue;
          const dayDir = join(monthDir, day);
          const files = await readdir(dayDir).catch(() => []);

          for (const file of files) {
            if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
            const filePath = join(dayDir, file);
            const s = await stat(filePath).catch(() => null);
            if (!s?.isFile()) continue;

            const { valid, meta } = await isValidCodexSession(filePath);
            if (!valid || !meta) continue;

            const cwd = meta.payload?.cwd ?? 'unknown';
            sources.push({ path: filePath, project: sanitizeProject(cwd), provider: 'codex' });
          }
        }
      }
    }

    return sources;
  },

  createSessionParser(source, seenKeys) {
    return {
      async *parse() {
        let content;
        try {
          content = await readFile(source.path, 'utf-8');
        } catch {
          return;
        }

        const lines = content.split('\n').filter(l => l.trim());
        let sessionModel;
        let sessionId = '';
        let prevCumulativeTotal = 0;
        let prevInput = 0;
        let prevCached = 0;
        let prevOutput = 0;
        let prevReasoning = 0;
        let pendingTools = [];
        let pendingUserMessage = '';

        for (const line of lines) {
          let entry;
          try {
            entry = JSON.parse(line);
          } catch { continue; }

          // Session metadata
          if (entry.type === 'session_meta') {
            sessionId = entry.payload?.session_id ?? basename(source.path, '.jsonl');
            sessionModel = entry.payload?.model;
            continue;
          }

          // Tool calls
          if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
            const rawName = entry.payload.name ?? '';
            pendingTools.push(TOOL_NAME_MAP[rawName] ?? rawName);
            continue;
          }

          // User messages
          if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'user') {
            const texts = (entry.payload.content ?? [])
              .filter(c => c.type === 'input_text')
              .map(c => c.text ?? '')
              .filter(Boolean);
            if (texts.length > 0) pendingUserMessage = texts.join(' ');
            continue;
          }

          // Token counts
          if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
            const info = entry.payload.info;
            if (!info) continue;

            const cumulativeTotal = info.total_token_usage?.total_tokens ?? 0;
            if (cumulativeTotal > 0 && cumulativeTotal === prevCumulativeTotal) continue;
            prevCumulativeTotal = cumulativeTotal;

            const last = info.last_token_usage;
            let inputTokens = 0;
            let cachedInputTokens = 0;
            let outputTokens = 0;
            let reasoningTokens = 0;

            if (last) {
              inputTokens = last.input_tokens ?? 0;
              cachedInputTokens = last.cached_input_tokens ?? 0;
              outputTokens = last.output_tokens ?? 0;
              reasoningTokens = last.reasoning_output_tokens ?? 0;
            } else if (cumulativeTotal > 0) {
              const total = info.total_token_usage;
              if (!total) continue;
              inputTokens = (total.input_tokens ?? 0) - prevInput;
              cachedInputTokens = (total.cached_input_tokens ?? 0) - prevCached;
              outputTokens = (total.output_tokens ?? 0) - prevOutput;
              reasoningTokens = (total.reasoning_output_tokens ?? 0) - prevReasoning;
            }

            if (!last) {
              const total = info.total_token_usage;
              if (total) {
                prevInput = total.input_tokens ?? 0;
                prevCached = total.cached_input_tokens ?? 0;
                prevOutput = total.output_tokens ?? 0;
                prevReasoning = total.reasoning_output_tokens ?? 0;
              }
            }

            const totalTokens = inputTokens + cachedInputTokens + outputTokens + reasoningTokens;
            if (totalTokens === 0) continue;

            // Normalize: OpenAI includes cached inside input; convert to Anthropic semantics
            const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);

            const model = info.model ?? info.model_name ?? sessionModel ?? 'gpt-5';
            const timestamp = entry.timestamp ?? '';
            const dedupKey = `codex:${source.path}:${timestamp}:${cumulativeTotal}`;

            if (seenKeys.has(dedupKey)) continue;
            seenKeys.add(dedupKey);

            const costUSD = calculateCost(
              model,
              uncachedInputTokens,
              outputTokens + reasoningTokens,
              0,
              cachedInputTokens,
              0,
            );

            yield {
              provider: 'codex',
              model,
              inputTokens: uncachedInputTokens,
              outputTokens,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: cachedInputTokens,
              cachedInputTokens,
              reasoningTokens,
              webSearchRequests: 0,
              costUSD,
              tools: pendingTools,
              timestamp,
              speed: 'standard',
              deduplicationKey: dedupKey,
              userMessage: pendingUserMessage,
              sessionId,
            };

            pendingTools = [];
            pendingUserMessage = '';
          }
        }
      },
    };
  },
};
