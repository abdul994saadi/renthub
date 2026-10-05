// Car photo gallery: thumbnails, previous/next buttons and swipe.
(function () {
  const root = document.querySelector('[data-gallery]');
  if (!root) return;
  const main = root.querySelector('[data-gallery-main]');
  const count = root.querySelector('[data-gallery-count]');
  const thumbs = [...root.querySelectorAll('[data-gallery-thumb]')];
  let index = 0;

  function show(i) {
    index = (i + thumbs.length) % thumbs.length;
    main.src = thumbs[index].dataset.galleryThumb;
    thumbs.forEach((t, j) => t.classList.toggle('active', j === index));
    count.textContent = `${index + 1} / ${thumbs.length}`;
    thumbs[index].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  thumbs.forEach((t, i) => t.addEventListener('click', () => show(i)));
  root.querySelector('[data-gallery-prev]').addEventListener('click', () => show(index - 1));
  root.querySelector('[data-gallery-next]').addEventListener('click', () => show(index + 1));

  let startX = null;
  main.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  main.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 40) show(index + (dx < 0 ? 1 : -1));
    startX = null;
  });
})();
