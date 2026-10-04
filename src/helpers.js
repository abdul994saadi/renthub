const CURRENCY = process.env.CURRENCY || 'USD';

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

function todayISO() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
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
  CURRENCY, CATEGORIES, TRANSMISSIONS, FUELS,
  money, formatDate, todayISO, isISODate, daysBetween, validateDates, carFeatures,
};
