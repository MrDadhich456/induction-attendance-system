const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const DATABASE_URL = process.env.DATABASE_URL;

if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD must be set when running in production.');
}
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL must be set to a PostgreSQL connection URL.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function withinWindow(settings) {
  const hhmm = new Date().toTimeString().slice(0, 5);
  return hhmm >= settings.start_time && hhmm <= settings.end_time;
}

function normalizeMobile(mobile) {
  return String(mobile || '').replace(/\D/g, '');
}

function isValidMobile(mobile) {
  return /^\d{10}$/.test(normalizeMobile(mobile));
}

async function settings() {
  return (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
}

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      venue_lat DOUBLE PRECISION,
      venue_lng DOUBLE PRECISION,
      radius_m DOUBLE PRECISION DEFAULT 100,
      start_time TEXT DEFAULT '00:00',
      end_time TEXT DEFAULT '23:59',
      venue_label TEXT DEFAULT 'Induction Venue'
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      branch TEXT NOT NULL,
      mobile TEXT NOT NULL,
      email TEXT,
      date TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,
      distance_m DOUBLE PRECISION,
      device_id TEXT NOT NULL,
      UNIQUE(mobile, date),
      UNIQUE(device_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
  `);
  await pool.query(`INSERT INTO settings (id, venue_lat, venue_lng, radius_m, start_time, end_time, venue_label)
    VALUES (1, 26.4499, 74.6399, 100, '00:00', '23:59', 'Induction Venue')
    ON CONFLICT (id) DO NOTHING`);
}

app.get('/api/status', async (req, res, next) => {
  try {
    const { deviceId, mobile } = req.query;
    const date = todayStr();
    const venue = await settings();
    const deviceMarked = deviceId
      ? (await pool.query('SELECT 1 FROM attendance WHERE device_id = $1 AND date = $2', [deviceId, date])).rowCount > 0
      : false;
    const mobileMarked = mobile
      ? (await pool.query('SELECT 1 FROM attendance WHERE mobile = $1 AND date = $2', [normalizeMobile(mobile), date])).rowCount > 0
      : false;
    res.json({
      ok: true, date,
      venue: { lat: venue.venue_lat, lng: venue.venue_lng, radius: venue.radius_m, label: venue.venue_label },
      window: { start: venue.start_time, end: venue.end_time, open: withinWindow(venue) },
      deviceAlreadyMarked: deviceMarked,
      mobileAlreadyMarked: mobileMarked,
    });
  } catch (error) { next(error); }
});

app.post('/api/attendance/mark', async (req, res, next) => {
  try {
    let { name, branch, mobile, email, lat, lng, accuracy, deviceId } = req.body || {};
    name = typeof name === 'string' ? name.trim() : '';
    branch = typeof branch === 'string' ? branch.trim() : '';
    email = typeof email === 'string' ? email.trim() : '';
    const mobileDigits = normalizeMobile(mobile);

    if (!name || !branch || !mobileDigits || !Number.isFinite(lat) || !Number.isFinite(lng) || !deviceId) {
      return res.status(400).json({ ok: false, error: 'Name, branch, mobile number, and location are required.' });
    }
    if (!isValidMobile(mobileDigits)) {
      return res.status(400).json({ ok: false, error: 'Enter a valid 10-digit mobile number.' });
    }

    const venue = await settings();
    const date = todayStr();
    if (!withinWindow(venue)) {
      return res.status(403).json({ ok: false, error: `Attendance is only open between ${venue.start_time} and ${venue.end_time}.` });
    }
    const distance = distanceMeters(lat, lng, venue.venue_lat, venue.venue_lng);
    if (distance > venue.radius_m) {
      return res.status(403).json({ ok: false, error: `You appear to be ${Math.round(distance)}m from the venue. You must be within ${venue.radius_m}m to mark attendance.`, distance: Math.round(distance) });
    }

    try {
      await pool.query(`INSERT INTO attendance
        (name, branch, mobile, email, date, timestamp, lat, lng, accuracy, distance_m, device_id)
        VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, $10)`,
      [name, branch, mobileDigits, email || null, date, lat, lng, Number.isFinite(accuracy) ? accuracy : null, distance, deviceId]);
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({ ok: false, error: 'This mobile number or device has already been used to mark attendance today.' });
      }
      throw error;
    }
    res.json({ ok: true, message: `Attendance marked for ${name}.`, distance: Math.round(distance) });
  } catch (error) { next(error); }
});

app.post('/api/admin/login', (req, res) => {
  if (req.body?.password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Wrong password' });
});

app.get('/api/admin/settings', requireAdmin, async (req, res, next) => {
  try { res.json(await settings()); } catch (error) { next(error); }
});

app.post('/api/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    const { venue_lat, venue_lng, radius_m, start_time, end_time, venue_label } = req.body || {};
    if (![venue_lat, venue_lng, radius_m].every(Number.isFinite) || !start_time || !end_time || !venue_label?.trim()) {
      return res.status(400).json({ ok: false, error: 'Enter a venue label, valid coordinates, radius, and time window.' });
    }
    await pool.query(`UPDATE settings SET venue_lat = $1, venue_lng = $2, radius_m = $3,
      start_time = $4, end_time = $5, venue_label = $6 WHERE id = 1`,
    [venue_lat, venue_lng, radius_m, start_time, end_time, venue_label.trim()]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/admin/attendance', requireAdmin, async (req, res, next) => {
  try {
    const date = req.query.date || todayStr();
    const rows = (await pool.query(`SELECT name, branch, mobile, email, timestamp, distance_m
      FROM attendance WHERE date = $1 ORDER BY timestamp`, [date])).rows;
    res.json({ ok: true, date, present: rows, presentCount: rows.length, branchCount: new Set(rows.map((row) => row.branch)).size });
  } catch (error) { next(error); }
});

app.get('/api/admin/attendance/export', requireAdmin, async (req, res, next) => {
  try {
    const date = req.query.date || todayStr();
    const rows = (await pool.query(`SELECT name, branch, mobile, email, timestamp, ROUND(distance_m::numeric, 1) AS distance_m
      FROM attendance WHERE date = $1 ORDER BY timestamp`, [date])).rows;
    const value = (item) => `"${String(item ?? '').replace(/"/g, '""')}"`;
    const csv = ['name,branch,mobile,email,timestamp,distance_m', ...rows.map((row) =>
      [row.name, row.branch, row.mobile, row.email, row.timestamp.toISOString(), row.distance_m].map(value).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${date}.csv"`);
    res.send(csv);
  } catch (error) { next(error); }
});

app.use((error, req, res, next) => {
  console.error('Unhandled request error:', error);
  res.status(500).json({ ok: false, error: 'The server could not complete the request. Please try again.' });
});

initializeDatabase()
  .then(() => app.listen(PORT, () => console.log(`Attendance server running on http://localhost:${PORT}`)))
  .catch((error) => {
    console.error('Database startup failed:', error);
    process.exit(1);
  });
