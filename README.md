# Soccer Flow

Youth soccer program in San Diego, CA — website + SMS/WhatsApp auto-reply AI bot.

## Architecture

- `site/` — static marketing website (HTML/CSS/JS, no build step). Deployed on **Vercel** (Root Directory = `site`). See `site/README.md`.
- `supabase/` — the bot: **Supabase Edge Functions + Postgres**. Receives SMS (Twilio) and WhatsApp (uazapi) webhooks, replies with DeepSeek AI, qualifies leads, notifies the owner, supports `/assumir` human takeover and a living knowledge base. See `supabase/README.md` for deploy.
- `bot/` — original Node.js/Express version of the same bot (kept as reference; production is `supabase/`).

## Bot features

- DeepSeek AI answers FAQs and books free trial classes (one question at a time, EN/ES/PT)
- Lead qualification → owner notified via WhatsApp + SMS
- `/assumir` / `/voltar` — owner takes over any conversation, AI resumes with full context
- Living knowledge base: admin page at `.../functions/v1/admin/` + `/ensinar` SMS command
- Never invents prices/schedules/links — hands off to a human instead
