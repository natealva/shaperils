const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const SELFIES_DIR = path.join(__dirname, 'uploads');
const TEST_SELFIES_DIR = path.join(__dirname, 'uploads_test');

if (!fs.existsSync(SELFIES_DIR)) fs.mkdirSync(SELFIES_DIR, { recursive: true });
if (!fs.existsSync(TEST_SELFIES_DIR)) fs.mkdirSync(TEST_SELFIES_DIR, { recursive: true });

// Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂ Database init Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        active BOOLEAN DEFAULT true,
        subscribed BOOLEAN DEFAULT true,
        silenced_until TEXT,
        test_mode BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS checkins (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        date TEXT NOT NULL,
        selfie TEXT,
        test_mode BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS vouches (
        id TEXT PRIMARY KEY,
        requester_id TEXT NOT NULL,
        requester_name TEXT NOT NULL,
        date TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        voucher_id TEXT,
        voucher_name TEXT,
        test_mode BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        approved_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_name TEXT NOT NULL,
        message_type TEXT NOT NULL,
        message_text TEXT NOT NULL,
        recipients_count INTEGER DEFAULT 0,
        test_mode BOOLEAN DEFAULT false,
        sent_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('Database tables initialized');
  } finally {
    client.release();
  }
}

// Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂ Helpers (sync) Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
function normalizePhone(phone) {
  let cleaned = phone.replace(/[^0-9+]/g, '');
  if (!cleaned.startsWith('+')) {
    if (cleaned.startsWith('1') && cleaned.length === 11) {
      cleaned = '+' + cleaned;
    } else if (cleaned.length === 10) {
      cleaned = '+1' + cleaned;
    }
  }
  return cleaned;
}

function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

function getMarchWeekdays() {
  const days = [];
  for (let d = 1; d <= 31; d++) {
    const date = new Date(2026, 2, d);
    const day = date.getDay();
    if (day >= 1 && day <= 5) {
      days.push(`2026-03-${String(d).padStart(2, '0')}`);
    }
  }
  return days;
}

function getAprilWeekdays() {
  const days = [];
  for (let d = 1; d <= 30; d++) {
    const date = new Date(2026, 3, d);
    const day = date.getDay();
    if (day >= 1 && day <= 5) {
      days.push(`2026-04-${String(d).padStart(2, '0')}`);
    }
  }
  return days;
}

function calculateStreak(weekdays, checkedDates, today) {
  let streak = 0;
  const relevantDays = weekdays.filter(d => d <= today).reverse();
  for (const day of relevantDays) {
    if (checkedDates.has(day)) streak++;
    else break;
  }
  return streak;
}

// Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂ Users Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
async function getUser(userId, testMode = false) {
  const r = await pool.query('SELECT * FROM users WHERE id=$1 AND test_mode=$2', [userId, !!testMode]);
  return r.rows[0] || null;
}

async function getUserByToken(token, testMode = false) {
  const r = await pool.query('SELECT * FROM users WHERE token=$1 AND test_mode=$2', [token, !!testMode]);
  return r.rows[0] || null;
}

async function getAllUsers(testMode = false) {
  const r = await pool.query('SELECT * FROM users WHERE active=true AND test_mode=$1', [!!testMode]);
  return r.rows;
}

async function createUser(name, phone, testMode = false) {
  const normalizedPhone = normalizePhone(phone);
  // Check if phone already exists
  const existing = await pool.query(
    'SELECT * FROM users WHERE phone=$1 AND test_mode=$2',
    [normalizedPhone, !!testMode]
  );
  if (existing.rows.length > 0) {
    const user = existing.rows[0];
    if (user.name !== name.trim()) {
      await pool.query('UPDATE users SET name=$1, active=true WHERE id=$2', [name.trim(), user.id]);
      user.name = name.trim();
    }
    user.active = true;
    return user;
  }
  const id = 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const token = generateToken();
  const r = await pool.query(
    `INSERT INTO users (id,token,name,phone,active,subscribed,silenced_until,test_mode)
     VALUES ($1,$2,$3,$4,true,true,null,$5) RETURNING *`,
    [id, token, name.trim(), normalizedPhone, !!testMode]
  );
  return r.rows[0];
}

async function updateUserSubscription(userId, subscribed, testMode = false) {
  await pool.query('UPDATE users SET subscribed=$1 WHERE id=$2 AND test_mode=$3',
    [subscribed, userId, !!testMode]);
}

async function getSubscribedUsers(testMode = false) {
  const now = new Date().toISOString();
  // Get active, subscribed users who are not silenced
  const r = await pool.query(
    `SELECT * FROM users WHERE active=true AND subscribed=true AND test_mode=$1
     AND (silenced_until IS NULL OR silenced_until <= $2)
     AND (silenced_until IS NULL OR silenced_until != 'forever')`,
    [!!testMode, now]
  );
  return r.rows;
}

// Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂ Silence Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
async function silenceUser(userId, duration, testMode = false) {
  let silencedUntil;
  if (duration === 'forever') {
    silencedUntil = 'forever';
  } else if (duration === 'day') {
    silencedUntil = new Date(Date.now() + 86400000).toISOString();
  } else if (duration === 'week') {
    silencedUntil = new Date(Date.now() + 7 * 86400000).toISOString();
  }
  await pool.query(
    'UPDATE users SET silenced_until=$1, subscribed=false WHERE id=$2 AND test_mode=$3',
    [silencedUntil, userId, !!testMode]
  );
  return { success: true, silenced_until: silencedUntil };
}

async function unsilenceUser(userId, testMode = false) {
  await pool.query(
    'UPDATE users SET silenced_until=null, subscribed=true WHERE id=$1 AND test_mode=$2',
    [userId, !!testMode]
  );
  return { success: true };
}

// Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂ Check-ins Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
async function addCheckin(userId, userName, dateStr, selfieFilename, testMode = false) {
  // Check for duplicate
  const dup = await pool.query(
    'SELECT * FROM checkins WHERE user_id=$1 AND date=$2 AND test_mode=$3',
    [userId, dateStr, !!testMode]
  );
  if (dup.rows.length > 0) {
    return { duplicate: true, checkin: dup.rows[0] };
  }
  const id = 'checkin_' + Date.now();
  const r = await pool.query(
    `INSERT INTO checkins (id,user_id,user_name,date,selfie,test_mode)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, userId, userName, dateStr, selfieFilename, !!testMode]
  );
  return { duplicate: false, checkin: r.rows[0] };
}

async function getCheckinsForUser(userId, testMode = false) {
  const r = await pool.query(
    'SELECT * FROM checkins WHERE user_id=$1 AND test_mode=$2 ORDER BY date',
    [userId, !!testMode]
  );
  return r.rows;
}

async function getCheckinsForDate(dateStr, testMode = false) {
  const r = await pool.query(
    'SELECT * FROM checkins WHERE date=$1 AND test_mode=$2',
    [dateStr, !!testMode]
  );
  return r.rows;
}

async function getAllCheckins(testMode = false) {
  const r = await pool.query(
    'SELECT * FROM checkins WHERE test_mode=$1 ORDER BY date',
    [!!testMode]
  );
  return r.rows;
}

async function deleteCheckin(checkinId, userId, testMode = false) {
  const r = await pool.query(
    'DELETE FROM checkins WHERE id=$1 AND user_id=$2 AND test_mode=$3 RETURNING *',
    [checkinId, userId, !!testMode]
  );
  if (r.rows.length === 0) return { error: 'Not found or not yours' };
  const checkin = r.rows[0];
  if (checkin.selfie && !checkin.selfie.startsWith('http')) {
    // Only delete local files, not Cloudinary URLs
    const dir = testMode ? TEST_SELFIES_DIR : SELFIES_DIR;
    try { fs.unlinkSync(path.join(dir, checkin.selfie)); } catch(e) {}
  }
  // Note: Cloudinary images are not deleted here to keep it simple.
  // They can be cleaned up manually via the Cloudinary dashboard.
  return { success: true, date: checkin.date };
}

// Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂ Album Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
async function getAllPhotos(testMode = false) {
  const r = await pool.query(
    'SELECT * FROM checkins WHERE selfie IS NOT NULL AND test_mode=$1 ORDER BY date DESC',
    [!!testMode]
  );
  return r.rows.map(c => ({
    id: c.id, user_id: c.user_id, user_name: c.user_name,
    date: c.date, selfie: c.selfie, created_at: c.created_at,
  }));
}

// Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂ Vouches Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
async function createVouchRequest(requesterId, requesterName, dateStr, testMode = false) {
  // Check duplicate
  const dup = await pool.query(
    'SELECT * FROM vouches WHERE requester_id=$1 AND date=$2 AND test_mode=$3',
    [requesterId, dateStr, !!testMode]
  );
  if (dup.rows.length > 0) return { duplicate: true, vouch: dup.rows[0] };

  // Check if already checked in
  const ci = await pool.query(
    'SELECT * FROM checkins WHERE user_id=$1 AND date=$2 AND test_mode=$3',
    [requesterId, dateStr, !!testMode]
  );
  if (ci.rows.length > 0) return { already_checked_in: true };

  const id = 'vouch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const r = await pool.query(
    `INSERT INTO vouches (id,requester_id,requester_name,date,status,test_mode)
     VALUES ($1,$2,$3,$4,'pending',$5) RETURNING *`,
    [id, requesterId, requesterName, dateStr, !!testMode]
  );
  return { success: true, vouch: r.rows[0] };
}

async function getPendingVouchRequests(excludeUserId, testMode = false) {
  const r = await pool.query(
    `SELECT * FROM vouches WHERE status='pending' AND requester_id!=$1 AND test_mode=$2`,
    [excludeUserId, !!testMode]
  );
  return r.rows;
}

async function getAllVouches(testMode = false) {
  const r = await pool.query('SELECT * FROM vouches WHERE test_mode=$1', [!!testMode]);
  return r.rows;
}

async function approveVouch(vouchId, voucherId, voucherName, testMode = false) {
  const v = await pool.query('SELECT * FROM vouches WHERE id=$1 AND test_mode=$2', [vouchId, !!testMode]);
  if (v.rows.length === 0) return { error: 'Vouch not found' };
  const vouch = v.rows[0];
  if (vouch.status === 'approved') return { error: 'Already approved' };
  if (vouch.requester_id === voucherId) return { error: 'You cannot vouch for yourself' };

  const r = await pool.query(
    `UPDATE vouches SET status='approved', voucher_id=$1, voucher_name=$2, approved_at=NOW()
     WHERE id=$3 RETURNING *`,
    [voucherId, voucherName, vouchId]
  );
  return { success: true, vouch: r.rows[0] };
}

// Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂ Leaderboard Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
async function getLeaderboard(testMode = false) {
  const users = await getAllUsers(testMode);
  const checkins = await getAllCheckins(testMode);
  const vouches = (await getAllVouches(testMode)).filter(v => v.status === 'approved');

  const allWeekdays = [...getMarchWeekdays(), ...getAprilWeekdays()];
  const aprilWeekdays = getAprilWeekdays();
  const today = new Date().toISOString().split('T')[0];

  return users.map(u => {
    const userCheckins = checkins.filter(c => c.user_id === u.id);
    const userVouches = vouches.filter(v => v.requester_id === u.id);
    const checkedDates = new Set([
      ...userCheckins.map(c => c.date),
      ...userVouches.map(v => v.date),
    ]);
    const weekdaysHit = allWeekdays.filter(d => checkedDates.has(d));
    // Only count missed days in APRIL (not March)
    const weekdaysMissed = aprilWeekdays.filter(d => d <= today && !checkedDates.has(d));

    return {
      id: u.id, name: u.name,
      total_checkins: checkedDates.size,
      weekdays_hit: weekdaysHit.length,
      weekdays_missed: weekdaysMissed.length,
      streak: calculateStreak(allWeekdays, checkedDates, today),
      checked_dates: Array.from(checkedDates),
    };
  }).sort((a, b) => b.total_checkins - a.total_checkins);
}

// Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂ Messages Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
async function logMessage(senderName, messageType, messageText, recipientsCount, testMode = false) {
  await pool.query(
    `INSERT INTO messages (sender_name,message_type,message_text,recipients_count,test_mode)
     VALUES ($1,$2,$3,$4,$5)`,
    [senderName, messageType, messageText, recipientsCount, !!testMode]
  );
}

async function getRecentMessages(testMode = false) {
  const r = await pool.query(
    'SELECT * FROM messages WHERE test_mode=$1 ORDER BY sent_at DESC LIMIT 20',
    [!!testMode]
  );
  return r.rows;
}

// Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂ Admin Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
async function adminGetAllUsers(testMode = false) {
  const r = await pool.query('SELECT * FROM users WHERE test_mode=$1', [!!testMode]);
  return r.rows;
}

async function adminUpdateUser(userId, updates, testMode = false) {
  const user = await getUser(userId, testMode);
  if (!user) return { error: 'Not found' };
  if (updates.name) {
    await pool.query('UPDATE users SET name=$1 WHERE id=$2', [updates.name, userId]);
  }
  if (updates.phone) {
    await pool.query('UPDATE users SET phone=$1 WHERE id=$2', [normalizePhone(updates.phone), userId]);
  }
  if (typeof updates.active === 'boolean') {
    await pool.query('UPDATE users SET active=$1 WHERE id=$2', [updates.active, userId]);
  }
  return { success: true, user: await getUser(userId, testMode) };
}

async function adminDeleteUser(userId, testMode = false) {
  const user = await getUser(userId, testMode);
  if (!user) return { error: 'Not found' };
  await pool.query('UPDATE users SET active=false WHERE id=$1', [userId]);
  return { success: true };
}

async function adminDeleteCheckin(checkinId, testMode = false) {
  const r = await pool.query(
    'DELETE FROM checkins WHERE id=$1 AND test_mode=$2 RETURNING *',
    [checkinId, !!testMode]
  );
  if (r.rows.length === 0) return { error: 'Not found' };
  const checkin = r.rows[0];
  if (checkin.selfie && !checkin.selfie.startsWith('http')) {
    const dir = testMode ? TEST_SELFIES_DIR : SELFIES_DIR;
    try { fs.unlinkSync(path.join(dir, checkin.selfie)); } catch(e) {}
  }
  return { success: true };
}

async function adminClearMessages(testMode = false) {
  const r = await pool.query('DELETE FROM messages WHERE test_mode=$1', [!!testMode]);
  return { success: true, deleted: r.rowCount };
}

async function adminEraseUser(userId, testMode = false) {
  const user = await getUser(userId, testMode);
  if (!user) return { error: 'User not found' };

  // Delete all their checkins
  const checkins = await pool.query(
    'DELETE FROM checkins WHERE user_id=$1 AND test_mode=$2 RETURNING *',
    [userId, !!testMode]
  );
  // Clean up local selfie files (Cloudinary ones are left alone)
  for (const c of checkins.rows) {
    if (c.selfie && !c.selfie.startsWith('http')) {
      const dir = testMode ? TEST_SELFIES_DIR : SELFIES_DIR;
      try { fs.unlinkSync(path.join(dir, c.selfie)); } catch(e) {}
    }
  }

  // Delete all their vouch requests
  await pool.query('DELETE FROM vouches WHERE requester_id=$1 AND test_mode=$2', [userId, !!testMode]);

  // Delete the user record entirely
  await pool.query('DELETE FROM users WHERE id=$1 AND test_mode=$2', [userId, !!testMode]);

  return {
    success: true,
    erased: user.name,
    checkinsDeleted: checkins.rowCount
  };
}

module.exports = {
  getUser, getUserByToken, getAllUsers, createUser, updateUserSubscription,
  getSubscribedUsers, addCheckin, getCheckinsForUser, getCheckinsForDate,
  getAllCheckins, getAllPhotos, createVouchRequest, getPendingVouchRequests,
  getAllVouches, approveVouch, getLeaderboard, logMessage, getRecentMessages,
  silenceUser, unsilenceUser, normalizePhone, getMarchWeekdays, getAprilWeekdays,
  deleteCheckin, adminDeleteCheckin, adminDeleteUser, adminUpdateUser, adminGetAllUsers,
  adminClearMessages, adminEraseUser,
  SELFIES_DIR, TEST_SELFIES_DIR, initDb
};
