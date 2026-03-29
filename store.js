const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');
const SELFIES_DIR = path.join(__dirname, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(SELFIES_DIR)) fs.mkdirSync(SELFIES_DIR, { recursive: true });

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading data:', e.message);
  }
  return { users: [], messages: [], checkins: [] };
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Users

function getUser(userId) {
  const data = load();
  return data.users.find(u => u.id === userId) || null;
}

function getUserByToken(token) {
  const data = load();
  return data.users.find(u => u.token === token) || null;
}

function getAllUsers() {
  const data = load();
  return data.users.filter(u => u.active);
}

function createUser(name, phone) {
  const data = load();
  let normalizedPhone = normalizePhone(phone);
  const existing = data.users.find(u => u.phone === normalizedPhone);
  if (existing) {
    existing.name = name;
    existing.active = true;
    save(data);
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
    created_at: new Date().toISOString(),
  };
  data.users.push(user);
  save(data);
  return user;
}

function updateUserSubscription(userId, subscribed) {
  const data = load();
  const user = data.users.find(u => u.id === userId);
  if (user) {
    user.subscribed = subscribed;
    save(data);
  }
}

// Check-ins (selfies)

function addCheckin(userId, userName, dateStr, selfieFilename) {
  const data = load();
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
  save(data);
  return { duplicate: false, checkin };
}

function getCheckinsForUser(userId) {
  const data = load();
  return data.checkins.filter(c => c.user_id === userId);
}

function getCheckinsForDate(dateStr) {
  const data = load();
  return data.checkins.filter(c => c.date === dateStr);
}

function getAllCheckins() {
  const data = load();
  return data.checkins || [];
}

// Leaderboard

function getLeaderboard() {
  const data = load();
  const users = data.users.filter(u => u.active);
  const checkins = data.checkins || [];
  const aprilWeekdays = getAprilWeekdays();
  const today = new Date().toISOString().split('T')[0];

  return users.map(u => {
    const userCheckins = checkins.filter(c => c.user_id === u.id);
    const checkedDates = new Set(userCheckins.map(c => c.date));
    const weekdaysHit = aprilWeekdays.filter(d => checkedDates.has(d));
    const weekdaysMissed = aprilWeekdays.filter(d => d <= today && !checkedDates.has(d));

    return {
      id: u.id,
      name: u.name,
      total_checkins: userCheckins.length,
      weekdays_hit: weekdaysHit.length,
      weekdays_missed: weekdaysMissed.length,
      streak: calculateStreak(aprilWeekdays, checkedDates, today),
      checked_dates: Array.from(checkedDates),
    };
  }).sort((a, b) => b.total_checkins - a.total_checkins);
}

// Messages

function logMessage(senderName, messageType, messageText, recipientsCount) {
  const data = load();
  data.messages.unshift({
    id: Date.now(),
    sender_name: senderName,
    message_type: messageType,
    message_text: messageText,
    recipients_count: recipientsCount,
    sent_at: new Date().toISOString(),
  });
  if (data.messages.length > 100) data.messages = data.messages.slice(0, 100);
  save(data);
}

function getRecentMessages(limit = 20) {
  const data = load();
  return (data.messages || []).slice(0, limit);
}

function getSubscribedUsers() {
  const data = load();
  return data.users.filter(u => u.active && u.subscribed);
}

// Helpers

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

function getAprilWeekdays() {
  const days = [];
  for (let d = 1; d <= 30; d++) {
    const date = new Date(2026, 3, d);
    const day = date.getDay();
    if (day >= 1 && day <= 5) {
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
  getLeaderboard,
  logMessage,
  getRecentMessages,
  normalizePhone,
  getAprilWeekdays,
  SELFIES_DIR,
};
