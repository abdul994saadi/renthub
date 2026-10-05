const { db } = require('./db');
const { localToDate } = require('./helpers');

const VISIBLE = 'hidden = 0';

// Customers can review once the rental has ended (return time passed) and it was not cancelled.
function canReview(booking, now = new Date()) {
  if (!['confirmed', 'completed'].includes(booking.status)) return false;
  if (localToDate(booking.return_date, booking.pickup_time) > now) return false;
  return !db.prepare('SELECT 1 FROM reviews WHERE booking_id = ?').get(booking.id);
}

function addReview(booking, { rating, comment }) {
  db.prepare(
    'INSERT INTO reviews (booking_id, car_id, shop_id, rating, comment, customer_name) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(booking.id, booking.car_id, booking.shop_id, rating, comment, booking.customer_name.split(/\s+/)[0]);
}

function carReviews(carId, limit = 20) {
  return db.prepare(`SELECT * FROM reviews WHERE car_id = ? AND ${VISIBLE} ORDER BY created_at DESC LIMIT ?`).all(carId, limit);
}

function shopReviews(shopId, limit = 20) {
  return db.prepare(
    `SELECT reviews.*, cars.make, cars.model FROM reviews JOIN cars ON cars.id = reviews.car_id
     WHERE reviews.shop_id = ? AND reviews.${VISIBLE} ORDER BY reviews.created_at DESC LIMIT ?`,
  ).all(shopId, limit);
}

// { average, count } for a car or a shop.
function ratingFor(column, id) {
  const r = db.prepare(`SELECT ROUND(AVG(rating), 1) AS average, COUNT(*) AS count FROM reviews WHERE ${column} = ? AND ${VISIBLE}`).get(id);
  return { average: r.average || 0, count: r.count };
}

// SQL snippets to add a car's rating to car listing queries (expects the cars table as "cars").
const CAR_RATING_COLUMNS = `
  (SELECT ROUND(AVG(rating), 1) FROM reviews r WHERE r.car_id = cars.id AND r.hidden = 0) AS rating,
  (SELECT COUNT(*) FROM reviews r WHERE r.car_id = cars.id AND r.hidden = 0) AS review_count`;

module.exports = { canReview, addReview, carReviews, shopReviews, ratingFor, CAR_RATING_COLUMNS };
