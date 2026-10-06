// Car page booking form: live price breakdown, return date after pick-up date,
// and showing the delivery address / flight number fields when needed.
(function () {
  const form = document.getElementById('book');
  const pickup = document.querySelector('[data-pickup]');
  const ret = document.querySelector('[data-return]');
  const out = document.querySelector('[data-estimate]');
  if (!form || !pickup || !ret || !out) return;

  const rate = Number(out.dataset.rate);
  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: out.dataset.currency });
  const lbpRate = Number(out.dataset.lbpRate) || 0;
  const lbp = (usd) => (lbpRate ? `≈ LBP ${new Intl.NumberFormat('en-US').format(Math.round((usd * lbpRate) / 1000) * 1000)}` : '');
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function row(label, amount) {
    return `<div class="est-row"><span>${esc(label)}</span><span>${fmt.format(amount)}</span></div>`;
  }

  function update() {
    if (pickup.value) {
      const next = new Date(pickup.value);
      next.setUTCDate(next.getUTCDate() + 1);
      ret.min = next.toISOString().slice(0, 10);
      if (ret.value && ret.value <= pickup.value) ret.value = ret.min;
    }
    const method = form.querySelector('input[name=pickup_method]:checked');
    form.querySelectorAll('[data-show-for]').forEach((el) => { el.hidden = !method || method.value !== el.dataset.showFor; });

    const days = pickup.value && ret.value ? Math.round((Date.parse(ret.value) - Date.parse(pickup.value)) / 86400000) : 0;
    if (days <= 0) { out.hidden = true; return; }
    let total = days * rate;
    let html = row(`${days} day${days === 1 ? '' : 's'} × ${fmt.format(rate)}`, days * rate);
    form.querySelectorAll('input[name=extras]:checked').forEach((el) => {
      const price = Number(el.dataset.price);
      const amount = el.dataset.per === 'day' ? price * days : price;
      total += amount;
      html += row(el.closest('label').querySelector('span').firstChild.textContent.trim(), amount);
    });
    if (method && Number(method.dataset.fee)) {
      total += Number(method.dataset.fee);
      html += row(method.value === 'airport' ? 'Airport pick-up' : 'Delivery', Number(method.dataset.fee));
    }
    html += `<div class="est-row est-total"><span>Total</span><span>${fmt.format(total)}</span></div>`;
    if (lbp(total)) html += `<div class="est-lbp">${lbp(total)}</div>`;
    out.innerHTML = html;
    out.hidden = false;
  }

  // Remember the customer's name, email and phone on this device for their next booking.
  const KEY = 'renthub_customer';
  const fields = ['name', 'email', 'phone'].map((n) => form.elements[n]).filter(Boolean);
  const note = form.querySelector('[data-remembered]');
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && fields.every((el) => !el.value)) {
      fields.forEach((el) => { el.value = saved[el.name] || ''; });
      if (note) note.hidden = false;
    }
  } catch { /* storage unavailable */ }
  form.addEventListener('submit', () => {
    try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(fields.map((el) => [el.name, el.value.trim()])))); } catch { /* ignore */ }
  });
  form.querySelector('[data-forget]')?.addEventListener('click', (e) => {
    e.preventDefault();
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    fields.forEach((el) => { el.value = ''; });
    if (note) note.hidden = true;
    fields[0]?.focus();
  });

  form.addEventListener('change', update);
  update();
  window.renthubBookingUpdate = update;
})();
