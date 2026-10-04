const nodemailer = require('nodemailer');
const { db } = require('./db');
const { money, formatDate } = require('./helpers');

const smtpConfigured = Boolean(process.env.SMTP_HOST);

const transport = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : null;

const FROM = process.env.MAIL_FROM || 'RentHub <no-reply@renthub.local>';

// Every email is stored in the `emails` table. Without SMTP settings it is only
// stored, and can be read on the /dev/outbox page.
async function sendEmail({ to, subject, html }) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO emails (to_address, subject, html) VALUES (?, ?, ?)')
    .run(to, subject, html);
  if (!transport) return;
  try {
    await transport.sendMail({ from: FROM, to, subject, html });
    db.prepare('UPDATE emails SET delivered = 1 WHERE id = ?').run(lastInsertRowid);
  } catch (err) {
    console.error(`Email to ${to} failed:`, err.message);
    db.prepare('UPDATE emails SET error = ? WHERE id = ?').run(err.message, lastInsertRowid);
  }
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
    ${row('Pick-up', formatDate(booking.pickup_date))}
    ${row('Return', formatDate(booking.return_date))}
    ${row('Rental days', booking.days)}
    ${row('Daily rate', money(booking.daily_price))}
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
    subject: `Booking confirmed: ${car.make} ${car.model} (${booking.reference})`,
    html: layout(
      `Your booking is confirmed, ${booking.customer_name}!`,
      `<p style="font-size:14px">Thank you for booking with <strong>${esc(shop.name)}</strong>.
       ${booking.payment_status === 'paid'
         ? `Your payment of <strong>${money(booking.total_price)}</strong> was received.`
         : `Please pay <strong>${money(booking.total_price)}</strong> to the shop when you pick up the car.`}
       Bring your driving licence and this reference when you pick up the car.</p>
       ${bookingTable(booking, car, shop)}`,
    ),
  });
  await sendEmail({
    to: shop.email,
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

async function sendCancellationEmail(booking, car, shop) {
  await sendEmail({
    to: booking.customer_email,
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
    subject: `Payment refunded: ${car.make} ${car.model} is no longer available`,
    html: layout(
      'Sorry, this car was booked by someone else',
      `<p style="font-size:14px">Your payment came through after the 30-minute hold on this car ran out, and another customer booked it in the meantime.
       We have refunded the full <strong>${money(booking.total_price)}</strong> to your card. It usually appears within 5–10 business days.</p>
       ${bookingTable(booking, car, shop)}`,
    ),
  });
}

module.exports = { sendBookingEmails, sendCancellationEmail, sendConflictRefundEmail, smtpConfigured };
