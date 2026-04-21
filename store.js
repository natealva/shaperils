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
        phone TEXT,
        active BOOLEAN DEFAULT true,
        subscribed BOOLEAN DEFAULT false,
        silenced_until TEXT,
        test_mode BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Migrations: keep existing deployments in sync with the new schema
    // (1) phone is now optional (nullable)
    await client.query(`ALTER TABLE users ALTER COLUMN phone DROP NOT NULL`).catch(() => {});
    // (2) default subscribed state is now OFF (explicit opt-in required)
    await client.query(`ALTER TABLE users ALTER COLUMN subscribed SET DEFAULT false`).catch(() => {});
    // (3) one-time: reset every existing user to un-subscribed so SMS is off by default
    //     for the entire user base. Gated by a flag row so it only runs once.
    const flag = await client.query(`SELECT 1 FROM schema_flags WHERE name='sms_reset_2026_04' LIMIT 1`).catch(() => null);
    if (!flag || flag.rowCount === 0) {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_flags (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
      await client.query(`UPDATE users SET subscribed=false`).catch(() => {});
      await client.query(`INSERT INTO schema_flags (name) VALUES ('sms_reset_2026_04') ON CONFLICT DO NOTHING`).catch(() => {});
    }
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
    // Add drinks column if it doesn't exist
    await client.query(`
      ALTER TABLE checkins ADD COLUMN IF NOT EXISTS drinks INTEGER
    `).catch(() => {}); // ignore if already exists
    // App settings table (key-value store for admin toggles)
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Cheers reactions on photos
    await client.query(`
      CREATE TABLE IF NOT EXISTS cheers (
        id TEXT PRIMARY KEY,
        checkin_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(checkin_id, user_id)
      )
    `);
    // Cheers reactions on activity feed messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS message_cheers (
        id TEXT PRIMARY KEY,
        message_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(message_id, user_id)
      )
    `);
    // Daily Question of the Day (conversation starter shown on check-in page)
    await client.query(`
      CREATE TABLE IF NOT EXISTS questions_of_the_day (
        date TEXT PRIMARY KEY,
        question_text TEXT NOT NULL,
        is_manual BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
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
  // Walk weekdays backwards from today. Today gets the benefit of the
  // doubt: if it's still in progress and the user hasn't checked in yet,
  // we skip it instead of breaking the streak. Any prior unchecked
  // weekday is still treated as a hard miss.
  let streak = 0;
  const relevantDays = weekdays.filter(d => d <= today).reverse();
  for (const day of relevantDays) {
    if (checkedDates.has(day)) {
      streak++;
    } else if (day === today) {
      continue;
    } else {
      break;
    }
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

async function createUser(name, phone, smsConsent = false, testMode = false) {
  const normalizedPhone = phone ? normalizePhone(phone) : null;

  // If a phone was provided, check whether this person already has an account
  if (normalizedPhone) {
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
      // Honor an explicit SMS opt-in on re-login (never auto-subscribe without consent)
      if (smsConsent && !user.subscribed) {
        await pool.query('UPDATE users SET subscribed=true, silenced_until=null WHERE id=$1', [user.id]);
        user.subscribed = true;
        user.silenced_until = null;
      }
      user.active = true;
      return user;
    }
  }

  // SMS only enabled if the user both opted in AND provided a phone
  const initialSubscribed = !!(smsConsent && normalizedPhone);
  const id = 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const token = generateToken();
  const r = await pool.query(
    `INSERT INTO users (id,token,name,phone,active,subscribed,silenced_until,test_mode)
     VALUES ($1,$2,$3,$4,true,$5,null,$6) RETURNING *`,
    [id, token, name.trim(), normalizedPhone, initialSubscribed, !!testMode]
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
  // Check how many check-ins today (max 2)
  const existing = await pool.query(
    'SELECT * FROM checkins WHERE user_id=$1 AND date=$2 AND test_mode=$3 ORDER BY created_at',
    [userId, dateStr, !!testMode]
  );
  if (existing.rows.length >= 2) {
    return { max_reached: true, checkin: existing.rows[0] };
  }
  const isSecond = existing.rows.length === 1;
  const id = 'checkin_' + Date.now();
  const r = await pool.query(
    `INSERT INTO checkins (id,user_id,user_name,date,selfie,test_mode)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, userId, userName, dateStr, selfieFilename, !!testMode]
  );
  return { duplicate: false, second_checkin: isSecond, checkin: r.rows[0] };
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

// Update a checkin's selfie value (used for photo recovery)
async function updateCheckinDrinks(checkinId, drinks, testMode = false) {
  await pool.query(
    'UPDATE checkins SET drinks=$1 WHERE id=$2 AND test_mode=$3',
    [drinks, checkinId, !!testMode]
  );
}

async function updateCheckinSelfie(checkinId, newSelfieValue, testMode = false) {
  await pool.query(
    'UPDATE checkins SET selfie=$1 WHERE id=$2 AND test_mode=$3',
    [newSelfieValue, checkinId, !!testMode]
  );
}

// Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂ Album Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
async function getAllPhotos(testMode = false) {
  const r = await pool.query(
    'SELECT * FROM checkins WHERE selfie IS NOT NULL AND test_mode=$1 ORDER BY date DESC',
    [!!testMode]
  );
  return r.rows.map(c => ({
    id: c.id, user_id: c.user_id, user_name: c.user_name,
    date: c.date, selfie: c.selfie, drinks: c.drinks, created_at: c.created_at,
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
  // Use Eastern Time for "today" — matches how check-in dates are recorded
  const now = new Date();
  const etStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const today = etStr; // format: YYYY-MM-DD

  return users.map(u => {
    const userCheckins = checkins.filter(c => c.user_id === u.id);
    const userVouches = vouches.filter(v => v.requester_id === u.id);
    const checkedDates = new Set([
      ...userCheckins.map(c => c.date),
      ...userVouches.map(v => v.date),
    ]);
    const weekdaysHit = allWeekdays.filter(d => checkedDates.has(d));
    // Only count missed days in APRIL (not March), and give today the
    // benefit of the doubt — only mark a day as missed once it has fully
    // passed, so the streak doesn't break mid-day.
    const weekdaysMissed = aprilWeekdays.filter(d => d < today && !checkedDates.has(d));

    // Sum drinks from check-ins
    const totalDrinks = userCheckins.reduce((sum, c) => sum + (c.drinks || 0), 0);

    return {
      id: u.id, name: u.name,
      total_checkins: checkedDates.size,
      weekdays_hit: weekdaysHit.length,
      weekdays_missed: weekdaysMissed.length,
      streak: calculateStreak(allWeekdays, checkedDates, today),
      checked_dates: Array.from(checkedDates),
      total_drinks: totalDrinks,
    };
  }).sort((a, b) => {
    // Primary: weekdays checked in (desc) — weekend bonus check-ins don't affect ranking
    if (b.weekdays_hit !== a.weekdays_hit) return b.weekdays_hit - a.weekdays_hit;
    // Tiebreak 1: total cumulative drinks (desc)
    if (b.total_drinks !== a.total_drinks) return b.total_drinks - a.total_drinks;
    // Tiebreak 2: alphabetical by name (asc)
    return a.name.localeCompare(b.name);
  });
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
  if (typeof updates.subscribed === 'boolean') {
    // Admin-forced SMS toggle. When turning ON, also clear any silence window
    // so the user actually receives texts. When turning OFF, leave silence
    // state alone — subscribed=false is sufficient to block sends.
    if (updates.subscribed) {
      await pool.query(
        'UPDATE users SET subscribed=true, silenced_until=null WHERE id=$1',
        [userId]
      );
    } else {
      await pool.query(
        'UPDATE users SET subscribed=false WHERE id=$1',
        [userId]
      );
    }
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

async function adminDeleteMessage(messageId, testMode = false) {
  const r = await pool.query('DELETE FROM messages WHERE id=$1 AND test_mode=$2', [messageId, !!testMode]);
  return { success: r.rowCount > 0 };
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

// ─── App Settings ──────────────────────────────────────────
async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key=$1', [key]);
  return rows.length ? rows[0].value : null;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
    [key, value]
  );
}

async function getAllSettings() {
  const { rows } = await pool.query('SELECT key, value FROM app_settings');
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  return settings;
}

// ─── Cheers ──────────────────────────────────────────
async function toggleCheers(checkinId, userId, userName) {
  // Check if already cheered
  const existing = await pool.query(
    'SELECT * FROM cheers WHERE checkin_id=$1 AND user_id=$2',
    [checkinId, userId]
  );
  if (existing.rows.length > 0) {
    // Remove cheers
    await pool.query('DELETE FROM cheers WHERE checkin_id=$1 AND user_id=$2', [checkinId, userId]);
    return { cheered: false };
  }
  // Add cheers
  const id = 'cheers_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  await pool.query(
    'INSERT INTO cheers (id, checkin_id, user_id, user_name) VALUES ($1,$2,$3,$4)',
    [id, checkinId, userId, userName]
  );
  return { cheered: true };
}

async function getCheersForCheckins(checkinIds) {
  if (!checkinIds.length) return {};
  const r = await pool.query(
    'SELECT checkin_id, user_id, user_name FROM cheers WHERE checkin_id = ANY($1)',
    [checkinIds]
  );
  const map = {};
  for (const row of r.rows) {
    if (!map[row.checkin_id]) map[row.checkin_id] = [];
    map[row.checkin_id].push({ user_id: row.user_id, user_name: row.user_name });
  }
  return map;
}

// ─── Message (feed) cheers ─────────────────────────────
async function toggleMessageCheers(messageId, userId, userName) {
  const mid = parseInt(messageId, 10);
  if (isNaN(mid)) return { cheered: false };
  const existing = await pool.query(
    'SELECT * FROM message_cheers WHERE message_id=$1 AND user_id=$2',
    [mid, userId]
  );
  if (existing.rows.length > 0) {
    await pool.query('DELETE FROM message_cheers WHERE message_id=$1 AND user_id=$2', [mid, userId]);
    return { cheered: false };
  }
  const id = 'mcheers_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  await pool.query(
    'INSERT INTO message_cheers (id, message_id, user_id, user_name) VALUES ($1,$2,$3,$4)',
    [id, mid, userId, userName]
  );
  return { cheered: true };
}

async function getMessageCheers(messageId) {
  const mid = parseInt(messageId, 10);
  if (isNaN(mid)) return [];
  const r = await pool.query(
    'SELECT user_id, user_name FROM message_cheers WHERE message_id=$1 ORDER BY created_at ASC',
    [mid]
  );
  return r.rows;
}

async function getCheersForMessages(messageIds) {
  if (!messageIds.length) return {};
  const ids = messageIds.map(id => parseInt(id, 10)).filter(n => !isNaN(n));
  if (!ids.length) return {};
  const r = await pool.query(
    'SELECT message_id, user_id, user_name FROM message_cheers WHERE message_id = ANY($1)',
    [ids]
  );
  const map = {};
  for (const row of r.rows) {
    if (!map[row.message_id]) map[row.message_id] = [];
    map[row.message_id].push({ user_id: row.user_id, user_name: row.user_name });
  }
  return map;
}

// ─── Question of the Day ──────────────────────────────
async function getQotD(date) {
  const r = await pool.query('SELECT * FROM questions_of_the_day WHERE date=$1', [date]);
  return r.rows[0] || null;
}

async function upsertQotD(date, text, isManual) {
  const r = await pool.query(
    `INSERT INTO questions_of_the_day (date, question_text, is_manual)
     VALUES ($1, $2, $3)
     ON CONFLICT (date) DO UPDATE
       SET question_text = EXCLUDED.question_text,
           is_manual = EXCLUDED.is_manual,
           updated_at = NOW()
     RETURNING *`,
    [date, text, !!isManual]
  );
  return r.rows[0];
}

async function getRecentQotDs(limit = 30) {
  const r = await pool.query(
    'SELECT date, question_text FROM questions_of_the_day ORDER BY date DESC LIMIT $1',
    [limit]
  );
  return r.rows;
}

module.exports = {
  getUser, getUserByToken, getAllUsers, createUser, updateUserSubscription,
  getSubscribedUsers, addCheckin, getCheckinsForUser, getCheckinsForDate,
  getAllCheckins, getAllPhotos, createVouchRequest, getPendingVouchRequests,
  getAllVouches, approveVouch, getLeaderboard, logMessage, getRecentMessages,
  silenceUser, unsilenceUser, normalizePhone, getMarchWeekdays, getAprilWeekdays,
  deleteCheckin, updateCheckinSelfie, updateCheckinDrinks, adminDeleteCheckin, adminDeleteUser, adminUpdateUser, adminGetAllUsers,
  adminDeleteMessage, adminClearMessages, adminEraseUser,
  getSetting, setSetting, getAllSettings,
  toggleCheers, getCheersForCheckins,
  toggleMessageCheers, getMessageCheers, getCheersForMessages,
  getQotD, upsertQotD, getRecentQotDs,
  SELFIES_DIR, TEST_SELFIES_DIR, initDb
};
