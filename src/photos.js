const path = require('node:path');
const fs = require('node:fs');
const { db } = require('./db');
const { UPLOAD_DIR } = require('./helpers');

const MAX_PHOTOS = 10;

function carPhotos(carId) {
  return db.prepare('SELECT * FROM car_photos WHERE car_id = ? ORDER BY position, id').all(carId);
}

function removeFile(filename) {
  if (filename) fs.rm(path.join(UPLOAD_DIR, path.basename(filename)), { force: true }, () => {});
}

// cars.image always holds the cover (first) photo, so listings need no extra query.
function syncCover(carId) {
  const first = db.prepare('SELECT filename FROM car_photos WHERE car_id = ? ORDER BY position, id LIMIT 1').get(carId);
  db.prepare('UPDATE cars SET image = ? WHERE id = ?').run(first?.filename ?? null, carId);
}

// Adds uploaded files, removes the ticked ones and moves the chosen cover to the front.
// Returns the filenames that were not stored because the car already has MAX_PHOTOS.
function updateCarPhotos(carId, { added = [], removeIds = [], coverId = null }) {
  for (const id of removeIds) {
    const photo = db.prepare('SELECT * FROM car_photos WHERE id = ? AND car_id = ?').get(Number(id), carId);
    if (photo) {
      db.prepare('DELETE FROM car_photos WHERE id = ?').run(photo.id);
      removeFile(photo.filename);
    }
  }
  let count = db.prepare('SELECT COUNT(*) AS n FROM car_photos WHERE car_id = ?').get(carId).n;
  let next = (db.prepare('SELECT MAX(position) AS p FROM car_photos WHERE car_id = ?').get(carId).p ?? -1) + 1;
  const rejected = [];
  for (const filename of added) {
    if (count >= MAX_PHOTOS) { rejected.push(filename); removeFile(filename); continue; }
    db.prepare('INSERT INTO car_photos (car_id, filename, position) VALUES (?, ?, ?)').run(carId, filename, next++);
    count++;
  }
  if (coverId && db.prepare('SELECT 1 FROM car_photos WHERE id = ? AND car_id = ?').get(Number(coverId), carId)) {
    db.prepare('UPDATE car_photos SET position = position + 1 WHERE car_id = ?').run(carId);
    db.prepare('UPDATE car_photos SET position = 0 WHERE id = ?').run(Number(coverId));
  }
  syncCover(carId);
  return rejected;
}

function deleteCarPhotos(carId) {
  for (const p of carPhotos(carId)) removeFile(p.filename);
}

module.exports = { MAX_PHOTOS, carPhotos, updateCarPhotos, deleteCarPhotos, removeFile };
