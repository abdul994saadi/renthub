const Stripe = require('stripe');
const { db } = require('./db');
const { CURRENCY, formatDate } = require('./helpers');
const { recordPayment, expireBooking } = require('./bookings');
const { sendBookingEmails, sendConflictRefundEmail } = require('./email');

const isProduction = process.env.NODE_ENV === 'production';
const secretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || 0);

if (isProduction && (!secretKey || !webhookSecret)) {
  throw new Error('STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set in production.');
}

// Without a Stripe key (local development only) payments are simulated on /dev/pay.
const demoMode = !secretKey;

const stripe = secretKey
  ? new Stripe(secretKey, {
      maxNetworkRetries: 2,
      // Lets tests point the SDK at stripe-mock, e.g. STRIPE_API_URL=http://localhost:12111
      ...(process.env.STRIPE_API_URL && (() => {
        const u = new URL(process.env.STRIPE_API_URL);
        return { host: u.hostname, port: u.port, protocol: u.protocol.replace(':', '') };
      })()),
    })
  : null;

const toCents = (amount) => Math.round(amount * 100);

function baseUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

// Starts payment for a pending booking and returns the URL to send the customer to.
async function startCheckout(req, booking, car, shop) {
  if (demoMode) return `/dev/pay/${booking.reference}`;

  const destination = shop.stripe_account_id && shop.stripe_charges_enabled ? shop.stripe_account_id : null;
  const amount = toCents(booking.total_price);
  const base = baseUrl(req);
  const metadata = { booking_id: String(booking.id), reference: booking.reference };

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    // Payment methods (cards, Apple Pay, Google Pay…) are chosen in the Stripe Dashboard.
    customer_email: booking.customer_email,
    client_reference_id: booking.reference,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: CURRENCY.toLowerCase(),
        unit_amount: amount,
        product_data: {
          name: `${car.year} ${car.make} ${car.model} · ${booking.days} day${booking.days === 1 ? '' : 's'}`,
          description: `${formatDate(booking.pickup_date)} to ${formatDate(booking.return_date)} with ${shop.name}`,
        },
      },
    }],
    metadata,
    payment_intent_data: {
      description: `Booking ${booking.reference}`,
      metadata,
      ...(destination && {
        transfer_data: { destination },
        application_fee_amount: Math.round((amount * PLATFORM_FEE_PERCENT) / 100),
      }),
    },
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    success_url: `${base}/bookings/${booking.reference}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/bookings/${booking.reference}/abandon`,
  });

  db.prepare('UPDATE bookings SET stripe_session_id = ?, stripe_destination = ? WHERE id = ?')
    .run(session.id, destination, booking.id);
  return session.url;
}

// Called when a payment succeeds (from the webhook, the return page, or demo mode).
async function handlePaid(bookingId, paymentIntentId) {
  const { booking, outcome } = recordPayment(bookingId, paymentIntentId);
  if (outcome !== 'confirmed' && outcome !== 'conflict') return booking;
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(booking.car_id);
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(booking.shop_id);
  if (outcome === 'confirmed') {
    await sendBookingEmails(booking, car, shop);
  } else {
    // The customer paid after their hold ran out and someone else booked the car.
    await refundBooking(booking);
    await sendConflictRefundEmail(booking, car, shop);
  }
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
}

// Checks Stripe directly, in case the customer returns before the webhook arrives.
async function syncFromSession(booking, sessionId) {
  if (demoMode || booking.payment_status !== 'unpaid' || sessionId !== booking.stripe_session_id) return booking;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status === 'paid') return handlePaid(booking.id, session.payment_intent);
  return booking;
}

async function abandonCheckout(booking) {
  if (booking.payment_status !== 'unpaid' || booking.status !== 'pending_payment') return;
  if (!demoMode && booking.stripe_session_id) {
    try {
      await stripe.checkout.sessions.expire(booking.stripe_session_id);
    } catch (err) {
      // The session may have just been paid; let the webhook decide.
      const session = await stripe.checkout.sessions.retrieve(booking.stripe_session_id);
      if (session.payment_status === 'paid') return handlePaid(booking.id, session.payment_intent);
      if (session.status === 'complete') return; // delayed payment method; the webhook will settle it
      if (session.status !== 'expired') throw err;
    }
  }
  expireBooking(booking.id);
}

// Full refund of a paid booking. Throws if Stripe refuses.
async function refundBooking(booking) {
  if (booking.payment_status !== 'paid') return;
  if (!demoMode) {
    await stripe.refunds.create(
      {
        payment_intent: booking.stripe_payment_intent,
        ...(booking.stripe_destination && { reverse_transfer: true, refund_application_fee: true }),
        metadata: { booking_id: String(booking.id), reference: booking.reference },
      },
      { idempotencyKey: `refund-${booking.id}` },
    );
  }
  db.prepare(`UPDATE bookings SET payment_status = 'refunded' WHERE id = ?`).run(booking.id);
}

async function handleWebhook(rawBody, signature) {
  const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  const session = event.data.object;
  const bookingId = Number(session.metadata?.booking_id);

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (bookingId && session.payment_status === 'paid') await handlePaid(bookingId, session.payment_intent);
      break;
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed':
      if (bookingId) expireBooking(bookingId);
      break;
    case 'account.updated':
      db.prepare('UPDATE shops SET stripe_charges_enabled = ? WHERE stripe_account_id = ?')
        .run(session.charges_enabled ? 1 : 0, session.id);
      break;
  }
}

// ---------- Stripe Connect: shops receive payouts directly ----------

async function connectOnboardingUrl(req, shop) {
  let accountId = shop.stripe_account_id;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      email: shop.email,
      business_profile: { name: shop.name, mcc: '7512' }, // 7512 = car rental agencies
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { shop_id: String(shop.id) },
    });
    accountId = account.id;
    db.prepare('UPDATE shops SET stripe_account_id = ? WHERE id = ?').run(accountId, shop.id);
  }
  const base = baseUrl(req);
  const link = await stripe.accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    refresh_url: `${base}/shop/payments/connect`,
    return_url: `${base}/shop/payments/return`,
  });
  return link.url;
}

async function refreshConnectStatus(shop) {
  if (!shop.stripe_account_id || demoMode) return shop;
  const account = await stripe.accounts.retrieve(shop.stripe_account_id);
  db.prepare('UPDATE shops SET stripe_charges_enabled = ? WHERE id = ?').run(account.charges_enabled ? 1 : 0, shop.id);
  return db.prepare('SELECT * FROM shops WHERE id = ?').get(shop.id);
}

async function connectDashboardUrl(shop) {
  const link = await stripe.accounts.createLoginLink(shop.stripe_account_id);
  return link.url;
}

module.exports = {
  demoMode, PLATFORM_FEE_PERCENT,
  startCheckout, handlePaid, syncFromSession, abandonCheckout, refundBooking, handleWebhook,
  connectOnboardingUrl, refreshConnectStatus, connectDashboardUrl,
};
