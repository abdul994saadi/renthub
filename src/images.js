// Shrinks car photos so pages load fast on phones: at most 1600 px on the long side,
// re-compressed, and turned the right way up. A file that cannot be processed is kept as it is.
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { db, getSetting, setSetting } = require('./db');
const { UPLOAD_DIR } = require('./helpers');

const MAX_SIDE = 1600;
const ENCODERS = {
  '.jpg': (img) => img.jpeg({ quality: 80, mozjpeg: true }),
  '.png': (img) => img.png({ compressionLevel: 9, palette: true }),
  '.webp': (img) => img.webp({ quality: 80 }),
};

async function optimizePhoto(file) {
  const encode = ENCODERS[path.extname(file).toLowerCase()];
  if (!encode) return false;
  const tmp = `${file}.tmp`;
  try {
    const before = (await fs.stat(file)).size;
    const img = sharp(file, { failOn: 'none' }).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    await encode(img).toFile(tmp);
    if ((await fs.stat(tmp)).size < before) await fs.rename(tmp, file);
    else await fs.rm(tmp, { force: true });
    return true;
  } catch (err) {
    await fs.rm(tmp, { force: true });
    console.warn(`Could not optimise photo ${path.basename(file)}: ${err.message}`);
    return false;
  }
}

// Uploaded files from multer, one at a time to keep memory low.
async function optimizeUploads(files = []) {
  for (const f of files) await optimizePhoto(f.path);
}

// One-time pass over photos uploaded before photos were optimised.
async function optimizeExistingPhotos() {
  if (getSetting('photos_optimized') === '1') return;
  const photos = db.prepare('SELECT filename FROM car_photos').all();
  let done = 0;
  for (const { filename } of photos) {
    const file = path.join(UPLOAD_DIR, path.basename(filename));
    const size = await fs.stat(file).then((s) => s.size, () => 0);
    if (size > 300 * 1024 && await optimizePhoto(file)) done += 1;
  }
  setSetting('photos_optimized', '1');
  if (done) console.log(`Optimised ${done} existing car photo(s).`);
}

module.exports = { optimizePhoto, optimizeUploads, optimizeExistingPhotos };
