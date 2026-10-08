// Record of every change the owner makes in the owner dashboard.
const { db } = require('./db');

function logAdmin(action, { booking = null, details = '' } = {}) {
  db.prepare('INSERT INTO admin_log (action, booking_id, booking_ref, details) VALUES (?, ?, ?, ?)')
    .run(action, booking?.id ?? null, booking?.reference ?? null, String(details).slice(0, 1000));
}

const recentLog = (limit = 200) => db.prepare('SELECT * FROM admin_log ORDER BY id DESC LIMIT ?').all(limit);
const bookingLog = (bookingId) => db.prepare('SELECT * FROM admin_log WHERE booking_id = ? ORDER BY id DESC').all(bookingId);

module.exports = { logAdmin, recentLog, bookingLog };
