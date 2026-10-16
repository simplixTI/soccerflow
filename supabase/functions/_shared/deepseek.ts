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

/**
 * Belt-and-suspenders typography sanitizer. The prompt forbids these, but a
 * model slip must never reach a customer, so we strip them in code too.
 *   em dash (U+2014) / en dash (U+2013) / horizontal bar (U+2015) -> ", "
 *   every emoji / pictograph (plus skin tones, ZWJ sequences, variation
 *   selectors)                                                      -> removed
 * Also collapses the double spaces / dangling commas the replacement can leave.
 */
export function sanitizeReply(raw: string): string {
  return raw
    // numeric ranges keep a plain hyphen ("ages 2–11" -> "ages 2-11")
    .replace(/(\d)\s*[—–―]\s*(\d)/g, '$1-$2')
    .replace(/\s*[—–―]\s*/g, ', ')
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]️?(‍[\p{Extended_Pictographic}]️?)*/gu, '')
    .replace(/[️‍]/g, '')
    .replace(/,\s*,/g, ',')
    // Collapse runs of spaces/tabs only. Newlines are KEPT: the reply style is
    // short paragraphs separated by one blank line, and WhatsApp renders them.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+([.!?])/g, '$1')
    .replace(/,[ \t]*$/gm, '.')
    .trim();
}

/**
 * House style: the question always stands alone in the last paragraph.
 * The prompt asks for it, but gpt-4o still glues "Could you share your
 * child's age?" to the end of an informative paragraph now and then, so we
 * enforce it here: inside the LAST paragraph, if the first sentence that
 * ends with "?" is not the paragraph's first sentence, break the paragraph
 * right before that question. Everything from the question onward (including
 * a trailing "That way I can..." explanation) becomes the final paragraph.
 */
export function isolateTrailingQuestion(text: string): string {
  const paragraphs = text.split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1];
  if (!last || !last.includes('?')) return text;
  // Sentence starts: whitespace after . ! ? followed by an uppercase letter,
  // an opening Spanish mark, or a quote. URLs have no space after the dot.
  const starts: number[] = [0];
  const re = /(?<=[.!?])\s+(?=[A-ZÀ-ÝÁÉÍÓÚÑ¿¡"'(])/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(last)) !== null) starts.push(m.index + m[0].length);
  if (starts.length < 2) return text;
  for (let i = 1; i < starts.length; i++) {
    const sentence = last.slice(starts[i], starts[i + 1] ?? last.length).trim();
    if (sentence.endsWith('?')) {
      const head = last.slice(0, starts[i]).trimEnd();
      const tail = last.slice(starts[i]).trim();
      if (!head || !tail) return text;
      paragraphs[paragraphs.length - 1] = `${head}\n\n${tail}`;
      return paragraphs.join('\n\n');
    }
  }
  return text;
}

function clipReply(raw: string): string {
  const trimmed = isolateTrailingQuestion(sanitizeReply(raw));
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
    // Hard timeout per attempt. DeepSeek has returned "unable to start
    // processing within 900s" during load — we'd rather fail fast and let
    // the owner reply manually than make the customer wait minutes.
    const controller = new AbortController();
    const timeoutMs = 25_000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(API_URL, {
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
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const e = err as Error;
      if (e.name === 'AbortError') {
        throw new Error(`DeepSeek timeout after ${timeoutMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
      }
      throw err;
    }
    clearTimeout(timeoutId);

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

export function parseModelOutput(content: string): ChatResult {
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
