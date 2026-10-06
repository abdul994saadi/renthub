const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const { localToDate, FREE_CANCELLATION_HOURS } = require('./helpers');
const commission = require('./commission');

// How long a car is held while the customer is on the payment page.
const HOLD_MINUTES = 30;

// A car is taken by confirmed bookings and by unexpired payment holds.
const BLOCKING = `(status = 'confirmed' OR (status = 'pending_payment' AND hold_expires_at > datetime('now')))`;

// Bookings use [pickup_date, return_date): the car is free again on the return day.
// Blocked days are inclusive [start_date, end_date].
function isCarAvailable(carId, pickup, ret, ignoreBookingId = 0) {
  const clash = db
    .prepare(
      `SELECT 1 FROM bookings
       WHERE car_id = ? AND id <> ? AND ${BLOCKING} AND pickup_date < ? AND return_date > ?
       LIMIT 1`,
    )
    .get(carId, ignoreBookingId, ret, pickup);
  return !clash && !blockedBetween(carId, pickup, ret);
}

// The shop's blocked period that overlaps a stay from pickup to ret, if any.
function blockedBetween(carId, pickup, ret) {
  return db.prepare('SELECT * FROM car_blocks WHERE car_id = ? AND start_date < ? AND end_date >= ? LIMIT 1').get(carId, ret, pickup);
}

// Booked and blocked periods ahead, as [pickup_date, return_date) ranges for the calendar.
function upcomingBookedRanges(carId, fromDate, limit = 100) {
  return db
    .prepare(
      `SELECT pickup_date, return_date FROM bookings
       WHERE car_id = ? AND ${BLOCKING} AND return_date > ?
       UNION ALL
       SELECT start_date, date(end_date, '+1 day') FROM car_blocks WHERE car_id = ? AND end_date >= ?
       ORDER BY 1 LIMIT ?`,
    )
    .all(carId, fromDate, carId, fromDate, limit);
}

function newReference() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let ref = '';
  for (const b of bytes) ref += alphabet[b % alphabet.length];
  return `RH-${ref}`;
}

// Creates an unpaid booking from a price quote (see pricing.quoteBooking). With online payment it holds the car while the
// customer pays (pending_payment); with pay at pick-up it is confirmed at once.
// Availability is re-checked inside a write transaction so two customers
// cannot hold the same car for overlapping dates. Returns null if taken.
function createBooking(car, details, q, { payAtPickup = false } = {}) {
  return transaction(() => {
    if (!isCarAvailable(car.id, details.pickup, details.ret)) return null;
    const reference = newReference();
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO bookings (reference, car_id, shop_id, customer_name, customer_email, customer_phone,
         pickup_date, pickup_time, return_date, days, daily_price, car_total, extras_total,
         pickup_method, delivery_address, flight_number, delivery_fee, promo_code, discount, total_price,
         notes, manage_token, status, hold_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${payAtPickup ? 'NULL' : "datetime('now', ?)"})`,
    ).run(
      reference, car.id, car.shop_id, details.name, details.email, details.phone,
      details.pickup, details.pickupTime, details.ret, q.days, q.dailyPrice, q.carTotal, q.extrasTotal,
      q.pickupMethod, q.pickupMethod === 'delivery' ? details.deliveryAddress : '', q.pickupMethod === 'airport' ? details.flightNumber : '',
      q.deliveryFee, q.promoCode, q.discount, q.total, details.notes,
      crypto.randomBytes(24).toString('base64url'),
      ...(payAtPickup ? ['confirmed'] : ['pending_payment', `+${HOLD_MINUTES} minutes`]),
    );
    const shop = db.prepare('SELECT commission_percent FROM shops WHERE id = ?').get(car.shop_id);
    db.prepare('UPDATE bookings SET commission_percent = ? WHERE id = ?').run(commission.shopPercent(shop), lastInsertRowid);
    const insertExtra = db.prepare('INSERT INTO booking_extras (booking_id, extra_id, name, price, per, total) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of q.extras) insertExtra.run(lastInsertRowid, e.id, e.name, e.price, e.per, e.total);
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
      `UPDATE bookings SET status = ?, payment_status = 'paid', payment_ref = ?, paid_at = datetime('now'),
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

// What the customer may do with a booking right now.
//   canCancel   - the booking can still be cancelled by the customer (before pick-up)
//   refundable  - cancelling now is free: a paid booking is refunded in full
//   deadline    - last moment for a free cancellation
function cancellationPolicy(booking, now = new Date()) {
  const pickupAt = localToDate(booking.pickup_date, booking.pickup_time || '10:00');
  const deadline = new Date(pickupAt.getTime() - FREE_CANCELLATION_HOURS * 3600 * 1000);
  const canCancel = booking.status === 'confirmed' && now < pickupAt;
  return { canCancel, refundable: canCancel && now < deadline, deadline, pickupAt };
}

// Constant-time check of the secret in the customer's booking link.
function hasManageAccess(booking, token) {
  if (!booking?.manage_token || typeof token !== 'string') return false;
  const a = Buffer.from(booking.manage_token);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  blockedBetween,
  cancellationPolicy, hasManageAccess,
  HOLD_MINUTES, isCarAvailable, upcomingBookedRanges, createBooking, recordPayment, expireBooking,
};
