const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const { daysBetween } = require('./helpers');

// How long a car is held while the customer is on the payment page.
// Stripe Checkout sessions last at least 30 minutes, so the hold is a little longer.
const HOLD_MINUTES = 35;

// A car is taken by confirmed bookings and by unexpired payment holds.
const BLOCKING = `(status = 'confirmed' OR (status = 'pending_payment' AND hold_expires_at > datetime('now')))`;

function isCarAvailable(carId, pickup, ret, ignoreBookingId = 0) {
  const clash = db
    .prepare(
      `SELECT 1 FROM bookings
       WHERE car_id = ? AND id <> ? AND ${BLOCKING} AND pickup_date < ? AND return_date > ?
       LIMIT 1`,
    )
    .get(carId, ignoreBookingId, ret, pickup);
  return !clash;
}

function upcomingBookedRanges(carId, fromDate) {
  return db
    .prepare(
      `SELECT pickup_date, return_date FROM bookings
       WHERE car_id = ? AND ${BLOCKING} AND return_date > ?
       ORDER BY pickup_date LIMIT 20`,
    )
    .all(carId, fromDate);
}

function quote(car, pickup, ret) {
  const days = daysBetween(pickup, ret);
  return { days, dailyPrice: car.daily_price, total: Math.round(days * car.daily_price * 100) / 100 };
}

function newReference() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let ref = '';
  for (const b of bytes) ref += alphabet[b % alphabet.length];
  return `RH-${ref}`;
}

// Creates an unpaid booking that holds the car while the customer pays.
// Availability is re-checked inside a write transaction so two customers
// cannot hold the same car for overlapping dates. Returns null if taken.
function createPendingBooking(car, details) {
  return transaction(() => {
    if (!isCarAvailable(car.id, details.pickup, details.ret)) return null;
    const q = quote(car, details.pickup, details.ret);
    const reference = newReference();
    db.prepare(
      `INSERT INTO bookings (reference, car_id, shop_id, customer_name, customer_email, customer_phone,
         pickup_date, return_date, days, daily_price, total_price, notes, status, hold_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', datetime('now', ?))`,
    ).run(
      reference, car.id, car.shop_id, details.name, details.email, details.phone,
      details.pickup, details.ret, q.days, q.dailyPrice, q.total, details.notes, `+${HOLD_MINUTES} minutes`,
    );
    return db.prepare('SELECT * FROM bookings WHERE reference = ?').get(reference);
  });
}

// Marks a booking as paid. Safe to call more than once for the same payment
// (the webhook and the customer's return page may both report it).
// Returns { booking, outcome } where outcome is:
//   'confirmed'      - newly confirmed; send the confirmation emails
//   'already'        - this payment was already recorded
//   'conflict'       - paid, but the hold had lapsed and the car was taken; refund it
function recordPayment(bookingId, paymentIntentId) {
  return transaction(() => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!booking) return { booking: null, outcome: 'missing' };
    if (booking.payment_status !== 'unpaid') return { booking, outcome: 'already' };

    const free = isCarAvailable(booking.car_id, booking.pickup_date, booking.return_date, booking.id);
    const status = free && ['pending_payment', 'expired'].includes(booking.status) ? 'confirmed' : 'cancelled';
    db.prepare(
      `UPDATE bookings SET status = ?, payment_status = 'paid', stripe_payment_intent = ?, paid_at = datetime('now'),
         hold_expires_at = NULL WHERE id = ?`,
    ).run(status, paymentIntentId, booking.id);
    const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
    return { booking: updated, outcome: status === 'confirmed' ? 'confirmed' : 'conflict' };
  });
}

// Releases the hold on an unpaid booking (payment abandoned or session expired).
function expireBooking(bookingId) {
  db.prepare(`UPDATE bookings SET status = 'expired', hold_expires_at = NULL WHERE id = ? AND status = 'pending_payment' AND payment_status = 'unpaid'`)
    .run(bookingId);
}

module.exports = {
  HOLD_MINUTES, isCarAvailable, upcomingBookedRanges, quote, createPendingBooking, recordPayment, expireBooking,
};
