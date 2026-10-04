const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const { db } = require('../db');
const { hashPassword, verifyPassword, logIn, logOut, requireShop } = require('../auth');
const { CATEGORIES, TRANSMISSIONS, FUELS, todayISO } = require('../helpers');
const { sendCancellationEmail } = require('../email');
const payments = require('../payments');

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
  logIn(res, shop.id);
  res.redirect(303, safeNext(req.body.next));
});

router.post('/logout', (req, res) => {
  logOut(res);
  res.redirect(303, '/');
});

router.use(requireShop);

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
  res.render('shop/dashboard', { stats, upcoming });
});

// ---------- Cars ----------

router.get('/cars', (req, res) => {
  const cars = db
    .prepare(
      `SELECT cars.*, (SELECT COUNT(*) FROM bookings b WHERE b.car_id = cars.id AND b.status = 'confirmed') AS booking_count
       FROM cars WHERE shop_id = ? ORDER BY created_at DESC`,
    )
    .all(req.shop.id);
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
    || null
  );
}

const carFormOptions = { categories: CATEGORIES, transmissions: TRANSMISSIONS, fuels: FUELS };

router.get('/cars/new', (req, res) => {
  res.render('shop/car-form', { ...carFormOptions, car: { doors: 4, seats: 5, mileage_policy: 'Unlimited', features: '' }, error: null });
});

router.post('/cars', upload.single('image'), (req, res) => {
  const car = readCarForm(req.body);
  const error = validateCar(car);
  if (error) {
    removeUpload(req.file?.filename);
    return res.status(400).render('shop/car-form', { ...carFormOptions, car, error });
  }
  db.prepare(
    `INSERT INTO cars (shop_id, make, model, year, category, transmission, fuel, seats, doors, daily_price, deposit,
       mileage_policy, features, description, image)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    req.shop.id, car.make, car.model, car.year, car.category, car.transmission, car.fuel, car.seats, car.doors,
    car.daily_price, car.deposit, car.mileage_policy, car.features, car.description, req.file?.filename ?? null,
  );
  res.flash('success', `${car.make} ${car.model} is now listed and can be booked.`);
  res.redirect(303, '/shop/cars');
});

router.get('/cars/:id/edit', (req, res) => {
  const car = ownCar(req);
  if (!car) return res.status(404).render('error', { title: 'Car not found', message: 'This car does not belong to your shop.' });
  res.render('shop/car-form', { ...carFormOptions, car, error: null });
});

router.post('/cars/:id', upload.single('image'), (req, res) => {
  const existing = ownCar(req);
  if (!existing) {
    removeUpload(req.file?.filename);
    return res.status(404).render('error', { title: 'Car not found', message: 'This car does not belong to your shop.' });
  }
  const car = { ...readCarForm(req.body), id: existing.id, image: existing.image };
  const error = validateCar(car);
  if (error) {
    removeUpload(req.file?.filename);
    return res.status(400).render('shop/car-form', { ...carFormOptions, car, error });
  }
  let image = existing.image;
  if (req.file) image = req.file.filename;
  else if (req.body.remove_image === 'on') image = null;
  if (image !== existing.image) removeUpload(existing.image);

  db.prepare(
    `UPDATE cars SET make = ?, model = ?, year = ?, category = ?, transmission = ?, fuel = ?, seats = ?, doors = ?,
       daily_price = ?, deposit = ?, mileage_policy = ?, features = ?, description = ?, image = ?
     WHERE id = ?`,
  ).run(
    car.make, car.model, car.year, car.category, car.transmission, car.fuel, car.seats, car.doors,
    car.daily_price, car.deposit, car.mileage_policy, car.features, car.description, image, existing.id,
  );
  res.flash('success', 'Car details saved.');
  res.redirect(303, '/shop/cars');
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
    db.prepare('DELETE FROM cars WHERE id = ?').run(car.id);
    removeUpload(car.image);
    res.flash('success', `${car.make} ${car.model} was deleted.`);
  }
  res.redirect(303, '/shop/cars');
});

// ---------- Bookings ----------

router.get('/bookings', (req, res) => {
  const status = ['confirmed', 'completed', 'cancelled'].includes(req.query.status) ? req.query.status : '';
  const bookings = db
    .prepare(
      `SELECT bookings.*, cars.make, cars.model, cars.year FROM bookings JOIN cars ON cars.id = bookings.car_id
       WHERE bookings.shop_id = ? AND bookings.status IN ('confirmed', 'completed', 'cancelled')
         ${status ? 'AND bookings.status = ?' : ''}
       ORDER BY bookings.pickup_date DESC`,
    )
    .all(...[req.shop.id, status].filter(Boolean));
  res.render('shop/bookings', { bookings, status });
});

router.post('/bookings/:id/status', async (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND shop_id = ?').get(Number(req.params.id), req.shop.id);
  const status = req.body.status;
  const back = req.get('referer')?.includes('/shop') ? req.get('referer') : '/shop/bookings';
  if (!booking || booking.status !== 'confirmed' || !['completed', 'cancelled'].includes(status)) return res.redirect(303, back);

  if (status === 'completed') {
    db.prepare(`UPDATE bookings SET status = 'completed' WHERE id = ?`).run(booking.id);
    res.flash('success', `Booking ${booking.reference} marked as completed.`);
    return res.redirect(303, back);
  }

  try {
    await payments.refundBooking(booking);
  } catch (err) {
    console.error(`Refund for ${booking.reference} failed:`, err.message);
    res.flash('error', `The refund could not be processed (${err.message}). The booking was not cancelled.`);
    return res.redirect(303, back);
  }
  db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(booking.id);
  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(booking.car_id);
  await sendCancellationEmail(updated, car, req.shop);
  res.flash('success', `Booking ${booking.reference} cancelled${updated.payment_status === 'refunded' ? ' and fully refunded' : ''}. The customer has been emailed.`);
  res.redirect(303, back);
});

// ---------- Payments ----------

// Customers pay RentHub online; RentHub pays each shop its share.
router.get('/payments', (req, res) => {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_price), 0) AS gross
       FROM bookings WHERE shop_id = ? AND payment_status = 'paid'`,
    )
    .get(req.shop.id);
  const fee = Math.round(totals.gross * payments.PLATFORM_FEE_PERCENT) / 100;
  const recent = db
    .prepare(
      `SELECT bookings.*, cars.make, cars.model, cars.year FROM bookings JOIN cars ON cars.id = bookings.car_id
       WHERE bookings.shop_id = ? AND bookings.payment_status IN ('paid', 'refunded')
       ORDER BY bookings.paid_at DESC LIMIT 20`,
    )
    .all(req.shop.id);
  res.render('shop/payments', { totals, fee, feePercent: payments.PLATFORM_FEE_PERCENT, recent });
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
  };
  const error = (!form.name && 'Please enter your shop name.') || (!form.city && 'Please enter your city.') || null;
  if (error) return res.status(400).render('shop/profile', { form: { ...req.shop, ...form }, error });
  db.prepare('UPDATE shops SET name = ?, phone = ?, city = ?, address = ?, opening_hours = ?, description = ? WHERE id = ?')
    .run(form.name, form.phone, form.city, form.address, form.opening_hours, form.description, req.shop.id);
  res.flash('success', 'Shop profile saved.');
  res.redirect(303, '/shop/profile');
});

module.exports = router;
