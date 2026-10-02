/**
 * Ollama native API (/api/chat, NDJSON streaming).
 *
 * Ollama answers 403 to `Origin: chrome-extension://…`. The background installs
 * a declarativeNetRequest rule that removes the Origin header for requests
 * *this extension* sends to the configured Ollama host (see ollamaOriginRule).
 */

import type { ProviderConfig } from '../settings';
import { LLMError, type ProviderAdapter } from './types';
import { httpError, joinUrl, readNDJSON, safeFetch } from './http';

const NAME = 'Ollama';

export const ollama: ProviderAdapter = {
  async generate(cfg, req) {
    if (!cfg.model) throw new LLMError('no-provider', 'No Ollama model selected.', { provider: NAME, hint: 'Run `ollama pull llama3.2` and pick it in settings.' });
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.prompt },
      ],
      stream: req.stream,
      options: { temperature: req.temperature, num_predict: req.maxTokens },
      keep_alive: '15m',
    };
    if (req.schema) body.format = req.schema;
    const res = await safeFetch(
      joinUrl(cfg.baseUrl, 'api/chat'),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: req.signal },
      NAME,
    );
    if (!res.ok) throw await httpError(res, NAME);
    let text = '';
    if (req.stream) {
      await readNDJSON(
        res,
        (o) => {
          if (o.error) throw new LLMError('bad-response', String(o.error), { provider: NAME });
          const t = (o.message as { content?: string } | undefined)?.content;
          if (t) {
            text += t;
            req.onText?.(text);
          }
        },
        req.signal,
      );
    } else {
      const o = (await res.json()) as { message?: { content?: string }; error?: string };
      if (o.error) throw new LLMError('bad-response', o.error, { provider: NAME });
      text = o.message?.content ?? '';
      req.onText?.(text);
    }
    return { text: text.replace(/<think>[\s\S]*?<\/think>\s*/g, ''), model: cfg.model };
  },

  async listModels(cfg: ProviderConfig, signal) {
    const res = await safeFetch(joinUrl(cfg.baseUrl, 'api/tags'), { signal }, NAME);
    if (!res.ok) throw await httpError(res, NAME);
    const j = (await res.json()) as {
      models?: { name: string; size?: number; modified_at?: string; details?: { parameter_size?: string; quantization_level?: string; family?: string } }[];
    };
    return (j.models ?? []).map((m) => ({
      id: m.name,
      size: m.size,
      params: m.details?.parameter_size,
      quant: m.details?.quantization_level,
      family: m.details?.family,
      modified: m.modified_at,
      installed: true,
      free: true,
    }));
  },
};

/** DNR rule that removes the Origin header for this extension's own requests to Ollama. */
export function ollamaOriginRule(baseUrl: string, extensionId: string, ruleId = 1): chrome.declarativeNetRequest.Rule | null {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return null;
  }
  return {
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [{ header: 'origin', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation }],
    },
    condition: {
      urlFilter: `|${origin}/`,
      // Only requests started by this extension (service worker *and* the options page,
      // which pulls models). Web pages talking to Ollama are untouched.
      initiatorDomains: [extensionId],
      resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType, 'other' as chrome.declarativeNetRequest.ResourceType],
    },
  };
}
