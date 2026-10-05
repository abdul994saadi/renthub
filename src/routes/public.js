const express = require('express');
const { db } = require('../db');
const { CATEGORIES, TRANSMISSIONS, PICKUP_TIMES, validateDates, todayISO, localToDate, isISODate } = require('../helpers');
const { isCarAvailable, upcomingBookedRanges, quote, createBooking, cancellationPolicy, hasManageAccess } = require('../bookings');
const { sendBookingEmails, sendCustomerCancellationEmails } = require('../email');
const { carPhotos } = require('../photos');
const { payAtPickup, startCheckout, syncPendingBooking, abandonCheckout, handleApsResult, refundBooking } = require('../payments');

const router = express.Router();

// Cars of suspended shops are never shown or bookable.
const CAR_WITH_SHOP = `
  SELECT cars.*, shops.name AS shop_name, shops.city AS shop_city, shops.verified AS shop_verified
  FROM cars JOIN shops ON shops.id = cars.shop_id AND shops.suspended = 0`;

function activeCar(id) {
  return db.prepare(`${CAR_WITH_SHOP} WHERE cars.id = ? AND cars.is_active = 1`).get(Number(id));
}

function cities() {
  return db.prepare(`SELECT DISTINCT city FROM shops WHERE city <> '' AND suspended = 0 ORDER BY city`).all().map((r) => r.city);
}

// Everything the car page shows, in one place (the booking form re-renders it on errors).
function renderCarPage(res, car, { form, error = null, status = 200 }) {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(car.shop_id);
  const otherCars = db
    .prepare('SELECT * FROM cars WHERE shop_id = ? AND id <> ? AND is_active = 1 ORDER BY daily_price LIMIT 3')
    .all(car.shop_id, car.id);
  res.status(status).render('car', {
    car, shop, otherCars, error, form,
    photos: carPhotos(car.id),
    booked: upcomingBookedRanges(car.id, todayISO()),
  });
}

router.get('/', (req, res) => {
  const featured = db.prepare(`${CAR_WITH_SHOP} WHERE cars.is_active = 1 ORDER BY cars.created_at DESC LIMIT 6`).all();
  const stats = db
    .prepare(`SELECT (SELECT COUNT(*) FROM cars JOIN shops ON shops.id = cars.shop_id AND shops.suspended = 0 WHERE cars.is_active = 1) AS cars,
                     (SELECT COUNT(*) FROM shops WHERE suspended = 0) AS shops`)
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
  renderCarPage(res, car, { form: { pickup: req.query.pickup || '', pickupTime: '10:00', return: req.query.return || '' } });
});

function readBookingForm(body) {
  return {
    pickup: String(body.pickup || ''),
    pickupTime: String(body.pickup_time || ''),
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
    || (!PICKUP_TIMES.includes(d.pickupTime) && 'Please choose a pick-up time.')
    || (localToDate(d.pickup, d.pickupTime) <= new Date() && 'That pick-up time has already passed. Please choose a later time.')
    || (!d.name && 'Please enter your full name.')
    || (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email) && 'Please enter a valid email address.')
    || (d.phone.replace(/\D/g, '').length < 7 && 'Please enter a valid phone number.')
    || (!d.licence && 'Please confirm you hold a valid driving licence.')
    || (!isCarAvailable(car.id, d.pickup, d.ret) && 'Sorry, this car is already booked for some of those dates. Please choose other dates.')
    || null
  );
}

function renderCarWithError(res, car, d, error) {
  renderCarPage(res, car, { form: { ...d, return: d.ret }, error, status: 400 });
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

// Step 2: the customer confirmed the summary. Either confirm the booking (pay at
// pick-up) or hold the car and send them to pay online.
router.post('/cars/:id/confirm', async (req, res) => {
  const car = activeCar(req.params.id);
  if (!car) return res.status(404).render('error', { title: 'Car not found', message: 'This car is no longer available.' });
  const d = readBookingForm(req.body);
  const error = validateBooking(d, car);
  if (error) return renderCarWithError(res, car, d, error);

  const booking = createBooking(car, d, { payAtPickup });
  if (!booking) return renderCarWithError(res, car, d, 'Sorry, someone just booked this car for those dates.');

  if (payAtPickup) {
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(car.shop_id);
    await sendBookingEmails(booking, car, shop);
    return res.redirect(303, manageUrl(booking));
  }

  const checkout = startCheckout(req, booking, car);
  if (checkout.redirect) return res.redirect(303, checkout.redirect);
  // APS's payment page is opened with a signed form POST from the browser.
  res.render('payment-redirect', { form: checkout.form, booking });
});

// The customer's browser comes back from the APS payment page with the signed result.
router.all('/payments/aps/return', async (req, res) => {
  const params = req.method === 'POST' ? req.body : req.query;
  let result;
  try {
    result = await handleApsResult(params);
  } catch (err) {
    console.error('APS return error:', err.message);
    return res.status(err.status || 500).render('error', {
      title: 'Payment could not be verified',
      message: 'If you were charged, your booking will be confirmed by email shortly. Otherwise please try booking again.',
    });
  }
  const { booking, paid, message } = result;
  if (!booking) return bookingNotFound(res);
  if (paid) return res.redirect(303, manageUrl(booking));
  res.flash('error', `Payment was not completed${message ? ` (${message})` : ''}. The car was not booked and you were not charged.`);
  res.redirect(303, `/cars/${booking.car_id}?pickup=${booking.pickup_date}&return=${booking.return_date}`);
});

// The customer's private link to their booking (lets them cancel it).
const manageUrl = (booking) => `/bookings/${booking.reference}?t=${booking.manage_token}`;

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
  if (after.payment_status !== 'unpaid') return res.redirect(303, manageUrl(after));
  res.flash('info', 'Payment cancelled. The car was not booked and you were not charged.');
  res.redirect(303, `/cars/${booking.car_id}?pickup=${booking.pickup_date}&return=${booking.return_date}`);
});

router.get('/bookings/:reference', async (req, res) => {
  let booking = findBooking(req.params.reference);
  if (!booking) return bookingNotFound(res);
  if (booking.status === 'pending_payment') booking = await syncPendingBooking(booking);
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(booking.car_id);
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(booking.shop_id);
  const token = hasManageAccess(booking, req.query.t) ? req.query.t : null;
  res.render('confirmation', { booking, car, shop, token, policy: cancellationPolicy(booking) });
});

// The customer cancels from their private booking link. Free (fully refunded)
// until FREE_CANCELLATION_HOURS before pick-up; after that it is non-refundable.
router.post('/bookings/:reference/cancel', async (req, res) => {
  const booking = findBooking(req.params.reference);
  if (!booking) return bookingNotFound(res);
  if (!hasManageAccess(booking, req.body.t)) {
    return res.status(403).render('error', { title: 'Link not valid', message: 'Use the link in your confirmation email to manage this booking.' });
  }
  const policy = cancellationPolicy(booking);
  if (!policy.canCancel) {
    res.flash('error', 'This booking can no longer be cancelled online. Please contact the rental shop.');
    return res.redirect(303, manageUrl(booking));
  }
  if (policy.refundable) {
    try {
      await refundBooking(booking);
    } catch (err) {
      console.error(`Refund for ${booking.reference} failed:`, err.message);
      res.flash('error', 'We could not process the refund, so the booking was not cancelled. Please try again or contact the shop.');
      return res.redirect(303, manageUrl(booking));
    }
  }
  const { changes } = db.prepare(
    `UPDATE bookings SET status = 'cancelled', cancelled_by = 'customer', cancelled_at = datetime('now')
     WHERE id = ? AND status = 'confirmed'`,
  ).run(booking.id);
  if (changes) {
    const updated = findBooking(booking.reference);
    const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(booking.car_id);
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(booking.shop_id);
    await sendCustomerCancellationEmails(updated, car, shop, { late: !policy.refundable });
    res.flash('success', 'Your booking has been cancelled. We have emailed you a confirmation.');
  }
  res.redirect(303, manageUrl(booking));
});

router.get('/shops', (req, res) => {
  const shops = db
    .prepare(
      `SELECT shops.*, COUNT(cars.id) AS car_count, MIN(cars.daily_price) AS from_price
       FROM shops LEFT JOIN cars ON cars.shop_id = shops.id AND cars.is_active = 1
       WHERE shops.suspended = 0
       GROUP BY shops.id ORDER BY shops.verified DESC, shops.name`,
    )
    .all();
  res.render('shops', { shops });
});

router.get('/shops/:id', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ? AND suspended = 0').get(Number(req.params.id));
  if (!shop) return res.status(404).render('error', { title: 'Shop not found', message: 'This rental shop does not exist.' });
  const cars = db.prepare('SELECT * FROM cars WHERE shop_id = ? AND is_active = 1 ORDER BY daily_price').all(shop.id);
  res.render('shop-public', { shop, cars });
});

module.exports = router;
