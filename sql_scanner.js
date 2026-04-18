/**
 * Zero-dependency heuristic string/JSON scanner for SQLite files.
 *
 * Since AG-Code Token strictly prohibits `better-sqlite3` and other compiled native dependencies,
 * we use byte-scanning heuristics to extract usage data from .db files (e.g. OpenCode, Hermes).
 * SQLite databases usually store strings uncompressed in pages, making them extractable.
 *
 * Security hardening (v2.0):
 *   - File size limit (50 MB) prevents OOM on large databases
 *   - Bounded regex quantifiers prevent catastrophic backtracking (ReDoS)
 *   - Iteration caps prevent CPU exhaustion on crafted binary content
 */

import { readFile, stat } from 'fs/promises';

const MAX_DB_SIZE = 50 * 1024 * 1024;    // 50 MB — reject files larger than this
const MAX_REGEX_ITERATIONS = 10_000;      // cap regex exec loop iterations

/**
 * Scans a binary file (like .db) for JSON-like strings containing usage/token stats.
 * Useful for grabbing JSON objects directly out of the binary pages.
 *
 * @param {string} filePath - Path to the file.
 * @returns {Promise<any[]>} - Array of parsed JSON objects.
 */
export async function scrapeJSONFromSQLite(filePath) {
  try {
    // Guard: check file size before reading to prevent OOM
    const fileStats = await stat(filePath);
    if (fileStats.size > MAX_DB_SIZE) {
      console.warn(`[sql_scanner] Skipping ${filePath}: file too large (${(fileStats.size / 1024 / 1024).toFixed(1)} MB)`);
      return [];
    }

    const buffer = await readFile(filePath);
    const content = buffer.toString('latin1'); // Preserve bytes while giving string methods

    // Bounded regex — {0,2000} prevents catastrophic backtracking on crafted input.
    // Single-quote variant removed since JSON strictly uses double quotes.
    const jsonPattern = /\{[^{}]{0,2000}?"(?:model|input_tokens|prompt_tokens|tokens|usage)"[^{}]{0,2000}?\}/gi;

    const results = [];
    let match;
    let iterations = 0;
    while ((match = jsonPattern.exec(content)) !== null) {
      if (++iterations > MAX_REGEX_ITERATIONS) {
        console.warn(`[sql_scanner] Hit iteration cap (${MAX_REGEX_ITERATIONS}) on ${filePath}`);
        break;
      }
      try {
        const text = match[0].replace(/[\u0000-\u001F\u007F-\u009F]/g, ''); // Strip control chars from DB
        const obj = JSON.parse(text);
        results.push(obj);
      } catch {
        // Not valid JSON or partial match, ignore
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Scrape OpenCode-specific patterns from binary db lines.
 * OpenCode might store it as fields instead of pure JSON.
 * @param {string} filePath
 */
export async function scrapeOpenCodeRecords(filePath) {
  try {
    // Guard: check file size before reading
    const fileStats = await stat(filePath);
    if (fileStats.size > MAX_DB_SIZE) {
      console.warn(`[sql_scanner] Skipping ${filePath}: file too large (${(fileStats.size / 1024 / 1024).toFixed(1)} MB)`);
      return [];
    }

    const buffer = await readFile(filePath);
    const content = buffer.toString('latin1');
    const records = [];

    // Bounded model name pattern — {1,40} limits model name length
    const modelPattern = /(claude-[a-z0-9.-]{1,40}|gpt-[a-z0-9.-]{1,40}|gemini-[a-z0-9.-]{1,40})/gi;

    let match;
    let iterations = 0;
    while ((match = modelPattern.exec(content)) !== null) {
      if (++iterations > MAX_REGEX_ITERATIONS) {
        console.warn(`[sql_scanner] Hit iteration cap (${MAX_REGEX_ITERATIONS}) on ${filePath}`);
        break;
      }

      const model = match[1];
      const index = match.index;
      // Look at nearby 150 bytes for input/output tokens
      const nearby = content.slice(index, index + 150).replace(/[^a-zA-Z0-9_{}.":]+/g, ' ');

      const promptMatch = /prompt(?:_tokens)?\s*[:=]?\s*(\d+)/i.exec(nearby);
      const completionMatch = /(?:completion|output)(?:_tokens)?\s*[:=]?\s*(\d+)/i.exec(nearby);

      if (promptMatch || completionMatch) {
        records.push({
          model,
          promptTokens: parseInt(promptMatch?.[1] || '0', 10),
          completionTokens: parseInt(completionMatch?.[1] || '0', 10),
        });
      }
    }
    return records;
  } catch {
    return [];
  }
}
