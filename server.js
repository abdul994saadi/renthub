const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const { db } = require('./src/db');
const { loadShop } = require('./src/auth');
const helpers = require('./src/helpers');
const { smtpConfigured } = require('./src/email');
const payments = require('./src/payments');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProduction) throw new Error('SESSION_SECRET must be set in production.');
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET is not set; using a random one (shops are logged out on restart).');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProduction ? '1d' : 0 }));
app.use('/uploads', express.static(helpers.UPLOAD_DIR, { maxAge: '7d' }));

// Server-to-server transaction notifications from APS (set this URL as the
// "Transaction Feedback" URL in the APS dashboard). Accepts form or JSON bodies.
app.post('/payments/aps/notify', express.urlencoded({ extended: false }), express.json(), async (req, res) => {
  if (payments.demoMode) return res.status(404).end();
  try {
    await payments.handleApsResult(req.body);
    res.send('OK');
  } catch (err) {
    console.error('APS notification error:', err.message);
    res.status(err.status || 500).send('ERROR');
  }
});

app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(cookieParser(sessionSecret));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// One-shot flash messages, carried across a redirect in a cookie.
app.use((req, res, next) => {
  const raw = req.signedCookies.flash;
  res.locals.flash = null;
  if (raw) {
    try { res.locals.flash = JSON.parse(raw); } catch { /* ignore */ }
    res.clearCookie('flash');
  }
  res.flash = (type, message) => res.cookie('flash', JSON.stringify({ type, message }), { signed: true, httpOnly: true, sameSite: 'lax' });
  next();
});

app.use(loadShop);
app.use((req, res, next) => {
  Object.assign(res.locals, helpers, { path: req.path, showOutbox: !isProduction, demoPayments: payments.demoMode, payAtPickup: payments.payAtPickup });
  next();
});

app.use('/', require('./src/routes/public'));
app.use('/shop', require('./src/routes/shop'));

// Test inbox: lets you read the emails the app "sent" before SMTP is set up.
if (!isProduction) {
  app.get('/dev/outbox', (req, res) => {
    const emails = db.prepare('SELECT id, to_address, subject, delivered, error, created_at FROM emails ORDER BY id DESC LIMIT 100').all();
    res.render('outbox', { emails, smtpConfigured });
  });
  app.get('/dev/outbox/:id', (req, res) => {
    const email = db.prepare('SELECT html FROM emails WHERE id = ?').get(Number(req.params.id));
    if (!email) return res.status(404).send('Not found');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src * data:");
    res.send(email.html);
  });
}

// Simulated payment page, used only when APS is not configured (never in production).
if (payments.demoMode) {
  const findPending = (ref) => db.prepare('SELECT * FROM bookings WHERE reference = ?').get(ref);
  app.get('/dev/pay/:reference', (req, res) => {
    const booking = findPending(req.params.reference);
    if (!booking) return res.status(404).render('error', { title: 'Not found', message: 'No such booking.' });
    if (booking.status !== 'pending_payment') return res.redirect(`/bookings/${booking.reference}`);
    const car = db.prepare('SELECT * FROM cars WHERE id = ?').get(booking.car_id);
    res.render('demo-pay', { booking, car });
  });
  app.post('/dev/pay/:reference', async (req, res) => {
    const booking = findPending(req.params.reference);
    if (!booking) return res.status(404).end();
    await payments.handlePaid(booking.id, `demo_${booking.reference}`);
    res.redirect(303, `/bookings/${booking.reference}`);
  });
}

app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'We could not find that page.' }));

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.flash('error', 'That photo is too large. Please use an image under 8 MB.');
    return res.redirect(303, req.get('referer') || '/shop/cars');
  }
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again in a moment.' });
});

app.listen(PORT, () => {
  console.log(`RentHub running at http://localhost:${PORT}`);
  console.log(smtpConfigured ? 'Emails are sent through SMTP.'
    : isProduction ? 'WARNING: SMTP not configured, so no emails will be sent.' : 'SMTP not configured: emails are saved to /dev/outbox.');
  console.log(payments.payAtPickup ? 'Payment mode: pay at pick-up (no online payment).' : payments.demoMode ? 'APS not configured: payments are simulated on /dev/pay.' : `Payments are processed by Amazon Payment Services (${payments.CHECKOUT_URL}).`);
});
