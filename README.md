# Kids Event Signup

A small Node/Express app to collect sign-ups for a children's event and take payments. Two-step flow, both on your own site:

1. **Step 1 — Your info.** Parent fills out contact, emergency contact, and per-child info (name, age, allergies, medical notes, photo consent). Multiple children per order supported.
2. **Step 2 — Payment.** Parent enters card details in an embedded Stripe payment form on your site (no redirect to stripe.com). Handles cards, Apple Pay, Google Pay, and other methods enabled in your Stripe dashboard.

## What's in the box

- **Sign-up form** (`/`) — Step 1 of the flow.
- **Embedded payment page** (`/pay.html`) — Step 2, hosted on your domain via [Stripe's embedded Checkout](https://stripe.com/docs/payments/checkout/embedded-form).
- **Admin view** (`/admin.html`) — lists sign-ups, shows stats, exports CSV.
- **JSON file storage** (`data/signups.json`) — fine for a single event. Swap for Postgres / Supabase / Airtable when you outgrow it.
- **Stripe webhook** — `checkout.session.completed` flips signups from `pending` to `paid`. A fallback `/api/confirm` endpoint is also wired up for local testing before the webhook is set up.

## Quick start (local)

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the environment template:
   ```bash
   cp .env.example .env
   ```
3. Connect your Stripe account (see next section).
4. Start the server:
   ```bash
   npm start
   ```
5. Visit <http://localhost:3000>. Use Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC.

## Connecting your Stripe account

You'll need a free Stripe account to take payments.

1. **Create your account** at <https://dashboard.stripe.com/register> — takes ~2 minutes. You can skip the full business onboarding for now and use test mode until you're ready to go live.
2. **Get your API keys.** In the dashboard, make sure the **"Test mode"** toggle (top-right) is ON, then go to <https://dashboard.stripe.com/test/apikeys>. You'll see two keys:
   - **Publishable key** — starts with `pk_test_...`
   - **Secret key** — click "Reveal test key" to see it. Starts with `sk_test_...`
3. **Paste both into your `.env` file:**
   ```
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_PUBLISHABLE_KEY=pk_test_...
   ```
4. **Restart the server** (`Ctrl+C` in the terminal, then `npm start` again).
5. **Test a payment:** go through the sign-up flow and on the payment page use card `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP. You'll see the payment appear in your Stripe dashboard under Payments.

### Going live (taking real money)

When you're ready to accept real payments:

1. In the Stripe dashboard, complete the "Activate payments" onboarding (business info, bank account for payouts, tax info).
2. Switch the dashboard to **Live mode** and grab your live API keys (`sk_live_...` / `pk_live_...`).
3. Replace the test keys in your `.env` (on whatever host you've deployed to — don't commit live keys to git).
4. Re-create the webhook endpoint in **Live mode** (see below) and use the new signing secret.

### Wire up the webhook (recommended)

The webhook is what reliably flips signups to `paid` — it runs server-to-server even if the parent closes their browser.

**For local testing**, install the [Stripe CLI](https://stripe.com/docs/stripe-cli):

```bash
stripe listen --forward-to localhost:3000/webhook/stripe
```

Copy the `whsec_...` secret it prints into `.env` as `STRIPE_WEBHOOK_SECRET`, then restart the server.

**For your deployed app**, in the Stripe dashboard go to Developers → Webhooks → Add endpoint. Point it at `https://your-domain.com/webhook/stripe`, subscribe to the `checkout.session.completed` event, and paste the signing secret into your hosting environment's env vars.

### Running without Stripe (UI-only preview)

If either Stripe key is missing, Step 2 shows a "Simulate successful payment" button so you can click through the whole flow without setting up Stripe. The button is disabled automatically once real Stripe keys are configured.

### Wire up the webhook (recommended, even locally)

Install the [Stripe CLI](https://stripe.com/docs/stripe-cli), then:

```bash
stripe listen --forward-to localhost:3000/webhook/stripe
```

It will print a line like `whsec_abc123...` — paste that into `.env` as `STRIPE_WEBHOOK_SECRET` and restart the server. Now signups reliably flip to `paid` via webhook.

> Without the webhook, the success page calls `/api/confirm` as a fallback — that works for demos but is less reliable than a real webhook.

### Running without Stripe (UI-only demo)

If `STRIPE_SECRET_KEY` is missing, submitting the form skips Stripe and marks the signup as paid so you can review the UX. Useful for a quick review before you set up Stripe.

## Customizing the event

Edit these env vars (or change the defaults in `server.js`):

| Var | Meaning |
| --- | --- |
| `EVENT_NAME` | Shown in the hero |
| `EVENT_DESCRIPTION` | Blurb under the name |
| `EVENT_PRICE_CENTS` | Price per child, in cents (e.g. `7500` = $75.00) |
| `EVENT_CURRENCY` | Lowercase ISO code, e.g. `usd` |
| `EVENT_CAPACITY` | Total spots across all paid signups |
| `EVENT_DATE` | Date shown in the hero |

## Admin page

- **Locally:** just open `http://localhost:3000/admin.html` — localhost bypasses auth.
- **Deployed:** set `ADMIN_TOKEN=something-long-and-random` in your env, then visit `https://your-app/admin.html?token=something-long-and-random`.

## Hosting recommendation

For a small event, the simplest production path is:

1. **Code host**: push this repo to GitHub.
2. **App host**: [Render](https://render.com) or [Railway](https://railway.app) — pick the "Web Service" option, point at your repo, set the env vars (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PUBLIC_URL=https://your-app.onrender.com`, `ADMIN_TOKEN=...`, plus event config). Both have free tiers that handle a single event's traffic easily.
3. **Stripe webhook**: in the Stripe dashboard, add an endpoint pointing at `https://your-app.onrender.com/webhook/stripe`, subscribe to `checkout.session.completed`, copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. **Data persistence**: the JSON file resets on redeploy on most hosts. For anything beyond a weekend prototype, switch to Postgres (Render has a free tier) or Supabase, and replace `readSignups` / `writeSignups` / `updateSignup` in `server.js` with DB calls. The rest of the app stays the same.

If you'd rather go fully serverless (Vercel / Netlify), you'll want to split the webhook and the API routes into serverless functions and move the signup store to a managed DB. Happy to refactor it in that direction if you want.

## Project layout

```
kids-event-signup/
├── server.js            # Express + Stripe
├── package.json
├── .env.example
├── .gitignore
├── README.md
├── data/
│   └── signups.json     # Auto-created on first run
└── public/
    ├── index.html       # Sign-up form
    ├── success.html     # Post-payment confirmation
    ├── cancel.html      # If the parent cancels at Stripe
    ├── admin.html       # Admin dashboard
    └── styles.css
```

## Before you take real money

- Switch Stripe from test mode to live mode (new `STRIPE_SECRET_KEY`, new webhook endpoint + secret).
- Double-check the refund/cancellation policy you display to parents.
- Back up `data/signups.json` regularly (or move to a real DB).
- Consider adding an email confirmation (e.g. via [Resend](https://resend.com)) so parents get a branded receipt alongside Stripe's.
- Add a terms/privacy page and link it from the form.
