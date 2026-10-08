// Owner actions on bookings: cancel, mark as test, mark completed / no-show, edit, notes, CSV export.
// Every action is written to the activity log.
const { db, transaction } = require('./db');
const { isCarAvailable } = require('./bookings');
const { isISODate, daysBetween, PICKUP_TIMES, money } = require('./helpers');
const payments = require('./payments');
const { sendAdminCancellationEmails, sendBookingUpdatedEmails } = require('./email');
const { logAdmin } = require('./adminlog');
const commission = require('./commission');

const ACTIVE = ['confirmed', 'pending_payment'];
const load = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(id));
const carOf = (b) => db.prepare('SELECT * FROM cars WHERE id = ?').get(b.car_id);
const shopOf = (b) => db.prepare('SELECT * FROM shops WHERE id = ?').get(b.shop_id);

async function cancel(booking, { notifyCustomer, notifyShop, reason }) {
  if (!ACTIVE.includes(booking.status)) throw new Error('Only upcoming bookings can be cancelled.');
  await payments.refundBooking(booking); // refunds online payments; nothing to do for pay at pick-up
  db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_by = 'admin', cancelled_at = datetime('now') WHERE id = ?`).run(booking.id);
  const updated = load(booking.id);
  await sendAdminCancellationEmails(updated, carOf(updated), shopOf(updated), { customer: notifyCustomer, toShop: notifyShop, reason });
  const told = [notifyCustomer && 'customer', notifyShop && 'shop'].filter(Boolean).join(' and ') || 'nobody';
  logAdmin('Cancelled booking', { booking, details: `${reason ? `Reason: ${reason}. ` : ''}Notified: ${told}.${updated.payment_status === 'refunded' ? ' Refunded in full.' : ''}` });
  return updated;
}

// A test or fake booking is cancelled quietly (no messages), so it frees the dates and is left out of
// commission and statistics. Undo restores its earlier status when that is still possible.
async function markTest(booking) {
  if (booking.is_test) return booking;
  if (booking.payment_status === 'paid') await payments.refundBooking(booking);
  db.prepare(`UPDATE bookings SET is_test = 1, test_prev_status = status, status = 'cancelled', cancelled_by = 'admin',
    cancelled_at = COALESCE(cancelled_at, datetime('now')) WHERE id = ?`).run(booking.id);
  logAdmin('Marked as test / fake', { booking, details: `Was ${booking.status}. No messages sent.` });
  return load(booking.id);
}

function unmarkTest(booking) {
  if (!booking.is_test) return { booking, note: '' };
  let status = 'cancelled';
  let note = 'It stays cancelled.';
  const prev = booking.test_prev_status;
  if (prev === 'completed' || prev === 'no_show') { status = prev; note = `It is ${prev === 'no_show' ? 'a no-show' : 'completed'} again.`; }
  else if (prev === 'confirmed' && booking.payment_status !== 'refunded' && isCarAvailable(booking.car_id, booking.pickup_date, booking.return_date, booking.id)) {
    status = 'confirmed'; note = 'It is confirmed again.';
  } else if (prev === 'confirmed') note = 'It stays cancelled because the dates are no longer free or it was refunded.';
  db.prepare(`UPDATE bookings SET is_test = 0, test_prev_status = NULL, status = ?,
    cancelled_by = CASE WHEN ? = 'cancelled' THEN cancelled_by ELSE NULL END,
    cancelled_at = CASE WHEN ? = 'cancelled' THEN cancelled_at ELSE NULL END WHERE id = ?`).run(status, status, status, booking.id);
  logAdmin('Unmarked test / fake', { booking, details: note });
  return { booking: load(booking.id), note };
}

function setStatus(booking, status) {
  const allowed = { completed: ['confirmed', 'no_show'], no_show: ['confirmed', 'completed'], confirmed: ['completed', 'no_show'] };
  if (!allowed[status]?.includes(booking.status)) throw new Error('That change is not possible for this booking.');
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, booking.id);
  const label = { completed: 'completed', no_show: 'no-show', confirmed: 'confirmed (upcoming)' }[status];
  logAdmin(`Marked as ${label}`, { booking, details: `Was ${booking.status.replace('_', '-')}.` });
  return load(booking.id);
}

function saveNotes(booking, notes) {
  const text = String(notes || '').trim().slice(0, 2000);
  db.prepare('UPDATE bookings SET admin_notes = ? WHERE id = ?').run(text, booking.id);
  logAdmin('Updated private notes', { booking, details: text ? text.slice(0, 200) : '(cleared)' });
}

// Change dates, time, car and/or price. Returns { booking } or { error }.
async function edit(booking, form) {
  const pickup = String(form.pickup_date || '');
  const ret = String(form.return_date || '');
  const time = String(form.pickup_time || '');
  const carId = Number(form.car_id) || booking.car_id;
  const car = db.prepare('SELECT * FROM cars WHERE id = ? AND shop_id = ?').get(carId, booking.shop_id);
  const days = isISODate(pickup) && isISODate(ret) ? daysBetween(pickup, ret) : 0;
  const error = (!isISODate(pickup) || !isISODate(ret) ? 'Please enter valid pick-up and return dates.' : null)
    || (days < 1 && 'The return date must be after the pick-up date.')
    || (days > 90 && 'Bookings are limited to 90 days.')
    || (!PICKUP_TIMES.includes(time) && 'Please choose a pick-up time.')
    || (!car && 'Please choose one of this shop\'s cars.')
    || (ACTIVE.includes(booking.status) && !isCarAvailable(car.id, pickup, ret, booking.id)
      && 'That car is already booked or blocked for some of those dates.');
  if (error) return { error };

  const dailyPrice = car.id === booking.car_id ? booking.daily_price : car.daily_price;
  const extras = db.prepare('SELECT rowid AS rid, * FROM booking_extras WHERE booking_id = ?').all(booking.id)
    .map((e) => ({ ...e, total: e.per === 'day' ? e.price * days : e.price }));
  const extrasTotal = extras.reduce((sum, e) => sum + e.total, 0);
  const carTotal = Math.round(dailyPrice * days * 100) / 100;
  const auto = Math.max(0, Math.round((carTotal + extrasTotal + (booking.delivery_fee || 0) - (booking.discount || 0)) * 100) / 100);
  let total = auto;
  if (form.recalculate !== 'on') {
    total = Number(form.total_price);
    if (!(total >= 0)) return { error: 'Please enter a valid total price, or tick "Recalculate the price".' };
  }
  if (booking.payment_status === 'paid' && Math.abs(total - booking.total_price) > 0.001) {
    return { error: 'This booking was paid online, so its price cannot be changed here. Change only the dates or car with the same total, or cancel and rebook.' };
  }

  const carName = (id) => { const c = db.prepare('SELECT year, make, model FROM cars WHERE id = ?').get(id); return c ? `${c.year} ${c.make} ${c.model}` : `car #${id}`; };
  const before = `${booking.pickup_date} ${booking.pickup_time} → ${booking.return_date}, ${carName(booking.car_id)}, ${money(booking.total_price)}`;
  transaction(() => {
    db.prepare(`UPDATE bookings SET pickup_date = ?, pickup_time = ?, return_date = ?, days = ?, car_id = ?, daily_price = ?,
      car_total = ?, extras_total = ?, total_price = ?, pickup_reminder_sent_at = NULL, return_reminder_sent_at = NULL WHERE id = ?`)
      .run(pickup, time, ret, days, car.id, dailyPrice, carTotal, extrasTotal, total, booking.id);
    const upd = db.prepare('UPDATE booking_extras SET total = ? WHERE rowid = ?');
    for (const e of extras) upd.run(e.total, e.rid);
  });
  const updated = load(booking.id);
  const after = `${updated.pickup_date} ${updated.pickup_time} → ${updated.return_date}, ${carName(updated.car_id)}, ${money(updated.total_price)}`;
  if (form.notify === 'on') await sendBookingUpdatedEmails(updated, car, shopOf(updated));
  logAdmin('Edited booking', { booking, details: `${before}  ⇒  ${after}${form.notify === 'on' ? '. Customer and shop emailed.' : '. Nobody notified.'}` });
  return { booking: updated };
}

// ---------- CSV ----------

const csvCell = (v) => {
  const s = String(v ?? '');
  // Leading = + - @ would be run as a formula by Excel.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

function toCsv(bookings) {
  const rate = commission.defaultPercent();
  const cols = [
    ['Reference', (b) => b.reference], ['Booked at (UTC)', (b) => b.created_at], ['Status', (b) => b.status],
    ['Test / fake', (b) => (b.is_test ? 'yes' : '')], ['Shop', (b) => b.shop_name], ['Car', (b) => `${b.year} ${b.make} ${b.model}`],
    ['Customer', (b) => b.customer_name], ['Email', (b) => b.customer_email], ['Phone', (b) => b.customer_phone],
    ['Pick-up date', (b) => b.pickup_date], ['Pick-up time', (b) => b.pickup_time], ['Return date', (b) => b.return_date], ['Days', (b) => b.days],
    ['Pick-up method', (b) => b.pickup_method], ['Promo code', (b) => b.promo_code], ['Discount (USD)', (b) => b.discount],
    ['Total (USD)', (b) => b.total_price], ['Payment', (b) => b.payment_status],
    ['Commission %', (b) => b.commission_percent ?? b.shop_commission_percent ?? rate],
    ['Commission (USD)', (b) => (['confirmed', 'completed'].includes(b.status)
      ? Math.round(b.total_price * (b.commission_percent ?? b.shop_commission_percent ?? rate)) / 100 : 0)],
    ['Cancelled by', (b) => b.cancelled_by], ['Private notes', (b) => b.admin_notes],
  ];
  const lines = [cols.map(([h]) => csvCell(h)).join(',')];
  for (const b of bookings) lines.push(cols.map(([, f]) => csvCell(f(b))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`; // BOM so Excel reads Arabic names correctly
}

module.exports = { load, carOf, shopOf, cancel, markTest, unmarkTest, setStatus, saveNotes, edit, toCsv };
