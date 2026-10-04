# RentHub

A car rental marketplace. Rental shops sign up and list their cars; customers browse cars from every shop, book for specific dates, and get a confirmation email.

## Features

**Customers**
- Browse and search cars across all shops (city, dates, type, gearbox, max price, sort)
- Date search hides cars that are already booked
- Car page with specs, features, deposit, mileage policy, and full rental-shop details
- Booking form with live price estimate → review page → confirm
- Double bookings are blocked, even if two people confirm at the same moment
- Confirmation page and confirmation email with reference, dates, price and shop address

**Rental shops** (`/shop`)
- Register / log in
- Dashboard with upcoming bookings and booking value
- Add, edit, hide or delete cars, with photo upload (works with the iPad/iPhone camera)
- Booking list: mark completed or cancel (the customer is emailed automatically)
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

## Emails

Without SMTP settings, emails are saved and shown at `/dev/outbox` (the test inbox, disabled when `NODE_ENV=production`).
To send real emails, set the SMTP variables from `.env.example`. Any SMTP provider works, e.g. Resend, Brevo, SendGrid, Mailgun, or a Gmail/Outlook account with an app password.

## Configuration

Copy `.env.example` to `.env`. In production you must set `SESSION_SECRET`.

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `SESSION_SECRET` | Signs shop login cookies |
| `CURRENCY` | Price currency, e.g. `USD`, `AED`, `SAR` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Outgoing email |
| `DATABASE_FILE` | SQLite file path (default `data/app.db`) |

Data is stored in SQLite (`data/`) and photos in `uploads/`. When hosting, put both on a persistent disk.

## Project layout

```
server.js            app setup, flash messages, test inbox
src/db.js            SQLite schema
src/bookings.js      availability, pricing, booking creation
src/email.js         email templates and sending
src/routes/public.js customer pages
src/routes/shop.js   shop portal
views/               EJS templates
public/              CSS, JS, icons, PWA manifest
scripts/seed.js      demo data
```
