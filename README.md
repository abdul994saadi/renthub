# RentHub

A car rental marketplace. Rental shops sign up and list their cars; customers browse cars from every shop, book for specific dates, and get a confirmation email.

## Features

**Customers**
- Browse and search cars across all shops (city, dates, type, gearbox, max price, sort)
- Date search hides cars that are already booked
- Car page with specs, features, deposit, mileage policy, and full rental-shop details
- Booking form with live price estimate → review page → pay online
- Payment by card, Apple Pay or Google Pay on Stripe Checkout (card details never touch this server)
- The car is held for 30 minutes while the customer pays; abandoned payments release it
- Double bookings are blocked, even if two people book at the same moment
- Confirmation page and confirmation email (sent only once payment succeeds) with reference, dates, amount paid and shop address

**Rental shops** (`/shop`)
- Register / log in
- Dashboard with upcoming bookings and booking value
- Add, edit, hide or delete cars, with photo upload (works with the iPad/iPhone camera)
- Booking list: mark completed or cancel (the customer is refunded in full and emailed automatically)
- Payments tab: connect a Stripe account to receive payouts directly (Stripe Connect Express)
- Every new booking is emailed to the shop
- Shop profile (address, phone, hours, description) shown to customers

**App**: the site is mobile-first and installable. In Safari, tap Share → *Add to Home Screen*.

## Run it

Requires Node.js 22.5 or newer.

```bash
npm install
npm run seed     # optional: 3 demo shops and 10 cars (password: demo1234)
npm start        # http://localhost:3000
```

## Payments (Stripe)

Without `STRIPE_SECRET_KEY` (development only) payments are simulated on a test page at `/dev/pay`.

To take real payments:

1. Create a Stripe account and copy the secret key (`sk_test_…` for testing, `sk_live_…` when live) into `STRIPE_SECRET_KEY`.
2. In Stripe → Settings → Payment methods, make sure Cards and Apple Pay are on (Google Pay too if you like). Checkout shows Apple Pay automatically in Safari on Apple devices.
3. In Stripe → Developers → Webhooks, add an endpoint `https://<your-site>/stripe/webhook` listening to
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
   `checkout.session.expired` and (enable "Listen to events on Connected accounts") `account.updated`.
   Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. To let shops get paid directly, enable **Connect** in the Stripe Dashboard. Shops then use *Payments → Connect with Stripe* in their portal.
   Bookings at a connected shop are paid to that shop, minus `PLATFORM_FEE_PERCENT`. Bookings at shops that have not connected are paid to the platform's Stripe account.

Test cards: `4242 4242 4242 4242`, any future date, any CVC.

## Emails

Without SMTP settings, emails are saved and shown at `/dev/outbox` (the test inbox, disabled when `NODE_ENV=production`).
To send real emails, set the SMTP variables from `.env.example`. Any SMTP provider works, e.g. Resend, Brevo, SendGrid, Mailgun, or a Gmail/Outlook account with an app password.

## Configuration

Copy `.env.example` to `.env`. In production you must set `SESSION_SECRET`, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `SESSION_SECRET` | Signs shop login cookies |
| `CURRENCY` | Price currency, e.g. `USD`, `AED`, `SAR` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Outgoing email |
| `APP_URL` | Public site address used in payment return links |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe payments |
| `PLATFORM_FEE_PERCENT` | Commission on bookings at connected shops |
| `DATABASE_FILE` | SQLite file path (default `data/app.db`) |
| `UPLOAD_DIR` | Car photo folder (default `uploads/`) |

Data is stored in SQLite (`data/`) and photos in `uploads/`. When hosting, put both on a persistent disk.

## Deploy to Render

`render.yaml` describes the whole setup. In Render choose **New → Blueprint**, pick this repository, and fill in the secret values it asks for.
It creates a web service with a 1 GB persistent disk at `/var/data` for the database and photos (needs a paid instance; the free tier has no disk).

## Project layout

```
server.js            app setup, flash messages, test inbox
src/db.js            SQLite schema
src/bookings.js      availability, pricing, booking creation
src/payments.js      Stripe Checkout, webhooks, refunds, Connect
src/email.js         email templates and sending
src/routes/public.js customer pages
src/routes/shop.js   shop portal
views/               EJS templates
public/              CSS, JS, icons, PWA manifest
scripts/seed.js      demo data
```
