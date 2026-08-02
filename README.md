# Induction Attendance System

Geofenced, device-limited attendance for a student induction program. No pre-loaded student list required — students enter their own details.

## What it does
- Students open a link/QR, fill in **name, branch, mobile number** (email optional), tap Check In.
- Browser geolocation is checked server-side against a venue radius (Haversine distance).
- One check-in per **mobile number** per day, AND one check-in per **device** per day (blocks phone-passing and re-submits).
- Admin dashboard: set venue lat/lng + radius + time window, view/export today's check-ins.

## Run it
```
npm install
npm start
```
Then open:
- `http://localhost:3000/` — student check-in page
- `http://localhost:3000/admin.html` — admin dashboard (default password: `changeme123`)

Do not open `public/index.html` with Live Server or another static-server extension. The
attendance form needs the Express API, so it must be served by `npm start`.

**Before real use:** set a real admin password via env var:
```
ADMIN_PASSWORD=your-strong-password node server.js
```

## Deploying publicly

This is an Express application, not a static site. Deploy it as a Node web
service and set these environment variables on the host:

```
NODE_ENV=production
ADMIN_PASSWORD=a-long-unique-password
DATA_DIR=/path/to/a-persistent-disk
```

`DATA_DIR` is where the SQLite attendance database is stored. It **must** be a
persistent disk/volume in production, otherwise records can disappear when the
host restarts or deploys the service.

## First-time setup
1. Go to `/admin.html`, log in.
2. Under "Venue & geofence": either type your venue's lat/lng, or stand at the venue and tap "Use my location". Set radius (start with 100–150m — GPS indoors is often 20–50m off, so don't set it too tight). Set the check-in time window.
3. Generate a QR code for `https://your-domain/` (any free QR generator) and display/print it at the venue.
4. Students fill the form themselves — no pre-registration needed.

## Why mobile number instead of roll number
Since there's no student list to validate against yet, the mobile number is the field students are least likely to have duplicates of, so it's used as the daily "already checked in" key. A student can still type a different number to bypass this (same trade-off as any self-reported field) — if that becomes a problem later, switching to roll-number verification against a real list is a small change to `server.js` (the `mobile` uniqueness check is isolated in one place).

## Known limitations (by design trade-off, not oversight)
- **GPS spoofing**: a determined student with a fake-GPS app can bypass the location check. There's no way to fully prevent this from a browser. If this matters for your event, add a manual review step (e.g. spot-check the distance column).
- **Device check is a deterrent, not a lock**: it's based on a random ID stored in localStorage. Clearing browser data or incognito mode resets it. Combined with the per-mobile-number check, this still stops the common case (one phone checking in a group of friends).
- **Self-reported data**: since there's no master list yet, name/branch/mobile are exactly what the student types — no spelling validation. Once you have an official student list, you can tighten this (see above).
- Dates are computed on the server's local clock — fine for a single-venue event; if you deploy across timezones, switch to a fixed timezone in `todayStr()`.

## Files
- `server.js` — Express + SQLite backend (all validation logic lives here)
- `public/index.html` — student check-in page (name, branch, mobile, email)
- `public/admin.html` — admin dashboard
- `attendance.db` — SQLite DB, created automatically on first run
