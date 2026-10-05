const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'app.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  opening_hours TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL,
  category TEXT NOT NULL,
  transmission TEXT NOT NULL,
  fuel TEXT NOT NULL,
  seats INTEGER NOT NULL,
  doors INTEGER NOT NULL DEFAULT 4,
  daily_price REAL NOT NULL,
  deposit REAL NOT NULL DEFAULT 0,
  mileage_policy TEXT NOT NULL DEFAULT 'Unlimited',
  features TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  pickup_date TEXT NOT NULL,
  return_date TEXT NOT NULL,
  days INTEGER NOT NULL,
  daily_price REAL NOT NULL,
  total_price REAL NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cars_shop ON cars(shop_id);
CREATE INDEX IF NOT EXISTS idx_bookings_car ON bookings(car_id, pickup_date, return_date);
CREATE INDEX IF NOT EXISTS idx_bookings_shop ON bookings(shop_id);

-- Copy of every email the app sends; doubles as the test inbox when SMTP is not configured.
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Columns added after the first release; ALTER TABLE keeps existing databases working.
function addColumn(table, column, definition) {
  const exists = db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Booking status: pending_payment -> confirmed -> completed, or cancelled / expired.
// A pending_payment booking holds the car until hold_expires_at.
addColumn('bookings', 'payment_status', "TEXT NOT NULL DEFAULT 'unpaid'"); // unpaid | paid | refunded
addColumn('bookings', 'hold_expires_at', 'TEXT');
addColumn('bookings', 'payment_ref', 'TEXT'); // the payment gateway's transaction id (APS fort_id)
addColumn('bookings', 'paid_at', 'TEXT');
addColumn('bookings', 'pickup_time', "TEXT NOT NULL DEFAULT '10:00'"); // local time (TIMEZONE), HH:MM
addColumn('bookings', 'manage_token', 'TEXT'); // secret in the customer's link to view/cancel the booking
addColumn('bookings', 'cancelled_by', 'TEXT'); // 'shop' | 'customer'
addColumn('bookings', 'cancelled_at', 'TEXT');

// Shops: verification by the site owner, suspension, contact and pick-up options.
addColumn('shops', 'verified', 'INTEGER NOT NULL DEFAULT 0');
addColumn('shops', 'suspended', 'INTEGER NOT NULL DEFAULT 0');
addColumn('shops', 'whatsapp', "TEXT NOT NULL DEFAULT ''");
addColumn('shops', 'delivery_fee', 'REAL'); // NULL = no delivery offered
addColumn('shops', 'airport_fee', 'REAL'); // NULL = no airport pick-up offered
addColumn('shops', 'delivery_note', "TEXT NOT NULL DEFAULT ''");

// Booking price breakdown and options. total_price stays the amount the customer pays.
addColumn('bookings', 'car_total', 'REAL');
addColumn('bookings', 'extras_total', 'REAL NOT NULL DEFAULT 0');
addColumn('bookings', 'pickup_method', "TEXT NOT NULL DEFAULT 'shop'"); // shop | delivery | airport
addColumn('bookings', 'delivery_address', "TEXT NOT NULL DEFAULT ''");
addColumn('bookings', 'flight_number', "TEXT NOT NULL DEFAULT ''");
addColumn('bookings', 'delivery_fee', 'REAL NOT NULL DEFAULT 0');
addColumn('bookings', 'promo_code', 'TEXT');
addColumn('bookings', 'discount', 'REAL NOT NULL DEFAULT 0');
addColumn('bookings', 'pickup_reminder_sent_at', 'TEXT');
addColumn('bookings', 'return_reminder_sent_at', 'TEXT');
addColumn('bookings', 'review_requested_at', 'TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS car_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_car_photos_car ON car_photos(car_id, position);

-- Site-wide settings changed from the owner dashboard (e.g. the LBP exchange rate).
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Optional extras a shop offers (child seat, GPS...), priced per day or per booking.
CREATE TABLE IF NOT EXISTS extras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  per TEXT NOT NULL DEFAULT 'day', -- day | booking
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Extras chosen on a booking, copied so later price changes do not alter past bookings.
CREATE TABLE IF NOT EXISTS booking_extras (
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  extra_id INTEGER,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  per TEXT NOT NULL,
  total REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL, -- percent | fixed
  value REAL NOT NULL,
  shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE, -- NULL = valid at every shop
  starts_on TEXT,
  ends_on TEXT,
  max_uses INTEGER,
  min_days INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_car ON reviews(car_id);
CREATE INDEX IF NOT EXISTS idx_reviews_shop ON reviews(shop_id);

-- Driving licence / ID photos uploaded by the customer. Stored privately, never publicly served.
CREATE TABLE IF NOT EXISTS booking_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- licence | id
  filename TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Cars created before photo galleries existed: their single image becomes the first photo.
db.exec(`INSERT INTO car_photos (car_id, filename, position)
  SELECT id, image, 0 FROM cars WHERE image IS NOT NULL AND id NOT IN (SELECT car_id FROM car_photos)`);

function getSetting(key, fallback = null) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, transaction, getSetting, setSetting };
