/**
 * Conversation brain (port of bot/src/brain.js).
 * Shared conversation logic used by both SMS and WhatsApp channels.
 */
import { chat as chatOpenAI, embed } from './openai.ts';
import {
  getHistory,
  appendMessages,
  findLead,
  upsertLead,
  markLeadNotified,
  isTakeover,
  setTakeover,
  clearTakeover,
  isOptedOut,
  setOptOut,
  clearOptOut,
  getKbPromptSection,
  matchKbChunks,
  getPolicyChunks,
  renderChunks,
  type Lead,
  type ChatMessage,
} from './store.ts';
import { notifyOwner } from './notify.ts';
import business from './business.json' with { type: 'json' };

/**
 * RAG retrieval. Embeds the customer's current message, pulls the top chunks
 * from kb_chunks, and renders them as the KB prompt section. Falls back to the
 * legacy "dump whole KB" path if the vector search is unavailable (OpenAI down,
 * migration not run yet, etc.) so the bot never loses its KB entirely.
 */
async function retrieveKbSection(queryText: string): Promise<string> {
  try {
    // Policies (style + correction) are ALWAYS included — they're owner rules
    // that override everything and shouldn't depend on semantic match.
    // Facts (business + faq) go through vector search, scoped to what the
    // customer actually asked about.
    const [policies, queryEmbedding] = await Promise.all([
      getPolicyChunks(),
      embed(queryText),
    ]);
    const facts = await matchKbChunks(queryEmbedding, { count: 8, minSimilarity: 0.25 });
    const combined = [...policies, ...facts];
    if (combined.length) {
      console.log(
        `[brain] RAG: ${policies.length} policy chunks + ${facts.length} fact chunks` +
        (facts.length ? ` (top fact sim ${facts[0].similarity.toFixed(2)})` : ''),
      );
      return renderChunks(combined);
    }
    console.warn('[brain] RAG returned 0 chunks; falling back to full KB dump');
  } catch (err) {
    console.error('[brain] RAG retrieval failed, falling back:', (err as Error).message);
  }
  return getKbPromptSection();
}

/**
 * LLM call — OpenAI gpt-4o-mini only. DeepSeek was removed after it kept
 * returning wrong answers and gave the owner a bad experience; we'd rather
 * stay silent (silent fallback in handleIncoming's catch) than reply with
 * a wrong answer from a second-tier model.
 */
async function chatWithFallback(
  args: { systemPrompt: string; messages: ChatMessage[] },
) {
  return await chatOpenAI(args);
}

const FALLBACK_REPLY =
  "Hi! Thanks for texting Soccer Flow ⚽ We're having a little technical hiccup — " +
  'the coach will get back to you shortly. You can also call us at ' +
  // Note: the original brain.js read `business.phone`, which does not exist
  // in business.json, so this was always the fallback text. Kept as-is.
  (((business as unknown) as Record<string, unknown>).phone || 'our number') + '.';

// Exact-match stop keywords (case + punctuation insensitive). Short set on
// purpose — fuzzy requests ("please stop texting me") the owner handles via
// takeover or by sending /parar themselves. Keeps the opt-out intentional.
const STOP_KEYWORDS = new Set([
  // English (SMS compliance standard)
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt out',
  // Portuguese
  'parar', 'cancelar', 'sair', 'descadastrar', 'descadastre', 'remover',
  // Spanish
  'detener', 'baja', 'cancelar suscripcion',
]);

const STOP_CONFIRMATION =
  "Got it — we won't message you from this number again. " +
  'If you change your mind, text START anytime and the Soccer Flow team will help you. ⚽';

const RESUBSCRIBE_KEYWORDS = new Set([
  'start', 'yes', 'unstop',
  'voltar', 'reativar',
  'empezar', 'reactivar',
]);

function normalizeKeyword(raw: string): string {
  return raw.trim().toLowerCase().replace(/[.!?,;:¡¿]/g, '').replace(/\s+/g, ' ');
}

function isStopKeyword(text: string): boolean {
  return STOP_KEYWORDS.has(normalizeKeyword(text));
}

function isResubscribeKeyword(text: string): boolean {
  return RESUBSCRIBE_KEYWORDS.has(normalizeKeyword(text));
}

/**
 * Emergency lockdown allowlist. When ALLOWLIST_PHONES env var is set
 * (comma-separated), ONLY those phones get bot replies — everyone else gets
 * silence. Normalizes to digits only so "+1 (858) 445-4126" and "18584454126"
 * both match. Empty / unset env var = allowlist off, bot responds normally.
 */
function isAllowed(phone: string): boolean {
  const raw = Deno.env.get('ALLOWLIST_PHONES');
  if (!raw || !raw.trim()) return true; // allowlist disabled
  const normalize = (s: string) => s.replace(/\D/g, '');
  const allowed = raw.split(/[,;\s]+/).map(normalize).filter(Boolean);
  return allowed.includes(normalize(phone));
}

/**
 * San Diego wall-clock time computed WITHOUT relying on the runtime's IANA
 * timezone support. America/Los_Angeles is UTC-7 during US daylight time
 * (second Sunday of March 2:00 -> first Sunday of November 2:00) and UTC-8
 * otherwise. We shift the instant by that offset and then format it as UTC,
 * which every JS runtime supports. A customer was told "today is Friday"
 * while it was still Thursday 9 PM in San Diego; this makes the anchor
 * deterministic no matter where the edge function runs.
 */
function laOffsetHours(utcMs: number): number {
  const y = new Date(utcMs).getUTCFullYear();
  const nthSunday = (month: number, n: number): number => {
    const firstDow = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return 1 + ((7 - firstDow) % 7) + 7 * (n - 1);
  };
  const dstStart = Date.UTC(y, 2, nthSunday(2, 2), 10, 0, 0);  // 2:00 AM PST = 10:00 UTC
  const dstEnd = Date.UTC(y, 10, nthSunday(10, 1), 9, 0, 0);   // 2:00 AM PDT = 09:00 UTC
  return utcMs >= dstStart && utcMs < dstEnd ? 7 : 8;
}

/** Returns a Date whose UTC fields equal San Diego's local wall-clock fields. */
function laClock(utcMs: number): Date {
  return new Date(utcMs - laOffsetHours(utcMs) * 3_600_000);
}

function fmt(d: Date, opts: Intl.DateTimeFormatOptions): string {
  return d.toLocaleString('en-US', { timeZone: 'UTC', ...opts });
}

/** Exposed for the admin diagnostic endpoint. */
export function currentTimeAnchor(): string {
  return buildTimeAnchor();
}

/**
 * Ground the LLM in the real San Diego date/time AND hand it a pre-computed
 * 8-day calendar. The model never does date arithmetic: it looks the day up.
 */
function buildTimeAnchor(): string {
  const now = laClock(Date.now());
  const today = fmt(now, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const todayShort = fmt(now, { month: 'numeric', day: 'numeric', year: 'numeric' });
  const time = fmt(now, { hour: 'numeric', minute: '2-digit', hour12: true });

  const classDays: Record<string, string> = {
    Monday: 'CLASS DAY (Explorers 4 PM, Juniors 5 PM, Academy 5 PM)',
    Wednesday: 'CLASS DAY (Juniors 5 PM, Academy 5 PM; NO Explorers on Wednesdays)',
    Saturday: 'CLASS DAY (Explorers 9 AM, Juniors 10 AM, Academy 11 AM)',
  };
  // Date-specific overrides from business.json (events, holidays). Keyed by
  // US date "M/D/YYYY" so the owner writes them the same way customers do.
  const special: Record<string, string> = {};
  for (const s of (business['03_schedule'].special_dates || [])) {
    special[s.date] = `SPECIAL EVENT: ${s.name}. ${s.note}`;
  }
  const lines: string[] = [];
  let nextSaturday = '';
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    const wd = fmt(d, { weekday: 'long' });
    const md = fmt(d, { month: 'numeric', day: 'numeric' });
    const mdy = fmt(d, { month: 'numeric', day: 'numeric', year: 'numeric' });
    if (wd === 'Saturday' && !nextSaturday && i > 0) nextSaturday = md;
    const label = i === 0 ? 'TODAY' : i === 1 ? 'TOMORROW' : '';
    const cls = special[mdy]
      ? ` -> ${special[mdy]}`
      : classDays[wd] ? ` -> ${classDays[wd]}` : ' -> no class';
    lines.push(`  ${wd} ${md}${label ? ' (' + label + ')' : ''}${cls}`);
  }

  return `TIME ANCHOR (San Diego, America/Los_Angeles). This is the ONLY source of truth for dates.
Right now it is ${today} (${todayShort}), ${time} local time in San Diego.

Next 8 days, already resolved for you. LOOK UP the day here, never calculate it yourself:
${lines.join('\n')}

Date rules:
- TODAY IS ALWAYS the line marked (TODAY) above: ${today}. If you write "today is", it must be exactly that weekday and date. The customer's greeting or wording NEVER changes the date: if they say "good morning" at 9 PM, or "see you tomorrow" or any other hint, the anchor still wins. Do not roll the date forward or backward for any reason.
- Do not echo time-of-day greetings. If the customer says "good morning", "good evening" or similar, reply with a neutral "Hi!" or "Hello!" and never state a time of day yourself.
- "today", "tomorrow", "this Saturday", "next Monday", "this weekend" MUST be resolved using the table above.
- Always write the weekday AND the date together, US order month/day. Example: "Saturday, ${nextSaturday || '10/18'} at 10 AM".
- Birthdays and any date the customer writes are US format month/day/year. "5/3/2020" means May 3, 2020.
- The weekly pattern is Mondays, Wednesdays and Saturdays, every week (no Explorers on Wednesdays). Do not add classes on other days. Do not cancel a class on your own. If a class is affected by weather or a holiday, the team tells the family; you only say the team will confirm.
- A day marked SPECIAL EVENT above replaces the normal classes that day: say the schedule is different and the team confirms the exact time for the child's group. Never quote a normal class time for that date.`;
}

/**
 * System prompt. Structure is deliberate for GPT-4o:
 *   1. identity              (short)
 *   2. ABSOLUTE RULES        (primacy: the six things that lost us customers)
 *   3. time anchor           (pre-resolved calendar)
 *   4. conversation state    (what is already known / locked)
 *   5. knowledge base        (business.json)
 *   6. team teachings        (KB chunks: policies always + retrieved facts)
 *   7. flow rules            (what to do in each situation)
 *   8. output format
 *   9. FINAL CHECK           (recency: repeat the absolute rules)
 */
function buildSystemPrompt(lead: Lead | null, kbSection: string, hasHistory: boolean): string {
  const leadJson = lead
    ? JSON.stringify({
        parentName: lead.parentName,
        childName: lead.childName,
        childAge: lead.childAge,
        program: lead.program,
        preferredTime: lead.preferredTime,
        state: lead.state,
      })
    : null;

  const conversationState = lead
    ? `RETURNING CONTACT. Structured record so far: ${leadJson}.
Fields that are null here may still have been answered in the chat history (the team often replies by hand without updating the record). The chat history wins over this record.`
    : hasHistory
      ? `RETURNING CONTACT. You have talked with this family before; the whole conversation is in the message history below.`
      : `NEW CONTACT. Nothing is known about this family yet. Greet warmly, answer what they asked, and find out the child's age early.`;

  const historyRules = hasHistory
    ? `
HOW TO USE THE HISTORY (hard rule):
1. Before writing, silently list what is already RESOLVED in the history: child's name, age, parent's name, program, chosen day, trial booked or not, questions already answered, links already sent, anything the team said by hand.
2. Every resolved item is LOCKED. Never ask it again. Never offer the trial again if it is booked. Never resend a price or a link that is already in the history.
3. Messages marked as assistant that you did not write were typed by a human teammate. They are the truth. Continue from where they left off, never contradict them, never restart.
4. If unsure whether something was resolved, re-read the last 15 messages. When in doubt, trust the history.`
    : '';

  const teachings = kbSection
    ? `\n\nTEAM TEACHINGS. Written by the Soccer Flow team. They are authoritative and override the knowledge base when they differ:\n${kbSection}`
    : '';

  return `You are a member of the Soccer Flow team answering parents on WhatsApp and SMS. Soccer Flow is a youth soccer program in San Diego, California, for kids ages 2 to 11. You sound like a real, warm, concise person. Never like a bot, never corporate.

ABSOLUTE RULES. Breaking any of these is a failure, no matter what else you get right:
1. TYPOGRAPHY. No emojis at all (unless the customer explicitly asks for them). Never write the em dash or the en dash (the long horizontal dash characters). Use commas, periods, or the word "and". Wrong: "Yes, that's fine — once the payment clears". Right: "Yes, that's fine. Once the payment clears".
2. DATES. Only use the TIME ANCHOR below. Never guess what day it is. Always write weekday plus date in US month/day order, like "Saturday, 10/24". A birthday written as 5/3/2020 means May 3, 2020. On a SPECIAL EVENT day, never quote the normal class time.
3. FACTS. Only say what is in the KNOWLEDGE BASE or TEAM TEACHINGS below. Never invent a price, time, address, link, discount, policy, availability, new location or opening date. If it is not there, say you will check with the team and set handoff.
4. MEMORY. Never ask for something the customer already told you in this conversation. Read the history first.
5. LINKS. Only the exact Google Maps pin and the four enrollment links from the knowledge base, pasted verbatim. Never create, shorten or change a link.
6. NEVER CLAIM SOMETHING WAS DONE. Do not say a child is on the attendance list, a spot is reserved, a payment was received, or a refund or cancellation was processed. A human does those. Say you are sending the info to the team, or that you will check.
7. PRIVACY. Never share other children's names, phone numbers, health info, attendance lists, contracts, or anything about the staff beyond their first names and roles.
8. SILENCE BEATS A WRONG ANSWER. If you are not sure, say you will confirm. A short honest "let me check that for you" is always better than a confident guess.

${buildTimeAnchor()}

CONVERSATION STATE:
${conversationState}${historyRules}

KNOWLEDGE BASE (base facts, always true unless a team teaching says otherwise):
${JSON.stringify(business, null, 2)}${teachings}

FLOW RULES:
- Language: mirror the customer (English, Spanish or Portuguese). Default English. Switch only if they switch.
- Length: one to three short sentences. One question per message. Answer what was asked first, then move one step forward. Never dump everything at once. Always end on a complete sentence.
- Identify who is writing: a new family, a current member, a family with a trial already booked, or something else. Use the conversation state before asking anything.
- New family: find out the child's age early (ask warmly, explain it helps you recommend the right program and time). Recommend the program from age_to_program_rule, give the days and times for that program only, and offer the free trial without pressure.
- Booking the trial: you need child's name, child's age and the chosen day (Monday, Wednesday or Saturday, if that day has a class for the age group). The parent naming a day while asking to try ("can he come Saturday?", "let's do Monday", "yes, Saturday") counts as choosing it. The time comes from the age and the day, never ask for it. Do NOT ask for the parent's name before booking. Do NOT ask "can I reserve it?" or "shall I book it?". When all three are known, send one message with: the child's name, the weekday AND the date from the TIME ANCHOR (for example "Saturday, 10/24"), the time, Liberty Station, and that you are sending the child's info to the team to add them to the attendance list (never say they ARE on the list or that the spot IS reserved, a human does that). Then: arrive 5 to 10 minutes early to meet the coach near the playground, comfortable clothes, cleats optional, bring a water bottle. If that date is a SPECIAL EVENT in the TIME ANCHOR, say the schedule is different that day and the team will confirm the exact time for the child's group instead of quoting the normal time. Set state LEAD_QUALIFIED (this notifies the team) and preferredTime like "Saturday 10:00 AM". If one of the three is missing, ask only for that one item.
- Already booked: never offer another trial. Help reschedule only if they ask.
- Questions about price, schedule, location, policies: answer only from the knowledge base and teachings. For location, always paste the Google Maps pin.
- Enrollment: only after the trial and when the parent says they want to continue. First present the two plans briefly and ask which one. Then send only the matching link.
- Distance, hesitation, discounts, competitive team, weather, holidays, what to bring, languages, experience: follow the knowledge base sections 05 to 10 exactly.
- Hand off (handoff=true) for anything in 11_human_escalation, when the customer asks for a person, is upset, or when you are not sure. Say naturally that you will check and get back, never "our team will contact you" as a filler.
- Do not close the conversation with "have a great day" or "let us know if you need anything" while there is still something to help with.
- When the conversation is naturally ending (the parent says bye, thanks, has no more questions, will think about it or will talk to someone), add ONE short, friendly invitation to follow the official Instagram so they stay connected with the programs and get updates on classes, events and new locations, pasting this exact link: https://www.instagram.com/soccerflowus?exln=YzRwOGRqeHhnbjRk . Only after answering what they asked, only once per conversation, never if that link already appears in the history, never as pressure.
- Off-topic, unclear, forwarded or accidental messages (random text, a pasted note, a sticker description, something unrelated to soccer): never reply with a canned refusal like "I can't assist with that". Answer like a person would, in the same language the message was written in: a short friendly line asking what they need, for example "Hey! Not sure I caught that. Are you asking about classes for your child?". If it is clearly a wrong-number message, say so kindly.
- Payments and billing: you cannot see payments. If asked whether a payment went through, say you will check with the team and confirm, and set handoff. Never confirm or deny a payment yourself.

OUTPUT FORMAT. Reply with strict JSON only, no markdown, nothing outside the JSON:
{"reply": "...", "state": "QUESTION|LEAD_IN_PROGRESS|LEAD_QUALIFIED|HUMAN_HANDOFF", "lead": {"parentName": null, "childName": null, "childAge": null, "program": null, "preferredTime": null}, "handoff": false, "handoff_reason": null}
- "lead" carries forward everything known so far; null only for unknown fields. "program" follows age_to_program_rule. "preferredTime" is the chosen day plus the class time, like "Saturday 10:00 AM".
- state LEAD_QUALIFIED when name, age, day and a clear yes are all known. handoff is true for LEAD_QUALIFIED and HUMAN_HANDOFF.

FINAL CHECK before you answer. Read your reply once and confirm:
- no emoji, no long dash characters
- every date matches the TIME ANCHOR table and is written weekday plus month/day; if you wrote "today is", it is exactly the (TODAY) line; no normal class time quoted on a SPECIAL EVENT day
- nothing was invented, every fact exists above
- you did not claim a reservation, list entry, payment, refund or cancellation was done
- you did not ask something already answered in the history
- any link or address is pasted exactly as it appears in the knowledge base
If any check fails, fix the reply before returning it.`;
}

/**
 * Shared conversation logic used by both SMS and WhatsApp channels.
 * Returns the reply text to send back to the parent, or null when the bot
 * must stay silent (human takeover active). Never throws.
 */
export async function handleIncoming(
  { channel, phone, text }: { channel: string; phone: string; text: string },
): Promise<string | null> {
  try {
    // ALLOWLIST (emergency lockdown mode): when ALLOWLIST_PHONES env var is set
    // (comma-separated digits), the bot only responds to those phones. Every
    // other message is persisted but silently ignored. Owner clears the env
    // var when the lockdown is over.
    if (!isAllowed(phone)) {
      await appendMessages(channel, phone, [{ role: 'user', content: text }]);
      console.log(`[brain] allowlist blocked ${channel}:${phone} — staying silent`);
      return null;
    }

    // OPT-OUT branch: customer previously said STOP. Record every incoming
    // message for compliance/history, stay silent — unless they explicitly
    // resubscribe (START/VOLTAR/EMPEZAR), in which case clear the opt-out and
    // let the normal flow continue below.
    if (await isOptedOut(channel, phone)) {
      await appendMessages(channel, phone, [{ role: 'user', content: text }]);
      if (isResubscribeKeyword(text)) {
        await clearOptOut(channel, phone);
        const resumed = "Welcome back to Soccer Flow ⚽ How can we help you today?";
        await appendMessages(channel, phone, [{ role: 'assistant', content: resumed }]);
        console.log(`[brain] RESUBSCRIBE from ${channel}:${phone} — opt-out cleared`);
        return resumed;
      }
      console.log(`[brain] opt-out active for ${channel}:${phone} — staying silent`);
      return null;
    }

    // STOP KEYWORD: register opt-out immediately and send one compliance
    // confirmation. Covers English, Spanish and Portuguese stop words plus the
    // standard SMS compliance set. Case/punctuation insensitive, exact match
    // on the trimmed message (so "stop sending me the invoice" is NOT an opt-out).
    if (isStopKeyword(text)) {
      await appendMessages(channel, phone, [{ role: 'user', content: text }]);
      await setOptOut(channel, phone, 'customer_keyword');
      const confirm = STOP_CONFIRMATION;
      await appendMessages(channel, phone, [{ role: 'assistant', content: confirm }]);
      console.log(`[brain] STOP keyword from ${channel}:${phone} — opted out`);
      return confirm;
    }

    // Human takeover: the owner is handling this conversation manually.
    // Record the parent's message for context but stay silent.
    if (await isTakeover(channel, phone)) {
      await appendMessages(channel, phone, [{ role: 'user', content: text }]);
      console.log(`[brain] takeover active for ${channel}:${phone} — staying silent`);
      return null;
    }

    // Record the customer's message FIRST so it never gets lost if the LLM
    // call fails — the DB is the source of truth for conversation history.
    await appendMessages(channel, phone, [{ role: 'user', content: text }]);

    const existingLead = await findLead(channel, phone);
    const history = await getHistory(channel, phone); // includes the message we just appended
    const kbSection = await retrieveKbSection(text);

    const result = await chatWithFallback({
      // history.length > 1 because the current message is now in the buffer;
      // "has prior context" only when there is at least one older message too.
      systemPrompt: buildSystemPrompt(existingLead, kbSection, history.length > 1),
      messages: history,
    });

    // Persist the bot's reply.
    await appendMessages(channel, phone, [{ role: 'assistant', content: result.reply }]);

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
    // Stay SILENT on failure — any auto-reply we send is likely to be a
    // "technical hiccup" message that alarms a parent for no reason. The
    // customer's message is already persisted (we append it before the LLM
    // call), so the owner can see it in the chat history and reply manually
    // from WhatsApp. Log the full error for diagnostics.
    const e = err as Error;
    console.error(
      `[brain] error handling ${channel}:${phone}:`,
      e?.message,
      e?.stack ? '\n' + e.stack.split('\n').slice(0, 5).join('\n') : '',
    );
    return null;
  }
}

const TAKEOVER_REPLY =
  "You're now chatting directly with the Soccer Flow team ⚽ We'll take it from here!";
const RESUME_REPLY =
  'Thanks for your patience! Our assistant is back and happy to help ⚽';

/**
 * Handle a message sent BY the business number itself (owner typing in the
 * customer chat, delivered via the uazapi fromMe webhook).
 *
 * Commands:
 *   /assumir — owner takes over explicitly; the AI goes silent
 *   /voltar  — AI resumes control immediately
 *
 * AUTO-TAKEOVER: any non-command owner message was typed manually (bot API
 * replies are excluded at the webhook level via wasSentByApi), so it also
 * triggers a takeover: the AI goes silent and the message is recorded as
 * assistant context for when the AI resumes — via /voltar or automatically
 * when the takeover TTL (TAKEOVER_TTL_HOURS, default 24h) expires.
 *
 * Returns a customer-facing message to send into the chat, or null.
 */
export async function handleOwnerMessage(
  { channel, phone, text }: { channel: string; phone: string; text: string },
): Promise<string | null> {
  try {
    const cmd = text.trim().toLowerCase();
    if (cmd === '/assumir' || cmd === '/takeover') {
      await setTakeover(channel, phone);
      console.log(`[brain] takeover ON (explicit) for ${channel}:${phone}`);
      return TAKEOVER_REPLY;
    }
    if (cmd === '/voltar' || cmd === '/resume') {
      await clearTakeover(channel, phone);
      console.log(`[brain] takeover OFF for ${channel}:${phone}`);
      return RESUME_REPLY;
    }
    // Owner-forced opt-out for this customer (bot never writes them again).
    if (cmd === '/parar' || cmd === '/optout' || cmd === '/stop') {
      await setOptOut(channel, phone, 'owner_command');
      console.log(`[brain] opt-out set by owner for ${channel}:${phone}`);
      return null; // no customer-facing message — the owner is already in the chat
    }
    // Owner reverses a prior opt-out so the bot can engage again.
    if (cmd === '/reativar' || cmd === '/optin') {
      await clearOptOut(channel, phone);
      console.log(`[brain] opt-out cleared by owner for ${channel}:${phone}`);
      return null;
    }
    // Not a command: manual owner message → automatic takeover.
    await setTakeover(channel, phone);
    await appendMessages(channel, phone, [{ role: 'assistant', content: text }]);
    console.log(`[brain] auto-takeover for ${channel}:${phone} (owner typed manually)`);
    return null;
  } catch (err) {
    console.error(`[brain] error handling owner message for ${channel}:${phone}:`, (err as Error).message);
    return null;
  }
}
