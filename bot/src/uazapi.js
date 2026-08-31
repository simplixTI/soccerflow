/**
 * uazapi (unofficial Baileys-based WhatsApp API) integration.
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

function digits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/**
 * Extract { phone, text } from an incoming uazapi webhook payload.
 * Returns null when the payload should be ignored.
 */
export function parseIncoming(body) {
  if (!body || typeof body !== 'object') return null;

  // Common nesting levels used by Baileys-style APIs.
  const msg = body.message || body.data?.message || body.data || body;

  // Ignore echoes of our own messages.
  const fromMe = msg.fromMe ?? msg.key?.fromMe ?? body.fromMe;
  if (fromMe) return null;

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

  // Text extraction across common shapes.
  const text =
    msg.text || msg.body || msg.caption || msg.message ||
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    body.text || body.body || body.content;

  if (!text || typeof text !== 'string' || !text.trim()) return null;

  const phone = digits(rawFrom.split('@')[0]);
  if (!phone) return null;

  return { phone, text: text.trim() };
}

/**
 * Send a WhatsApp text message via uazapi.
 * Throws on failure — callers must catch and log.
 */
export async function sendText(number, text) {
  const baseUrl = process.env.UAZAPI_BASE_URL;
  const token = process.env.UAZAPI_TOKEN;
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
