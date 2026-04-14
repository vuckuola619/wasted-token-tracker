/**
 * Universal Provider Interface Types
 * 
 * Every AI coding tool provider implements these contracts.
 * This is the core extensibility mechanism — adding a new tool
 * means implementing one file that satisfies the Provider shape.
 */

/**
 * @typedef {Object} SessionSource
 * @property {string} path - Filesystem path to session file/directory
 * @property {string} project - Project identifier (sanitized path)
 * @property {string} provider - Provider name ('claude', 'codex', etc.)
 */

/**
 * @typedef {Object} ParsedProviderCall
 * @property {string} provider
 * @property {string} model
 * @property {number} inputTokens - Non-cached input tokens (Anthropic semantics)
 * @property {number} outputTokens
 * @property {number} cacheCreationInputTokens
 * @property {number} cacheReadInputTokens
 * @property {number} cachedInputTokens
 * @property {number} reasoningTokens
 * @property {number} webSearchRequests
 * @property {number} costUSD
 * @property {string[]} tools
 * @property {string} timestamp - ISO 8601
 * @property {'standard'|'fast'} speed
 * @property {string} deduplicationKey
 * @property {string} userMessage
 * @property {string} sessionId
 */

/**
 * @typedef {Object} SessionParser
 * @property {function(): AsyncGenerator<ParsedProviderCall>} parse
 */

/**
 * @typedef {Object} Provider
 * @property {string} name - Unique identifier
 * @property {string} displayName - Human-readable name
 * @property {function(string): string} modelDisplayName
 * @property {function(string): string} toolDisplayName
 * @property {function(): Promise<SessionSource[]>} discoverSessions
 * @property {function(SessionSource, Set<string>): SessionParser} createSessionParser
 */

export const PROVIDER_TYPES = 'types'; // module marker
