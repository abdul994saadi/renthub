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
addColumn('bookings', 'stripe_session_id', 'TEXT');
addColumn('bookings', 'stripe_payment_intent', 'TEXT');
addColumn('bookings', 'stripe_destination', 'TEXT');
addColumn('bookings', 'paid_at', 'TEXT');
addColumn('shops', 'stripe_account_id', 'TEXT');
addColumn('shops', 'stripe_charges_enabled', 'INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS idx_bookings_session ON bookings(stripe_session_id)');

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

module.exports = { db, transaction };
