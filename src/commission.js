// RentHub's commission. There is a default rate (owner dashboard → Settings, or PLATFORM_FEE_PERCENT),
// and each shop can have its own rate. Each booking keeps the rate in force when it was made,
// so changing a rate later does not change past bookings.
const { db, getSetting, setSetting } = require('./db');

function defaultPercent() {
  return Number(getSetting('commission_percent', process.env.PLATFORM_FEE_PERCENT || 0)) || 0;
}
function setDefaultPercent(percent) {
  setSetting('commission_percent', percent);
}

// The shop's own rate, or the default when it has none.
function shopPercent(shop) {
  return shop.commission_percent ?? defaultPercent();
}

// SQL for the commission on a set of bookings (alias b, joined to shops as s).
// Older bookings made before rates were stored use the shop's current rate.
const COMMISSION_SUM = `COALESCE(ROUND(SUM(b.total_price * COALESCE(b.commission_percent, s.commission_percent, ?) / 100), 2), 0)`;

const parsePercent = (value) => {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const n = Number(text.replace('%', ''));
  return n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : NaN;
};

module.exports = { defaultPercent, setDefaultPercent, shopPercent, COMMISSION_SUM, parsePercent };
