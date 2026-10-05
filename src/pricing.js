// Booking price: car rental + chosen extras + delivery/airport fee - promo discount.
const { db } = require('./db');
const { daysBetween, todayISO } = require('./helpers');

const round2 = (n) => Math.round(n * 100) / 100;

const PICKUP_METHODS = {
  shop: 'Pick up at the shop',
  delivery: 'Delivery to my address',
  airport: 'Beirut airport (BEY)',
};

function shopExtras(shopId, { activeOnly = true } = {}) {
  return db.prepare(`SELECT * FROM extras WHERE shop_id = ? ${activeOnly ? 'AND active = 1' : ''} ORDER BY name`).all(shopId);
}

// Pick-up methods a shop offers, with their fee.
function pickupOptions(shop) {
  const options = [{ value: 'shop', label: PICKUP_METHODS.shop, fee: 0 }];
  if (shop.delivery_fee !== null && shop.delivery_fee !== undefined) options.push({ value: 'delivery', label: PICKUP_METHODS.delivery, fee: shop.delivery_fee });
  if (shop.airport_fee !== null && shop.airport_fee !== undefined) options.push({ value: 'airport', label: PICKUP_METHODS.airport, fee: shop.airport_fee });
  return options;
}

// How many live bookings already used a promo code.
function promoUses(code) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM bookings WHERE promo_code = ? COLLATE NOCASE
     AND (status IN ('confirmed', 'completed') OR (status = 'pending_payment' AND hold_expires_at > datetime('now')))`,
  ).get(code).n;
}

// Returns { promo } or { error } for a code entered by the customer.
function checkPromo(code, { shopId, days }) {
  const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ? COLLATE NOCASE').get(code);
  const today = todayISO();
  if (!promo || !promo.active) return { error: 'That promo code is not valid.' };
  if (promo.shop_id && promo.shop_id !== shopId) return { error: 'That promo code is not valid for this rental shop.' };
  if (promo.starts_on && today < promo.starts_on) return { error: 'That promo code is not active yet.' };
  if (promo.ends_on && today > promo.ends_on) return { error: 'That promo code has expired.' };
  if (days < promo.min_days) return { error: `That promo code needs a rental of at least ${promo.min_days} days.` };
  if (promo.max_uses && promoUses(promo.code) >= promo.max_uses) return { error: 'That promo code has been fully used.' };
  return { promo };
}

// Full price breakdown. Unknown extras/methods are ignored; an invalid promo code is reported in promoError.
function quoteBooking({ car, shop, pickup, ret, extraIds = [], pickupMethod = 'shop', promoCode = '' }) {
  const days = daysBetween(pickup, ret);
  const carTotal = round2(days * car.daily_price);

  const wanted = new Set(extraIds.map(Number));
  const extras = shopExtras(shop.id).filter((e) => wanted.has(e.id)).map((e) => ({
    id: e.id, name: e.name, price: e.price, per: e.per,
    total: round2(e.per === 'day' ? e.price * days : e.price),
  }));
  const extrasTotal = round2(extras.reduce((sum, e) => sum + e.total, 0));

  const option = pickupOptions(shop).find((o) => o.value === pickupMethod) || pickupOptions(shop)[0];
  const deliveryFee = round2(option.fee);
  const subtotal = round2(carTotal + extrasTotal + deliveryFee);

  let discount = 0;
  let promo = null;
  let promoError = null;
  if (promoCode) {
    const result = checkPromo(promoCode, { shopId: shop.id, days });
    if (result.error) promoError = result.error;
    else {
      promo = result.promo;
      discount = promo.kind === 'percent' ? round2((subtotal * promo.value) / 100) : round2(promo.value);
      discount = Math.min(discount, subtotal);
    }
  }

  return {
    days, dailyPrice: car.daily_price, carTotal, extras, extrasTotal,
    pickupMethod: option.value, pickupLabel: option.label, deliveryFee,
    subtotal, promoCode: promo ? promo.code : null, promo, promoError, discount,
    total: round2(subtotal - discount),
  };
}

function bookingExtras(bookingId) {
  return db.prepare('SELECT * FROM booking_extras WHERE booking_id = ?').all(bookingId);
}

// Adds .extras (chosen extras) to each booking row, for booking lists.
function withExtras(bookings) {
  return bookings.map((b) => ({ ...b, extras: bookingExtras(b.id) }));
}

module.exports = { withExtras, PICKUP_METHODS, shopExtras, pickupOptions, checkPromo, promoUses, quoteBooking, bookingExtras };
