import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chat } from './deepseek.js';
import {
  getHistory,
  appendMessages,
  findLead,
  upsertLead,
  markLeadNotified,
} from './store.js';
import { notifyOwner } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const business = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'business.json'), 'utf8')
);

const FALLBACK_REPLY =
  "Hi! Thanks for texting Soccer Flow ⚽ We're having a little technical hiccup — " +
  'the coach will get back to you shortly. You can also call us at ' +
  (business.phone || 'our number') + '.';

function buildSystemPrompt(lead) {
  const knownLead = lead
    ? `Already collected from this parent: ${JSON.stringify({
        parentName: lead.parentName,
        childName: lead.childName,
        childAge: lead.childAge,
        area: lead.area,
        preferredTime: lead.preferredTime,
      })}`
    : 'Nothing collected from this parent yet.';

  return `You are the friendly SMS/WhatsApp assistant for "${business.name}", a youth soccer program in ${business.city}.

BUSINESS FACTS (never go beyond these):
${JSON.stringify(business, null, 2)}

BEHAVIOR RULES:
- Reply in English by default. If the parent writes in Spanish, reply entirely in natural, warm Spanish.
- Keep every reply SHORT: maximum 320 characters, ideally 1-3 sentences. This is SMS.
- Be warm, upbeat and parent-friendly. Occasional ⚽ emoji is fine.
- Classify the conversation state as exactly one of: QUESTION, LEAD_IN_PROGRESS, LEAD_QUALIFIED, HUMAN_HANDOFF.
- QUESTION: parent is just asking about the program. Answer using the facts above.
- A LEAD is a parent interested in booking the FREE first class. When you detect interest, start collecting, in a natural conversational way, ONE question at a time: parent name, child name, child age, neighborhood/area of San Diego, preferred day/time. Never ask for more than one field per message. Do not re-ask fields already collected.
- LEAD_QUALIFIED: all five fields are collected. Confirm warmly that the coach will reach out to book the free first class.
- NEVER invent prices, schedules, locations or policies not listed in the facts. If a fact is "TODO" or missing and the parent asks, say the coach will confirm it directly, set handoff=true with handoff_reason explaining what was asked.
- HUMAN_HANDOFF / handoff=true: the parent explicitly asks for a human, is upset, or you are unsure. Set handoff=true, reply that the coach will personally follow up soon.
- ${knownLead}

OUTPUT FORMAT: respond with STRICT JSON only, no markdown, no extra text:
{"reply": "...", "state": "QUESTION|LEAD_IN_PROGRESS|LEAD_QUALIFIED|HUMAN_HANDOFF", "lead": {"parentName": null, "childName": null, "childAge": null, "area": null, "preferredTime": null}, "handoff": false, "handoff_reason": null}
- In "lead", include every field known so far (carry forward previously collected values), null for missing ones.
- handoff must be true whenever state is LEAD_QUALIFIED or HUMAN_HANDOFF.`;
}

/**
 * Shared conversation logic used by both SMS and WhatsApp channels.
 * Returns the reply text to send back to the parent. Never throws.
 */
export async function handleIncoming({ channel, phone, text }) {
  try {
    const existingLead = await findLead(channel, phone);
    const history = await getHistory(channel, phone);

    const result = await chat({
      systemPrompt: buildSystemPrompt(existingLead),
      messages: [...history, { role: 'user', content: text }],
    });

    // Persist conversation turn.
    await appendMessages(channel, phone, [
      { role: 'user', content: text },
      { role: 'assistant', content: result.reply },
    ]);

    // Persist lead progress if the model captured anything or state is lead-ish.
    const hasLeadData = Object.values(result.lead).some((v) => v != null && v !== '');
    if (hasLeadData || result.state === 'LEAD_IN_PROGRESS' || result.state === 'LEAD_QUALIFIED') {
      await upsertLead(channel, phone, result.lead, result.state);
    }

    // Owner notification: LEAD_QUALIFIED (once per lead) or HUMAN_HANDOFF.
    const lead = await findLead(channel, phone);
    if (result.state === 'LEAD_QUALIFIED' && lead && !lead.ownerNotified) {
      await notifyOwner({ lead, kind: 'LEAD_QUALIFIED', reason: result.handoff_reason });
      await markLeadNotified(channel, phone);
    } else if (result.handoff && result.state === 'HUMAN_HANDOFF') {
      await notifyOwner({
        lead: lead || { channel, phone },
        kind: 'HUMAN_HANDOFF',
        reason: result.handoff_reason,
      });
    }

    return result.reply;
  } catch (err) {
    console.error(`[brain] error handling ${channel}:${phone}:`, err.message);
    return FALLBACK_REPLY;
  }
}
