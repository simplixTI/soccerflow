# Soccer Flow — Status

Last update: **2026-10-16** (rebuild on top of the owner's knowledge package)

## Source of truth
The owner's package `C:\Users\GalaxyBook3\Downloads\Soccer_Flow_RAG_2026-10-15` (17 records, PT) is the source of truth. Everything in this repo was aligned to it; where ours differed, ours was changed. Our own entries are the bot-operational layer (how to phrase, what never to claim, flows).

Changes it forced: **Wednesday classes** (Juniors + Academy 5 PM, no Explorers yet), **Halloween Kick & Treat on Saturday 10/17/2026** replaces normal classes, trial booking must **not claim the child is on the list** (a human adds them), cancellation notice period is **not a firm 30 days**, street address **2455 Cushing Rd, 92106, meet near the playground** (never 2640 Historic Decatur), **no emojis at all**, card only on PushPress (no cash), referral promo 30% (subject to confirmation), team (Lucas head coach, Juliana, Gabriel), expansion areas under consideration (Chula Vista, Mission Valley, Carlsbad, Friday slot: never announced as open), privacy, congratulate after enrollment, ask age before prices on first contact.

## 🟢 Live in production

### LLM
| | |
|---|---|
| Model | **OpenAI gpt-4o** (secret `OPENAI_CHAT_MODEL`; `gpt-4o-mini` cuts cost ~15x) |
| Fallback | none. DeepSeek removed. On failure the bot stays silent; the customer message is already persisted. |
| Timeout | 25s |
| Output sanitizer | `sanitizeReply()` in `_shared/deepseek.ts` strips em/en dashes and **every emoji** from each reply before sending, regardless of the model. Keeps paragraph breaks (only runs of spaces are collapsed). |
| Reply format | House style = the ad greeting: short paragraphs separated by one blank line, one idea each, the question **alone in the last paragraph**. Prompt rule with 3 examples + `isolateTrailingQuestion()` in `_shared/deepseek.ts` enforces the lone question in code when the model glues it to the previous paragraph. |

### System prompt (`_shared/brain.ts` → `buildSystemPrompt`)
identity → **8 ABSOLUTE RULES** (no emoji/dash, dates only from anchor, no invention, memory, exact links, **never claim something was done**, privacy, silence beats a wrong answer) → **TIME ANCHOR**: pre-resolved 8-day calendar in `America/Los_Angeles` with class days and **SPECIAL EVENT days from `business.json 03_schedule.special_dates`** → conversation state + history rules → `business.json` → team teachings → flow rules → JSON format → **FINAL CHECK**.

### Knowledge
| Layer | What |
|---|---|
| **business.json** | Base facts rebuilt from the owner's package: 3 class days, special_dates, full address, 4 enrollment links, pin, sibling pricing, billing, policies, team, referral, privacy, style forbidden list. No TODOs. |
| **KB policies** (`style`, `correction`) | Always injected in full. Includes the owner's "Diretrizes de atendimento" and "Restrições" verbatim. |
| **KB facts** (`faq`, `business`) | Vector search, top 8 above 0.25. Includes the owner's 14 topic records verbatim (PT) plus our 35 English Q&A. |
| Seed | **65 entries** (4 style, 11 correction, 36 faq, 14 business), 28K chars, 92 chunks. `scripts/kb-seed.json` → `node scripts/seed-kb.mjs --wipe` → `node scripts/backfill-kb-embeddings.mjs` |

Owner adds entries on `/admin` → indexed immediately (`_shared/kb-index.ts`); page shows "Salvo e indexado (N trechos)". Delete cascades.

### Behaviors
| Feature | Behavior |
|---|---|
| Special event / holiday dates | `business.json 03_schedule.special_dates` (US `M/D/YYYY`). Shown in the anchor table; the bot says the schedule is different and the team confirms the time. Requires a deploy to change. |
| Trial booking | needs name, age, day. Confirms weekday+date+time+Liberty Station and says the info is being **sent to the team** to add to the attendance list. Never "reserved"/"on the list". LEAD_QUALIFIED notifies the owner. |
| Human-like delay | first reply ~10s, then 5–10s. The wait happens BEFORE the model call and doubles as the burst window. |
| Burst debouncing | each incoming message is persisted immediately with an id; after the wait, only the invocation holding the latest customer message answers, with the whole burst in context → one reply covering everything (fixes the duplicated location/schedule replies when a parent sends 3 messages in a row). |
| Ad first contact | "Hi! I'd like to learn more about Soccer Flow and how it works." (and close variants) on a brand-new conversation gets a fixed template, no model call: intro + "ages 2-11" + warm ask for the child's age. `AD_OPENER_REPLY` in `_shared/brain.ts`. |
| Reactions | ignored |
| API echo filter | bot's own messages coming back are dropped (was causing bogus auto-takeovers) |
| Auto-takeover | owner types in a chat → bot silent **4h** (`TAKEOVER_TTL_HOURS=4`) |
| Opt-out | STOP keywords → permanent; owner `/parar` / `/reativar` |
| Lockdown allowlist | `ALLOWLIST_PHONES` (comma-separated digits). **Currently not set: bot open to everyone** (lifted 2026-10-16 after the owner's live test, 60 messages, all clean). Set it to lock down again. |
| Time anchor clock | San Diego time computed manually (UTC-7/-8 with US DST rules) and formatted as UTC, independent of the runtime's timezone data. `GET /functions/v1/admin/api/anchor` (admin key) shows the exact anchor the bot receives. |
| Instagram | at a natural goodbye, one invitation to follow the official profile with the exact link `https://www.instagram.com/soccerflowus?exln=YzRwOGRqeHhnbjRk`, never repeated, never before answering. |
| Identity | "a member of the Soccer Flow team's assistant helping with messages"; never claims to be Coach Lucas; does not deny being an AI if asked directly. |
| Memory | last 60 messages; customer message persisted before the LLM call |
| Off-topic | friendly redirect in the message's language |
| Payments / refunds / cancellations / list | never confirmed or denied by the bot; "I'll check with the team" + handoff |

### Admin (`/admin`)
KB add/list/delete with instant indexing · API balance card (DeepSeek prepaid, OpenAI key status + billing link).

## ✅ Verified 2026-10-16 on gpt-4o (synthetic end-to-end)
New lead · location (full address, playground, exact pin, no old address) · "what day is it / class tomorrow" (correct SD weekday+date) · trial booking (date, time, no redundant confirmation) · **booking on the Halloween day** (says event, no 10 AM, no "reserved", team confirms) · **Wednesday Juniors yes** · **Wednesday Explorers no** (offers Mon/Sat) · second-turn memory · payment (no confirmation) · "too far" (no re-ask, no promised location) · plans + sibling · **cancellation (no "30 days")** · off-topic redirect. Zero dashes, zero emoji, nothing invented.

## 📞 Commands & keywords
Customer opt-out: `STOP` `UNSUBSCRIBE` `CANCEL` `QUIT` `OPTOUT` · `PARAR` `CANCELAR` `SAIR` `DESCADASTRAR` · `DETENER` `BAJA`. Back: `START` `VOLTAR` `EMPEZAR`.
Owner in the chat: `/assumir` (4h) · `/voltar` · `/parar` (permanent) · `/reativar`.

## 🏗️ Architecture
```
WhatsApp (uazapi) / SMS (Twilio) → Edge Function → _shared/brain.ts handleIncoming
  allowlist? opt-out? STOP? takeover? → appendMessages(user)
  → policy chunks (all) + embed(msg) → match_kb_chunks (top 8)
  → buildSystemPrompt (rules + anchor w/ special dates + business.json + KB + flows + final check)
  → openai.chat gpt-4o → parseModelOutput → sanitizeReply → clipReply
  → appendMessages(assistant) → upsertLead → notifyOwner
Postgres: conversations · leads · kb_entries · kb_chunks (pgvector hnsw) · takeovers · opt_outs
```

## 💰 Cost
gpt-4o ~$50–150/mo (mini ~$5–15) · embeddings < $0.10 · DeepSeek $0 (unused, $7.61 prepaid) · Supabase free tier.

## 🔑 Secrets
`OPENAI_API_KEY` · `OPENAI_CHAT_MODEL=gpt-4o` · `ALLOWLIST_PHONES` · `TAKEOVER_TTL_HOURS=4` · `ADMIN_TOKEN` · `UAZAPI_*` · `TWILIO_*` · `DEEPSEEK_*` (unused)

## 🛠️ Operations
- **Open the bot to everyone**: `supabase secrets unset ALLOWLIST_PHONES` (PAT with `edge_functions_write`).
- **Add an event or holiday**: add `{ "date": "M/D/YYYY", "name": "...", "note": "..." }` to `03_schedule.special_dates` in `_shared/business.json`, deploy `uazapi-webhook` + `twilio-webhook`. It appears in the TIME ANCHOR automatically. Remove it after the date.
- **Teach the bot without a deploy**: `/admin` → category `correction` for "when X, do Y", `faq` for Q&A, `business` for facts, `style` for tone.
- **Re-seed KB**: `node scripts/seed-kb.mjs --wipe && node scripts/backfill-kb-embeddings.mjs` (env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`).
- **New owner package**: drop records into `scripts/kb-seed.json` (the owner's block is at the end, prefixed `[Soccer Flow, fonte oficial …]`), then re-seed.
- **Deploy**: `supabase functions deploy uazapi-webhook && supabase functions deploy twilio-webhook && supabase functions deploy admin`.
- **Clear a takeover**: `/voltar` in the chat.
- **Full KB dump PDF**: `python scripts/generate-kb-full-pdf.py` → `soccerflow-rag-full.pdf`.

## ⚠️ Known
- Owner's personal phone `16195304777` is used as a scratchpad; its history is noise.
- On a special event day the structured `leads.preferred_time` still stores the normal class time (e.g. "Saturday 10:00 AM") even though the reply correctly says the time is TBC. Cosmetic; the owner notification carries the conversation.
- `soccerflow-rag-summary.pdf` is stale; use `soccerflow-rag-full.pdf`.
- Rotate the OpenAI key and the Supabase PAT that were pasted in chat.
