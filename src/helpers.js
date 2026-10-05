const path = require('node:path');

const CURRENCY = process.env.CURRENCY || 'USD';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
// Local time zone of the rental shops: pick-up times and "today" are in this zone.
const TIMEZONE = process.env.TIMEZONE || 'Asia/Beirut';
// Customers can cancel for a full refund until this many hours before pick-up.
const FREE_CANCELLATION_HOURS = Number(process.env.FREE_CANCELLATION_HOURS || 24);

// Pick-up times offered on the booking form, every 30 minutes from 07:00 to 21:00.
const PICKUP_TIMES = Array.from({ length: 29 }, (_, i) => {
  const minutes = 7 * 60 + i * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
});

const CATEGORIES = ['Economy', 'Compact', 'Sedan', 'SUV', 'Luxury', 'Sports', 'Van', 'Pickup', 'Electric'];
const TRANSMISSIONS = ['Automatic', 'Manual'];
const FUELS = ['Petrol', 'Diesel', 'Hybrid', 'Electric'];

function money(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: CURRENCY, maximumFractionDigits: 2 }).format(amount);
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// Today's date (YYYY-MM-DD) in the shops' time zone.
function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
}

// The real moment a local date + time (in TIMEZONE) happens, as a Date.
function localToDate(dateISO, hhmm) {
  const [y, mo, d] = dateISO.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Find the zone's UTC offset at that moment and correct for it (twice, to settle across DST changes).
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    t = guess - (shown - t);
  }
  return new Date(t);
}

function formatDateTime(date) {
  return date.toLocaleString('en-GB', {
    timeZone: TIMEZONE, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

const isISODate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

function daysBetween(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}

// Returns an error message, or null when the date range is bookable.
function validateDates(pickup, ret) {
  if (!isISODate(pickup) || !isISODate(ret)) return 'Please choose a pick-up and return date.';
  if (pickup < todayISO()) return 'The pick-up date cannot be in the past.';
  if (ret <= pickup) return 'The return date must be after the pick-up date.';
  if (daysBetween(pickup, ret) > 90) return 'Bookings are limited to 90 days.';
  return null;
}

function carFeatures(car) {
  return car.features.split(',').map((f) => f.trim()).filter(Boolean);
}

module.exports = {
  CURRENCY, UPLOAD_DIR, TIMEZONE, FREE_CANCELLATION_HOURS, PICKUP_TIMES, CATEGORIES, TRANSMISSIONS, FUELS,
  money, formatDate, formatTime, formatDateTime, todayISO, localToDate, isISODate, daysBetween, validateDates, carFeatures,
};
