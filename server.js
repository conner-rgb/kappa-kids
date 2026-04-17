// Kids Event Signup — Express + embedded Stripe Checkout
//
// Two-step flow, both on our own site:
//   Step 1: Parent fills out /index.html form, submits to POST /api/signup
//           Server validates + saves a PENDING signup to data/signups.json
//           Server creates an EMBEDDED Stripe Checkout session and returns
//           its client_secret + our signup id.
//   Step 2: Parent is sent to /pay.html?sid=... which mounts Stripe's
//           embedded payment UI (card, Apple Pay, etc.) in-page.
//           On success, Stripe redirects to /success.html.
//   The Stripe webhook (checkout.session.completed) flips status to "paid".
//
// Storage: flat JSON file (fine for a prototype / small event). Swap to
// Postgres / Supabase / Airtable when you outgrow it.

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Stripe = require('stripe');

const {
  PORT = 3000,
  STRIPE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY,
  STRIPE_WEBHOOK_SECRET,
  PUBLIC_URL = `http://localhost:3000`,
  EVENT_NAME = 'Kappa Kids',
  EVENT_DESCRIPTION = 'An opportunity to continue kappa traditions and values.',
  EVENT_PRICE_CENTS = '3000', // $30.00
  EVENT_CURRENCY = 'usd',
  EVENT_CAPACITY = '', // blank = unlimited
  EVENT_DATE = '', // blank = no specific date
  EVENT_PRICE_LABEL = '', // optional human-readable price text
  RESEND_API_KEY,
  RESEND_FROM = 'onboarding@resend.dev',
  RESEND_REPLY_TO = '',
} = process.env;

if (!STRIPE_SECRET_KEY || !STRIPE_PUBLISHABLE_KEY) {
  console.warn(
    '\n⚠️  Stripe keys are not fully set. Copy .env.example to .env and add BOTH:\n' +
      '       STRIPE_SECRET_KEY       (sk_test_...)\n' +
      '       STRIPE_PUBLISHABLE_KEY  (pk_test_...)\n' +
      '    Get them at https://dashboard.stripe.com/test/apikeys\n'
  );
}

const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

// ---------- Resend confirmation email ----------
let resendClient = null;
if (RESEND_API_KEY) {
  try {
    const { Resend } = require('resend');
    resendClient = new Resend(RESEND_API_KEY);
  } catch (err) {
    console.warn('resend package not installed — run `npm install`');
  }
} else {
  console.warn('ℹ️  RESEND_API_KEY not set — confirmation emails are disabled.');
}

function money(cents, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (currency || 'usd').toUpperCase(),
  }).format((cents || 0) / 100);
}

async function sendConfirmationEmail(signup) {
  if (!resendClient) return;
  if (signup?.confirmationEmailSent) return; // idempotency
  try {
    const children = signup.children || [];
    const childList = children
      .map((c) => `${c.name} (age ${c.age})`)
      .join(', ');
    const amount = money(signup.amountPaid, EVENT.currency);
    const subject = `You're signed up — ${EVENT.name}`;
    const isSub = !!signup.stripeSubscriptionId;
    const manageUrl = `${PUBLIC_URL}/manage?sid=${signup.id}`;
    const renewalNote = isSub
      ? `Your membership will auto-renew at ${amount} each year until you cancel.`
      : `This is a one-year membership — there's no auto-renewal, so you'll need to sign up again next year to continue.`;

    const text = [
      `Hi ${signup.parent.name},`,
      '',
      `Thanks for registering for ${EVENT.name}! We've received your payment of ${amount}.`,
      '',
      `Registered: ${childList}`,
      '',
      EVENT.date ? `Event date: ${EVENT.date}` : null,
      renewalNote,
      isSub ? `Manage your subscription (cancel, update card, view invoices): ${manageUrl}` : null,
      '',
      'If you need to make any changes, just reply to this email.',
      '',
      '— ' + EVENT.name,
    ]
      .filter((l) => l !== null)
      .join('\n');

    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1f2937;">
        <h2 style="color:#1D3D82;margin-top:0;">You're signed up!</h2>
        <p>Hi ${escapeHtml(signup.parent.name)},</p>
        <p>Thanks for registering for <strong>${escapeHtml(EVENT.name)}</strong>! We've received your payment of <strong>${amount}</strong>.</p>
        <div style="background:#f3f4f6;border-left:4px solid #87CEEB;padding:12px 16px;border-radius:4px;margin:18px 0;">
          <div style="font-size:0.85rem;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">Registered</div>
          <div>${escapeHtml(childList)}</div>
          ${EVENT.date ? `<div style="margin-top:8px;font-size:0.85rem;color:#6b7280;">Event date: ${escapeHtml(EVENT.date)}</div>` : ''}
        </div>
        ${renewalNote ? `<p style="font-size:0.92rem;color:#374151;">${escapeHtml(renewalNote)}</p>` : ''}
        ${isSub ? `
          <p style="margin:22px 0;">
            <a href="${manageUrl}" style="display:inline-block;background:#1D3D82;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;">Manage subscription</a>
          </p>
          <p style="font-size:0.85rem;color:#6b7280;">Use the button above any time to cancel, update your card, or view past invoices.</p>
        ` : ''}
        <p>If you need any help, just reply to this email.</p>
        <p style="color:#6b7280;font-size:0.85rem;margin-top:28px;">— ${escapeHtml(EVENT.name)}</p>
      </div>`;

    const payload = {
      from: RESEND_FROM,
      to: [signup.parent.email],
      subject,
      text,
      html,
    };
    if (RESEND_REPLY_TO) payload.reply_to = RESEND_REPLY_TO;
    const { error } = await resendClient.emails.send(payload);
    if (error) {
      console.error('Resend send error:', error);
      return;
    }
    updateSignup(signup.id, { confirmationEmailSent: true });
    console.log(`✓ Confirmation email sent to ${signup.parent.email}`);
  } catch (err) {
    console.error('Failed to send confirmation email:', err);
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

const app = express();

// ---------- Simple JSON file store ----------
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'signups.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

function readSignups() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to read signups:', err);
    return [];
  }
}
function writeSignups(rows) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2));
}
function updateSignup(id, patch) {
  const rows = readSignups();
  const i = rows.findIndex((r) => r.id === id);
  if (i === -1) return null;
  rows[i] = { ...rows[i], ...patch, updatedAt: new Date().toISOString() };
  writeSignups(rows);
  return rows[i];
}

// ---------- Event config (exposed to frontend) ----------
const parsedCapacity = EVENT_CAPACITY && !isNaN(Number(EVENT_CAPACITY)) ? Number(EVENT_CAPACITY) : null;
const EVENT = {
  name: EVENT_NAME,
  description: EVENT_DESCRIPTION,
  priceCents: Number(EVENT_PRICE_CENTS),
  currency: EVENT_CURRENCY,
  capacity: parsedCapacity, // null = unlimited
  date: EVENT_DATE || null,
  priceLabel: EVENT_PRICE_LABEL || null,
};

function spotsRemaining() {
  if (EVENT.capacity == null) return null; // unlimited
  const paidCount = readSignups()
    .filter((s) => s.status === 'paid')
    .reduce((sum, s) => sum + (s.children?.length || 1), 0);
  return Math.max(0, EVENT.capacity - paidCount);
}

// ---------- Stripe webhook (MUST use raw body, so mount BEFORE json()) ----------
app.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return res.status(503).send('Stripe not configured');
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const signupId = session.metadata?.signupId;
        if (signupId) {
          const updated = updateSignup(signupId, {
            status: 'paid',
            stripeSessionId: session.id,
            stripeSubscriptionId: session.subscription || null,
            stripeCustomerId: session.customer || null,
            amountPaid: session.amount_total,
            paidAt: new Date().toISOString(),
          });
          console.log(`✓ Signup ${signupId} marked paid.`);
          if (updated) sendConfirmationEmail(updated);
        }
      } else if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        const signupId = sub.metadata?.signupId;
        if (signupId) {
          updateSignup(signupId, {
            status: 'cancelled',
            cancelledAt: new Date().toISOString(),
          });
          console.log(`✓ Signup ${signupId} marked cancelled.`);
        }
      } else if (event.type === 'invoice.payment_failed') {
        const invoice = event.data.object;
        const signupId = invoice.subscription_details?.metadata?.signupId;
        if (signupId) {
          updateSignup(signupId, { status: 'past_due' });
          console.log(`⚠ Signup ${signupId} marked past_due.`);
        }
      } else if (event.type === 'invoice.paid') {
        // Renewal — refresh renewedAt on the signup if we can find it.
        const invoice = event.data.object;
        const signupId = invoice.subscription_details?.metadata?.signupId;
        if (signupId && invoice.billing_reason === 'subscription_cycle') {
          updateSignup(signupId, {
            status: 'paid',
            lastRenewedAt: new Date().toISOString(),
          });
          console.log(`↻ Signup ${signupId} renewed.`);
        }
      }
    } catch (handlerErr) {
      console.error('Webhook handler error:', handlerErr);
    }

    res.json({ received: true });
  }
);

// ---------- Normal middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- API ----------
app.get('/api/event', (req, res) => {
  res.json({ ...EVENT, spotsRemaining: spotsRemaining() });
});

// Publishable key is safe to expose to the browser (that's its whole point).
app.get('/api/stripe-config', (req, res) => {
  res.json({
    publishableKey: STRIPE_PUBLISHABLE_KEY || null,
    configured: !!(STRIPE_SECRET_KEY && STRIPE_PUBLISHABLE_KEY),
  });
});

// Create the Stripe Checkout session once the parent has picked one-time vs.
// auto-renew on /pay.html. Returns the client_secret for the embedded UI.
app.post('/api/checkout', async (req, res) => {
  const { sid, autoRenew } = req.body || {};
  if (!sid) return res.status(400).json({ error: 'Missing sid' });
  const row = readSignups().find((r) => r.id === sid);
  if (!row) return res.status(404).json({ error: 'Signup not found' });
  if (row.status === 'paid') return res.status(409).json({ error: 'Already paid' });

  const id = row.id;
  // Note which choice the parent made so we can show correct messaging later.
  updateSignup(id, { autoRenew: !!autoRenew });

  if (!stripe) {
    return res.json({ devMode: true, next: `/pay.html?sid=${id}&dev=1` });
  }

  try {
    const childCount = row.children.length;
    const descLine = `${childCount} child${childCount > 1 ? 'ren' : ''}: ` +
      row.children.map((c) => c.name).join(', ');

    const baseLine = {
      currency: EVENT.currency,
      product_data: {
        name: autoRenew
          ? `${EVENT.name} — annual membership`
          : `${EVENT.name} — one-year membership (no renewal)`,
        description: descLine,
      },
      unit_amount: EVENT.priceCents,
    };
    if (autoRenew) baseLine.recurring = { interval: 'year' };

    const sessionArgs = {
      ui_mode: 'embedded',
      mode: autoRenew ? 'subscription' : 'payment',
      customer_email: row.parent.email,
      line_items: [{ price_data: baseLine, quantity: childCount }],
      metadata: { signupId: id, autoRenew: autoRenew ? '1' : '0' },
      return_url: `${PUBLIC_URL}/success.html?sid=${id}&cs={CHECKOUT_SESSION_ID}`,
    };
    if (autoRenew) {
      sessionArgs.subscription_data = { metadata: { signupId: id } };
    }

    const session = await stripe.checkout.sessions.create(sessionArgs);
    updateSignup(id, { stripeSessionId: session.id });
    res.json({ clientSecret: session.client_secret });
  } catch (err) {
    console.error('POST /api/checkout failed:', err);
    res.status(500).json({ error: 'Could not create checkout session. Please try again.' });
  }
});

// Given our signup id, return the Stripe session's client_secret so /pay.html
// can re-mount the embedded checkout if the page is refreshed.
app.get('/api/checkout/:id', async (req, res) => {
  const row = readSignups().find((r) => r.id === req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status === 'paid') return res.json({ status: 'paid' });
  if (!stripe || !row.stripeSessionId) {
    return res.json({ status: row.status, devMode: !stripe });
  }
  try {
    const session = await stripe.checkout.sessions.retrieve(row.stripeSessionId);
    if (session.status === 'complete') {
      return res.json({ status: 'paid' });
    }
    return res.json({ status: row.status, clientSecret: session.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/signup', async (req, res) => {
  try {
    const {
      parentName,
      parentEmail,
      parentPhone,
      emergencyName,
      emergencyPhone,
      children, // [{ name, age, allergies, medicalNotes, photoConsent }]
    } = req.body || {};

    // ---- Validation ----
    const errors = [];
    if (!parentName || !parentName.trim()) errors.push('Parent name is required.');
    if (!parentEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parentEmail))
      errors.push('A valid parent email is required.');
    if (!parentPhone || !parentPhone.trim()) errors.push('Parent phone is required.');
    if (!emergencyName || !emergencyName.trim())
      errors.push('Emergency contact name is required.');
    if (!emergencyPhone || !emergencyPhone.trim())
      errors.push('Emergency contact phone is required.');
    if (!Array.isArray(children) || children.length === 0)
      errors.push('At least one child is required.');
    else {
      children.forEach((c, i) => {
        if (!c?.name?.trim()) errors.push(`Child #${i + 1}: name is required.`);
        const age = Number(c?.age);
        if (!Number.isFinite(age) || age < 0 || age > 18)
          errors.push(`Child #${i + 1}: age must be between 0 and 18.`);
      });
    }

    const remaining = spotsRemaining();
    if (remaining != null && children && children.length > remaining) {
      errors.push(
        `Only ${remaining} spot${remaining === 1 ? '' : 's'} remaining — you requested ${children.length}.`
      );
    }

    if (errors.length) return res.status(400).json({ errors });

    // ---- Create pending signup ----
    const id = crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();
    const signup = {
      id,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      parent: {
        name: parentName.trim(),
        email: parentEmail.trim().toLowerCase(),
        phone: parentPhone.trim(),
      },
      emergency: {
        name: emergencyName.trim(),
        phone: emergencyPhone.trim(),
      },
      children: children.map((c) => ({
        name: c.name.trim(),
        age: Number(c.age),
        allergies: (c.allergies || '').trim(),
        medicalNotes: (c.medicalNotes || '').trim(),
        photoConsent: !!c.photoConsent,
      })),
    };
    const rows = readSignups();
    rows.push(signup);
    writeSignups(rows);

    // The Stripe Checkout session is created later (POST /api/checkout) after
    // the parent picks one-time vs. auto-renew on /pay.html. Hand them off now.
    res.json({
      signupId: id,
      devMode: !stripe,
      next: stripe ? `/pay.html?sid=${id}` : `/pay.html?sid=${id}&dev=1`,
    });
  } catch (err) {
    console.error('POST /api/signup failed:', err);
    res.status(500).json({ errors: ['Server error. Please try again.'] });
  }
});

// Safety-net for test mode: if the webhook isn't wired up yet, the success
// page calls this endpoint so the signup still flips to "paid" for demos.
// In production, rely on the webhook (more reliable) and you can remove this.
app.post('/api/confirm', async (req, res) => {
  const { sid, cs } = req.body || {};
  const rows = readSignups();
  const row = rows.find((r) => r.id === sid);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status === 'paid') return res.json(row);
  if (!stripe || !cs) return res.status(400).json({ error: 'Missing checkout session' });
  try {
    const session = await stripe.checkout.sessions.retrieve(cs);
    if (session.payment_status === 'paid' && session.metadata?.signupId === sid) {
      const updated = updateSignup(sid, {
        status: 'paid',
        stripeSessionId: session.id,
        stripeSubscriptionId: session.subscription || null,
        stripeCustomerId: session.customer || null,
        amountPaid: session.amount_total,
        paidAt: new Date().toISOString(),
      });
      if (updated) sendConfirmationEmail(updated);
      return res.json(updated);
    }
    res.status(402).json({ error: 'Payment not completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Parents click a link from their confirmation email; this redirects them
// to the Stripe-hosted customer portal where they can cancel, update their
// card, view invoices, etc. The `sid` is a 16-hex-char token — not secret,
// but not guessable — which is a reasonable trade-off for email links.
app.get('/manage', async (req, res) => {
  const sid = req.query.sid;
  if (!stripe) return res.status(503).send('Stripe not configured on this server.');
  if (!sid) return res.status(400).send('Missing signup reference.');
  const row = readSignups().find((r) => r.id === sid);
  if (!row) return res.status(404).send('We could not find that subscription. Reply to your confirmation email and we will sort it out.');
  if (!row.stripeCustomerId) {
    return res.status(400).send('This signup does not have an associated subscription yet. Please try again after the payment completes.');
  }
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripeCustomerId,
      return_url: `${PUBLIC_URL}/`,
    });
    res.redirect(session.url);
  } catch (err) {
    console.error('billingPortal.sessions.create failed:', err);
    res.status(500).send(
      'Could not open the subscription portal. If this keeps happening, check that the Customer Portal is activated at https://dashboard.stripe.com/test/settings/billing/portal'
    );
  }
});

// Dev-only helper: simulate a paid checkout when no Stripe keys are present.
// Refuses to do anything once real Stripe keys are configured.
app.post('/api/confirm-dev/:id', (req, res) => {
  if (stripe) return res.status(403).json({ error: 'Not available with Stripe configured' });
  const updated = updateSignup(req.params.id, {
    status: 'paid',
    paidAt: new Date().toISOString(),
    amountPaid: EVENT.priceCents,
    note: 'DEV_NO_STRIPE',
  });
  if (!updated) return res.status(404).json({ error: 'Not found' });
  sendConfirmationEmail(updated);
  res.json(updated);
});

app.get('/api/signup/:id', (req, res) => {
  const row = readSignups().find((r) => r.id === req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // Don't leak sensitive fields — this is used by the success page.
  res.json({
    id: row.id,
    status: row.status,
    parentName: row.parent.name,
    childCount: row.children.length,
    amountPaid: row.amountPaid || 0,
    autoRenew: !!row.autoRenew,
  });
});

// ---------- Admin (basic auth) ----------
function adminAuth(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    // No token configured — only allow localhost for safety.
    const ip = req.ip || req.connection.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    return res.status(401).send('ADMIN_TOKEN not set — admin is localhost-only.');
  }
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (provided === token) return next();
  res.status(401).send('Unauthorized');
}

app.get('/api/admin/signups', adminAuth, (req, res) => {
  res.json(readSignups());
});

app.get('/admin.html', adminAuth, (req, res, next) => {
  // Let static middleware serve the file, but only after auth passes.
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`\n🎪 ${EVENT.name} — signup server running`);
  console.log(`   Parent signup:  ${PUBLIC_URL}`);
  console.log(`   Admin view:     ${PUBLIC_URL}/admin.html`);
  console.log(`   Spots left:     ${spotsRemaining()} / ${EVENT.capacity}\n`);
});
