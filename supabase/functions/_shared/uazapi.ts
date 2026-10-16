/**
 * uazapi (unofficial Baileys-based WhatsApp API) integration.
 * (Port of bot/src/uazapi.js.)
 *
 * NOTE: the exact incoming webhook payload schema is not confirmed yet.
 * parseIncoming() is intentionally TOLERANT: it probes several common
 * shapes and returns null for anything it can't use (groups, status
 * broadcasts, fromMe echoes, unknown payloads) so the caller can just
 * 200-ack and move on.
 *
 * sendText() POSTs to `${UAZAPI_BASE_URL}/send/text` with header
 * `token: ${UAZAPI_TOKEN}` and body `{ number, text }`.
 * Adjust here once verified against the real uazapi docs.
 */

function digits(phone: unknown): string {
  return String(phone || '').replace(/\D/g, '');
}

export interface IncomingMessage {
  phone: string;
  text: string;
  fromMe: boolean;
}

/**
 * Extract { phone, text, fromMe } from an incoming uazapi webhook payload.
 * fromMe=true marks messages sent by the business number itself (owner typing in the chat,
 * e.g. the /assumir takeover command, or the bot's own API replies).
 * Returns null when the payload should be ignored.
 */
// deno-lint-ignore no-explicit-any
export function parseIncoming(body: any): IncomingMessage | null {
  if (!body || typeof body !== 'object') return null;

  // Common nesting levels used by Baileys-style APIs.
  const msg = body.message || body.data?.message || body.data || body;

  // Sender / chat identifiers seen in the wild.
  const rawFrom =
    msg.chatid || msg.chatId || msg.from || msg.remoteJid ||
    msg.key?.remoteJid || msg.sender || body.chatid || body.from || body.sender;

  if (!rawFrom || typeof rawFrom !== 'string') return null;

  // Ignore groups and status/broadcast messages.
  if (rawFrom.endsWith('@g.us')) return null;
  if (rawFrom.includes('broadcast') || rawFrom.includes('status@')) return null;
  const chatType = msg.chat_type || msg.chatType || body.chat_type;
  if (chatType === 'group') return null;
  if (msg.isGroup || body.isGroup) return null;

  // Defensive: if uazapi echoes our own API-sent messages back, ignore them.
  // (The uazapi instance SHOULD also be configured to exclude `wasSentByApi`
  // events, but we belt-and-suspenders every signal we can see.)
  // Any ONE of these means "this came from an API call we made":
  //   - wasSentByApi flag true (standard uazapi field)
  //   - sendFunction present (sendtext/sendmedia/… — only set by API senders)
  //   - sendPayload present   (the API request body uazapi echoes back)
  //   - source === 'api'      (some payload shapes)
  const wasSentByApi =
    msg.wasSentByApi === true || body.wasSentByApi === true || msg.data?.wasSentByApi === true;
  const hasSendFn = !!(msg.sendFunction || body.sendFunction || msg.data?.sendFunction);
  const hasSendPayload = !!(msg.sendPayload || body.sendPayload || msg.data?.sendPayload);
  const sourceIsApi = String(msg.source || body.source || '').toLowerCase() === 'api';
  if (wasSentByApi || hasSendFn || hasSendPayload || sourceIsApi) return null;

  // Ignore reactions (thumbs-up, ❤️, etc. that customers tap on prior messages).
  // These are not new questions — they're acknowledgements. Replying to them
  // feels robotic and often re-opens a conversation the team already closed.
  const messageType = String(msg.messageType || msg.type || body.messageType || '').toLowerCase();
  if (messageType.includes('reaction')) return null;
  const reactionField = msg.reaction ?? body.reaction ?? msg.message?.reactionMessage;
  if (reactionField && typeof reactionField === 'object') return null;
  if (typeof reactionField === 'string' && reactionField.trim() && !msg.text && !msg.body) return null;

  const fromMe = Boolean(msg.fromMe ?? msg.key?.fromMe ?? body.fromMe);

  // Text extraction across common shapes.
  const text =
    msg.text || msg.body || msg.caption || msg.message ||
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    body.text || body.body || body.content;

  if (!text || typeof text !== 'string' || !text.trim()) return null;

  const phone = digits(rawFrom.split('@')[0]);
  if (!phone) return null;

  return { phone, text: text.trim(), fromMe };
}

/**
 * Send a WhatsApp text message via uazapi.
 * Throws on failure — callers must catch and log.
 */
// deno-lint-ignore no-explicit-any
export async function sendText(number: string, text: string): Promise<any> {
  const baseUrl = Deno.env.get('UAZAPI_BASE_URL');
  const token = Deno.env.get('UAZAPI_TOKEN');
  if (!baseUrl || !token) throw new Error('UAZAPI_BASE_URL / UAZAPI_TOKEN not set');

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/send/text`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      token,
    },
    body: JSON.stringify({ number: digits(number), text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`uazapi send/text failed ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}
