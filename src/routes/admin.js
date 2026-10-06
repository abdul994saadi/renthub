// Site owner's dashboard: protected by ADMIN_PASSWORD (HTTP basic auth, username "admin").
const express = require('express');
const crypto = require('node:crypto');
const { db, getSetting, setSetting } = require('../db');
const { todayISO, lbpRate, supportWhatsapp, whatsappLink } = require('../helpers');
const email = require('../email');
const { promoUses } = require('../pricing');
const scheduler = require('../scheduler');
const documents = require('../documents');
const commission = require('../commission');
const verify = require('../verify');

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
      (SELECT COUNT(*) FROM bookings WHERE status = 'cancelled' AND date(created_at) >= ?) AS month_cancelled,
      (SELECT ${commission.COMMISSION_SUM} FROM bookings b JOIN shops s ON s.id = b.shop_id WHERE b.${LIVE} AND date(b.created_at) >= ?) AS month_commission,
      (SELECT ${commission.COMMISSION_SUM} FROM bookings b JOIN shops s ON s.id = b.shop_id WHERE b.${LIVE}) AS all_commission`)
    .get(monthStart, monthStart, monthStart, commission.defaultPercent(), monthStart, commission.defaultPercent());
  const recent = db.prepare(
    `SELECT bookings.*, cars.make, cars.model, shops.name AS shop_name FROM bookings
     JOIN cars ON cars.id = bookings.car_id JOIN shops ON shops.id = bookings.shop_id
     WHERE bookings.status IN ('confirmed', 'completed', 'cancelled')
     ORDER BY bookings.created_at DESC LIMIT 10`,
  ).all();
  const pendingShops = db.prepare('SELECT * FROM shops WHERE verified = 0 AND suspended = 0 ORDER BY created_at DESC LIMIT 5').all();
  res.render('admin/overview', {
    stats, recent, pendingShops, feePercent: commission.defaultPercent(),
    customRates: db.prepare('SELECT COUNT(*) AS n FROM shops WHERE commission_percent IS NOT NULL').get().n,
  });
});

router.post('/reminders/run', async (req, res) => {
  const s = await scheduler.runOnce();
  res.flash('success', `Checked now: sent ${s.pickup} pick-up reminder(s), ${s.return} return reminder(s), ${s.review} review request(s). This also runs automatically every 10 minutes.`);
  res.redirect(303, '/admin/');
});

router.get('/reviews', (req, res) => {
  const list = db.prepare(
    `SELECT reviews.*, cars.make, cars.model, shops.name AS shop_name FROM reviews
     JOIN cars ON cars.id = reviews.car_id JOIN shops ON shops.id = reviews.shop_id
     ORDER BY reviews.created_at DESC LIMIT 200`,
  ).all();
  res.render('admin/reviews', { reviews: list });
});

router.post('/reviews/:id/:action', (req, res) => {
  const hidden = { hide: 1, show: 0 }[req.params.action];
  if (hidden !== undefined) {
    db.prepare('UPDATE reviews SET hidden = ? WHERE id = ?').run(hidden, Number(req.params.id));
    res.flash('success', hidden ? 'Review hidden from the site.' : 'Review visible again.');
  }
  res.redirect(303, '/admin/reviews');
});

router.get('/bookings/:id/documents/:docId', (req, res) => {
  const doc = db.prepare('SELECT * FROM booking_documents WHERE id = ? AND booking_id = ?').get(Number(req.params.docId), Number(req.params.id));
  if (!doc) return res.status(404).render('error', { title: 'Not found', message: 'This document does not exist.' });
  documents.sendDocument(res, doc);
});

router.get('/shops', (req, res) => {
  const monthStart = `${todayISO().slice(0, 7)}-01`;
  const rate = commission.defaultPercent();
  const shops = db.prepare(
    `SELECT shops.*,
       (SELECT COUNT(*) FROM cars WHERE cars.shop_id = shops.id AND cars.is_active = 1) AS car_count,
       (SELECT COUNT(*) FROM bookings b WHERE b.shop_id = shops.id AND b.${LIVE}) AS booking_count,
       (SELECT COALESCE(SUM(total_price), 0) FROM bookings b WHERE b.shop_id = shops.id AND b.${LIVE}) AS booking_value,
       (SELECT ${commission.COMMISSION_SUM} FROM bookings b JOIN shops s ON s.id = b.shop_id
          WHERE b.shop_id = shops.id AND b.${LIVE} AND date(b.created_at) >= ?) AS month_commission,
       (SELECT ${commission.COMMISSION_SUM} FROM bookings b JOIN shops s ON s.id = b.shop_id
          WHERE b.shop_id = shops.id AND b.${LIVE}) AS all_commission
     FROM shops ORDER BY shops.suspended, shops.verified, shops.created_at DESC`,
  ).all(rate, monthStart, rate).map((s) => ({ ...s, rate: commission.shopPercent(s) }));
  res.render('admin/shops', { shops, defaultRate: rate });
});

// Sets a shop's own commission rate; an empty value goes back to the default rate.
router.post('/shops/:id/commission', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(Number(req.params.id));
  const percent = commission.parsePercent(req.body.commission_percent);
  if (!shop) return res.redirect(303, '/admin/shops');
  if (Number.isNaN(percent)) {
    res.flash('error', 'Enter a commission between 0 and 100, or leave it empty to use the default rate.');
  } else {
    db.prepare('UPDATE shops SET commission_percent = ? WHERE id = ?').run(percent, shop.id);
    res.flash('success', percent === null
      ? `${shop.name} now uses the default commission (${commission.defaultPercent()}%).`
      : `${shop.name}'s commission is now ${percent}%. It applies to new bookings.`);
  }
  res.redirect(303, '/admin/shops');
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
  ).all(...params).map((b) => ({ ...b, documents: documents.bookingDocuments(b.id) }));
  res.render('admin/bookings', { bookings, status, q });
});

// ---------- Promo codes ----------

function promoPage(res, { form = { kind: 'percent', min_days: 1 }, error = null, status = 200 } = {}) {
  const promos = db.prepare(
    `SELECT promo_codes.*, shops.name AS shop_name FROM promo_codes LEFT JOIN shops ON shops.id = promo_codes.shop_id
     ORDER BY promo_codes.active DESC, promo_codes.created_at DESC`,
  ).all().map((p) => ({ ...p, uses: promoUses(p.code) }));
  const shops = db.prepare('SELECT id, name FROM shops ORDER BY name').all();
  res.status(status).render('admin/promos', { promos, shops, form, error, today: todayISO() });
}

router.get('/promos', (req, res) => promoPage(res));

router.post('/promos', (req, res) => {
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const form = {
    code: String(req.body.code || '').trim().toUpperCase().replace(/\s+/g, ''),
    kind: req.body.kind === 'fixed' ? 'fixed' : 'percent',
    value: Number(req.body.value),
    shop_id: Number(req.body.shop_id) || null,
    starts_on: date(req.body.starts_on),
    ends_on: date(req.body.ends_on),
    max_uses: Number(req.body.max_uses) || null,
    min_days: Math.max(1, Number(req.body.min_days) || 1),
  };
  const error = (!/^[A-Z0-9_-]{3,30}$/.test(form.code) && 'Codes are 3–30 letters, numbers, - or _.')
    || (!(form.value > 0) && 'Enter a discount above zero.')
    || (form.kind === 'percent' && form.value > 100 && 'A percentage cannot be more than 100.')
    || (form.starts_on && form.ends_on && form.ends_on < form.starts_on && 'The end date is before the start date.')
    || (db.prepare('SELECT 1 FROM promo_codes WHERE code = ?').get(form.code) && 'That code already exists.')
    || null;
  if (error) return promoPage(res, { form, error, status: 400 });
  db.prepare(
    `INSERT INTO promo_codes (code, kind, value, shop_id, starts_on, ends_on, max_uses, min_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(form.code, form.kind, form.value, form.shop_id, form.starts_on, form.ends_on, form.max_uses, form.min_days);
  res.flash('success', `Promo code ${form.code} created.`);
  res.redirect(303, '/admin/promos');
});

router.post('/promos/:id/:action', (req, res) => {
  const promo = db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(Number(req.params.id));
  if (promo && req.params.action === 'toggle') {
    db.prepare('UPDATE promo_codes SET active = ? WHERE id = ?').run(promo.active ? 0 : 1, promo.id);
    res.flash('success', `${promo.code} ${promo.active ? 'switched off' : 'switched on'}.`);
  } else if (promo && req.params.action === 'delete') {
    db.prepare('DELETE FROM promo_codes WHERE id = ?').run(promo.id);
    res.flash('success', `${promo.code} deleted. Bookings that used it keep their discount.`);
  }
  res.redirect(303, '/admin/promos');
});

// ---------- Settings ----------

router.get('/settings', (req, res) => {
  res.render('admin/settings', { rate: lbpRate(), commissionRate: commission.defaultPercent(), error: null, commissionError: null, verify });
});

router.post('/settings/protection', (req, res) => {
  const max = Number(req.body.max_open_bookings);
  if (!(Number.isInteger(max) && max >= 0 && max <= 50)) {
    res.flash('error', 'Enter a number of bookings between 0 and 50 (0 means no limit).');
    return res.redirect(303, '/admin/settings');
  }
  setSetting('verify_email', req.body.verify_email === 'on' ? '1' : '0');
  setSetting('max_open_bookings', String(max));
  res.flash('success', 'Booking protection saved.');
  res.redirect(303, '/admin/settings');
});

router.post('/settings/whatsapp', (req, res) => {
  const number = String(req.body.support_whatsapp || '').trim();
  if (number && !whatsappLink(number)) {
    res.flash('error', 'Please enter a valid phone number, e.g. 03 123 456 or +961 3 123 456.');
  } else {
    setSetting('support_whatsapp', number);
    res.flash('success', number ? `WhatsApp button saved: customers will reach ${number}.` : 'WhatsApp button removed from the site.');
  }
  res.redirect(303, '/admin/settings');
});

router.post('/settings/commission', (req, res) => {
  const percent = commission.parsePercent(req.body.commission_percent);
  if (percent === null || Number.isNaN(percent)) {
    return res.status(400).render('admin/settings', {
      rate: lbpRate(), commissionRate: req.body.commission_percent, error: null, verify,
      commissionError: 'Please enter a commission between 0 and 100.',
    });
  }
  commission.setDefaultPercent(percent);
  res.flash('success', `Default commission saved: ${percent}%. It applies to new bookings from shops without their own rate.`);
  res.redirect(303, '/admin/settings');
});

router.post('/settings', (req, res) => {
  const rate = Number(String(req.body.lbp_rate || '').replace(/[,\s]/g, ''));
  if (!(rate >= 0 && rate < 10_000_000)) {
    return res.status(400).render('admin/settings', { rate: req.body.lbp_rate, commissionRate: commission.defaultPercent(), commissionError: null, verify, error: 'Please enter a valid exchange rate (LBP for 1 USD), or 0 to hide LBP prices.' });
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
