// Background jobs: pick-up and return reminders, and review requests after a rental.
// Runs inside the web server every few minutes; each email is sent once (tracked on the booking).
const { db } = require('./db');
const { localToDate } = require('./helpers');
const email = require('./email');
const { canReview } = require('./reviews');

const HOUR = 3600 * 1000;
const PICKUP_REMINDER_BEFORE = 24 * HOUR;
const RETURN_REMINDER_BEFORE = 12 * HOUR;
const REVIEW_REQUEST_AFTER = 2 * HOUR;
const REVIEW_REQUEST_MAX_AGE = 14 * 24 * HOUR; // never ask about old rentals (e.g. on first start)

function details(booking) {
  return {
    car: db.prepare('SELECT * FROM cars WHERE id = ?').get(booking.car_id),
    shop: db.prepare('SELECT * FROM shops WHERE id = ?').get(booking.shop_id),
  };
}

// Claims a booking for one job so it is never emailed twice, even if two runs overlap.
function claim(bookingId, column) {
  return db.prepare(`UPDATE bookings SET ${column} = datetime('now') WHERE id = ? AND ${column} IS NULL`).run(bookingId).changes === 1;
}

async function runOnce(now = new Date()) {
  const sent = { pickup: 0, return: 0, review: 0 };

  const confirmed = db.prepare(
    `SELECT * FROM bookings WHERE status = 'confirmed'
     AND (pickup_reminder_sent_at IS NULL OR return_reminder_sent_at IS NULL)
     AND return_date >= date(?, '-1 day')`,
  ).all(now.toISOString().slice(0, 10));

  for (const b of confirmed) {
    const pickupAt = localToDate(b.pickup_date, b.pickup_time);
    const returnAt = localToDate(b.return_date, b.pickup_time);
    const bookedAt = new Date(`${b.created_at.replace(' ', 'T')}Z`);
    // Skip the pick-up reminder when the booking itself was made less than a day ahead.
    if (!b.pickup_reminder_sent_at && pickupAt > now && pickupAt - now <= PICKUP_REMINDER_BEFORE
        && pickupAt - bookedAt > PICKUP_REMINDER_BEFORE && claim(b.id, 'pickup_reminder_sent_at')) {
      const { car, shop } = details(b);
      await email.sendPickupReminder(b, car, shop);
      sent.pickup++;
    }
    if (!b.return_reminder_sent_at && returnAt > now && returnAt - now <= RETURN_REMINDER_BEFORE
        && returnAt - pickupAt > RETURN_REMINDER_BEFORE && claim(b.id, 'return_reminder_sent_at')) {
      const { car, shop } = details(b);
      await email.sendReturnReminder(b, car, shop);
      sent.return++;
    }
  }

  const ended = db.prepare(
    `SELECT * FROM bookings WHERE status IN ('confirmed', 'completed') AND review_requested_at IS NULL
     AND manage_token IS NOT NULL AND return_date <= ? AND return_date >= date(?, '-15 days')`,
  ).all(now.toISOString().slice(0, 10), now.toISOString().slice(0, 10));
  for (const b of ended) {
    const returnAt = localToDate(b.return_date, b.pickup_time);
    const since = now - returnAt;
    if (since >= REVIEW_REQUEST_AFTER && since <= REVIEW_REQUEST_MAX_AGE && canReview(b, now) && claim(b.id, 'review_requested_at')) {
      const { car, shop } = details(b);
      await email.sendReviewRequest(b, car, shop);
      sent.review++;
    }
  }
  return sent;
}

let timer = null;
function start(intervalMinutes = Number(process.env.REMINDER_INTERVAL_MINUTES || 10)) {
  const tick = () => runOnce().then((s) => {
    if (s.pickup || s.return || s.review) console.log(`Reminders sent: ${s.pickup} pick-up, ${s.return} return, ${s.review} review requests.`);
  }).catch((err) => console.error('Reminder job failed:', err));
  setTimeout(tick, 30 * 1000);
  timer = setInterval(tick, intervalMinutes * 60 * 1000);
  timer.unref();
}

module.exports = { runOnce, start };
