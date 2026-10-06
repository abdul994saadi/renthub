# RentHub

A car rental marketplace. Rental shops sign up and list their cars; customers browse cars from every shop, book for specific dates, and get a confirmation email.

## Features

**Customers**
- Browse and search cars across all shops (city, dates, type, gearbox, max price, sort)
- Date search hides cars that are already booked
- Car page with specs, features, deposit, mileage policy, and full rental-shop details
- Booking form with live price estimate → review page → pay online
- Payment by debit/credit card on the Amazon Payment Services hosted page (card details never touch this server)
- The car is held for 30 minutes while the customer pays; declined or abandoned payments release it
- Double bookings are blocked, even if two people book at the same moment
- Customers choose a pick-up time and get a private link (in their email) to view or cancel the booking:
  free cancellation with a full refund until 24 hours before pick-up, non-refundable after that, not possible once pick-up has passed
- Confirmation page and confirmation email (sent only once payment succeeds) with reference, dates, amount paid and shop address

- Photo gallery per car, ratings and reviews, availability calendar, optional extras, delivery / airport pick-up, promo codes
- Approximate LBP prices next to USD
- Private upload of driving licence and ID before pick-up
- WhatsApp buttons to contact the shop; optional automatic WhatsApp messages
- Reminder emails before pick-up and return, and a review request after the rental

**Rental shops** (`/shop`)
- Register / log in
- Dashboard with upcoming bookings and booking value
- Add, edit, hide or delete cars, with photo upload (works with the iPad/iPhone camera)
- Booking list: mark completed or cancel (the customer is refunded in full and emailed automatically)
- Payments tab: money collected for the shop, RentHub's fee, and the shop's share
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

## Payments (Amazon Payment Services)

`PAYMENT_MODE=pickup` turns online payment off: bookings are confirmed immediately and the customer pays the shop at pick-up
(no APS credentials needed). `render.yaml` starts in this mode; change it to `online` once APS is set up.

Customers pay on the APS hosted payment page ("Redirection" integration). RentHub collects all payments and pays each shop its share.
Without APS credentials (development only) payments are simulated on a test page at `/dev/pay`.

To take real payments:

1. Get a merchant account from Amazon Payment Services. You receive a **sandbox** (test) account first.
2. In the APS dashboard → **Integration Settings → Security Settings**, copy the Merchant Identifier, Access Code,
   SHA Request Phrase and SHA Response Phrase, and set the SHA type to **SHA-256**. Put them in the `APS_*` variables.
3. In **Integration Settings → Technical Settings**, set:
   - Redirection URL / return URL: `https://<your-site>/payments/aps/return`
   - Direct Transaction Feedback and Notification Feedback URL: `https://<your-site>/payments/aps/notify`
4. Test with APS's sandbox test cards, then switch to your production account and set `APS_ENVIRONMENT=production`.

How it works: the booking is created as `pending_payment` (holding the car for 30 minutes) and the browser is sent to APS with a signed request.
APS sends the signed result back to `/payments/aps/return` and to `/payments/aps/notify`; both are verified with the SHA response phrase and are idempotent.
If neither arrives, opening the booking page asks APS directly (`CHECK_STATUS`). Shop cancellations call APS `REFUND`.

Apple Pay through APS needs extra setup (Apple Pay must be enabled on your APS account, and APS gives separate Apple Pay credentials). Ask your APS account manager whether it can be shown on the hosted payment page.

## Emails

Without SMTP settings, emails are saved and shown at `/dev/outbox` (the test inbox, disabled when `NODE_ENV=production`).
To send real emails, set the SMTP variables from `.env.example`. Any SMTP provider works, e.g. Resend, Brevo, SendGrid, Mailgun, or a Gmail/Outlook account with an app password.

## Owner dashboard

Set `ADMIN_PASSWORD` and open `/admin` (username `admin`): overview with commission, shops (verify / suspend),
all bookings (with driver documents), promo codes, reviews (hide / show), settings (LBP exchange rate) and the email check.

## Reminders

A background job inside the server (every `REMINDER_INTERVAL_MINUTES`, default 10) emails:
- the customer and the shop about 24 hours before pick-up (not for bookings made less than a day ahead),
- the customer about 12 hours before the return time,
- the customer a review request 2 hours after the return time (only for rentals that ended in the last 14 days).
Each email is sent once. "Send due reminders now" on the dashboard runs the job immediately.

## Automatic WhatsApp messages

Optional. Needs a WhatsApp Business account on Meta (WhatsApp Cloud API): a phone number ID, an access token, and message
templates approved in WhatsApp Manager. Booking confirmation codes use an "Authentication" template with a copy-code button, named in `WHATSAPP_TEMPLATE_CODE`; without it codes go by email. Set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` and the template names; the
confirmation template is sent when a booking is confirmed and the reminder template with the pick-up reminder.
Without these, the site still shows "Chat on WhatsApp" buttons (free wa.me links).

## Email check page

Set `ADMIN_PASSWORD` and open `/admin/email` (username `admin`). It shows whether the app can log in to the
mail server, lets you send a test email, and lists recent emails with the exact error for any that failed.
The same login check is written to the logs at startup.

## Configuration

Copy `.env.example` to `.env`. In production you must set `SESSION_SECRET`, plus the four `APS_*` credentials unless `PAYMENT_MODE=pickup`.

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `SESSION_SECRET` | Signs shop login cookies |
| `CURRENCY` | Price currency, e.g. `USD`, `AED`, `SAR` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Outgoing email |
| `APP_URL` | Public site address used in payment return links |
| `APS_MERCHANT_IDENTIFIER`, `APS_ACCESS_CODE`, `APS_SHA_REQUEST_PHRASE`, `APS_SHA_RESPONSE_PHRASE` | Amazon Payment Services credentials |
| `PAYMENT_MODE` | `online` (default) or `pickup` |
| `APS_SHA_TYPE` | `sha256` (default) or `sha512` |
| `APS_ENVIRONMENT` | `sandbox` (default) or `production` |
| `PLATFORM_FEE_PERCENT` | Starting default commission. Once set in owner dashboard → Settings, that value is used instead; each shop can also get its own rate on the Shops page |
| `ADMIN_PASSWORD` | Enables the `/admin/email` check page |
| `TIMEZONE` | Shops' time zone for pick-up times (default `Asia/Beirut`) |
| `FREE_CANCELLATION_HOURS` | Free cancellation window before pick-up (default `24`) |
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
src/payments.js      Amazon Payment Services: checkout, signed results, status checks, refunds
src/email.js         email templates and sending
src/routes/public.js customer pages
src/routes/shop.js   shop portal
views/               EJS templates
public/              CSS, JS, icons, PWA manifest
scripts/seed.js      demo data
```
