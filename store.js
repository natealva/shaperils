const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');
const SELFIES_DIR = path.join(__dirname, 'uploads');
const TEST_DB_PATH = path.join(__dirname, 'data_test.json');
const TEST_SELFIES_DIR = path.join(__dirname, 'uploads_test');

// Ensure uploads directory exists
if (!fs.existsSync(SELFIES_DIR)) fs.mkdirSync(SELFIES_DIR, { recursive: true });
if (!fs.existsSync(TEST_SELFIES_DIR)) fs.mkdirSync(TEST_SELFIES_DIR, { recursive: true });

function load(testMode) {
  const dbPath = testMode ? TEST_DB_PATH : DB_PATH;
  try {
    if (fs.existsSync(dbPath)) {
      return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading data:', e.message);
  }
  return { users: [], messages: [], checkins: [], vouches: [] };
}

function save(data, testMode) {
  const dbPath = testMode ? TEST_DB_PATH : DB_PATH;
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

// Ã¢Ã¢Ã¢ Users Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢

function getUser(userId, testMode) {
  const data = load(testMode);
  return data.users.find(u => u.id === userId) || null;
}

function getUserByToken(token, testMode) {
  const data = load(testMode);
  return data.users.find(u => u.token === token) || null;
}

function getAllUsers(testMode) {
  const data = load(testMode);
  return data.users.filter(u => u.active);
}

function createUser(name, phone, testMode) {
  const data = load(testMode);
  // Check if phone already exists Ã¢ remember by phone number
  let normalizedPhone = normalizePhone(phone);
  const existing = data.users.find(u => u.phone === normalizedPhone);
  if (existing) {
    // Update name if they give a different one, keep the same account
    existing.name = name;
    existing.active = true;
    save(data, testMode);
    return existing;
  }
  const token = generateToken();
  const user = {
    id: 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    token,
    name: name.trim(),
    phone: normalizedPhone,
    active: true,
    subscribed: true,
    silenced_until: null,
    created_at: new Date().toISOString(),
  };
  data.users.push(user);
  save(data, testMode);
  return user;
}

function updateUserSubscription(userId, subscribed, testMode) {
  const data = load(testMode);
  const user = data.users.find(u => u.id === userId);
  if (user) {
    user.subscribed = subscribed;
    save(data, testMode);
  }
}

// Ã¢Ã¢Ã¢ Check-ins (selfies) Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢

function addCheckin(userId, userName, dateStr, selfieFilename, testMode) {
  const data = load(testMode);
  // One photo per day per user
  const existing = data.checkins.find(c => c.user_id === userId && c.date === dateStr);
  if (existing) {
    return { duplicate: true, checkin: existing };
  }
  const checkin = {
    id: 'checkin_' + Date.now(),
    user_id: userId,
    user_name: userName,
    date: dateStr,
    selfie: selfieFilename,
    created_at: new Date().toISOString(),
  };
  data.checkins.push(checkin);
  save(data, testMode);
  return { duplicate: false, checkin };
}

function getCheckinsForUser(userId, testMode) {
  const data = load(testMode);
  return data.checkins.filter(c => c.user_id === userId);
}

function getCheckinsForDate(dateStr, testMode) {
  const data = load(testMode);
  return data.checkins.filter(c => c.date === dateStr);
}

function getAllCheckins(testMode) {
  const data = load(testMode);
  return data.checkins || [];
}

// Ã¢Ã¢Ã¢ Album (all photos) Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢

function getAllPhotos(testMode) {
  const data = load(testMode);
  return (data.checkins || []).filter(c => c.selfie).map(c => ({
    id: c.id,
    user_id: c.user_id,
    user_name: c.user_name,
    date: c.date,
    selfie: c.selfie,
    created_at: c.created_at,
  }));
}

// Ã¢Ã¢Ã¢ Vouch System Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢

function createVouchRequest(requesterId, requesterName, dateStr, testMode) {
  const data = load(testMode);
  if (!data.vouches) data.vouches = [];

  // Check if already requested
  const existing = data.vouches.find(v => v.requester_id === requesterId && v.date === dateStr);
  if (existing) {
    return { duplicate: true, vouch: existing };
  }

  // Check if they already checked in that day
  const checkin = data.checkins.find(c => c.user_id === requesterId && c.date === dateStr);
  if (checkin) {
    return { already_checked_in: true };
  }

  const vouch = {
    id: 'vouch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    requester_id: requesterId,
    requester_name: requesterName,
    date: dateStr,
    status: 'pending', // pending, approved
    voucher_id: null,
    voucher_name: null,
    created_at: new Date().toISOString(),
    approved_at: null,
  };
  data.vouches.push(vouch);
  save(data, testMode);
  return { success: true, vouch };
}

function getPendingVouchRequests(excludeUserId, testMode) {
  const data = load(testMode);
  if (!data.vouches) return [];
  // Show pending vouches from OTHER users (you can't vouch for yourself)
  return data.vouches.filter(v => v.status === 'pending' && v.requester_id !== excludeUserId);
}

function getAllVouches(testMode) {
  const data = load(testMode);
  return data.vouches || [];
}

function approveVouch(vouchId, voucherId, voucherName, testMode) {
  const data = load(testMode);
  if (!data.vouches) return { error: 'No vouches found' };

  const vouch = data.vouches.find(v => v.id === vouchId);
  if (!vouch) return { error: 'Vouch not found' };
  if (vouch.status === 'approved') return { error: 'Already approved' };
  if (vouch.requester_id === voucherId) return { error: 'You cannot vouch for yourself' };

  vouch.status = 'approved';
  vouch.voucher_id = voucherId;
  vouch.voucher_name = voucherName;
  vouch.approved_at = new Date().toISOString();
  save(data, testMode);
  return { success: true, vouch };
}

// Ã¢Ã¢Ã¢ Leaderboard Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢

function getLeaderboard(testMode) {
  const data = load(testMode);
  const users = data.users.filter(u => u.active);
  const checkins = data.checkins || [];
  const vouches = (data.vouches || []).filter(v => v.status === 'approved');

  const allWeekdays = [...getMarchWeekdays(), ...getAprilWeekdays()];
  const today = new Date().toISOString().split('T')[0];

  return users.map(u => {
    const userCheckins = checkins.filter(c => c.user_id === u.id);
    const userVouches = vouches.filter(v => v.requester_id === u.id);
    const checkedDates = new Set([
      ...userCheckins.map(c => c.date),
      ...userVouches.map(v => v.date),
    ]);
    const weekdaysHit = allWeekdays.filter(d => checkedDates.has(d));
    const weekdaysMissed = allWeekdays.filter(d => d <= today && !checkedDates.has(d));

    return {
      id: u.id,
      name: u.name,
      total_checkins: checkedDates.size,
      weekdays_hit: weekdaysHit.length,
      weekdays_missed: weekdaysMissed.length,
      streak: calculateStreak(allWeekdays, checkedDates, today),
      checked_dates: Array.from(checkedDates),
    };
  }).sort((a, b) => b.total_checkins - a.total_checkins);
}

// Ã¢Ã¢Ã¢ Messages Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢

function logMessage(senderName, messageType, messageText, recipientsCount, testMode) {
  const data = load(testMode);
  data.messages.unshift({
    id: Date.now(),
    sender_name: senderName,
    message_type: messageType,
    message_text: messageText,
    recipients_count: recipientsCount,
    sent_at: new Date().toISOString(),
  });
  if (data.messages.length > 100) data.messages = data.messages.slice(0, 100);
  save(data, testMode);
}

function getRecentMessages(limit = 20, testMode) {
  const data = load(testMode);
  return (data.messages || []).slice(0, limit);
}

function getSubscribedUsers(testMode) {
  const data = load(testMode);
  const now = new Date().toISOString();
  return data.users.filter(u => {
    if (!u.active || !u.subscribed) return false;
    if (u.silenced_until === 'forever') return false;
    if (u.silenced_until && u.silenced_until > now) return false;
    // Auto-unsilence if time has passed
    if (u.silenced_until && u.silenced_until <= now) {
      u.silenced_until = null;
      u.subscribed = true;
      save(data, testMode);
    }
    return true;
  });
}

// Ã¢Ã¢Ã¢ Silence/Notification Support Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢

function silenceUser(userId, duration, testMode) {
  const data = load(testMode);
  const user = data.users.find(u => u.id === userId);
  if (!user) return { error: 'Not found' };
  if (duration === 'forever') {
    user.silenced_until = 'forever';
    user.subscribed = false;
  } else if (duration === 'day') {
    user.silenced_until = new Date(Date.now() + 86400000).toISOString();
    user.subscribed = false;
  } else if (duration === 'week') {
    user.silenced_until = new Date(Date.now() + 7 * 86400000).toISOString();
    user.subscribed = false;
  }
  save(data, testMode);
  return { success: true, silenced_until: user.silenced_until };
}

function unsilenceUser(userId, testMode) {
  const data = load(testMode);
  const user = data.users.find(u => u.id === userId);
  if (!user) return { error: 'Not found' };
  user.silenced_until = null;
  user.subscribed = true;
  save(data, testMode);
  return { success: true };
}

// Ã¢Ã¢Ã¢ Helpers Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢Ã¢

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
    const date = new Date(2026, 2, d); // Month is 0-indexed, 2 = March
    const day = date.getDay();
    if (day >= 1 && day <= 5) { // Monday-Friday
      const dateStr = `2026-03-${String(d).padStart(2, '0')}`;
      days.push(dateStr);
    }
  }
  return days;
}

function getAprilWeekdays() {
  const days = [];
  for (let d = 1; d <= 30; d++) {
    const date = new Date(2026, 3, d); // Month is 0-indexed, so 3 = April
    const day = date.getDay();
    if (day >= 1 && day <= 5) { // Monday-Friday
      const dateStr = `2026-04-${String(d).padStart(2, '0')}`;
      days.push(dateStr);
    }
  }
  return days;
}

function calculateStreak(weekdays, checkedDates, today) {
  let streak = 0;
  const relevantDays = weekdays.filter(d => d <= today).reverse();
  for (const day of relevantDays) {
    if (checkedDates.has(day)) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}


// Delete a checkin (user can delete own)
function deleteCheckin(checkinId, userId, testMode) {
  const data = load(testMode);
  const idx = data.checkins.findIndex(c => c.id === checkinId && c.user_id === userId);
  if (idx === -1) return { error: 'Not found or not yours' };
  const checkin = data.checkins[idx];
  data.checkins.splice(idx, 1);
  save(data, testMode);
  if (checkin.selfie) {
    const selfiePath = testMode ? TEST_SELFIES_DIR : SELFIES_DIR;
    try { fs.unlinkSync(path.join(selfiePath, checkin.selfie)); } catch(e) {}
  }
  return { success: true };
}

// Admin: delete any checkin
function adminDeleteCheckin(checkinId, testMode) {
  const data = load(testMode);
  const idx = data.checkins.findIndex(c => c.id === checkinId);
  if (idx === -1) return { error: 'Not found' };
  const checkin = data.checkins[idx];
  data.checkins.splice(idx, 1);
  save(data, testMode);
  if (checkin.selfie) {
    const selfiePath = testMode ? TEST_SELFIES_DIR : SELFIES_DIR;
    try { fs.unlinkSync(path.join(selfiePath, checkin.selfie)); } catch(e) {}
  }
  return { success: true };
}

// Admin: deactivate user
function adminDeleteUser(userId, testMode) {
  const data = load(testMode);
  const user = data.users.find(u => u.id === userId);
  if (!user) return { error: 'Not found' };
  user.active = false;
  save(data, testMode);
  return { success: true };
}

// Admin: update user info
function adminUpdateUser(userId, updates, testMode) {
  const data = load(testMode);
  const user = data.users.find(u => u.id === userId);
  if (!user) return { error: 'Not found' };
  if (updates.name) user.name = updates.name;
  if (updates.phone) user.phone = normalizePhone(updates.phone);
  if (typeof updates.active === 'boolean') user.active = updates.active;
  save(data, testMode);
  return { success: true, user };
}

// Admin: get all users including inactive
function adminGetAllUsers(testMode) {
  const data = load(testMode);
  return data.users;
}

module.exports = {
  getUser,
  getUserByToken,
  getAllUsers,
  createUser,
  updateUserSubscription,
  getSubscribedUsers,
  addCheckin,
  getCheckinsForUser,
  getCheckinsForDate,
  getAllCheckins,
  getAllPhotos,
  createVouchRequest,
  getPendingVouchRequests,
  getAllVouches,
  approveVouch,
  getLeaderboard,
  logMessage,
  getRecentMessages,
  silenceUser,
  unsilenceUser,
  normalizePhone,
  getMarchWeekdays,
  getAprilWeekdays,
  deleteCheckin,
  adminDeleteCheckin,
  adminDeleteUser,
  adminUpdateUser,
  adminGetAllUsers,
  SELFIES_DIR,
  TEST_SELFIES_DIR,
};
