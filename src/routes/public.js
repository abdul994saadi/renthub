const express = require('express');
const { db } = require('../db');
const { CATEGORIES, TRANSMISSIONS, validateDates, todayISO, isISODate } = require('../helpers');
const { isCarAvailable, upcomingBookedRanges, quote, createPendingBooking } = require('../bookings');
const { startCheckout, syncFromSession, abandonCheckout } = require('../payments');

const router = express.Router();

const CAR_WITH_SHOP = `
  SELECT cars.*, shops.name AS shop_name, shops.city AS shop_city
  FROM cars JOIN shops ON shops.id = cars.shop_id`;

function activeCar(id) {
  return db.prepare(`${CAR_WITH_SHOP} WHERE cars.id = ? AND cars.is_active = 1`).get(Number(id));
}

function cities() {
  return db.prepare(`SELECT DISTINCT city FROM shops WHERE city <> '' ORDER BY city`).all().map((r) => r.city);
}

router.get('/', (req, res) => {
  const featured = db.prepare(`${CAR_WITH_SHOP} WHERE cars.is_active = 1 ORDER BY cars.created_at DESC LIMIT 6`).all();
  const stats = db
    .prepare(`SELECT (SELECT COUNT(*) FROM cars WHERE is_active = 1) AS cars, (SELECT COUNT(*) FROM shops) AS shops`)
    .get();
  res.render('home', { featured, stats, cities: cities(), categories: CATEGORIES });
});

router.get('/cars', (req, res) => {
  const f = {
    q: String(req.query.q || '').trim(),
    city: String(req.query.city || ''),
    category: String(req.query.category || ''),
    transmission: String(req.query.transmission || ''),
    maxPrice: Number(req.query.maxPrice) || '',
    pickup: isISODate(req.query.pickup) ? req.query.pickup : '',
    ret: isISODate(req.query.return) ? req.query.return : '',
    sort: String(req.query.sort || 'price'),
  };

  const where = ['cars.is_active = 1'];
  const params = [];
  if (f.q) {
    where.push(`(cars.make || ' ' || cars.model || ' ' || shops.name) LIKE ?`);
    params.push(`%${f.q}%`);
  }
  if (f.city) { where.push('shops.city = ?'); params.push(f.city); }
  if (f.category) { where.push('cars.category = ?'); params.push(f.category); }
  if (f.transmission) { where.push('cars.transmission = ?'); params.push(f.transmission); }
  if (f.maxPrice) { where.push('cars.daily_price <= ?'); params.push(f.maxPrice); }

  const orderBy = { price: 'cars.daily_price ASC', price_desc: 'cars.daily_price DESC', newest: 'cars.created_at DESC' }[f.sort]
    || 'cars.daily_price ASC';

  let cars = db.prepare(`${CAR_WITH_SHOP} WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`).all(...params);

  const dateError = f.pickup || f.ret ? validateDates(f.pickup, f.ret) : null;
  if (f.pickup && f.ret && !dateError) cars = cars.filter((c) => isCarAvailable(c.id, f.pickup, f.ret));

  res.render('cars', { cars, f, dateError, cities: cities(), categories: CATEGORIES, transmissions: TRANSMISSIONS });
});

router.get('/cars/:id', (req, res) => {
  const car = activeCar(req.params.id);
  if (!car) return res.status(404).render('error', { title: 'Car not found', message: 'This car is no longer available.' });
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(car.shop_id);
  const otherCars = db
    .prepare('SELECT * FROM cars WHERE shop_id = ? AND id <> ? AND is_active = 1 ORDER BY daily_price LIMIT 3')
    .all(car.shop_id, car.id);
  res.render('car', {
    car, shop, otherCars,
    booked: upcomingBookedRanges(car.id, todayISO()),
    form: { pickup: req.query.pickup || '', return: req.query.return || '' },
    error: null,
  });
});

function readBookingForm(body) {
  return {
    pickup: String(body.pickup || ''),
    ret: String(body.return || ''),
    name: String(body.name || '').trim(),
    email: String(body.email || '').trim(),
    phone: String(body.phone || '').trim(),
    notes: String(body.notes || '').trim().slice(0, 500),
    licence: body.licence === 'on' || body.licence === 'yes',
  };
}

function validateBooking(d, car) {
  return (
    validateDates(d.pickup, d.ret)
    || (!d.name && 'Please enter your full name.')
    || (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email) && 'Please enter a valid email address.')
    || (d.phone.replace(/\D/g, '').length < 7 && 'Please enter a valid phone number.')
    || (!d.licence && 'Please confirm you hold a valid driving licence.')
    || (!isCarAvailable(car.id, d.pickup, d.ret) && 'Sorry, this car is already booked for some of those dates. Please choose other dates.')
    || null
  );
}

function renderCarWithError(res, car, d, error) {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(car.shop_id);
  res.status(400).render('car', {
    car, shop, otherCars: [], booked: upcomingBookedRanges(car.id, todayISO()),
    form: { ...d, return: d.ret }, error,
  });
}

// Step 1: check the details and show a summary to review.
router.post('/cars/:id/book', (req, res) => {
  const car = activeCar(req.params.id);
  if (!car) return res.status(404).render('error', { title: 'Car not found', message: 'This car is no longer available.' });
  const d = readBookingForm(req.body);
  const error = validateBooking(d, car);
  if (error) return renderCarWithError(res, car, d, error);
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(car.shop_id);
  res.render('review', { car, shop, d, q: quote(car, d.pickup, d.ret) });
});

// Step 2: the customer confirmed the summary. Hold the car and send them to pay.
router.post('/cars/:id/confirm', async (req, res) => {
  const car = activeCar(req.params.id);
  if (!car) return res.status(404).render('error', { title: 'Car not found', message: 'This car is no longer available.' });
  const d = readBookingForm(req.body);
  const error = validateBooking(d, car);
  if (error) return renderCarWithError(res, car, d, error);

  const booking = createPendingBooking(car, d);
  if (!booking) return renderCarWithError(res, car, d, 'Sorry, someone just booked this car for those dates.');

  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(car.shop_id);
  try {
    res.redirect(303, await startCheckout(req, booking, car, shop));
  } catch (err) {
    console.error('Could not start checkout:', err.message);
    db.prepare(`UPDATE bookings SET status = 'expired', hold_expires_at = NULL WHERE id = ?`).run(booking.id);
    renderCarWithError(res, car, d, 'We could not start the payment. Please try again in a moment.');
  }
});

function findBooking(reference) {
  return db.prepare('SELECT * FROM bookings WHERE reference = ?').get(reference);
}

const bookingNotFound = (res) =>
  res.status(404).render('error', { title: 'Booking not found', message: 'Check the reference in your confirmation email.' });

// The customer pressed "back" on the payment page.
router.get('/bookings/:reference/abandon', async (req, res) => {
  const booking = findBooking(req.params.reference);
  if (!booking) return bookingNotFound(res);
  await abandonCheckout(booking);
  const after = findBooking(booking.reference);
  if (after.payment_status !== 'unpaid') return res.redirect(303, `/bookings/${after.reference}`);
  res.flash('info', 'Payment cancelled. The car was not booked and you were not charged.');
  res.redirect(303, `/cars/${booking.car_id}?pickup=${booking.pickup_date}&return=${booking.return_date}`);
});

router.get('/bookings/:reference', async (req, res) => {
  let booking = findBooking(req.params.reference);
  if (!booking) return bookingNotFound(res);
  if (req.query.session_id) booking = await syncFromSession(booking, String(req.query.session_id));
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(booking.car_id);
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(booking.shop_id);
  res.render('confirmation', { booking, car, shop });
});

router.get('/shops', (req, res) => {
  const shops = db
    .prepare(
      `SELECT shops.*, COUNT(cars.id) AS car_count, MIN(cars.daily_price) AS from_price
       FROM shops LEFT JOIN cars ON cars.shop_id = shops.id AND cars.is_active = 1
       GROUP BY shops.id ORDER BY shops.name`,
    )
    .all();
  res.render('shops', { shops });
});

router.get('/shops/:id', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(Number(req.params.id));
  if (!shop) return res.status(404).render('error', { title: 'Shop not found', message: 'This rental shop does not exist.' });
  const cars = db.prepare('SELECT * FROM cars WHERE shop_id = ? AND is_active = 1 ORDER BY daily_price').all(shop.id);
  res.render('shop-public', { shop, cars });
});

module.exports = router;
