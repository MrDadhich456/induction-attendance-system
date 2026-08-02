const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const dataDir = process.env.DATA_DIR || __dirname;

if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD must be set when running in production.');
}
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'attendance.db'));
db.pragma('journal_mode = WAL');

// ---------- schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  venue_lat REAL,
  venue_lng REAL,
  radius_m REAL DEFAULT 100,
  start_time TEXT DEFAULT '00:00',
  end_time TEXT DEFAULT '23:59',
  venue_label TEXT DEFAULT 'Induction Venue'
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  mobile TEXT NOT NULL,
  email TEXT,
  date TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  lat REAL,
  lng REAL,
  accuracy REAL,
  distance_m REAL,
  device_id TEXT NOT NULL,
  UNIQUE(mobile, date)
);

`);

// Earlier versions of this project used a roll-number-only attendance table.
// Keep that data intact, but create the current self-registration schema so a
// new check-in cannot fail with "no column named name".
const attendanceColumns = db.prepare('PRAGMA table_info(attendance)').all().map((column) => column.name);
const currentAttendanceColumns = ['name', 'branch', 'mobile', 'email'];
if (!currentAttendanceColumns.every((column) => attendanceColumns.includes(column))) {
  const legacyTable = `attendance_legacy_${Date.now()}`;
  db.exec(`ALTER TABLE attendance RENAME TO ${legacyTable};
    DROP INDEX IF EXISTS idx_att_date;
    DROP INDEX IF EXISTS idx_att_device_date;
    CREATE TABLE attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      branch TEXT NOT NULL,
      mobile TEXT NOT NULL,
      email TEXT,
      date TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      lat REAL,
      lng REAL,
      accuracy REAL,
      distance_m REAL,
      device_id TEXT NOT NULL,
      UNIQUE(mobile, date)
    );`);
  console.warn(`Migrated an incompatible legacy attendance table to ${legacyTable}.`);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
  CREATE INDEX IF NOT EXISTS idx_att_device_date ON attendance(device_id, date);
`);

const settingsRow = db.prepare('SELECT * FROM settings WHERE id = 1').get();
if (!settingsRow) {
  db.prepare(`INSERT INTO settings (id, venue_lat, venue_lng, radius_m, start_time, end_time, venue_label)
              VALUES (1, 26.4499, 74.6399, 100, '00:00', '23:59', 'Induction Venue')`).run();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

function withinWindow(settings) {
  const now = new Date();
  const hhmm = now.toTimeString().slice(0, 5);
  return hhmm >= settings.start_time && hhmm <= settings.end_time;
}

function normalizeMobile(m) {
  return String(m || '').replace(/\D/g, '');
}

function isValidMobile(m) {
  const digits = normalizeMobile(m);
  return /^\d{10}$/.test(digits);
}

// ---------- public: check status ----------
app.get('/api/status', (req, res) => {
  const { deviceId, mobile } = req.query;
  const date = todayStr();
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();

  const deviceMarked = deviceId
    ? db.prepare('SELECT 1 FROM attendance WHERE device_id = ? AND date = ?').get(deviceId, date)
    : null;
  const mobileMarked = mobile
    ? db.prepare('SELECT 1 FROM attendance WHERE mobile = ? AND date = ?').get(normalizeMobile(mobile), date)
    : null;

  res.json({
    ok: true,
    date,
    venue: { lat: settings.venue_lat, lng: settings.venue_lng, radius: settings.radius_m, label: settings.venue_label },
    window: { start: settings.start_time, end: settings.end_time, open: withinWindow(settings) },
    deviceAlreadyMarked: !!deviceMarked,
    mobileAlreadyMarked: !!mobileMarked,
  });
});

// ---------- public: mark attendance ----------
app.post('/api/attendance/mark', (req, res) => {
  let { name, branch, mobile, email, lat, lng, accuracy, deviceId } = req.body || {};

  name = (name || '').trim();
  branch = (branch || '').trim();
  email = (email || '').trim();
  const mobileDigits = normalizeMobile(mobile);

  if (!name || !branch || !mobileDigits || typeof lat !== 'number' || typeof lng !== 'number' || !deviceId) {
    return res.status(400).json({ ok: false, error: 'Name, branch, mobile number, and location are required.' });
  }
  if (!isValidMobile(mobileDigits)) {
    return res.status(400).json({ ok: false, error: 'Enter a valid 10-digit mobile number.' });
  }

  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  const date = todayStr();
  const timestamp = new Date().toISOString();

  if (!withinWindow(settings)) {
    return res.status(403).json({ ok: false, error: `Attendance is only open between ${settings.start_time} and ${settings.end_time}.` });
  }

  const alreadyByMobile = db.prepare('SELECT 1 FROM attendance WHERE mobile = ? AND date = ?').get(mobileDigits, date);
  if (alreadyByMobile) {
    return res.status(409).json({ ok: false, error: 'This mobile number has already been used to mark attendance today.' });
  }

  const alreadyByDevice = db.prepare('SELECT name FROM attendance WHERE device_id = ? AND date = ?').get(deviceId, date);
  if (alreadyByDevice) {
    return res.status(409).json({ ok: false, error: 'This device has already been used to mark attendance today.' });
  }

  const dist = distanceMeters(lat, lng, settings.venue_lat, settings.venue_lng);
  if (dist > settings.radius_m) {
    return res.status(403).json({
      ok: false,
      error: `You appear to be ${Math.round(dist)}m from the venue. You must be within ${settings.radius_m}m to mark attendance.`,
      distance: Math.round(dist),
    });
  }

  try {
    db.prepare(`INSERT INTO attendance (name, branch, mobile, email, date, timestamp, lat, lng, accuracy, distance_m, device_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, branch, mobileDigits, email || null, date, timestamp, lat, lng, accuracy ?? null, dist, deviceId);
  } catch (e) {
    return res.status(409).json({ ok: false, error: 'Attendance already recorded (duplicate submission).' });
  }

  res.json({ ok: true, message: `Attendance marked for ${name}.`, distance: Math.round(dist) });
});

// ================= ADMIN =================

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Wrong password' });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM settings WHERE id = 1').get());
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { venue_lat, venue_lng, radius_m, start_time, end_time, venue_label } = req.body || {};
  db.prepare(`UPDATE settings SET venue_lat=?, venue_lng=?, radius_m=?, start_time=?, end_time=?, venue_label=? WHERE id=1`)
    .run(venue_lat, venue_lng, radius_m, start_time, end_time, venue_label);
  res.json({ ok: true });
});

app.get('/api/admin/attendance', requireAdmin, (req, res) => {
  const date = req.query.date || todayStr();
  const rows = db.prepare(`
    SELECT name, branch, mobile, email, timestamp, distance_m
    FROM attendance WHERE date = ? ORDER BY timestamp
  `).all(date);
  const branches = [...new Set(rows.map(r => r.branch))].length;
  res.json({ ok: true, date, present: rows, presentCount: rows.length, branchCount: branches });
});

app.get('/api/admin/attendance/export', requireAdmin, (req, res) => {
  const date = req.query.date || todayStr();
  const rows = db.prepare(`
    SELECT name, branch, mobile, email, timestamp, ROUND(distance_m,1) as distance_m
    FROM attendance WHERE date = ? ORDER BY timestamp
  `).all(date);
  let csv = 'name,branch,mobile,email,timestamp,distance_m\n';
  csv += rows.map(r => `"${r.name}","${r.branch}",${r.mobile},"${r.email || ''}",${r.timestamp},${r.distance_m}`).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance_${date}.csv"`);
  res.send(csv);
});

// Do not send an HTML error page to API clients when an unexpected error occurs.
app.use((err, req, res, next) => {
  console.error('Unhandled request error:', err);
  res.status(500).json({ ok: false, error: 'The server could not complete the request. Please try again.' });
});

app.listen(PORT, () => console.log(`Attendance server running on http://localhost:${PORT}`));
