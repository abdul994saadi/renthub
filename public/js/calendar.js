// Availability calendar on the car page: two months at a time, booked days greyed out.
// Tapping free days fills in the pick-up and return dates of the booking form.
(function () {
  const root = document.querySelector('[data-calendar]');
  if (!root) return;
  const today = root.dataset.today;
  const ranges = JSON.parse(root.dataset.booked || '[]');
  const pickup = document.querySelector('[data-pickup]');
  const ret = document.querySelector('[data-return]');
  const minDays = Number(document.querySelector('[data-min-days]')?.dataset.minDays) || 1;
  const hint = document.querySelector('.booking-rules');

  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  // A booking blocks its pick-up day up to the day before return (the return day can be a new pick-up day).
  const isBooked = (day) => ranges.some(([from, to]) => day >= from && day < to);
  const rangeFree = (from, to) => { for (let d = from; d < to; d = addDays(d, 1)) if (isBooked(d)) return false; return true; };

  let start = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  const months = () => (root.clientWidth > 520 ? 2 : 1);

  function monthHtml(first) {
    const name = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const offset = (first.getUTCDay() + 6) % 7; // Monday first
    const daysIn = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    let cells = '<span></span>'.repeat(offset);
    for (let n = 1; n <= daysIn; n++) {
      const day = iso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), n)));
      const past = day < today;
      const booked = isBooked(day);
      const picked = pickup.value && (day === pickup.value || (ret.value && day > pickup.value && day < ret.value) || day === ret.value);
      const cls = past ? 'past' : booked ? 'booked' : picked ? 'picked' : 'free';
      cells += `<button type="button" class="cal-day ${cls}" data-day="${day}" ${past || booked ? 'disabled' : ''} aria-label="${day}${booked ? ' booked' : ''}">${n}</button>`;
    }
    return `<div class="cal-month"><div class="cal-title">${name}</div><div class="cal-grid">
      ${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => `<span class="cal-dow">${d}</span>`).join('')}${cells}</div></div>`;
  }

  function render() {
    const firsts = Array.from({ length: months() }, (_, i) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1)));
    const atStart = iso(start).slice(0, 7) <= today.slice(0, 7);
    root.innerHTML = `<div class="cal-nav">
        <button type="button" class="btn btn-ghost btn-small" data-cal-prev ${atStart ? 'disabled' : ''} aria-label="Previous month">‹</button>
        <button type="button" class="btn btn-ghost btn-small" data-cal-next aria-label="Next month">›</button>
      </div><div class="cal-months">${firsts.map(monthHtml).join('')}</div>`;
  }

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-cal-prev]')) { start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1)); return render(); }
    if (e.target.closest('[data-cal-next]')) { start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)); return render(); }
    const btn = e.target.closest('[data-day]');
    if (!btn) return;
    const day = btn.dataset.day;
    if (pickup.value && !ret.value && day > pickup.value && day < addDays(pickup.value, minDays)) {
      // Too short for this car's minimum rental: keep the pick-up and point out the rule.
      if (hint) { hint.classList.remove('flash'); void hint.offsetWidth; hint.classList.add('flash'); }
      return;
    }
    if (pickup.value && !ret.value && day > pickup.value && rangeFree(pickup.value, day)) {
      ret.value = day;
    } else {
      pickup.value = day;
      ret.value = '';
    }
    pickup.dispatchEvent(new Event('change', { bubbles: true }));
    ret.dispatchEvent(new Event('change', { bubbles: true }));
    render();
    if (ret.value) document.getElementById('book').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  pickup.addEventListener('change', render);
  ret.addEventListener('change', render);
  window.addEventListener('resize', render);
  render();
})();
