/**
 * uazapi WhatsApp webhook (replaces the Express /webhook/uazapi route).
 *
 * The original Express route 200-acked first and processed in the
 * background; edge functions can't respond-then-process reliably, so we
 * process within the request (uazapi tolerates a few seconds of latency)
 * but wrap EVERYTHING in try/catch and always end with 200 {received:true}.
 *
 * - fromMe payloads (owner typing in the chat) -> handleOwnerMessage;
 *   a non-null reply is sent back into the chat via sendText.
 * - customer payloads -> handleIncoming; a non-null reply is sent via sendText.
 * - anything unparseable is logged and acked.
 */
import { handleIncoming, handleOwnerMessage } from '../_shared/brain.ts';
import { getHistory } from '../_shared/store.ts';
import { parseIncoming, sendText } from '../_shared/uazapi.ts';

function ack(): Response {
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Human-like reply pacing: instant replies feel obviously botty.
// First reply in a fresh conversation waits ~10s; subsequent replies
// wait a random 5–10s. Runs in-request (uazapi tolerates the extra latency).
async function humanDelayMs(phone: string): Promise<number> {
  try {
    const history = await getHistory('whatsapp', phone);
    if (history.length === 0) return 10_000;
  } catch {
    // If we can't read history, fall back to the random range.
  }
  return 5_000 + Math.floor(Math.random() * 5_001); // 5000–10000ms
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== 'POST') return ack();

    const body = await req.json().catch(() => null);
    const incoming = parseIncoming(body);
    if (!incoming) {
      console.log('[uazapi webhook] ignored payload:', JSON.stringify(body).slice(0, 500));
      return ack();
    }

    // Message sent by the business number itself (owner typing in the chat).
    if (incoming.fromMe) {
      const ownerReply = await handleOwnerMessage({
        channel: 'whatsapp',
        phone: incoming.phone,
        text: incoming.text,
      });
      if (ownerReply) {
        try {
          await sendText(incoming.phone, ownerReply);
        } catch (err) {
          console.error('[uazapi webhook] failed to send owner-command reply:', (err as Error).message);
        }
      }
      return ack();
    }

    const delayMs = await humanDelayMs(incoming.phone);
    const reply = await handleIncoming({
      channel: 'whatsapp',
      phone: incoming.phone,
      text: incoming.text,
    });
    if (reply == null) return ack(); // takeover active: stay silent
    try {
      await sleep(delayMs);
      await sendText(incoming.phone, reply);
    } catch (err) {
      console.error('[uazapi webhook] failed to send reply:', (err as Error).message);
    }
  } catch (err) {
    console.error('[uazapi webhook] error:', err);
  }
  return ack();
});
