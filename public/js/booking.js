// Live price estimate on the car page, and keeps the return date after the pick-up date.
(function () {
  const pickup = document.querySelector('[data-pickup]');
  const ret = document.querySelector('[data-return]');
  const out = document.querySelector('[data-estimate]');
  if (!pickup || !ret || !out) return;

  const rate = Number(out.dataset.rate);
  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: out.dataset.currency });

  function update() {
    if (pickup.value) {
      const next = new Date(pickup.value);
      next.setUTCDate(next.getUTCDate() + 1);
      ret.min = next.toISOString().slice(0, 10);
      if (ret.value && ret.value <= pickup.value) ret.value = ret.min;
    }
    const days = pickup.value && ret.value ? Math.round((Date.parse(ret.value) - Date.parse(pickup.value)) / 86400000) : 0;
    out.textContent = days > 0 ? `${days} day${days === 1 ? '' : 's'} × ${fmt.format(rate)} = ${fmt.format(days * rate)}` : '';
  }

  pickup.addEventListener('change', update);
  ret.addEventListener('change', update);
  update();
})();
