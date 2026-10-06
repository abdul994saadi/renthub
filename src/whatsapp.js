// Automatic WhatsApp messages through the WhatsApp Business Cloud API (Meta).
// Off unless WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are set. Business-initiated
// messages must use templates approved in Meta's WhatsApp Manager; the template names
// are configurable and each template's body takes the parameters listed below.
const { db } = require('./db');
const { formatDate, formatTime } = require('./helpers');

const env = (name) => (process.env[name] || '').trim();
const config = {
  token: env('WHATSAPP_TOKEN'),
  phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
  apiVersion: env('WHATSAPP_API_VERSION') || 'v21.0',
  apiBase: env('WHATSAPP_API_URL') || 'https://graph.facebook.com',
  language: env('WHATSAPP_TEMPLATE_LANGUAGE') || 'en',
  templates: {
    // Body parameters: {{1}} customer name, {{2}} booking reference, {{3}} car, {{4}} pick-up date and time, {{5}} shop name
    confirmation: env('WHATSAPP_TEMPLATE_CONFIRMATION'),
    // Same parameters as the confirmation template.
    pickup_reminder: env('WHATSAPP_TEMPLATE_PICKUP_REMINDER'),
    // An "Authentication" template with a copy-code button: {{1}} is the 6-digit code.
    code: env('WHATSAPP_TEMPLATE_CODE'),
  },
};
const enabled = Boolean(config.token && config.phoneNumberId);

// International number without "+" (961...) as WhatsApp expects. Local Lebanese numbers get 961.
function toWhatsAppNumber(phone) {
  let digits = String(phone || '').replace(/\D/g, '').replace(/^00/, '');
  if (digits.length && digits.length <= 8) digits = `961${digits.replace(/^0/, '')}`;
  return digits.length >= 10 ? digits : null;
}

async function sendTemplate(to, template, params, extraComponents = []) {
  const res = await fetch(`${config.apiBase}/${config.apiVersion}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: template,
        language: { code: config.language },
        components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) }, ...extraComponents],
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// Sends a booking message to the customer if WhatsApp is set up for that kind of message.
// Never throws: a failed WhatsApp message must not break a booking.
async function notifyCustomer(kind, booking, car, shop) {
  const template = config.templates[kind];
  const to = toWhatsAppNumber(booking.customer_phone);
  if (!enabled || !template || !to) return false;
  try {
    await sendTemplate(to, template, [
      booking.customer_name, booking.reference, `${car.year} ${car.make} ${car.model}`,
      `${formatDate(booking.pickup_date)}, ${formatTime(booking.pickup_time)}`, shop.name,
    ]);
    return true;
  } catch (err) {
    console.error(`WhatsApp ${kind} for ${booking.reference} failed:`, err.message);
    return false;
  }
}

const codesEnabled = enabled && Boolean(config.templates.code);

// Sends a booking confirmation code. Returns true when WhatsApp accepted the message.
async function sendCode(phone, code) {
  const to = toWhatsAppNumber(phone);
  if (!codesEnabled || !to) return false;
  try {
    await sendTemplate(to, config.templates.code, [code], [
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
    ]);
    return true;
  } catch (err) {
    console.error(`WhatsApp code to ${to} failed:`, err.message);
    return false;
  }
}

module.exports = { enabled, codesEnabled, config, toWhatsAppNumber, notifyCustomer, sendCode };
