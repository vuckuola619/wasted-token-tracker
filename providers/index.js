/**
 * Universal Provider Registry
 *
 * Central registry for ALL supported AI coding IDEs and tools.
 *
 * Supported providers:
 *   - Antigravity (Google DeepMind) — What we're using right now!
 *   - Claude Code (Anthropic CLI)
 *   - Codex (OpenAI CLI)
 *   - Cursor IDE
 *   - Windsurf (Codeium)
 *   - Cline (VS Code extension)
 *   - Continue.dev
 *   - GitHub Copilot
 *   - Aider
 *   - Gemini CLI (@google/gemini-cli)
 *   - Amp (formerly Codegen)
 *   - Roo Code (Roo-Cline VS Code extension)
 *   - Zed Editor
 *
 * To add a new provider:
 *   1. Create providers/yourprovider.js implementing the Provider interface
 *   2. Import and add it to the providers array below
 */

import { antigravity } from './antigravity.js';
import { claude } from './claude.js';
import { codex } from './codex.js';
import { cursor } from './cursor.js';
import { windsurf } from './windsurf.js';
import { cline } from './cline.js';
import { continuedev } from './continuedev.js';
import { copilot } from './copilot.js';
import { aider } from './aider.js';
import { geminiCli } from './geminicli.js';
import { amp } from './amp.js';
import { rooCode } from './roocode.js';
import { zed } from './zed.js';
import { extendedProviders } from './extended.js';
import { sqliteProviders } from './sqlite_providers.js';

/** All registered providers — order matters for display priority */
export const providers = [
  antigravity,  // Google DeepMind IDE
  claude,       // Anthropic Claude Code CLI
  codex,        // OpenAI Codex CLI
  cursor,       // Cursor IDE
  windsurf,     // Windsurf (Codeium)
  cline,        // Cline VS Code extension
  copilot,      // GitHub Copilot
  continuedev,  // Continue.dev
  aider,        // Aider CLI
  geminiCli,    // Google Gemini CLI (@google/gemini-cli)
  amp,          // Amp (formerly Codegen)
  rooCode,      // Roo Code (Roo-Cline VS Code extension)
  zed,          // Zed Editor
  ...sqliteProviders,   // OpenCode, Hermes, etc (SQLite heuristics)
  ...extendedProviders, // Factory Droid, Pi, Kimi, Qwen, Kilo, Mux, Crush (JSON long-tail)
];

/**
 * Discover sessions from all (or filtered) providers
 * @param {string} [providerFilter] - 'all', 'antigravity', 'claude', 'codex', etc.
 * @returns {Promise<import('./types.js').SessionSource[]>}
 */
export async function discoverAllSessions(providerFilter) {
  const filtered = providerFilter && providerFilter !== 'all'
    ? providers.filter(p => p.name === providerFilter)
    : providers;

  const all = [];
  for (const provider of filtered) {
    try {
      const sessions = await provider.discoverSessions();
      all.push(...sessions);
    } catch (err) {
      // Silently skip providers that fail (e.g., tool not installed)
    }
  }
  return all;
}

/**
 * Get a provider by name
 */
export function getProvider(name) {
  return providers.find(p => p.name === name);
}

/**
 * Get list of available provider names
 */
export function getProviderNames() {
  return providers.map(p => ({ name: p.name, displayName: p.displayName }));
}

/**
 * Discover which providers actually have data on this machine
 */
export async function getActiveProviders() {
  const active = [];
  for (const provider of providers) {
    try {
      const sessions = await provider.discoverSessions();
      if (sessions.length > 0) {
        active.push({
          name: provider.name,
          displayName: provider.displayName,
          sessionCount: sessions.length,
        });
      }
    } catch {}
  }
  return active;
}

/**
 * Get filesystem paths to watch for real-time session updates.
 * Each provider can expose its session directories for fs.watch().
 */
export async function getProviderWatchPaths() {
  const results = [];
  for (const provider of providers) {
    try {
      const sessions = await provider.discoverSessions();
      if (sessions.length > 0) {
        // Collect unique parent directories from session paths
        const dirs = new Set();
        for (const session of sessions) {
          if (session.path) {
            // Watch the parent directory of each session
            const { dirname } = await import('path');
            const dir = dirname(session.path);
            dirs.add(dir);
          }
        }
        if (dirs.size > 0) {
          results.push({
            provider: provider.name,
            paths: [...dirs].slice(0, 5), // Limit to 5 dirs per provider
          });
        }
      }
    } catch {}
  }
  return results;
}
