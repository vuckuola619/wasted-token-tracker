/**
 * Universal LLM Pricing Engine
 * 
 * Supports ALL major LLM providers and models:
 *   - Anthropic (Claude Opus, Sonnet, Haiku — all versions)
 *   - OpenAI (GPT-5.x, GPT-4o, o3, o4-mini)
 *   - Google (Gemini 3.1 Pro, 3 Flash, 2.5 Pro, Flash, etc.)
 *   - DeepSeek (V3, R1, Coder)
 *   - Meta (Llama 4, 3.x)
 *   - Mistral (Large, Medium, Small, Codestral)
 *   - Qwen (2.5, Coder)
 *   - Cohere (Command R+)
 *   - xAI (Grok)
 * 
 * Pricing from LiteLLM (auto-cached 24h) with comprehensive hardcoded fallbacks.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const WEB_SEARCH_COST = 0.01;

// ─── Comprehensive Fallback Pricing (per token) ────────────────────────────────
// Covers every major model family. Prices in USD per token.
const FALLBACK_PRICING = {
  // ─── Anthropic Claude ───
  'claude-opus-4-6':     { inputCostPerToken: 5e-6,   outputCostPerToken: 25e-6,  cacheWriteCostPerToken: 6.25e-6,  cacheReadCostPerToken: 0.5e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 6 },
  'claude-opus-4-5':     { inputCostPerToken: 5e-6,   outputCostPerToken: 25e-6,  cacheWriteCostPerToken: 6.25e-6,  cacheReadCostPerToken: 0.5e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-opus-4-1':     { inputCostPerToken: 15e-6,  outputCostPerToken: 75e-6,  cacheWriteCostPerToken: 18.75e-6, cacheReadCostPerToken: 1.5e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-opus-4':       { inputCostPerToken: 15e-6,  outputCostPerToken: 75e-6,  cacheWriteCostPerToken: 18.75e-6, cacheReadCostPerToken: 1.5e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-sonnet-4-6':   { inputCostPerToken: 3e-6,   outputCostPerToken: 15e-6,  cacheWriteCostPerToken: 3.75e-6,  cacheReadCostPerToken: 0.3e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-sonnet-4-5':   { inputCostPerToken: 3e-6,   outputCostPerToken: 15e-6,  cacheWriteCostPerToken: 3.75e-6,  cacheReadCostPerToken: 0.3e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-sonnet-4':     { inputCostPerToken: 3e-6,   outputCostPerToken: 15e-6,  cacheWriteCostPerToken: 3.75e-6,  cacheReadCostPerToken: 0.3e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-3-7-sonnet':   { inputCostPerToken: 3e-6,   outputCostPerToken: 15e-6,  cacheWriteCostPerToken: 3.75e-6,  cacheReadCostPerToken: 0.3e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-3-5-sonnet':   { inputCostPerToken: 3e-6,   outputCostPerToken: 15e-6,  cacheWriteCostPerToken: 3.75e-6,  cacheReadCostPerToken: 0.3e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-haiku-4-5':    { inputCostPerToken: 1e-6,   outputCostPerToken: 5e-6,   cacheWriteCostPerToken: 1.25e-6,  cacheReadCostPerToken: 0.1e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'claude-3-5-haiku':    { inputCostPerToken: 0.8e-6, outputCostPerToken: 4e-6,   cacheWriteCostPerToken: 1e-6,     cacheReadCostPerToken: 0.08e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },

  // ─── OpenAI GPT ───
  'gpt-5.4':             { inputCostPerToken: 2.5e-6,  outputCostPerToken: 10e-6,  cacheWriteCostPerToken: 2.5e-6,  cacheReadCostPerToken: 1.25e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5.4-mini':        { inputCostPerToken: 0.4e-6,  outputCostPerToken: 1.6e-6, cacheWriteCostPerToken: 0.4e-6,  cacheReadCostPerToken: 0.2e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5.3-codex':       { inputCostPerToken: 2.5e-6,  outputCostPerToken: 10e-6,  cacheWriteCostPerToken: 2.5e-6,  cacheReadCostPerToken: 1.25e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-5':               { inputCostPerToken: 2.5e-6,  outputCostPerToken: 10e-6,  cacheWriteCostPerToken: 2.5e-6,  cacheReadCostPerToken: 1.25e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4.1':             { inputCostPerToken: 2e-6,    outputCostPerToken: 8e-6,   cacheWriteCostPerToken: 2e-6,    cacheReadCostPerToken: 0.5e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4.1-mini':        { inputCostPerToken: 0.4e-6,  outputCostPerToken: 1.6e-6, cacheWriteCostPerToken: 0.4e-6,  cacheReadCostPerToken: 0.1e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4.1-nano':        { inputCostPerToken: 0.1e-6,  outputCostPerToken: 0.4e-6, cacheWriteCostPerToken: 0.1e-6,  cacheReadCostPerToken: 0.025e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4o':              { inputCostPerToken: 2.5e-6,  outputCostPerToken: 10e-6,  cacheWriteCostPerToken: 2.5e-6,  cacheReadCostPerToken: 1.25e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4o-mini':         { inputCostPerToken: 0.15e-6, outputCostPerToken: 0.6e-6, cacheWriteCostPerToken: 0.15e-6, cacheReadCostPerToken: 0.075e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gpt-4-turbo':         { inputCostPerToken: 10e-6,   outputCostPerToken: 30e-6,  cacheWriteCostPerToken: 10e-6,   cacheReadCostPerToken: 5e-6,    webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },

  // ─── OpenAI Reasoning ───
  'o4-mini':             { inputCostPerToken: 1.1e-6,  outputCostPerToken: 4.4e-6, cacheWriteCostPerToken: 1.1e-6,  cacheReadCostPerToken: 0.275e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'o3':                  { inputCostPerToken: 10e-6,   outputCostPerToken: 40e-6,  cacheWriteCostPerToken: 10e-6,   cacheReadCostPerToken: 2.5e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'o3-mini':             { inputCostPerToken: 1.1e-6,  outputCostPerToken: 4.4e-6, cacheWriteCostPerToken: 1.1e-6,  cacheReadCostPerToken: 0.275e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'o1':                  { inputCostPerToken: 15e-6,   outputCostPerToken: 60e-6,  cacheWriteCostPerToken: 15e-6,   cacheReadCostPerToken: 7.5e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'o1-mini':             { inputCostPerToken: 3e-6,    outputCostPerToken: 12e-6,  cacheWriteCostPerToken: 3e-6,    cacheReadCostPerToken: 1.5e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },

  // ─── Google Gemini ───
  'gemini-3.1-pro':      { inputCostPerToken: 1.5e-6,  outputCostPerToken: 12e-6,  cacheWriteCostPerToken: 1.5e-6,  cacheReadCostPerToken: 0.375e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gemini-3-flash':      { inputCostPerToken: 0.1e-6,  outputCostPerToken: 0.4e-6, cacheWriteCostPerToken: 0.1e-6,  cacheReadCostPerToken: 0.025e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gemini-2.5-pro':      { inputCostPerToken: 1.25e-6, outputCostPerToken: 10e-6,  cacheWriteCostPerToken: 1.25e-6, cacheReadCostPerToken: 0.315e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gemini-2.5-flash':    { inputCostPerToken: 0.15e-6, outputCostPerToken: 0.6e-6, cacheWriteCostPerToken: 0.15e-6, cacheReadCostPerToken: 0.0375e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gemini-2.0-flash':    { inputCostPerToken: 0.1e-6,  outputCostPerToken: 0.4e-6, cacheWriteCostPerToken: 0.1e-6,  cacheReadCostPerToken: 0.025e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gemini-1.5-pro':      { inputCostPerToken: 1.25e-6, outputCostPerToken: 5e-6,   cacheWriteCostPerToken: 1.25e-6, cacheReadCostPerToken: 0.315e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'gemini-1.5-flash':    { inputCostPerToken: 0.075e-6,outputCostPerToken: 0.3e-6, cacheWriteCostPerToken: 0.075e-6,cacheReadCostPerToken: 0.01875e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },

  // ─── DeepSeek ───
  'deepseek-chat':       { inputCostPerToken: 0.27e-6, outputCostPerToken: 1.1e-6, cacheWriteCostPerToken: 0.27e-6, cacheReadCostPerToken: 0.07e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'deepseek-reasoner':   { inputCostPerToken: 0.55e-6, outputCostPerToken: 2.19e-6,cacheWriteCostPerToken: 0.55e-6, cacheReadCostPerToken: 0.14e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'deepseek-coder':      { inputCostPerToken: 0.14e-6, outputCostPerToken: 0.28e-6,cacheWriteCostPerToken: 0.14e-6, cacheReadCostPerToken: 0.035e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'deepseek-v3':         { inputCostPerToken: 0.27e-6, outputCostPerToken: 1.1e-6, cacheWriteCostPerToken: 0.27e-6, cacheReadCostPerToken: 0.07e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'deepseek-r1':         { inputCostPerToken: 0.55e-6, outputCostPerToken: 2.19e-6,cacheWriteCostPerToken: 0.55e-6, cacheReadCostPerToken: 0.14e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },

  // ─── Mistral ───
  'mistral-large':       { inputCostPerToken: 2e-6,    outputCostPerToken: 6e-6,   cacheWriteCostPerToken: 2e-6,    cacheReadCostPerToken: 0.5e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'mistral-medium':      { inputCostPerToken: 2.7e-6,  outputCostPerToken: 8.1e-6, cacheWriteCostPerToken: 2.7e-6,  cacheReadCostPerToken: 0.675e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'mistral-small':       { inputCostPerToken: 0.1e-6,  outputCostPerToken: 0.3e-6, cacheWriteCostPerToken: 0.1e-6,  cacheReadCostPerToken: 0.025e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'codestral':           { inputCostPerToken: 0.3e-6,  outputCostPerToken: 0.9e-6, cacheWriteCostPerToken: 0.3e-6,  cacheReadCostPerToken: 0.075e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },

  // ─── Meta Llama ───
  'llama-4-maverick':    { inputCostPerToken: 0.2e-6,  outputCostPerToken: 0.6e-6, cacheWriteCostPerToken: 0.2e-6,  cacheReadCostPerToken: 0.05e-6, webSearchCostPerRequest: 0, fastMultiplier: 1 },
  'llama-4-scout':       { inputCostPerToken: 0.15e-6, outputCostPerToken: 0.4e-6, cacheWriteCostPerToken: 0.15e-6, cacheReadCostPerToken: 0.035e-6,webSearchCostPerRequest: 0, fastMultiplier: 1 },
  'llama-3.3-70b':       { inputCostPerToken: 0.6e-6,  outputCostPerToken: 0.6e-6, cacheWriteCostPerToken: 0.6e-6,  cacheReadCostPerToken: 0.15e-6, webSearchCostPerRequest: 0, fastMultiplier: 1 },
  'llama-3.1-405b':      { inputCostPerToken: 3e-6,    outputCostPerToken: 3e-6,   cacheWriteCostPerToken: 3e-6,    cacheReadCostPerToken: 0.75e-6, webSearchCostPerRequest: 0, fastMultiplier: 1 },
  'llama-3.1-70b':       { inputCostPerToken: 0.6e-6,  outputCostPerToken: 0.6e-6, cacheWriteCostPerToken: 0.6e-6,  cacheReadCostPerToken: 0.15e-6, webSearchCostPerRequest: 0, fastMultiplier: 1 },
  'llama-3.1-8b':        { inputCostPerToken: 0.05e-6, outputCostPerToken: 0.08e-6,cacheWriteCostPerToken: 0.05e-6, cacheReadCostPerToken: 0.01e-6, webSearchCostPerRequest: 0, fastMultiplier: 1 },

  // ─── Qwen ───
  'qwen-2.5-coder-32b':  { inputCostPerToken: 0.2e-6, outputCostPerToken: 0.2e-6, cacheWriteCostPerToken: 0.2e-6,  cacheReadCostPerToken: 0.05e-6, webSearchCostPerRequest: 0, fastMultiplier: 1 },
  'qwen-2.5-72b':        { inputCostPerToken: 0.3e-6, outputCostPerToken: 0.3e-6, cacheWriteCostPerToken: 0.3e-6,  cacheReadCostPerToken: 0.075e-6,webSearchCostPerRequest: 0, fastMultiplier: 1 },
  'qwen-max':            { inputCostPerToken: 1.6e-6, outputCostPerToken: 6.4e-6, cacheWriteCostPerToken: 1.6e-6,  cacheReadCostPerToken: 0.4e-6,  webSearchCostPerRequest: 0, fastMultiplier: 1 },

  // ─── Cohere ───
  'command-r-plus':      { inputCostPerToken: 2.5e-6, outputCostPerToken: 10e-6,  cacheWriteCostPerToken: 2.5e-6,  cacheReadCostPerToken: 0.625e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'command-r':           { inputCostPerToken: 0.15e-6,outputCostPerToken: 0.6e-6, cacheWriteCostPerToken: 0.15e-6, cacheReadCostPerToken: 0.0375e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },

  // ─── xAI Grok ───
  'grok-3':              { inputCostPerToken: 3e-6,   outputCostPerToken: 15e-6,  cacheWriteCostPerToken: 3e-6,    cacheReadCostPerToken: 0.75e-6, webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'grok-3-mini':         { inputCostPerToken: 0.3e-6, outputCostPerToken: 0.5e-6, cacheWriteCostPerToken: 0.3e-6,  cacheReadCostPerToken: 0.075e-6,webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },
  'grok-2':              { inputCostPerToken: 2e-6,   outputCostPerToken: 10e-6,  cacheWriteCostPerToken: 2e-6,    cacheReadCostPerToken: 0.5e-6,  webSearchCostPerRequest: WEB_SEARCH_COST, fastMultiplier: 1 },

  // ─── Local/Self-hosted (zero cost) ───
  'local':               { inputCostPerToken: 0, outputCostPerToken: 0, cacheWriteCostPerToken: 0, cacheReadCostPerToken: 0, webSearchCostPerRequest: 0, fastMultiplier: 1 },
  'ollama':              { inputCostPerToken: 0, outputCostPerToken: 0, cacheWriteCostPerToken: 0, cacheReadCostPerToken: 0, webSearchCostPerRequest: 0, fastMultiplier: 1 },

  // ─── GPT-OSS (Open-source variant available in Antigravity) ───
  'gpt-oss-120b':        { inputCostPerToken: 0.6e-6,  outputCostPerToken: 1.8e-6, cacheWriteCostPerToken: 0.6e-6,  cacheReadCostPerToken: 0.15e-6, webSearchCostPerRequest: 0, fastMultiplier: 1 },
};

// ─── Display name mapping (canonical → friendly) ──────────────────────────────
const SHORT_MODEL_NAMES = {
  // Anthropic
  'claude-opus-4-6':     'Opus 4.6',
  'claude-opus-4-5':     'Opus 4.5',
  'claude-opus-4-1':     'Opus 4.1',
  'claude-opus-4':       'Opus 4',
  'claude-sonnet-4-6':   'Sonnet 4.6',
  'claude-sonnet-4-5':   'Sonnet 4.5',
  'claude-sonnet-4':     'Sonnet 4',
  'claude-3-7-sonnet':   'Sonnet 3.7',
  'claude-3-5-sonnet':   'Sonnet 3.5',
  'claude-haiku-4-5':    'Haiku 4.5',
  'claude-3-5-haiku':    'Haiku 3.5',
  // OpenAI
  'gpt-5.4-mini':        'GPT-5.4 Mini',
  'gpt-5.4':             'GPT-5.4',
  'gpt-5.3-codex':       'GPT-5.3 Codex',
  'gpt-5':               'GPT-5',
  'gpt-4.1-nano':        'GPT-4.1 Nano',
  'gpt-4.1-mini':        'GPT-4.1 Mini',
  'gpt-4.1':             'GPT-4.1',
  'gpt-4o-mini':          'GPT-4o Mini',
  'gpt-4o':              'GPT-4o',
  'gpt-4-turbo':         'GPT-4 Turbo',
  'o4-mini':             'o4-mini',
  'o3-mini':             'o3-mini',
  'o3':                  'o3',
  'o1-mini':             'o1-mini',
  'o1':                  'o1',
  // Google
  'gemini-3.1-pro':      'Gemini 3.1 Pro',
  'gemini-3-flash':      'Gemini 3 Flash',
  'gemini-2.5-pro':      'Gemini 2.5 Pro',
  'gemini-2.5-flash':    'Gemini 2.5 Flash',
  'gemini-2.0-flash':    'Gemini 2.0 Flash',
  'gemini-1.5-pro':      'Gemini 1.5 Pro',
  'gemini-1.5-flash':    'Gemini 1.5 Flash',
  // DeepSeek
  'deepseek-chat':       'DeepSeek V3',
  'deepseek-reasoner':   'DeepSeek R1',
  'deepseek-coder':      'DeepSeek Coder',
  'deepseek-v3':         'DeepSeek V3',
  'deepseek-r1':         'DeepSeek R1',
  // Mistral
  'mistral-large':       'Mistral Large',
  'mistral-medium':      'Mistral Medium',
  'mistral-small':       'Mistral Small',
  'codestral':           'Codestral',
  // Meta
  'llama-4-maverick':    'Llama 4 Maverick',
  'llama-4-scout':       'Llama 4 Scout',
  'llama-3.3-70b':       'Llama 3.3 70B',
  'llama-3.1-405b':      'Llama 3.1 405B',
  'llama-3.1-70b':       'Llama 3.1 70B',
  'llama-3.1-8b':        'Llama 3.1 8B',
  // Qwen
  'qwen-2.5-coder-32b':  'Qwen 2.5 Coder 32B',
  'qwen-2.5-72b':        'Qwen 2.5 72B',
  'qwen-max':            'Qwen Max',
  // Cohere
  'command-r-plus':      'Command R+',
  'command-r':           'Command R',
  // xAI
  'grok-3':              'Grok 3',
  'grok-3-mini':         'Grok 3 Mini',
  'grok-2':              'Grok 2',
  // GPT-OSS
  'gpt-oss-120b':        'GPT-OSS 120B',
};

let pricingCache = null;

function getCacheDir() {
  return join(homedir(), '.cache', 'ag-code-token');
}

function getCachePath() {
  return join(getCacheDir(), 'litellm-pricing.json');
}

function parseLiteLLMEntry(entry) {
  if (!entry.input_cost_per_token || !entry.output_cost_per_token) return null;
  return {
    inputCostPerToken: entry.input_cost_per_token,
    outputCostPerToken: entry.output_cost_per_token,
    cacheWriteCostPerToken: entry.cache_creation_input_token_cost ?? entry.input_cost_per_token * 1.25,
    cacheReadCostPerToken: entry.cache_read_input_token_cost ?? entry.input_cost_per_token * 0.1,
    webSearchCostPerRequest: WEB_SEARCH_COST,
    fastMultiplier: entry.provider_specific_entry?.fast ?? 1,
  };
}

async function fetchAndCachePricing() {
  const response = await fetch(LITELLM_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const pricing = new Map();

  for (const [name, entry] of Object.entries(data)) {
    if (name.includes('/') || name.includes('.')) continue;
    const costs = parseLiteLLMEntry(entry);
    if (costs) pricing.set(name, costs);
  }

  await mkdir(getCacheDir(), { recursive: true });
  await writeFile(getCachePath(), JSON.stringify({
    timestamp: Date.now(),
    data: Object.fromEntries(pricing),
  }));

  return pricing;
}

async function loadCachedPricing() {
  try {
    const raw = await readFile(getCachePath(), 'utf-8');
    const cached = JSON.parse(raw);
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null;
    return new Map(Object.entries(cached.data));
  } catch {
    return null;
  }
}

export async function loadPricing() {
  const cached = await loadCachedPricing();
  if (cached) {
    pricingCache = cached;
    return;
  }

  try {
    pricingCache = await fetchAndCachePricing();
    console.log(`[models] Fetched LiteLLM pricing (${pricingCache.size} models)`);
  } catch {
    pricingCache = new Map(Object.entries(FALLBACK_PRICING));
    console.log(`[models] Using fallback pricing (${pricingCache.size} models)`);
  }
}

function getCanonicalName(model) {
  return model
    .replace(/@.*$/, '')       // remove @version
    .replace(/-\d{8}$/, '')    // remove -YYYYMMDD date suffix
    .toLowerCase();
}

export function getModelCosts(model) {
  const canonical = getCanonicalName(model);

  // 1. Exact match in LiteLLM
  if (pricingCache?.has(canonical)) return pricingCache.get(canonical);

  // 2. Exact match in fallback
  for (const [key, costs] of Object.entries(FALLBACK_PRICING)) {
    if (canonical === key || canonical.startsWith(key + '-')) return costs;
  }

  // 3. Prefix match in LiteLLM
  for (const [key, costs] of pricingCache ?? new Map()) {
    if (canonical.startsWith(key) || key.startsWith(canonical)) return costs;
  }

  // 4. Prefix match in fallback
  for (const [key, costs] of Object.entries(FALLBACK_PRICING)) {
    if (canonical.startsWith(key)) return costs;
  }

  return null;
}

/**
 * Calculate cost for a single API call
 */
export function calculateCost(model, inputTokens, outputTokens, cacheCreationTokens = 0, cacheReadTokens = 0, webSearchRequests = 0, speed = 'standard') {
  const costs = getModelCosts(model);
  if (!costs) return 0;

  const multiplier = speed === 'fast' ? costs.fastMultiplier : 1;

  return multiplier * (
    inputTokens * costs.inputCostPerToken +
    outputTokens * costs.outputCostPerToken +
    cacheCreationTokens * costs.cacheWriteCostPerToken +
    cacheReadTokens * costs.cacheReadCostPerToken +
    webSearchRequests * costs.webSearchCostPerRequest
  );
}

/**
 * Get a short, human-readable model name
 */
export function getShortModelName(model) {
  const canonical = getCanonicalName(model);
  for (const [key, name] of Object.entries(SHORT_MODEL_NAMES)) {
    if (canonical.startsWith(key)) return name;
  }
  return canonical;
}

/**
 * Get all known model families for the dashboard
 */
export function getAllModelFamilies() {
  return [
    { family: 'Anthropic', models: ['Opus 4.6', 'Opus 4.5', 'Sonnet 4.6', 'Sonnet 4.5', 'Sonnet 4', 'Haiku 4.5'] },
    { family: 'OpenAI', models: ['GPT-5.4', 'GPT-5', 'GPT-4o', 'o4-mini', 'o3', 'o1'] },
    { family: 'Google', models: ['Gemini 3.1 Pro', 'Gemini 3 Flash', 'Gemini 2.5 Pro', 'Gemini 2.5 Flash'] },
    { family: 'DeepSeek', models: ['DeepSeek V3', 'DeepSeek R1', 'DeepSeek Coder'] },
    { family: 'Mistral', models: ['Mistral Large', 'Codestral', 'Mistral Small'] },
    { family: 'Meta', models: ['Llama 4 Maverick', 'Llama 4 Scout', 'Llama 3.3 70B'] },
    { family: 'xAI', models: ['Grok 3', 'Grok 3 Mini'] },
    { family: 'Local', models: ['Ollama', 'LM Studio', 'vLLM'] },
  ];
}
