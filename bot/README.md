# Soccer Flow Bot

SMS + WhatsApp auto-reply bot for **Soccer Flow**, a youth soccer program in San Diego, CA.
Powered by DeepSeek. Answers program questions, qualifies leads for the free first class
(parent name, child name, child age, neighborhood, preferred day/time), and notifies the
owner on qualified leads and human handoffs.

## Setup

```bash
cd bot
npm install
cp .env.example .env   # then fill in your values
```

Fill in `.env`:

- `DEEPSEEK_API_KEY` — create an account at <https://platform.deepseek.com>, add a small
  balance, then create an API key under "API keys".
- Twilio values from <https://console.twilio.com> (Account SID, Auth Token, your number).
- uazapi instance URL + token from your uazapi dashboard.
- Owner notification numbers.

## Run locally

```bash
npm start
# in another terminal, expose it publicly:
ngrok http 3000
```

Use the ngrok URL for the webhook configuration below.

## Deploy on Render (free tier)

1. Push this repo to GitHub.
2. In Render: **New → Web Service**, connect the repo, set the **Root Directory** to `bot`.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add every variable from `.env.example` in the Render dashboard (Environment).
6. Note: the free tier **sleeps after inactivity**, so the first incoming message after an
   idle period can be delayed ~30-60s while the service wakes. For always-on behavior,
   upgrade to a paid instance or add an external uptime ping to `/health`.

## Webhook configuration

- **Twilio (SMS):** Twilio Console → your phone number → Messaging →
  *"A message comes in"* → Webhook: `https://<your-host>/webhook/twilio` (HTTP POST).
- **uazapi (WhatsApp):** in your uazapi instance settings, set the webhook URL to
  `https://<your-host>/webhook/uazapi`.

## How lead notification works

When the AI marks a conversation `LEAD_QUALIFIED` (all five fields collected), the owner
gets a summary **once per lead** via both WhatsApp (uazapi send-text) and SMS (Twilio REST).
The same happens on `HUMAN_HANDOFF` (parent asks for a human, or the AI is unsure / asked
about something not in `business.json`). Notification failures are logged but never break
the parent's reply.

Conversation history (last 20 messages per channel+phone) and leads are stored in
`bot/data/db.json` (lowdb, gitignored).

## Owner action required

`business.json` is the bot's knowledge base, organized in 12 numbered modules
(company, programs, schedule, location, pricing, free trial, enrollment, policies,
FAQ, links, human escalation, communication style). The remaining `"TODO"` items
are: official address/map pin, enrollment link, payment link, and make-up-class rules.
Update schedule, pricing and `08_policies.weather.current_class_status` there as they
change — no code changes needed. Anything still marked TODO is handed off to a human
by design.

## Useful endpoints

- `GET /health` — liveness check.
- `POST /webhook/twilio` — Twilio SMS webhook (signature-validated; set
  `TWILIO_VALIDATE_SIGNATURE=false` for local dev).
- `POST /webhook/uazapi` — uazapi WhatsApp webhook (tolerant payload parser).
