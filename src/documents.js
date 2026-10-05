// Driving licence / ID uploads. Stored outside the public uploads folder and only
// served through routes that check the viewer may see them (the booking's shop or the owner).
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const { db } = require('./db');
const { UPLOAD_DIR } = require('./helpers');

const DOCS_DIR = process.env.DOCS_DIR || path.join(path.dirname(UPLOAD_DIR), 'private-docs');
fs.mkdirSync(DOCS_DIR, { recursive: true });

const KINDS = { licence: 'Driving licence', id: 'ID card or passport' };
const TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'application/pdf': '.pdf' };

const upload = multer({
  storage: multer.diskStorage({
    destination: DOCS_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + TYPES[file.mimetype]),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => cb(null, Boolean(TYPES[file.mimetype]) && Boolean(KINDS[file.fieldname])),
});

function bookingDocuments(bookingId) {
  return db.prepare('SELECT * FROM booking_documents WHERE booking_id = ? ORDER BY kind').all(bookingId);
}

// Saves the uploaded files, replacing an earlier upload of the same kind.
function saveDocuments(bookingId, files = {}) {
  const saved = [];
  for (const [kind, list] of Object.entries(files)) {
    const file = list[0];
    if (!KINDS[kind] || !file) continue;
    const old = db.prepare('SELECT * FROM booking_documents WHERE booking_id = ? AND kind = ?').get(bookingId, kind);
    if (old) {
      fs.rm(path.join(DOCS_DIR, old.filename), { force: true }, () => {});
      db.prepare('DELETE FROM booking_documents WHERE id = ?').run(old.id);
    }
    db.prepare('INSERT INTO booking_documents (booking_id, kind, filename, mimetype) VALUES (?, ?, ?, ?)')
      .run(bookingId, kind, file.filename, file.mimetype);
    saved.push(KINDS[kind]);
  }
  return saved;
}

function sendDocument(res, doc) {
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', 'inline');
  res.type(doc.mimetype).sendFile(path.join(DOCS_DIR, path.basename(doc.filename)));
}

module.exports = { DOCS_DIR, KINDS, upload, bookingDocuments, saveDocuments, sendDocument };
