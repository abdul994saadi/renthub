const nodemailer = require('nodemailer');
const { db } = require('./db');
const { money, formatDate, formatTime, formatDateTime, whatsappLink, FREE_CANCELLATION_HOURS } = require('./helpers');
const whatsapp = require('./whatsapp');
const { cancellationPolicy } = require('./bookings');
const { bookingExtras } = require('./pricing');

// Public address of the site, used for links in emails.
const SITE_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// Settings are trimmed: a stray space pasted into a dashboard field breaks SMTP logins.
const env = (name) => (process.env[name] || '').trim();
const smtp = {
  host: env('SMTP_HOST'),
  port: Number(env('SMTP_PORT')) || 587,
  user: env('SMTP_USER'),
  pass: env('SMTP_PASS'),
};
const smtpConfigured = Boolean(smtp.host);

const transport = smtpConfigured
  ? nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      // Fail within seconds instead of leaving a customer's booking page waiting.
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    })
  : null;

const FROM = env('MAIL_FROM') || 'RentHub <no-reply@renthub.local>';

// Settings summary for the admin email page (the password is never shown).
function smtpSummary() {
  return {
    configured: smtpConfigured,
    host: smtp.host || '(not set)',
    port: smtp.port,
    user: smtp.user || '(not set)',
    passSet: Boolean(smtp.pass),
    from: FROM,
    siteUrl: SITE_URL,
  };
}

// Connects and logs in to the SMTP server without sending anything.
async function verifySmtp() {
  if (!transport) return { ok: false, error: 'SMTP_HOST is not set, so no emails are sent.' };
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Plain-text version of an email. Mail filters trust messages that include one.
function htmlToText(html) {
  return html
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2: $1')
    .replace(/<br\s*\/?>|<\/(p|tr|h1|h2|div)>/gi, '\n')
    .replace(/<\/td>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// Every email is stored in the `emails` table. Without SMTP settings it is only
// stored, and can be read on the /dev/outbox page.
// Returns true when sent (or saved to the test inbox when SMTP is not set up), false when sending failed.
async function sendEmail({ to, subject, html, replyTo }) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO emails (to_address, subject, html) VALUES (?, ?, ?)')
    .run(to, subject, html);
  if (!transport) return true;
  try {
    await transport.sendMail({ from: FROM, to, subject, html, text: htmlToText(html), ...(replyTo && { replyTo }) });
    db.prepare('UPDATE emails SET delivered = 1 WHERE id = ?').run(lastInsertRowid);
    return true;
  } catch (err) {
    console.error(`Email to ${to} failed:`, err.message);
    db.prepare('UPDATE emails SET error = ? WHERE id = ?').run(err.message, lastInsertRowid);
    return false;
  }
}

function sendVerificationCode(to, code) {
  return sendEmail({
    to,
    subject: `${code} is your RentHub booking code`,
    html: layout('Confirm your email', `<p style="font-size:14px">Enter this code on RentHub to confirm your booking:</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0">${esc(code)}</p>
      <p style="font-size:13px;color:#6b7280">The code is valid for 15 minutes. If you did not try to book a car on RentHub, you can ignore this email.</p>`),
  });
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(title, body) {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <div style="font-size:20px;font-weight:bold;color:#2563eb;margin-bottom:16px">RentHub</div>
    <div style="background:#fff;border-radius:12px;padding:24px">
      <h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>
      ${body}
    </div>
    <p style="font-size:12px;color:#6b7280;margin-top:16px">This email was sent automatically by RentHub.</p>
  </div></body></html>`;
}

function row(label, value) {
  return `<tr><td style="padding:6px 0;color:#6b7280">${esc(label)}</td><td style="padding:6px 0;text-align:right;font-weight:bold">${esc(value)}</td></tr>`;
}

function bookingTable(booking, car, shop) {
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">
    ${row('Booking reference', booking.reference)}
    ${row('Car', `${car.year} ${car.make} ${car.model}`)}
    ${row('Pick-up', `${formatDate(booking.pickup_date)}, ${formatTime(booking.pickup_time)}`)}
    ${row('Return by', `${formatDate(booking.return_date)}, ${formatTime(booking.pickup_time)}`)}
    ${booking.pickup_method === 'delivery' ? row('Delivery to', booking.delivery_address) : ''}
    ${booking.pickup_method === 'airport' ? row('Pick-up at', `Beirut airport${booking.flight_number ? `, flight ${booking.flight_number}` : ''}`) : ''}
    ${row(`${money(booking.daily_price)} × ${booking.days} day${booking.days === 1 ? '' : 's'}`, money(booking.car_total ?? booking.days * booking.daily_price))}
    ${bookingExtras(booking.id).map((e) => row(e.name, money(e.total))).join('')}
    ${booking.delivery_fee ? row(booking.pickup_method === 'airport' ? 'Airport pick-up' : 'Delivery', money(booking.delivery_fee)) : ''}
    ${booking.discount ? row(`Promo code ${booking.promo_code}`, `-${money(booking.discount)}`) : ''}
    ${row(booking.payment_status === 'unpaid' ? 'Total (pay at pick-up)' : 'Total paid online', money(booking.total_price))}
    ${booking.payment_status === 'refunded' ? row('Refunded', money(booking.total_price)) : ''}
    ${car.deposit ? row('Refundable deposit (at pick-up)', money(car.deposit)) : ''}
  </table>
  <h2 style="font-size:16px;margin:20px 0 8px">Rental shop</h2>
  <p style="margin:0;font-size:14px;line-height:1.6">
    <strong>${esc(shop.name)}</strong><br>
    ${esc(shop.address)}${shop.city ? `, ${esc(shop.city)}` : ''}<br>
    ${shop.phone ? `Phone: ${esc(shop.phone)}<br>` : ''}
    Email: ${esc(shop.email)}
    ${shop.opening_hours ? `<br>Hours: ${esc(shop.opening_hours)}` : ''}
  </p>`;
}

async function sendBookingEmails(booking, car, shop) {
  await sendEmail({
    to: booking.customer_email,
    replyTo: shop.email,
    subject: `Booking confirmed: ${car.make} ${car.model} (${booking.reference})`,
    html: layout(
      `Your booking is confirmed, ${booking.customer_name}!`,
      `<p style="font-size:14px">Thank you for booking with <strong>${esc(shop.name)}</strong>.
       ${booking.payment_status === 'paid'
         ? `Your payment of <strong>${money(booking.total_price)}</strong> was received.`
         : `Please pay <strong>${money(booking.total_price)}</strong> to the shop when you pick up the car.`}
       Bring your driving licence and this reference when you pick up the car.</p>
       ${bookingTable(booking, car, shop)}
       ${docsSection(booking)}
       ${whatsappSection(booking, shop)}
       ${manageSection(booking)}`,
    ),
  });
  await whatsapp.notifyCustomer('confirmation', booking, car, shop);
  await sendEmail({
    to: shop.email,
    replyTo: booking.customer_email,
    subject: `New booking ${booking.reference}: ${car.make} ${car.model}`,
    html: layout(
      booking.payment_status === 'paid' ? 'You have a new paid booking' : 'You have a new booking',
      `<p style="font-size:14px">${booking.payment_status === 'paid'
        ? `The customer has paid ${money(booking.total_price)} online.`
        : `The customer will pay ${money(booking.total_price)} at pick-up.`}<br>Customer: <strong>${esc(booking.customer_name)}</strong><br>
       Email: ${esc(booking.customer_email)}<br>Phone: ${esc(booking.customer_phone)}
       ${booking.notes ? `<br>Notes: ${esc(booking.notes)}` : ''}</p>
       ${bookingTable(booking, car, shop)}`,
    ),
  });
}

function button(href, label) {
  return `<a href="${esc(href)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">${esc(label)}</a>`;
}

// Cancellation policy + the customer's private link to view or cancel the booking.
const manageUrl = (booking) => `${SITE_URL}/bookings/${booking.reference}?t=${booking.manage_token}`;

// Link for the customer to message the shop on WhatsApp.
function whatsappSection(booking, shop) {
  const link = whatsappLink(shop.whatsapp || shop.phone, `Hello ${shop.name}, about my RentHub booking ${booking.reference}: `);
  return link ? `<p style="font-size:14px;margin:16px 0 0">Questions? <a href="${esc(link)}">Message ${esc(shop.name)} on WhatsApp</a>.</p>` : '';
}

const docsSection = (booking) => (booking.manage_token
  ? `<p style="font-size:14px;margin:16px 0 0">Save time at pick-up: <a href="${esc(manageUrl(booking))}">upload a photo of your driving licence and ID</a> before you arrive.</p>`
  : '');

function manageSection(booking) {
  if (!booking.manage_token) return '';
  const { deadline } = cancellationPolicy(booking);
  return `<h2 style="font-size:16px;margin:20px 0 8px">Need to cancel?</h2>
  <p style="font-size:14px;margin:0 0 12px">You can cancel free of charge until <strong>${esc(formatDateTime(deadline))}</strong>
  (${FREE_CANCELLATION_HOURS} hours before pick-up). After that, cancellations are non-refundable.</p>
  <p style="margin:0">${button(`${SITE_URL}/bookings/${booking.reference}?t=${booking.manage_token}`, 'View or cancel booking')}</p>`;
}

// Sent when the customer cancels from their booking link.
async function sendCustomerCancellationEmails(booking, car, shop, { late }) {
  const paidAndKept = booking.payment_status === 'paid';
  const refundText = booking.payment_status === 'refunded'
    ? `A full refund of <strong>${money(booking.total_price)}</strong> has been sent to your card. It usually appears within 5–10 business days.`
    : paidAndKept
      ? `Because the booking was cancelled less than ${FREE_CANCELLATION_HOURS} hours before pick-up, your payment of <strong>${money(booking.total_price)}</strong> is non-refundable.`
      : 'Nothing was charged for this booking.';
  await sendEmail({
    to: booking.customer_email,
    replyTo: shop.email,
    subject: `Booking cancelled: ${booking.reference}`,
    html: layout(
      'Your booking has been cancelled',
      `<p style="font-size:14px">You cancelled the booking below. ${refundText}</p>
       ${bookingTable(booking, car, shop)}`,
    ),
  });
  await sendEmail({
    to: shop.email,
    replyTo: booking.customer_email,
    subject: `Booking ${booking.reference} cancelled by the customer`,
    html: layout(
      'A customer cancelled their booking',
      `<p style="font-size:14px"><strong>${esc(booking.customer_name)}</strong> cancelled the booking below.
       ${late ? `<br><strong>Late cancellation</strong> (less than ${FREE_CANCELLATION_HOURS} hours before pick-up)${paidAndKept ? ': the payment was kept.' : '.'}` : ''}
       The car is available again for these dates.</p>
       ${bookingTable(booking, car, shop)}`,
    ),
  });
}

async function sendTestEmail(to) {
  await sendEmail({
    to,
    subject: 'RentHub test email',
    html: layout('Email is working', `<p style="font-size:14px">This test was sent from ${esc(SITE_URL)} at ${esc(new Date().toISOString())}.
      If you can read this, booking confirmations will reach your customers.</p>`),
  });
  return db.prepare('SELECT * FROM emails ORDER BY id DESC LIMIT 1').get();
}

// ---------- Reminders (sent by the scheduler) ----------

async function sendPickupReminder(booking, car, shop) {
  const when = `${formatDate(booking.pickup_date)} at ${formatTime(booking.pickup_time)}`;
  const where = booking.pickup_method === 'delivery' ? `delivered to ${esc(booking.delivery_address)}`
    : booking.pickup_method === 'airport' ? 'at Beirut airport' : `at ${esc([shop.address, shop.city].filter(Boolean).join(', '))}`;
  await sendEmail({
    to: booking.customer_email,
    replyTo: shop.email,
    subject: `Reminder: your ${car.make} ${car.model} pick-up is ${when}`,
    html: layout(
      `See you soon, ${booking.customer_name}!`,
      `<p style="font-size:14px">Your rental starts <strong>${esc(when)}</strong>, ${where}. Bring your driving licence and your booking reference <strong>${esc(booking.reference)}</strong>.</p>
       ${bookingTable(booking, car, shop)}
       ${docsSection(booking)}
       ${whatsappSection(booking, shop)}`,
    ),
  });
  await sendEmail({
    to: shop.email,
    replyTo: booking.customer_email,
    subject: `Pick-up ${when}: ${car.make} ${car.model} for ${booking.customer_name}`,
    html: layout('Upcoming pick-up', `<p style="font-size:14px"><strong>${esc(booking.customer_name)}</strong> (${esc(booking.customer_phone)}) picks up the car <strong>${esc(when)}</strong>.</p>
      ${bookingTable(booking, car, shop)}`),
  });
  await whatsapp.notifyCustomer('pickup_reminder', booking, car, shop);
}

async function sendReturnReminder(booking, car, shop) {
  const when = `${formatDate(booking.return_date)} at ${formatTime(booking.pickup_time)}`;
  await sendEmail({
    to: booking.customer_email,
    replyTo: shop.email,
    subject: `Reminder: please return the ${car.make} ${car.model} by ${when}`,
    html: layout('Your rental ends soon', `<p style="font-size:14px">Please return the car to <strong>${esc(shop.name)}</strong> by <strong>${esc(when)}</strong>.
      If you need more time, contact the shop before then.</p>${whatsappSection(booking, shop)}`),
  });
}

async function sendReviewRequest(booking, car, shop) {
  const url = `${SITE_URL}/bookings/${booking.reference}/review?t=${booking.manage_token}`;
  const stars = [5, 4, 3, 2, 1].map((n) => `<a href="${esc(`${url}&rating=${n}`)}" style="text-decoration:none;font-size:28px;color:#f59e0b">${'★'.repeat(n)}</a>`).join('<br>');
  await sendEmail({
    to: booking.customer_email,
    replyTo: shop.email,
    subject: `How was your ${car.make} ${car.model} from ${shop.name}?`,
    html: layout(`Thank you for renting with ${shop.name}`, `<p style="font-size:14px">How was the car and the service? Tap a rating to leave a quick review:</p>
      <p style="margin:12px 0;line-height:1.4">${stars}</p>
      <p style="margin:16px 0 0">${button(url, 'Write a review')}</p>`),
  });
}

async function sendCancellationEmail(booking, car, shop) {
  await sendEmail({
    to: booking.customer_email,
    replyTo: shop.email,
    subject: `Booking cancelled: ${booking.reference}`,
    html: layout(
      'Your booking has been cancelled',
      `<p style="font-size:14px">${esc(shop.name)} has cancelled the booking below.
       ${booking.payment_status === 'refunded' ? `A full refund of <strong>${money(booking.total_price)}</strong> has been sent to your card. It usually appears within 5–10 business days.` : ''}
       Contact the shop if you have any questions.</p>
       ${bookingTable(booking, car, shop)}`,
    ),
  });
}

async function sendConflictRefundEmail(booking, car, shop) {
  await sendEmail({
    to: booking.customer_email,
    replyTo: shop.email,
    subject: `Payment refunded: ${car.make} ${car.model} is no longer available`,
    html: layout(
      'Sorry, this car was booked by someone else',
      `<p style="font-size:14px">Your payment came through after the 30-minute hold on this car ran out, and another customer booked it in the meantime.
       We have refunded the full <strong>${money(booking.total_price)}</strong> to your card. It usually appears within 5–10 business days.</p>
       ${bookingTable(booking, car, shop)}`,
    ),
  });
}

module.exports = { sendVerificationCode, sendPickupReminder, sendReturnReminder, sendReviewRequest, htmlToText, smtpSummary, verifySmtp, sendTestEmail, sendBookingEmails, sendCancellationEmail, sendCustomerCancellationEmails, sendConflictRefundEmail, smtpConfigured };
