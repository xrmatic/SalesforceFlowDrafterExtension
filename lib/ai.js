// AI API client.
// Supports OpenAI, Anthropic (Claude), and any OpenAI-compatible custom endpoint.
// All requests carry explicit timeouts and detailed error messages.

import { log } from './logger.js';

/** Default timeout for AI requests in milliseconds. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** System prompt injected before every user message. */
const SYSTEM_PROMPT = `You are an expert Salesforce developer specialising in Flow Builder automation.
Your task is to generate valid, deployable Salesforce Flow Metadata XML based on user requirements.

Rules you MUST follow:
1. Output ONLY the raw XML – start with: <?xml version="1.0" encoding="UTF-8"?>
2. Use the Flow metadata namespace: http://soap.sforce.com/2006/04/metadata
3. Set <apiVersion> to the value provided in the configuration context.
4. Derive a concise camelCase API name from the user request and set <label> accordingly.
5. Include proper <start> coordinates (locationX: 50, locationY: 0) so Flow Builder renders correctly.
6. Set <status> to one of the valid Salesforce values: Active, Draft, Obsolete, or InvalidDraft.
   Use "Draft" as the default – it is safe and lets the admin activate manually in Flow Builder.
7. Include at least one flow element and a logical connector so the flow is non-trivial.
8. Do NOT wrap the XML in markdown code fences or add any prose – raw XML only.`;

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function callOpenAI({ apiKey, model, messages, maxTokens, temperature, baseUrl, timeoutMs }) {
  const url = `${baseUrl || 'https://api.openai.com'}/v1/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o',
        messages,
        max_tokens: maxTokens || 4096,
        temperature: temperature ?? 0.2,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`OpenAI API error ${resp.status}: ${errBody}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned an empty response');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic({ apiKey, model, messages, maxTokens, temperature, timeoutMs }) {
  const url = 'https://api.anthropic.com/v1/messages';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Anthropic API separates the system prompt
  const systemMsg = messages.find(m => m.role === 'system')?.content || SYSTEM_PROMPT;
  const userMessages = messages.filter(m => m.role !== 'system');

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-3-5-sonnet-20241022',
        system: systemMsg,
        messages: userMessages,
        max_tokens: maxTokens || 4096,
        temperature: temperature ?? 0.2,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`Anthropic API error ${resp.status}: ${errBody}`);
    }

    const data = await resp.json();
    const content = data?.content?.[0]?.text;
    if (!content) throw new Error('Anthropic returned an empty response');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a conversation to the configured AI provider and return the assistant reply.
 *
 * @param {object} opts
 * @param {string} opts.provider  'openai' | 'anthropic' | 'custom'
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} [opts.baseUrl]       Custom endpoint base URL (for 'custom' provider)
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {number} [opts.timeoutMs]
 * @param {string} opts.apiVersion      Salesforce API version, injected into system prompt
 * @param {Array<{role:string, content:string}>} opts.history  Prior chat turns
 * @param {string} opts.userMessage     Latest user message
 * @returns {Promise<string>} Assistant reply text
 */
export async function sendPrompt({
  provider,
  apiKey,
  model,
  baseUrl,
  maxTokens,
  temperature,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  apiVersion,
  history = [],
  userMessage,
}) {
  if (!apiKey) throw new Error('No AI API key configured. Please open Settings.');
  if (!userMessage) throw new Error('User message is empty.');

  const systemContent = `${SYSTEM_PROMPT}\n\nSalesforce API version for this session: ${apiVersion || '62.0'}`;

  // Build full message list with system prompt prepended
  const messages = [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: userMessage },
  ];

  log.info(`Sending prompt to ${provider} (model: ${model}), history length: ${history.length}`);

  try {
    let reply;
    switch (provider) {
      case 'anthropic':
        reply = await callAnthropic({ apiKey, model, messages, maxTokens, temperature, timeoutMs });
        break;
      case 'custom':
        reply = await callOpenAI({ apiKey, model, messages, maxTokens, temperature, baseUrl, timeoutMs });
        break;
      case 'openai':
      default:
        reply = await callOpenAI({ apiKey, model, messages, maxTokens, temperature, timeoutMs });
        break;
    }

    log.info(`AI response received (${reply.length} chars)`);
    return reply;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`AI request timed out after ${timeoutMs / 1000}s. Try a simpler prompt or increase the timeout in Settings.`);
    }
    log.error('AI request failed:', err);
    throw err;
  }
}

/**
 * Extract the first complete XML block from an AI response string.
 * Returns the raw string if no XML declaration is found (graceful fallback).
 *
 * @param {string} text  Raw AI response
 * @returns {string}     Extracted XML
 */
export function extractXml(text) {
  // Strip markdown code fences if the AI disobeyed instructions
  const stripped = text.replace(/^```[a-z]*\n?/gim, '').replace(/```$/gim, '').trim();

  const start = stripped.indexOf('<?xml');
  if (start === -1) return stripped.trim();
  return stripped.slice(start).trim();
}

/**
 * Parse the Flow API name from generated XML (falls back to a timestamp-based name).
 *
 * @param {string} xml
 * @returns {string}  Flow API name suitable for filenames
 */
export function extractFlowName(xml) {
  // Try <fullName> first (set by some AI responses)
  const fullNameMatch = xml.match(/<fullName>([^<]+)<\/fullName>/);
  if (fullNameMatch) return fullNameMatch[1].trim().replace(/\s+/g, '_');

  // Fall back to <label>
  const labelMatch = xml.match(/<label>([^<]+)<\/label>/);
  if (labelMatch) {
    return labelMatch[1]
      .trim()
      .replace(/[^a-zA-Z0-9 _]/g, '')
      .replace(/\s+/g, '_');
  }

  return `GeneratedFlow_${Date.now()}`;
}
