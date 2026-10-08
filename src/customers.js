// Recognising returning customers without accounts: other bookings with the same email
// or the same phone number (last 8 digits, so "+961 3 123 456" and "03123456" match).
const { db, getSetting } = require('./db');
const { todayISO, money } = require('./helpers');

const PHONE_KEY = (col) => `substr(replace(replace(replace(replace(replace(replace(${col}, ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), '.', ''), -8)`;
const phoneKey = (phone) => String(phone || '').replace(/\D/g, '').slice(-8);

// { rentals, withShop, noShows } for the customer of this booking, not counting the booking itself or test bookings.
// A rental counts once it is completed, or confirmed with its return date passed.
function customerHistory(booking) {
  const key = phoneKey(booking.customer_phone);
  return db.prepare(
    `SELECT
       COALESCE(SUM(status = 'completed' OR (status = 'confirmed' AND return_date < ?)), 0) AS rentals,
       COALESCE(SUM((status = 'completed' OR (status = 'confirmed' AND return_date < ?)) AND shop_id = ?), 0) AS withShop,
       COALESCE(SUM(status = 'no_show'), 0) AS noShows
     FROM bookings
     WHERE id <> ? AND is_test = 0
       AND (lower(customer_email) = lower(?) OR (length(?) >= 7 AND ${PHONE_KEY('customer_phone')} = ?))`,
  ).get(todayISO(), todayISO(), booking.shop_id, booking.id, booking.customer_email, key, key);
}

const withHistory = (bookings) => bookings.map((b) => ({ ...b, history: customerHistory(b) }));

// The promo code offered to customers after a rental (owner dashboard → Settings), if it is still usable for this shop.
function returningOffer(shopId) {
  const code = getSetting('returning_promo_code', '');
  if (!code) return null;
  const p = db.prepare('SELECT * FROM promo_codes WHERE code = ? COLLATE NOCASE AND active = 1').get(code);
  const today = todayISO();
  if (!p || (p.shop_id && p.shop_id !== shopId) || (p.ends_on && today > p.ends_on)) return null;
  return { code: p.code, label: p.kind === 'percent' ? `${p.value}% off` : `${money(p.value)} off`, minDays: p.min_days };
}

module.exports = { customerHistory, withHistory, returningOffer };
