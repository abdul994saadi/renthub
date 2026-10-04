const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const { db } = require('./src/db');
const { loadShop } = require('./src/auth');
const helpers = require('./src/helpers');
const { smtpConfigured } = require('./src/email');

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
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '7d' }));
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
  Object.assign(res.locals, helpers, { path: req.path, showOutbox: !isProduction });
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
  console.log(smtpConfigured ? 'Emails are sent through SMTP.' : 'SMTP not configured: emails are saved to /dev/outbox.');
});
