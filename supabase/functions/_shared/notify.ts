/**
 * Notify the owner about a qualified lead or a human-handoff request.
 * (Port of bot/src/notify.js, without the twilio npm package.)
 * Sends via BOTH WhatsApp (uazapi) and SMS (Twilio REST API).
 * Failures are logged, never thrown — the parent must still get a reply.
 */
import { sendText as sendWhatsApp } from './uazapi.ts';
import { sendSms } from './twilio.ts';
import type { Lead } from './store.ts';

export async function notifyOwner(
  { lead, kind, reason }: {
    lead: Partial<Lead> & { channel?: string; phone?: string };
    kind: 'LEAD_QUALIFIED' | 'HUMAN_HANDOFF';
    reason?: string | null;
  },
): Promise<void> {
  const lines = [
    kind === 'LEAD_QUALIFIED' ? '⚽ New QUALIFIED LEAD (Soccer Flow)' : '🙋 HUMAN HANDOFF REQUEST (Soccer Flow)',
    `Channel: ${lead.channel}`,
    `Phone: ${lead.phone}`,
    `Parent: ${lead.parentName || '-'}`,
    `Child: ${lead.childName || '-'}`,
    `Age: ${lead.childAge || '-'}`,
    `Program: ${lead.program || '-'}`,
    `Preferred: ${lead.preferredTime || '-'}`,
  ];
  if (reason) lines.push(`Reason: ${reason}`);
  const summary = lines.join('\n');

  const tasks: Promise<void>[] = [];

  const ownerWhatsApp = Deno.env.get('OWNER_WHATSAPP_NUMBER');
  if (ownerWhatsApp) {
    tasks.push(
      sendWhatsApp(ownerWhatsApp, summary).catch((err) => {
        console.error('[notify] WhatsApp to owner failed:', err.message);
      }),
    );
  } else {
    console.warn('[notify] OWNER_WHATSAPP_NUMBER not set, skipping WhatsApp notification');
  }

  const ownerSms = Deno.env.get('OWNER_SMS_NUMBER');
  if (ownerSms) {
    tasks.push(
      sendOwnerSms(summary).catch((err) => {
        console.error('[notify] SMS to owner failed:', err.message);
      }),
    );
  } else {
    console.warn('[notify] OWNER_SMS_NUMBER not set, skipping SMS notification');
  }

  await Promise.all(tasks);
}

async function sendOwnerSms(text: string): Promise<void> {
  const from = Deno.env.get('TWILIO_PHONE_NUMBER');
  const to = Deno.env.get('OWNER_SMS_NUMBER');
  if (!Deno.env.get('TWILIO_ACCOUNT_SID') || !Deno.env.get('TWILIO_AUTH_TOKEN') || !from || !to) {
    throw new Error('Twilio env vars (SID / token / TWILIO_PHONE_NUMBER) not set');
  }
  await sendSms({ from, to, body: text });
}
