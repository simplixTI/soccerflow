# Soccer Flow — Marketing Website

Static one-page marketing site for **Soccer Flow**, a youth soccer program for
children ages 2–7+ in San Diego, CA. It replaces the existing one-pager at
<https://soccerflowus.com>.

## Stack

Plain HTML + CSS + JavaScript. **No frameworks, no build step, no dependencies.**
The only external requests are Google Fonts (CDN). Open `index.html` in a browser
and it works.

## Files

| File | Purpose |
|---|---|
| `index.html` | All content and page structure |
| `styles.css` | All styling (mobile-first, plain CSS) |
| `script.js` | FAQ accordion, smooth scroll, sticky header, floating WhatsApp button |
| `robots.txt` | Search-engine crawling rules |
| `sitemap.xml` | Single-URL sitemap |

## Editing content

Everything is in `index.html` — there is no templating. Search the file for the
relevant section `id` or comment.

- **Testimonials** — section `#testimonials`. The three quotes are **placeholders**
  (marked with an HTML comment `PLACEHOLDER TESTIMONIALS`). Replace with real
  parent quotes before or shortly after launch.
- **Program age ranges** — section `#programs`, look for `<!-- EDITABLE: age range -->`
  comments above each age badge (currently Explorers 2–4, Juniors 4–6, Academy 6–7+).
- **Prices** — there are deliberately no prices on the site. The FAQ "How much do
  classes cost?" answer is generic. When pricing is decided, edit that FAQ answer
  (`#faq-a1`) or add a pricing section.
- **FAQ answers with unknown facts** — each answer written with assumptions
  (pricing, locations, weather policy, what to bring, group size) is marked with
  `<!-- TODO: confirm with owner -->`. Review and correct them.
- **Phone / WhatsApp / SMS links** — the booking links appear in several places
  (header, hero, FAQ, final CTA, footer, floating button). If the number ever
  changes, search-and-replace `18584454126` and `+1 (858) 445-4126` across
  `index.html`.
- **Colors / fonts** — CSS custom properties at the top of `styles.css` (`:root`).
  Change `--green-*` / `--accent` to re-skin the whole site.
- **Social share image** — the Open Graph / Twitter tags point to
  `https://soccerflowus.com/og-image.jpg`, which does not exist yet. Create a
  1200×630 image, add it to this folder, and it will be picked up automatically
  (see the `TODO` comment in `<head>`).

## Deploying

The site is fully static — upload the **contents of this folder** (`index.html`,
`styles.css`, `script.js`, `robots.txt`, `sitemap.xml`) to any static host.

### Netlify Drop

1. Go to <https://app.netlify.com/drop>.
2. Drag the `site` folder onto the page. Done — you get a `*.netlify.app` URL.
3. In **Site settings → Domain management → Add a custom domain**, enter
   `soccerflowus.com` and follow the wizard.

### Vercel

1. Install the CLI (`npm i -g vercel`) or use the dashboard "Add New → Project".
2. From this folder run `vercel` (or import the folder in the dashboard).
   No build settings needed — it's plain static files.
3. In **Settings → Domains**, add `soccerflowus.com` and follow the DNS prompts.

### Cloudflare Pages

1. Dashboard → **Workers & Pages → Create → Pages → Upload assets** (direct
   upload) or connect a Git repo.
2. Upload the folder contents (or point the repo at this folder as the output
   directory). No build command.
3. Under **Custom domains**, add `soccerflowus.com`.

### Pointing the soccerflowus.com DNS

At your domain registrar/DNS provider:

- **Netlify**: either use Netlify DNS (change nameservers to the ones shown) or
  add an `A` record for `soccerflowus.com` → `75.2.60.5` and a `CNAME` for
  `www` → your `*.netlify.app` hostname.
- **Vercel**: add an `A` record for `soccerflowus.com` → `76.76.21.21` and a
  `CNAME` for `www` → `cname.vercel-dns.com`.
- **Cloudflare Pages**: if DNS is already on Cloudflare, adding the custom
  domain in Pages creates the records automatically (orange-clouded `CNAME`
  to your `*.pages.dev` hostname).

All three hosts provision HTTPS automatically once the domain resolves.
Always confirm the exact DNS values in the host's dashboard — they are shown
during the "add custom domain" flow and can change over time.

## Accessibility & SEO notes

- Semantic HTML with one `h1`, logical heading order, landmarks (`header`,
  `main`, `footer`, labelled `section`s).
- FAQ accordion is keyboard-accessible (`button` + `aria-expanded` +
  `aria-controls`/`aria-labelledby`).
- All CTAs carry `aria-label`s; `prefers-reduced-motion` disables animations
  and smooth scrolling.
- SEO: title/meta description, canonical, Open Graph, Twitter card, and
  JSON-LD `SportsActivityLocation` schema are in `<head>`.
