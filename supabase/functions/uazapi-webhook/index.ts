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
import { parseIncoming, sendText } from '../_shared/uazapi.ts';

function ack(): Response {
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
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

    const reply = await handleIncoming({
      channel: 'whatsapp',
      phone: incoming.phone,
      text: incoming.text,
    });
    if (reply == null) return ack(); // takeover active: stay silent
    try {
      await sendText(incoming.phone, reply);
    } catch (err) {
      console.error('[uazapi webhook] failed to send reply:', (err as Error).message);
    }
  } catch (err) {
    console.error('[uazapi webhook] error:', err);
  }
  return ack();
});
