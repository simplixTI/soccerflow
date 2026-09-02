/**
 * Call DeepSeek's OpenAI-compatible chat API. (Port of bot/src/deepseek.js.)
 * Expects the model to return strict JSON:
 *   { reply, state, lead: {...}, handoff, handoff_reason }
 * Parses defensively; throws on HTTP/transport errors so the caller
 * can fall back to a graceful message.
 */
import type { ChatMessage } from './store.ts';

const API_URL = 'https://api.deepseek.com/chat/completions';

export interface LeadFields {
  parentName: string | null;
  childName: string | null;
  childAge: string | null;
  program: string | null;
  preferredTime: string | null;
}

export interface ChatResult {
  reply: string;
  state: string;
  lead: LeadFields;
  handoff: boolean;
  handoff_reason: string | null;
}

// Hard ceiling for the reply text. The prompt already asks for short replies,
// but we clip as a safety net. If we DO need to clip, snap back to the last
// sentence boundary so we never send a message that ends mid-word.
const REPLY_HARD_MAX = 800;

function clipReply(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= REPLY_HARD_MAX) return trimmed;
  const window = trimmed.slice(0, REPLY_HARD_MAX);
  // Prefer the last sentence-ending punctuation in the window.
  const lastBoundary = Math.max(
    window.lastIndexOf('.'),
    window.lastIndexOf('!'),
    window.lastIndexOf('?'),
    window.lastIndexOf('\n'),
  );
  if (lastBoundary >= REPLY_HARD_MAX * 0.5) return window.slice(0, lastBoundary + 1).trim();
  // No decent boundary — fall back to the last whitespace to avoid mid-word cuts.
  const lastSpace = window.lastIndexOf(' ');
  return (lastSpace > 0 ? window.slice(0, lastSpace) : window).trim();
}

export async function chat(
  { systemPrompt, messages }: { systemPrompt: string; messages: ChatMessage[] },
): Promise<ChatResult> {
  const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');

  // DeepSeek occasionally returns whitespace-only content with json_object
  // mode (finish_reason "stop"). Retry, and on the last attempt drop
  // response_format entirely (parseModelOutput extracts the JSON anyway).
  const MAX_ATTEMPTS = 3;
  let lastContent: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const useJsonMode = attempt < MAX_ATTEMPTS;
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: Deno.env.get('DEEPSEEK_MODEL') || 'deepseek-chat',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
        temperature: 0.4,
        max_tokens: 600,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`DeepSeek API error ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (Deno.env.get('DEBUG_DEEPSEEK')) {
      console.error('[deepseek] finish_reason:', data?.choices?.[0]?.finish_reason);
      console.error('[deepseek] raw content:', JSON.stringify(content));
    }

    if (content && content.trim()) return parseModelOutput(content);

    lastContent = content;
    console.warn(`[deepseek] whitespace-only response (attempt ${attempt}/${MAX_ATTEMPTS}, json_mode=${useJsonMode})`);
  }

  throw new Error(`DeepSeek returned only whitespace after ${MAX_ATTEMPTS} attempts: ${JSON.stringify(lastContent)}`);
}

function parseModelOutput(content: string): ChatResult {
  // deno-lint-ignore no-explicit-any
  let parsed: any = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Defensive: try to pull a JSON object out of surrounding prose.
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    // Plain-text fallback: treat the whole content as the reply.
    return {
      reply: clipReply(content),
      state: 'QUESTION',
      lead: {
        parentName: null,
        childName: null,
        childAge: null,
        program: null,
        preferredTime: null,
      },
      handoff: false,
      handoff_reason: null,
    };
  }

  const validStates = ['QUESTION', 'LEAD_IN_PROGRESS', 'LEAD_QUALIFIED', 'HUMAN_HANDOFF'];
  const lead = (parsed.lead && typeof parsed.lead === 'object') ? parsed.lead : {};

  return {
    reply: clipReply(String(parsed.reply || '')) ||
      'Thanks for reaching out to Soccer Flow! How can I help you today?',
    state: validStates.includes(parsed.state) ? parsed.state : 'QUESTION',
    lead: {
      parentName: lead.parentName ?? null,
      childName: lead.childName ?? null,
      childAge: lead.childAge ?? null,
      program: lead.program ?? null,
      preferredTime: lead.preferredTime ?? null,
    },
    handoff: Boolean(parsed.handoff),
    handoff_reason: parsed.handoff_reason ? String(parsed.handoff_reason) : null,
  };
}
