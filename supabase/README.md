# Soccer Flow Bot — Supabase Edge Functions

The Soccer Flow first-contact bot (SMS via Twilio + WhatsApp via uazapi), ported
from the Node.js/Express version in `../bot/` to Supabase Edge Functions (Deno)
with Postgres storage. The `bot/` folder is kept as reference only; data now
lives in Postgres and persists across deploys (unlike the old lowdb JSON file).

## Layout

- `functions/twilio-webhook` — SMS webhook (Twilio → bot, owner SMS commands)
- `functions/uazapi-webhook` — WhatsApp webhook (uazapi → bot, owner takeover)
- `functions/admin` — admin HTML page + knowledge-base JSON API
- `functions/_shared/` — shared modules (store, brain, deepseek, uazapi, twilio, notify, business.json)
- `migrations/` — database schema (conversations, leads, takeovers, kb_entries)
- `config.toml` — disables JWT verification for all three functions (required:
  the webhooks and the admin page carry no Supabase JWT)

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) ≥ 2.x installed
- `supabase login` (access token)
- A Supabase project — create an empty one at <https://supabase.com/dashboard>
  or reuse an existing one

## Setup

From the repository root:

```bash
# 1. Link the project (fills in config.toml)
supabase link --project-ref <your-project-ref>

# 2. Create the tables
supabase db push

# 3. Set the secrets
supabase secrets set \
  DEEPSEEK_API_KEY=sk-... \
  DEEPSEEK_MODEL=deepseek-chat \
  UAZAPI_BASE_URL=https://your-uazapi-instance \
  UAZAPI_TOKEN=... \
  TWILIO_ACCOUNT_SID=AC... \
  TWILIO_AUTH_TOKEN=... \
  TWILIO_PHONE_NUMBER=+1... \
  TWILIO_VALIDATE_SIGNATURE=true \
  OWNER_WHATSAPP_NUMBER=1... \
  OWNER_SMS_NUMBER=+1... \
  ADMIN_TOKEN=choose-a-strong-password \
  DEBUG_DEEPSEEK=

# 4. Deploy the functions (config.toml already disables JWT verification)
supabase functions deploy twilio-webhook uazapi-webhook admin
```

Notes:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by the
  edge runtime — do NOT set them yourself.
- `TWILIO_VALIDATE_SIGNATURE=false` skips signature checks (local dev only).
- `DEBUG_DEEPSEEK` (any non-empty value) logs raw DeepSeek responses.
- `DEEPSEEK_MODEL`, `TWILIO_VALIDATE_SIGNATURE` and `DEBUG_DEEPSEEK` are
  optional; the rest are required for full operation.

## Webhook URLs

After deploy, your endpoints are:

```
https://<ref>.supabase.co/functions/v1/uazapi-webhook
https://<ref>.supabase.co/functions/v1/twilio-webhook
https://<ref>.supabase.co/functions/v1/admin
```

### uazapi panel

Paste the `uazapi-webhook` URL into the instance webhook settings:

- Habilitado: **ON**, method **POST**
- addUrlEvents / addUrlTypesMessages: **OFF**
- Events: `messages` (exclude `wasSentByApi`, `isGroupYes`)

### Twilio console

Phone Number → Messaging → "A message comes in" → webhook:
`https://<ref>.supabase.co/functions/v1/twilio-webhook`, HTTP POST.

## Admin page (teach the AI)

Open in the browser:

```
https://<ref>.supabase.co/functions/v1/admin/
```

Enter the `ADMIN_TOKEN` in the password field (stored in localStorage). The
same knowledge base can also be fed by SMS from the owner number:
`/ensinar <fato|faq|estilo|correcao> <texto>`.

Owner takeover: on WhatsApp, **any message the owner types manually** in a
customer chat (phone or WhatsApp Web) automatically silences the AI in that
conversation — no command needed. The owner's messages are recorded as context
for when the AI resumes. Typing `/voltar` (or `/resume`) hands the conversation
back to the AI immediately; otherwise the takeover expires automatically after
`TAKEOVER_TTL_HOURS` (default 24h) of owner inactivity. `/assumir` still works
as an explicit takeover that also posts a transition message in the chat.
Via SMS, the owner texts the Twilio number: `/assumir +1XXX` / `/voltar +1XXX`.

## Debugging

```bash
supabase functions logs twilio-webhook
supabase functions logs uazapi-webhook
supabase functions logs admin
```

All functions log errors but never surface them to Twilio/uazapi (always 200),
so check logs when something looks silent.
