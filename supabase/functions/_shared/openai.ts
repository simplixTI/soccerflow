/**
 * OpenAI thin client — embeddings for RAG + chat completions (primary).
 * No SDK; just fetch to keep edge function cold-start minimal.
 */
import type { ChatMessage } from './store.ts';
import { parseModelOutput, type ChatResult } from './deepseek.ts';

const EMBED_URL = 'https://api.openai.com/v1/embeddings';
const CHAT_URL  = 'https://api.openai.com/v1/chat/completions';

const EMBED_MODEL = Deno.env.get('OPENAI_EMBED_MODEL') || 'text-embedding-3-small';
const CHAT_MODEL  = Deno.env.get('OPENAI_CHAT_MODEL')  || 'gpt-4o-mini';

function key(): string {
  const k = Deno.env.get('OPENAI_API_KEY');
  if (!k) throw new Error('OPENAI_API_KEY is not set');
  return k;
}

/** Embed one piece of text and return its vector (1536 dims for small model). */
export async function embed(text: string): Promise<number[]> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(EMBED_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key()}`,
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, 8000) }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    return data.data[0].embedding as number[];
  } finally {
    clearTimeout(t);
  }
}

/**
 * Primary chat call. Returns the parsed ChatResult (same shape as deepseek.chat).
 * Keeps the same prompt / JSON contract so swapping providers is transparent.
 */
export async function chat(
  { systemPrompt, messages }: { systemPrompt: string; messages: ChatMessage[] },
): Promise<ChatResult> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key()}`,
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_tokens: 600,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI chat ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) throw new Error('OpenAI returned empty content');
    return parseModelOutput(content);
  } catch (err) {
    const e = err as Error;
    if (e.name === 'AbortError') throw new Error('OpenAI timeout after 25000ms');
    throw err;
  } finally {
    clearTimeout(t);
  }
}
