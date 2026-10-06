// Protection against fake pay-at-pick-up bookings:
// - the customer enters a 6-digit code sent by WhatsApp to their phone (or by email when WhatsApp is not
//   set up or cannot deliver it); a device that verified a phone or email skips it later;
// - one email or phone can hold only a few upcoming unpaid bookings at a time.
// Both are switched on or off in the owner dashboard (Settings).
const crypto = require('node:crypto');
const { db, getSetting } = require('./db');
const { todayISO } = require('./helpers');
const { sendVerificationCode } = require('./email');
const whatsapp = require('./whatsapp');

const CODE_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const COOKIE = 'verified_emails';

const verifyEmailRequired = () => getSetting('verify_email', '1') === '1';
// 'whatsapp' (falls back to email) or 'email'.
const codeChannel = () => getSetting('verify_channel', 'whatsapp');
const maxOpenBookings = () => Math.max(0, Number(getSetting('max_open_bookings', '2')) || 0);

const normEmail = (email) => String(email || '').trim().toLowerCase();
const phoneKey = (phone) => String(phone || '').replace(/\D/g, '').slice(-8);
const emailKey = (email) => `e:${normEmail(email)}`;
const phoneVerifyKey = (phone) => { const n = whatsapp.toWhatsAppNumber(phone); return n ? `p:${n}` : null; };
const hash = (key, code) => crypto.createHash('sha256').update(`${key}:${code}`).digest('hex');

function verifiedEmails(req) {
  try { return JSON.parse(req.signedCookies[COOKIE] || '[]'); } catch { return []; }
}

function needsCode(req, email, phone) {
  if (!verifyEmailRequired()) return false;
  const done = verifiedEmails(req);
  return !(done.includes(emailKey(email)) || done.includes(normEmail(email)) || (phoneVerifyKey(phone) && done.includes(phoneVerifyKey(phone))));
}

// Formats +961 70 123 456 style for messages.
const showPhone = (phone) => `+${whatsapp.toWhatsAppNumber(phone) || String(phone).replace(/\D/g, '')}`;

// Sends a new code (WhatsApp first when chosen, email otherwise or as a fallback), unless one was
// sent less than a minute ago. Returns { ok, via, to, recent?, error? }.
async function issueCode(email, phone) {
  const keys = [emailKey(email), phoneVerifyKey(phone)].filter(Boolean);
  const recent = db.prepare(
    `SELECT email AS key FROM email_codes WHERE email IN (${keys.map(() => '?').join(',')})
       AND created_at > datetime('now', ?) AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`,
  ).get(...keys, `-${RESEND_SECONDS} seconds`);
  if (recent) return recent.key.startsWith('p:') ? { ok: true, recent: true, via: 'whatsapp', to: showPhone(phone) } : { ok: true, recent: true, via: 'email', to: email };

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const store = (key) => {
    db.prepare("DELETE FROM email_codes WHERE email IN (" + keys.map(() => '?').join(',') + ") OR expires_at < datetime('now', '-1 day')").run(...keys);
    db.prepare(`INSERT INTO email_codes (email, code_hash, expires_at) VALUES (?, ?, datetime('now', ?))`)
      .run(key, hash(key, code), `+${CODE_MINUTES} minutes`);
  };
  if (codeChannel() === 'whatsapp' && phoneVerifyKey(phone) && await whatsapp.sendCode(phone, code)) {
    store(phoneVerifyKey(phone));
    return { ok: true, via: 'whatsapp', to: showPhone(phone) };
  }
  store(emailKey(email));
  const sent = await sendVerificationCode(email, code);
  return sent ? { ok: true, via: 'email', to: email }
    : { ok: false, error: 'We could not send you a code. Please check your phone number and email, or try again in a few minutes.' };
}

// Checks the latest code sent to the customer's phone or email. Returns { ok, key } or { ok: false, error }.
function checkCode(email, phone, code) {
  const keys = [emailKey(email), phoneVerifyKey(phone)].filter(Boolean);
  const row = db.prepare(
    `SELECT * FROM email_codes WHERE email IN (${keys.map(() => '?').join(',')}) AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`,
  ).get(...keys);
  if (!row) return { ok: false, error: 'This code has expired. Tap "Send a new code" to get another one.' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Too many wrong codes. Tap "Send a new code" to get another one.' };
  const given = String(code || '').replace(/\D/g, '');
  if (given.length === 6 && crypto.timingSafeEqual(Buffer.from(hash(row.email, given)), Buffer.from(row.code_hash))) {
    db.prepare(`DELETE FROM email_codes WHERE email IN (${keys.map(() => '?').join(',')})`).run(...keys);
    return { ok: true, key: row.email };
  }
  db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
  return { ok: false, error: 'That code is not right. Please check the message and try again.' };
}

// Remember on this device that this phone or email is verified (up to 5, for 6 months).
function rememberVerified(req, res, key) {
  const list = [key, ...verifiedEmails(req).filter((x) => x !== key)].slice(0, 5);
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

module.exports = { whatsappReady: () => whatsapp.codesEnabled, verifyEmailRequired, codeChannel, maxOpenBookings, needsCode, issueCode, checkCode, rememberVerified, bookingLimitError };
