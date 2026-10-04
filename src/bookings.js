const crypto = require('node:crypto');
const { db, transaction } = require('./db');
const { daysBetween } = require('./helpers');

// Only confirmed bookings block a car; cancelled and completed ones free it up.
function isCarAvailable(carId, pickup, ret) {
  const clash = db
    .prepare(
      `SELECT 1 FROM bookings
       WHERE car_id = ? AND status = 'confirmed' AND pickup_date < ? AND return_date > ?
       LIMIT 1`,
    )
    .get(carId, ret, pickup);
  return !clash;
}

function upcomingBookedRanges(carId, fromDate) {
  return db
    .prepare(
      `SELECT pickup_date, return_date FROM bookings
       WHERE car_id = ? AND status = 'confirmed' AND return_date > ?
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

// Re-checks availability inside a write transaction so two customers cannot
// book the same car for overlapping dates. Returns null if the car was taken.
function createBooking(car, details) {
  return transaction(() => {
    if (!isCarAvailable(car.id, details.pickup, details.ret)) return null;
    const q = quote(car, details.pickup, details.ret);
    const reference = newReference();
    db.prepare(
      `INSERT INTO bookings (reference, car_id, shop_id, customer_name, customer_email, customer_phone,
         pickup_date, return_date, days, daily_price, total_price, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      reference, car.id, car.shop_id, details.name, details.email, details.phone,
      details.pickup, details.ret, q.days, q.dailyPrice, q.total, details.notes,
    );
    return db.prepare('SELECT * FROM bookings WHERE reference = ?').get(reference);
  });
}

module.exports = { isCarAvailable, upcomingBookedRanges, quote, createBooking };
