const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_COOKIE = 'shop_session';
const SESSION_DAYS = 14;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function logIn(res, shopId) {
  res.cookie(SESSION_COOKIE, String(shopId), {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

function logOut(res) {
  res.clearCookie(SESSION_COOKIE);
}

// Attaches the logged-in shop (if any) to req and to every rendered view.
function loadShop(req, res, next) {
  const id = Number(req.signedCookies?.[SESSION_COOKIE]);
  req.shop = id ? db.prepare('SELECT * FROM shops WHERE id = ?').get(id) : undefined;
  res.locals.currentShop = req.shop;
  next();
}

function requireShop(req, res, next) {
  if (!req.shop) return res.redirect(`/shop/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

module.exports = { hashPassword, verifyPassword, logIn, logOut, loadShop, requireShop };
