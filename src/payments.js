// Online payments through Amazon Payment Services (APS, formerly PayFort),
// using its "Redirection" integration: the customer pays on APS's hosted
// payment page and APS posts the signed result back to us.
const crypto = require('node:crypto');
const { db } = require('./db');
const { CURRENCY } = require('./helpers');
const { recordPayment, expireBooking } = require('./bookings');
const { sendBookingEmails, sendConflictRefundEmail } = require('./email');

const isProduction = process.env.NODE_ENV === 'production';
const config = {
  merchantIdentifier: process.env.APS_MERCHANT_IDENTIFIER,
  accessCode: process.env.APS_ACCESS_CODE,
  requestPhrase: process.env.APS_SHA_REQUEST_PHRASE,
  responsePhrase: process.env.APS_SHA_RESPONSE_PHRASE,
  shaType: (process.env.APS_SHA_TYPE || 'sha256').toLowerCase(),
};
const live = process.env.APS_ENVIRONMENT === 'production';
const CHECKOUT_URL = process.env.APS_CHECKOUT_URL
  || (live ? 'https://checkout.payfort.com/FortAPI/paymentPage' : 'https://sbcheckout.payfort.com/FortAPI/paymentPage');
const API_URL = process.env.APS_API_URL
  || (live ? 'https://paymentservices.payfort.com/FortAPI/paymentApi' : 'https://sbpaymentservices.payfort.com/FortAPI/paymentApi');
const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || 0);

const configured = Object.values(config).every(Boolean);
if (isProduction && !configured) {
  throw new Error('APS_MERCHANT_IDENTIFIER, APS_ACCESS_CODE, APS_SHA_REQUEST_PHRASE and APS_SHA_RESPONSE_PHRASE must be set in production.');
}
if (configured && !['sha256', 'sha512'].includes(config.shaType)) {
  throw new Error('APS_SHA_TYPE must be sha256 or sha512 (match the SHA type chosen in the APS dashboard).');
}

// Without APS credentials (local development only) payments are simulated on /dev/pay.
const demoMode = !configured;

// APS status codes (the `status` field of a response).
const STATUS = { PURCHASE_SUCCESS: '14', REFUND_SUCCESS: '06', CHECK_STATUS_SUCCESS: '12' };

// SHA phrase + every key=value sorted by key (signature itself excluded) + SHA phrase.
function sign(params, phrase) {
  const body = Object.keys(params)
    .filter((k) => k !== 'signature' && params[k] !== null && params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('');
  return crypto.createHash(config.shaType).update(phrase + body + phrase).digest('hex');
}

function isValidResponse(params) {
  if (typeof params?.signature !== 'string') return false;
  const expected = Buffer.from(sign(params, config.responsePhrase));
  const received = Buffer.from(params.signature);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

const toMinorUnits = (amount) => String(Math.round(amount * 100));

function baseUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

// Returns what the browser needs to start paying for a pending booking:
// either a URL to redirect to (demo mode) or a form to auto-submit to APS.
function startCheckout(req, booking, car) {
  if (demoMode) return { redirect: `/dev/pay/${booking.reference}` };
  const fields = {
    command: 'PURCHASE',
    access_code: config.accessCode,
    merchant_identifier: config.merchantIdentifier,
    merchant_reference: booking.reference,
    amount: toMinorUnits(booking.total_price),
    currency: CURRENCY,
    language: 'en',
    customer_email: booking.customer_email,
    order_description: `${car.year} ${car.make} ${car.model}, ${booking.days} day rental`.replace(/[^A-Za-z0-9 ,.-]/g, '').slice(0, 150),
    return_url: `${baseUrl(req)}/payments/aps/return`,
  };
  fields.signature = sign(fields, config.requestPhrase);
  return { form: { action: CHECKOUT_URL, fields } };
}

async function callApi(params) {
  const body = { ...params, access_code: config.accessCode, merchant_identifier: config.merchantIdentifier, language: 'en' };
  body.signature = sign(body, config.requestPhrase);
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`APS returned HTTP ${res.status}`);
  const data = await res.json();
  if (!isValidResponse(data)) throw new Error('APS response signature is invalid');
  return data;
}

// Called when a payment succeeds (from APS's return/notification, a status check, or demo mode).
async function handlePaid(bookingId, transactionId) {
  const { booking, outcome } = recordPayment(bookingId, transactionId);
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

// Handles a signed transaction result from APS: the customer's browser coming
// back (return_url) or APS's server-to-server notification. Returns the booking.
async function handleApsResult(params) {
  if (!isValidResponse(params)) {
    const err = new Error('Invalid APS signature');
    err.status = 400;
    throw err;
  }
  const booking = db.prepare('SELECT * FROM bookings WHERE reference = ?').get(String(params.merchant_reference || ''));
  if (!booking) return { booking: null };

  // Refund notifications and other commands carry the same reference; only purchases change the booking.
  if (params.command && params.command !== 'PURCHASE') return { booking };

  const amountMatches = String(params.amount) === toMinorUnits(booking.total_price) && params.currency === CURRENCY;
  if (params.status === STATUS.PURCHASE_SUCCESS && amountMatches) {
    return { booking: await handlePaid(booking.id, String(params.fort_id || '')), paid: true };
  }
  if (params.status === STATUS.PURCHASE_SUCCESS) {
    console.error(`APS amount mismatch for ${booking.reference}: got ${params.amount} ${params.currency}`);
  }
  expireBooking(booking.id);
  return { booking, paid: false, message: params.response_message };
}

// Asks APS directly whether a pending booking was paid (in case the customer
// closed the tab before being sent back and no notification has arrived yet).
async function syncPendingBooking(booking) {
  if (demoMode || booking.status !== 'pending_payment' || booking.payment_status !== 'unpaid') return booking;
  try {
    const res = await callApi({ query_command: 'CHECK_STATUS', merchant_reference: booking.reference });
    if (res.status === STATUS.CHECK_STATUS_SUCCESS && res.transaction_status === STATUS.PURCHASE_SUCCESS) {
      return handlePaid(booking.id, String(res.fort_id || ''));
    }
  } catch (err) {
    console.error(`APS status check for ${booking.reference} failed:`, err.message);
  }
  return booking;
}

async function abandonCheckout(booking) {
  if (booking.payment_status !== 'unpaid' || booking.status !== 'pending_payment') return;
  const synced = await syncPendingBooking(booking);
  if (synced.payment_status === 'unpaid') expireBooking(booking.id);
}

// Full refund of a paid booking. Throws if APS refuses.
async function refundBooking(booking) {
  if (booking.payment_status !== 'paid') return;
  if (!demoMode) {
    const res = await callApi({
      command: 'REFUND',
      merchant_reference: booking.reference,
      fort_id: booking.payment_ref || undefined,
      amount: toMinorUnits(booking.total_price),
      currency: CURRENCY,
    });
    if (res.status !== STATUS.REFUND_SUCCESS) throw new Error(res.response_message || `refund status ${res.status}`);
  }
  db.prepare(`UPDATE bookings SET payment_status = 'refunded' WHERE id = ?`).run(booking.id);
}

module.exports = {
  demoMode, PLATFORM_FEE_PERCENT, CHECKOUT_URL,
  sign, isValidResponse, startCheckout, handlePaid, handleApsResult, syncPendingBooking, abandonCheckout, refundBooking,
};
