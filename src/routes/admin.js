// Site owner's dashboard: protected by ADMIN_PASSWORD (HTTP basic auth, username "admin").
const express = require('express');
const crypto = require('node:crypto');
const { db, getSetting, setSetting } = require('../db');
const { todayISO, lbpRate } = require('../helpers');
const email = require('../email');
const payments = require('../payments');

const router = express.Router();

function requireAdmin(req, res, next) {
  const password = (process.env.ADMIN_PASSWORD || '').trim();
  if (!password) return res.status(404).render('error', { title: 'Page not found', message: 'Set ADMIN_PASSWORD to enable the owner dashboard.' });
  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  const [user, pass] = Buffer.from(encoded || '', 'base64').toString().split(/:(.*)/s);
  const expected = Buffer.from(`admin:${password}`);
  const given = Buffer.from(`${user}:${pass}`);
  if (scheme === 'Basic' && expected.length === given.length && crypto.timingSafeEqual(expected, given)) {
    res.locals.adminPath = req.baseUrl + req.path;
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="RentHub owner"').status(401).send('Login required');
}
router.use(requireAdmin);

const feePercent = () => payments.PLATFORM_FEE_PERCENT;
const commission = (amount) => Math.round(amount * feePercent()) / 100;

// Bookings that count as business: confirmed or completed (not cancelled, expired or unpaid holds).
const LIVE = `status IN ('confirmed', 'completed')`;

router.get('/', (req, res) => {
  const monthStart = `${todayISO().slice(0, 7)}-01`;
  const stats = db.prepare(`SELECT
      (SELECT COUNT(*) FROM shops) AS shops,
      (SELECT COUNT(*) FROM shops WHERE verified = 1) AS verified_shops,
      (SELECT COUNT(*) FROM shops WHERE suspended = 1) AS suspended_shops,
      (SELECT COUNT(*) FROM cars WHERE is_active = 1) AS active_cars,
      (SELECT COUNT(*) FROM bookings WHERE ${LIVE} AND date(created_at) >= ?) AS month_bookings,
      (SELECT COALESCE(SUM(total_price), 0) FROM bookings WHERE ${LIVE} AND date(created_at) >= ?) AS month_value,
      (SELECT COALESCE(SUM(total_price), 0) FROM bookings WHERE ${LIVE}) AS all_value,
      (SELECT COALESCE(SUM(total_price), 0) FROM bookings WHERE payment_status = 'paid') AS paid_online,
      (SELECT COUNT(*) FROM bookings WHERE status = 'cancelled' AND date(created_at) >= ?) AS month_cancelled`)
    .get(monthStart, monthStart, monthStart);
  const recent = db.prepare(
    `SELECT bookings.*, cars.make, cars.model, shops.name AS shop_name FROM bookings
     JOIN cars ON cars.id = bookings.car_id JOIN shops ON shops.id = bookings.shop_id
     WHERE bookings.status IN ('confirmed', 'completed', 'cancelled')
     ORDER BY bookings.created_at DESC LIMIT 10`,
  ).all();
  const pendingShops = db.prepare('SELECT * FROM shops WHERE verified = 0 AND suspended = 0 ORDER BY created_at DESC LIMIT 5').all();
  res.render('admin/overview', {
    stats, recent, pendingShops, feePercent: feePercent(),
    monthCommission: commission(stats.month_value), allCommission: commission(stats.all_value),
  });
});

router.get('/shops', (req, res) => {
  const shops = db.prepare(
    `SELECT shops.*,
       (SELECT COUNT(*) FROM cars WHERE cars.shop_id = shops.id AND cars.is_active = 1) AS car_count,
       (SELECT COUNT(*) FROM bookings b WHERE b.shop_id = shops.id AND b.${LIVE}) AS booking_count,
       (SELECT COALESCE(SUM(total_price), 0) FROM bookings b WHERE b.shop_id = shops.id AND b.${LIVE}) AS booking_value
     FROM shops ORDER BY shops.suspended, shops.verified, shops.created_at DESC`,
  ).all().map((s) => ({ ...s, commission: commission(s.booking_value) }));
  res.render('admin/shops', { shops, feePercent: feePercent() });
});

router.post('/shops/:id/:action', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(Number(req.params.id));
  const actions = {
    verify: ['verified', 1, 'is now verified'],
    unverify: ['verified', 0, 'is no longer verified'],
    suspend: ['suspended', 1, 'is suspended: its cars are hidden and it cannot log in'],
    unsuspend: ['suspended', 0, 'is active again'],
  };
  const action = actions[req.params.action];
  if (shop && action) {
    db.prepare(`UPDATE shops SET ${action[0]} = ? WHERE id = ?`).run(action[1], shop.id);
    res.flash('success', `${shop.name} ${action[2]}.`);
  }
  res.redirect(303, '/admin/shops');
});

router.get('/bookings', (req, res) => {
  const status = ['confirmed', 'completed', 'cancelled'].includes(req.query.status) ? req.query.status : '';
  const q = String(req.query.q || '').trim();
  const where = [`bookings.status IN ('confirmed', 'completed', 'cancelled')`];
  const params = [];
  if (status) { where.push('bookings.status = ?'); params.push(status); }
  if (q) {
    where.push(`(bookings.reference LIKE ? OR bookings.customer_name LIKE ? OR bookings.customer_email LIKE ? OR shops.name LIKE ?)`);
    params.push(...Array(4).fill(`%${q}%`));
  }
  const bookings = db.prepare(
    `SELECT bookings.*, cars.make, cars.model, cars.year, shops.name AS shop_name FROM bookings
     JOIN cars ON cars.id = bookings.car_id JOIN shops ON shops.id = bookings.shop_id
     WHERE ${where.join(' AND ')} ORDER BY bookings.created_at DESC LIMIT 200`,
  ).all(...params);
  res.render('admin/bookings', { bookings, status, q });
});

router.get('/settings', (req, res) => {
  res.render('admin/settings', { rate: lbpRate(), error: null });
});

router.post('/settings', (req, res) => {
  const rate = Number(String(req.body.lbp_rate || '').replace(/[,\s]/g, ''));
  if (!(rate >= 0 && rate < 10_000_000)) {
    return res.status(400).render('admin/settings', { rate: req.body.lbp_rate, error: 'Please enter a valid exchange rate (LBP for 1 USD), or 0 to hide LBP prices.' });
  }
  setSetting('lbp_rate', rate);
  res.flash('success', rate ? `Exchange rate saved: 1 USD = ${new Intl.NumberFormat('en-US').format(rate)} LBP.` : 'LBP prices are now hidden.');
  res.redirect(303, '/admin/settings');
});

const recentEmails = () => db.prepare('SELECT id, to_address, subject, delivered, error, created_at FROM emails ORDER BY id DESC LIMIT 25').all();

router.get('/email', async (req, res) => {
  res.render('admin-email', { settings: email.smtpSummary(), check: await email.verifySmtp(), recent: recentEmails(), sent: null });
});

router.post('/email/test', async (req, res) => {
  const to = String(req.body.to || '').trim();
  const sent = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) ? await email.sendTestEmail(to) : { error: 'Please enter a valid email address.' };
  res.render('admin-email', { settings: email.smtpSummary(), check: await email.verifySmtp(), recent: recentEmails(), sent });
});

module.exports = { router, getSetting };
