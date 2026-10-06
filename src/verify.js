// Protection against fake pay-at-pick-up bookings:
// - the customer confirms their email with a 6-digit code (a device that verified an email skips it later);
// - one email or phone can hold only a few upcoming unpaid bookings at a time.
// Both are switched on or off in the owner dashboard (Settings).
const crypto = require('node:crypto');
const { db, getSetting } = require('./db');
const { todayISO } = require('./helpers');
const { sendVerificationCode } = require('./email');

const CODE_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const COOKIE = 'verified_emails';

const verifyEmailRequired = () => getSetting('verify_email', '1') === '1';
const maxOpenBookings = () => Math.max(0, Number(getSetting('max_open_bookings', '2')) || 0);

const normEmail = (email) => String(email || '').trim().toLowerCase();
const phoneKey = (phone) => String(phone || '').replace(/\D/g, '').slice(-8);
const hash = (email, code) => crypto.createHash('sha256').update(`${normEmail(email)}:${code}`).digest('hex');

function verifiedEmails(req) {
  try { return JSON.parse(req.signedCookies[COOKIE] || '[]'); } catch { return []; }
}

function needsCode(req, email) {
  return verifyEmailRequired() && !verifiedEmails(req).includes(normEmail(email));
}

// Sends a new code unless one was sent less than a minute ago. Returns { ok, error }.
async function issueCode(email) {
  const e = normEmail(email);
  const recent = db.prepare(
    `SELECT 1 FROM email_codes WHERE email = ? AND created_at > datetime('now', ?) AND expires_at > datetime('now')`,
  ).get(e, `-${RESEND_SECONDS} seconds`);
  if (recent) return { ok: true, recent: true };
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare('DELETE FROM email_codes WHERE email = ? OR expires_at < datetime(\'now\', \'-1 day\')').run(e);
  db.prepare(`INSERT INTO email_codes (email, code_hash, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .run(e, hash(e, code), `+${CODE_MINUTES} minutes`);
  const sent = await sendVerificationCode(email, code);
  return sent ? { ok: true } : { ok: false, error: 'We could not send the code to this email. Please check the address, or try again in a few minutes.' };
}

// Returns { ok } or { ok: false, error }.
function checkCode(email, code) {
  const e = normEmail(email);
  const row = db.prepare(`SELECT * FROM email_codes WHERE email = ? AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`).get(e);
  if (!row) return { ok: false, error: 'This code has expired. Tap "Send a new code" to get another one.' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Too many wrong codes. Tap "Send a new code" to get another one.' };
  const given = String(code || '').replace(/\D/g, '');
  if (given.length === 6 && crypto.timingSafeEqual(Buffer.from(hash(e, given)), Buffer.from(row.code_hash))) {
    db.prepare('DELETE FROM email_codes WHERE email = ?').run(e);
    return { ok: true };
  }
  db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
  return { ok: false, error: 'That code is not right. Please check the email and try again.' };
}

// Remember on this device that the email is verified (up to 5 emails, for 6 months).
function rememberVerified(req, res, email) {
  const list = [normEmail(email), ...verifiedEmails(req).filter((x) => x !== normEmail(email))].slice(0, 5);
  res.cookie(COOKIE, JSON.stringify(list), { signed: true, httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 180 * 24 * 3600 * 1000 });
}

// Upcoming bookings not yet paid that use this email or phone.
function openBookingsFor(email, phone) {
  const e = normEmail(email);
  const p = phoneKey(phone);
  return db.prepare(
    `SELECT customer_email, customer_phone FROM bookings
     WHERE status = 'confirmed' AND payment_status = 'unpaid' AND return_date >= ?`,
  ).all(todayISO()).filter((b) => normEmail(b.customer_email) === e || (p.length >= 7 && phoneKey(b.customer_phone) === p)).length;
}

function bookingLimitError(email, phone) {
  const max = maxOpenBookings();
  if (!max || openBookingsFor(email, phone) < max) return null;
  return `You already have ${max} upcoming booking${max === 1 ? '' : 's'} with this email or phone number. `
    + 'Please complete or cancel one (using the link in its confirmation email) before booking another car.';
}

module.exports = { verifyEmailRequired, maxOpenBookings, needsCode, issueCode, checkCode, rememberVerified, bookingLimitError };
