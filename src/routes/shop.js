const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const { db } = require('../db');
const { hashPassword, verifyPassword, logIn, logOut, requireShop } = require('../auth');
const { CATEGORIES, TRANSMISSIONS, FUELS, todayISO, isISODate } = require('../helpers');
const { sendCancellationEmail } = require('../email');
const payments = require('../payments');
const { MAX_PHOTOS, carPhotos, updateCarPhotos, deleteCarPhotos } = require('../photos');
const { shopExtras, withExtras } = require('../pricing');
const documents = require('../documents');
const { optimizeUploads } = require('../images');
const commission = require('../commission');

// Booking rows for lists: chosen extras and uploaded driver documents.
const withDetails = (bookings) => withExtras(bookings).map((b) => ({ ...b, documents: documents.bookingDocuments(b.id) }));

const router = express.Router();

const { UPLOAD_DIR } = require('../helpers');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + IMAGE_TYPES[file.mimetype]),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, Boolean(IMAGE_TYPES[file.mimetype])),
});

function removeUpload(filename) {
  if (filename) fs.rm(path.join(UPLOAD_DIR, path.basename(filename)), { force: true }, () => {});
}
const removeUploads = (files = []) => files.forEach((f) => removeUpload(f.filename));

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/shop') && !n.startsWith('//') ? n : '/shop');

// ---------- Account ----------

router.get('/register', (req, res) => res.render('shop/register', { form: {}, error: null }));

router.post('/register', (req, res) => {
  const form = {
    name: String(req.body.name || '').trim(),
    email: String(req.body.email || '').trim().toLowerCase(),
    phone: String(req.body.phone || '').trim(),
    city: String(req.body.city || '').trim(),
    address: String(req.body.address || '').trim(),
  };
  const password = String(req.body.password || '');
  const error =
    (!form.name && 'Please enter your shop name.')
    || (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email) && 'Please enter a valid email address.')
    || (!form.city && 'Please enter the city your shop is in.')
    || (password.length < 8 && 'The password must be at least 8 characters.')
    || (db.prepare('SELECT 1 FROM shops WHERE email = ?').get(form.email) && 'A shop with this email already exists. Try logging in.')
    || null;
  if (error) return res.status(400).render('shop/register', { form, error });

  const { lastInsertRowid } = db
    .prepare('INSERT INTO shops (name, email, password_hash, phone, city, address) VALUES (?, ?, ?, ?, ?, ?)')
    .run(form.name, form.email, hashPassword(password), form.phone, form.city, form.address);
  logIn(res, lastInsertRowid);
  res.flash('success', 'Welcome to RentHub! Add your first car to start taking bookings.');
  res.redirect(303, '/shop/cars/new');
});

router.get('/login', (req, res) => res.render('shop/login', { email: '', next: safeNext(req.query.next), error: null }));

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim();
  const shop = db.prepare('SELECT * FROM shops WHERE email = ?').get(email);
  if (!shop || !verifyPassword(String(req.body.password || ''), shop.password_hash)) {
    return res.status(401).render('shop/login', { email, next: safeNext(req.body.next), error: 'Wrong email or password.' });
  }
  if (shop.suspended) {
    return res.status(403).render('shop/login', { email, next: '/shop', error: 'This shop account is suspended. Please contact RentHub.' });
  }
  logIn(res, shop.id);
  res.redirect(303, safeNext(req.body.next));
});

router.post('/logout', (req, res) => {
  logOut(res);
  res.redirect(303, '/');
});

router.use(requireShop);
router.use((req, res, next) => {
  if (!req.shop.suspended) return next();
  logOut(res);
  res.status(403).render('error', { title: 'Account suspended', message: 'This shop account is suspended. Please contact RentHub.' });
});

// ---------- Dashboard ----------

router.get('/', (req, res) => {
  const shopId = req.shop.id;
  const today = todayISO();
  const stats = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM cars WHERE shop_id = ?) AS cars,
         (SELECT COUNT(*) FROM cars WHERE shop_id = ? AND is_active = 1) AS active_cars,
         (SELECT COUNT(*) FROM bookings WHERE shop_id = ? AND status = 'confirmed' AND return_date >= ?) AS upcoming,
         (SELECT COALESCE(SUM(total_price), 0) FROM bookings WHERE shop_id = ? AND status IN ('confirmed', 'completed')) AS revenue`,
    )
    .get(shopId, shopId, shopId, today, shopId);
  const upcoming = db
    .prepare(
      `SELECT bookings.*, cars.make, cars.model, cars.year FROM bookings JOIN cars ON cars.id = bookings.car_id
       WHERE bookings.shop_id = ? AND bookings.status = 'confirmed' AND bookings.return_date >= ?
       ORDER BY bookings.pickup_date LIMIT 8`,
    )
    .all(shopId, today);
  res.render('shop/dashboard', { stats, upcoming: withDetails(upcoming) });
});

// ---------- Cars ----------

router.get('/cars', (req, res) => {
  const cars = db
    .prepare(
      `SELECT cars.*, (SELECT COUNT(*) FROM bookings b WHERE b.car_id = cars.id AND b.status = 'confirmed') AS booking_count,
         (SELECT start_date || ' to ' || end_date FROM car_blocks k WHERE k.car_id = cars.id AND k.end_date >= ? ORDER BY start_date LIMIT 1) AS next_block
       FROM cars WHERE shop_id = ? ORDER BY created_at DESC`,
    )
    .all(todayISO(), req.shop.id);
  res.render('shop/cars', { cars });
});

function ownCar(req) {
  return db.prepare('SELECT * FROM cars WHERE id = ? AND shop_id = ?').get(Number(req.params.id), req.shop.id);
}

function readCarForm(body) {
  const features = [].concat(body.features || []).map(String);
  if (body.extra_features) features.push(...String(body.extra_features).split(','));
  return {
    make: String(body.make || '').trim(),
    model: String(body.model || '').trim(),
    year: Number(body.year),
    category: String(body.category || ''),
    transmission: String(body.transmission || ''),
    fuel: String(body.fuel || ''),
    seats: Number(body.seats),
    doors: Number(body.doors) || 4,
    daily_price: Number(body.daily_price),
    deposit: Number(body.deposit) || 0,
    min_days: Number(body.min_days) || 1,
    mileage_policy: String(body.mileage_policy || 'Unlimited').trim() || 'Unlimited',
    features: [...new Set(features.map((f) => f.trim()).filter(Boolean))].join(', '),
    description: String(body.description || '').trim(),
  };
}

function validateCar(c) {
  const thisYear = new Date().getFullYear();
  return (
    (!c.make && 'Please enter the car make (e.g. Toyota).')
    || (!c.model && 'Please enter the car model (e.g. Corolla).')
    || (!(c.year >= 1980 && c.year <= thisYear + 1) && 'Please enter a valid year.')
    || (!CATEGORIES.includes(c.category) && 'Please choose a category.')
    || (!TRANSMISSIONS.includes(c.transmission) && 'Please choose a transmission.')
    || (!FUELS.includes(c.fuel) && 'Please choose a fuel type.')
    || (!(c.seats >= 1 && c.seats <= 20) && 'Please enter the number of seats.')
    || (!(c.daily_price > 0) && 'Please enter a daily price above zero.')
    || (c.deposit < 0 && 'The deposit cannot be negative.')
    || (!(Number.isInteger(c.min_days) && c.min_days >= 1 && c.min_days <= 60) && 'The minimum rental must be between 1 and 60 days.')
    || null
  );
}

const carFormOptions = { categories: CATEGORIES, transmissions: TRANSMISSIONS, fuels: FUELS, maxPhotos: MAX_PHOTOS };

router.get('/cars/new', (req, res) => {
  res.render('shop/car-form', { ...carFormOptions, car: { doors: 4, seats: 5, mileage_policy: 'Unlimited', features: '' }, photos: [], error: null });
});

router.post('/cars', upload.array('photos', MAX_PHOTOS), async (req, res) => {
  const car = readCarForm(req.body);
  const error = validateCar(car);
  if (error) {
    removeUploads(req.files);
    return res.status(400).render('shop/car-form', { ...carFormOptions, car, photos: [], error });
  }
  const { lastInsertRowid: carId } = db.prepare(
    `INSERT INTO cars (shop_id, make, model, year, category, transmission, fuel, seats, doors, daily_price, deposit,
       mileage_policy, features, description, min_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    req.shop.id, car.make, car.model, car.year, car.category, car.transmission, car.fuel, car.seats, car.doors,
    car.daily_price, car.deposit, car.mileage_policy, car.features, car.description, car.min_days,
  );
  await optimizeUploads(req.files);
  updateCarPhotos(Number(carId), { added: (req.files || []).map((f) => f.filename) });
  res.flash('success', `${car.make} ${car.model} is now listed and can be booked.`);
  res.redirect(303, '/shop/cars');
});

router.get('/cars/:id/edit', (req, res) => {
  const car = ownCar(req);
  if (!car) return res.status(404).render('error', { title: 'Car not found', message: 'This car does not belong to your shop.' });
  res.render('shop/car-form', { ...carFormOptions, car, photos: carPhotos(car.id), error: null });
});

router.post('/cars/:id', upload.array('photos', MAX_PHOTOS), async (req, res) => {
  const existing = ownCar(req);
  if (!existing) {
    removeUploads(req.files);
    return res.status(404).render('error', { title: 'Car not found', message: 'This car does not belong to your shop.' });
  }
  const car = { ...readCarForm(req.body), id: existing.id, image: existing.image };
  const error = validateCar(car);
  if (error) {
    removeUploads(req.files);
    return res.status(400).render('shop/car-form', { ...carFormOptions, car, photos: carPhotos(existing.id), error });
  }
  db.prepare(
    `UPDATE cars SET make = ?, model = ?, year = ?, category = ?, transmission = ?, fuel = ?, seats = ?, doors = ?,
       daily_price = ?, deposit = ?, mileage_policy = ?, features = ?, description = ?, min_days = ?
     WHERE id = ?`,
  ).run(
    car.make, car.model, car.year, car.category, car.transmission, car.fuel, car.seats, car.doors,
    car.daily_price, car.deposit, car.mileage_policy, car.features, car.description, car.min_days, existing.id,
  );
  await optimizeUploads(req.files);
  const rejected = updateCarPhotos(existing.id, {
    added: (req.files || []).map((f) => f.filename),
    removeIds: [].concat(req.body.remove_photo || []),
    coverId: req.body.cover_photo || null,
  });
  res.flash(rejected.length ? 'error' : 'success', rejected.length
    ? `Car details saved, but ${rejected.length} photo(s) were not added: a car can have at most ${MAX_PHOTOS} photos.`
    : 'Car details saved.');
  res.redirect(303, '/shop/cars');
});

// ---------- Blocked dates (service, repairs...) ----------

const BLOCK_REASONS = ['Service', 'Repair', 'Maintenance', 'Private use', 'Other'];

function blocksPage(res, car, { form = {}, error = null, status = 200 } = {}) {
  const blocks = db.prepare('SELECT * FROM car_blocks WHERE car_id = ? AND end_date >= ? ORDER BY start_date').all(car.id, todayISO());
  const bookings = db.prepare(
    `SELECT reference, customer_name, pickup_date, return_date FROM bookings
     WHERE car_id = ? AND status = 'confirmed' AND return_date >= ? ORDER BY pickup_date LIMIT 20`,
  ).all(car.id, todayISO());
  res.status(status).render('shop/car-blocks', { car, blocks, bookings, form, error, reasons: BLOCK_REASONS, today: todayISO() });
}

router.get('/cars/:id/blocks', (req, res) => {
  const car = ownCar(req);
  if (!car) return res.status(404).render('error', { title: 'Car not found', message: 'This car does not belong to your shop.' });
  blocksPage(res, car);
});

router.post('/cars/:id/blocks', (req, res) => {
  const car = ownCar(req);
  if (!car) return res.status(404).render('error', { title: 'Car not found', message: 'This car does not belong to your shop.' });
  const form = {
    start_date: String(req.body.start_date || ''),
    end_date: String(req.body.end_date || req.body.start_date || ''),
    reason: BLOCK_REASONS.includes(req.body.reason) ? req.body.reason : 'Other',
    note: String(req.body.note || '').trim().slice(0, 100),
  };
  const nextDay = (d) => new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10);
  let error = (!isISODate(form.start_date) || !isISODate(form.end_date)) && 'Please choose the first and last day the car is unavailable.';
  error = error || (form.end_date < form.start_date && 'The last day cannot be before the first day.')
    || (form.start_date < todayISO() && 'The first day cannot be in the past.');
  if (!error) {
    // A confirmed booking already uses some of these days: the shop must deal with it first.
    const clash = db.prepare(
      `SELECT reference, customer_name, pickup_date, return_date FROM bookings
       WHERE car_id = ? AND status IN ('confirmed', 'pending_payment') AND pickup_date < ? AND return_date > ? LIMIT 1`,
    ).get(car.id, nextDay(form.end_date), form.start_date);
    if (clash) {
      error = `Booking ${clash.reference} (${clash.customer_name}) already has this car from ${clash.pickup_date} to ${clash.return_date}. `
        + 'Choose other days, or cancel that booking first from the Bookings tab.';
    }
  }
  if (error) return blocksPage(res, car, { form, error, status: 400 });
  db.prepare('INSERT INTO car_blocks (car_id, start_date, end_date, reason) VALUES (?, ?, ?, ?)')
    .run(car.id, form.start_date, form.end_date, [form.reason, form.note].filter(Boolean).join(': '));
  res.flash('success', `${car.make} ${car.model} is blocked from ${form.start_date} to ${form.end_date}. Customers cannot book it on these days.`);
  res.redirect(303, `/shop/cars/${car.id}/blocks`);
});

router.post('/cars/:id/blocks/:blockId/delete', (req, res) => {
  const car = ownCar(req);
  if (car) {
    db.prepare('DELETE FROM car_blocks WHERE id = ? AND car_id = ?').run(Number(req.params.blockId), car.id);
    res.flash('success', 'Those days are open for booking again.');
  }
  res.redirect(303, car ? `/shop/cars/${car.id}/blocks` : '/shop/cars');
});

router.post('/cars/:id/toggle', (req, res) => {
  const car = ownCar(req);
  if (car) {
    db.prepare('UPDATE cars SET is_active = ? WHERE id = ?').run(car.is_active ? 0 : 1, car.id);
    res.flash('success', car.is_active ? `${car.make} ${car.model} is hidden from customers.` : `${car.make} ${car.model} is visible again.`);
  }
  res.redirect(303, '/shop/cars');
});

router.post('/cars/:id/delete', (req, res) => {
  const car = ownCar(req);
  if (!car) return res.redirect(303, '/shop/cars');
  const upcoming = db
    .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE car_id = ? AND status = 'confirmed' AND return_date >= ?`)
    .get(car.id, todayISO()).n;
  if (upcoming) {
    res.flash('error', `This car has ${upcoming} upcoming booking(s). Cancel them first, or hide the car instead.`);
  } else {
    deleteCarPhotos(car.id);
    db.prepare('DELETE FROM cars WHERE id = ?').run(car.id);
    res.flash('success', `${car.make} ${car.model} was deleted.`);
  }
  res.redirect(303, '/shop/cars');
});

// ---------- Bookings ----------

router.get('/bookings', (req, res) => {
  const status = ['confirmed', 'completed', 'cancelled', 'no_show'].includes(req.query.status) ? req.query.status : '';
  const bookings = db
    .prepare(
      `SELECT bookings.*, cars.make, cars.model, cars.year FROM bookings JOIN cars ON cars.id = bookings.car_id
       WHERE bookings.shop_id = ? AND bookings.status IN ('confirmed', 'completed', 'cancelled', 'no_show')
         ${status ? 'AND bookings.status = ?' : ''}
       ORDER BY bookings.pickup_date DESC`,
    )
    .all(...[req.shop.id, status].filter(Boolean));
  res.render('shop/bookings', { bookings: withDetails(bookings), status });
});

// A customer's driver document, only for the shop that owns the booking.
router.get('/bookings/:id/documents/:docId', (req, res) => {
  const doc = db.prepare(
    `SELECT booking_documents.* FROM booking_documents JOIN bookings ON bookings.id = booking_documents.booking_id
     WHERE booking_documents.id = ? AND bookings.id = ? AND bookings.shop_id = ?`,
  ).get(Number(req.params.docId), Number(req.params.id), req.shop.id);
  if (!doc) return res.status(404).render('error', { title: 'Not found', message: 'This document does not exist.' });
  documents.sendDocument(res, doc);
});

router.post('/bookings/:id/status', async (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND shop_id = ?').get(Number(req.params.id), req.shop.id);
  const status = req.body.status;
  const back = req.get('referer')?.includes('/shop') ? req.get('referer') : '/shop/bookings';
  if (!booking || booking.status !== 'confirmed' || !['completed', 'cancelled', 'no_show'].includes(status)) return res.redirect(303, back);

  if (status === 'completed') {
    db.prepare(`UPDATE bookings SET status = 'completed' WHERE id = ?`).run(booking.id);
    res.flash('success', `Booking ${booking.reference} marked as completed.`);
    return res.redirect(303, back);
  }
  // The customer did not come to pick up the car (only once the pick-up day has arrived). No commission is charged.
  if (status === 'no_show') {
    if (booking.pickup_date > todayISO()) return res.redirect(303, back);
    db.prepare(`UPDATE bookings SET status = 'no_show' WHERE id = ?`).run(booking.id);
    res.flash('success', `Booking ${booking.reference} marked as a no-show.`);
    return res.redirect(303, back);
  }

  try {
    await payments.refundBooking(booking);
  } catch (err) {
    console.error(`Refund for ${booking.reference} failed:`, err.message);
    res.flash('error', `The refund could not be processed (${err.message}). The booking was not cancelled.`);
    return res.redirect(303, back);
  }
  db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_by = 'shop', cancelled_at = datetime('now') WHERE id = ?`).run(booking.id);
  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(booking.car_id);
  await sendCancellationEmail(updated, car, req.shop);
  res.flash('success', `Booking ${booking.reference} cancelled${updated.payment_status === 'refunded' ? ' and fully refunded' : ''}. The customer has been emailed.`);
  res.redirect(303, back);
});

// ---------- Payments ----------

// Customers pay RentHub online; RentHub pays each shop its share.
router.get('/payments', (req, res) => {
  const rate = commission.defaultPercent();
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(b.total_price), 0) AS gross, ${commission.COMMISSION_SUM} AS fee
       FROM bookings b JOIN shops s ON s.id = b.shop_id WHERE b.shop_id = ? AND b.payment_status = 'paid'`,
    )
    .get(rate, req.shop.id);
  // With pay at pick-up the shop collects the money, so the commission is owed on its confirmed and completed bookings.
  const owed = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(b.total_price), 0) AS value, ${commission.COMMISSION_SUM} AS fee
       FROM bookings b JOIN shops s ON s.id = b.shop_id
       WHERE b.shop_id = ? AND b.status IN ('confirmed', 'completed') AND b.payment_status <> 'paid'`,
    )
    .get(rate, req.shop.id);
  const recent = db
    .prepare(
      `SELECT bookings.*, cars.make, cars.model, cars.year FROM bookings JOIN cars ON cars.id = bookings.car_id
       WHERE bookings.shop_id = ? AND bookings.payment_status IN ('paid', 'refunded')
       ORDER BY bookings.paid_at DESC LIMIT 20`,
    )
    .all(req.shop.id);
  res.render('shop/payments', { totals, owed, fee: totals.fee, feePercent: commission.shopPercent(req.shop), recent });
});

// ---------- Extras ----------

router.get('/extras', (req, res) => {
  res.render('shop/extras', { extras: shopExtras(req.shop.id, { activeOnly: false }), form: {}, error: null });
});

router.post('/extras', (req, res) => {
  const form = {
    name: String(req.body.name || '').trim().slice(0, 60),
    price: Number(req.body.price),
    per: req.body.per === 'booking' ? 'booking' : 'day',
  };
  const error = (!form.name && 'Please enter a name, e.g. Child seat.')
    || (!(form.price >= 0) && 'Please enter a price (0 for free).') || null;
  if (error) return res.status(400).render('shop/extras', { extras: shopExtras(req.shop.id, { activeOnly: false }), form, error });
  db.prepare('INSERT INTO extras (shop_id, name, price, per) VALUES (?, ?, ?, ?)').run(req.shop.id, form.name, form.price, form.per);
  res.flash('success', `${form.name} added. Customers can now choose it when booking.`);
  res.redirect(303, '/shop/extras');
});

router.post('/extras/:id/:action', (req, res) => {
  const extra = db.prepare('SELECT * FROM extras WHERE id = ? AND shop_id = ?').get(Number(req.params.id), req.shop.id);
  if (extra && req.params.action === 'toggle') {
    db.prepare('UPDATE extras SET active = ? WHERE id = ?').run(extra.active ? 0 : 1, extra.id);
  } else if (extra && req.params.action === 'delete') {
    db.prepare('DELETE FROM extras WHERE id = ?').run(extra.id);
    res.flash('success', `${extra.name} removed.`);
  }
  res.redirect(303, '/shop/extras');
});

// ---------- Profile ----------

router.get('/profile', (req, res) => res.render('shop/profile', { form: req.shop, error: null }));

router.post('/profile', (req, res) => {
  const form = {
    name: String(req.body.name || '').trim(),
    phone: String(req.body.phone || '').trim(),
    city: String(req.body.city || '').trim(),
    address: String(req.body.address || '').trim(),
    opening_hours: String(req.body.opening_hours || '').trim(),
    description: String(req.body.description || '').trim(),
    whatsapp: String(req.body.whatsapp || '').trim(),
    // NULL means the option is not offered; 0 means offered for free.
    delivery_fee: req.body.offer_delivery ? Number(req.body.delivery_fee) || 0 : null,
    delivery_note: String(req.body.delivery_note || '').trim().slice(0, 200),
    airport_fee: req.body.offer_airport ? Number(req.body.airport_fee) || 0 : null,
  };
  const error = (!form.name && 'Please enter your shop name.') || (!form.city && 'Please enter your city.')
    || ((form.delivery_fee < 0 || form.airport_fee < 0) && 'Fees cannot be negative.') || null;
  if (error) return res.status(400).render('shop/profile', { form: { ...req.shop, ...form }, error });
  db.prepare(`UPDATE shops SET name = ?, phone = ?, city = ?, address = ?, opening_hours = ?, description = ?,
      whatsapp = ?, delivery_fee = ?, delivery_note = ?, airport_fee = ? WHERE id = ?`)
    .run(form.name, form.phone, form.city, form.address, form.opening_hours, form.description,
      form.whatsapp, form.delivery_fee, form.delivery_note, form.airport_fee, req.shop.id);
  res.flash('success', 'Shop profile saved.');
  res.redirect(303, '/shop/profile');
});

module.exports = router;
