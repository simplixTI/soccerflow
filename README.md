# Soccer Flow

Youth soccer program in San Diego, CA — website + SMS/WhatsApp auto-reply bot.

## Structure

- `site/` — static marketing website (HTML/CSS/JS, no build step). See `site/README.md` for editing and deploy instructions.
- `bot/` — Node.js bot that auto-replies to SMS (Twilio) and WhatsApp (uazapi) using DeepSeek AI to answer questions, qualify leads, and notify the owner. See `bot/README.md` for setup and deploy.

## Quick start

- Website: deploy the `site/` folder to Netlify/Vercel/Cloudflare Pages and point `soccerflowus.com` DNS to it.
- Bot: `cd bot && npm install && cp .env.example .env`, fill in the credentials, `npm start`. Deploy to Render (free tier) and set the webhook URLs in Twilio and uazapi.
