require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const twilio = require('twilio');
const cloudinary = require('cloudinary').v2;
const store = require('./store');

// Configure Cloudinary
if (process.env.CLOUDINARY_URL || process.env.CLOUDINARY_CLOUD_NAME) {
  if (process.env.CLOUDINARY_URL) {
    // CLOUDINARY_URL format: cloudinary://API_KEY:API_SECRET@CLOUD_NAME
    // cloudinary SDK auto-parses CLOUDINARY_URL from env
  } else {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }
  console.log('Cloudinary configured (cloud: ' + cloudinary.config().cloud_name + ')');
} else {
  console.warn('Cloudinary not configured — photos will be stored locally (ephemeral!)');
}

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '8675';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(store.SELFIES_DIR));
app.use('/uploads_test', express.static(store.TEST_SELFIES_DIR));

// Test mode middleware
app.use((req, res, next) => {
  req.testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  next();
});

// ─── Twilio Client ──────────────────────────────────────────
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_ACCOUNT_SID !== 'your_account_sid_here') {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log('Twilio client initialized');
} else {
  console.warn('Twilio credentials not set — running in demo mode');
}

// ─── Auth middleware ────────────────────────────────────────
async function authMiddleware(req, res, next) {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  const user = await store.getUserByToken(token, testMode);
  if (!user) return res.status(401).json({ error: 'Invalid session' });
  req.user = user;
  req.testMode = testMode;
  next();
}

function adminAuth(req, res, next) {
  const pin = req.headers['x-admin-pin'];
  if (pin !== ADMIN_PIN) return res.status(403).json({ error: 'Invalid admin PIN' });
  next();
}

// ─── Helper: Send SMS ───────────────────────────────────────
async function sendToSubscribers(senderName, messageText, excludeUserId = null, testMode = false) {
  const subscribers = await store.getSubscribedUsers(testMode);
  const recipients = excludeUserId
    ? subscribers.filter(s => s.id !== excludeUserId)
    : subscribers;

  if (recipients.length === 0) return { sent: 0, total: 0 };

  let sentCount = 0;
  for (const sub of recipients) {
    try {
      if (twilioClient && process.env.TWILIO_PHONE_NUMBER) {
        await twilioClient.messages.create({
          body: messageText,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: sub.phone,
        });
        console.log(`Sent to ${sub.name} (${sub.phone})`);
      } else {
        console.log(`[DEMO] -> ${sub.name} (${sub.phone}): ${messageText}`);
      }
      sentCount++;
    } catch (err) {
      console.error(`Failed to send to ${sub.phone}:`, err.message);
    }
  }
  await store.logMessage(senderName, 'broadcast', messageText, sentCount, testMode);
  return { sent: sentCount, total: recipients.length };
}

// ═══════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  try {
    const user = await store.createUser(name.trim(), phone, req.testMode);
    res.json({
      success: true, token: user.token,
      user: { id: user.id, name: user.name, phone: user.phone,
              subscribed: user.subscribed, silenced_until: user.silenced_until || null },
      message: `Welcome to Shayprils, ${user.name}!`,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Failed to register' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  res.json({
    user: { id: req.user.id, name: req.user.name, phone: req.user.phone,
            subscribed: req.user.subscribed, silenced_until: req.user.silenced_until || null },
  });
});

app.post('/api/auth/subscription', authMiddleware, async (req, res) => {
  const { subscribed } = req.body;
  await store.updateUserSubscription(req.user.id, !!subscribed, req.testMode);
  res.json({ success: true, subscribed: !!subscribed });
});

app.post('/api/auth/silence', authMiddleware, async (req, res) => {
  const { duration } = req.body;
  if (!['day', 'week', 'forever'].includes(duration)) {
    return res.status(400).json({ error: 'Invalid duration' });
  }
  const result = await store.silenceUser(req.user.id, duration, req.testMode);
  if (result.error) return res.status(400).json(result);
  res.json({ success: true, silenced_until: result.silenced_until });
});

app.post('/api/auth/unsilence', authMiddleware, async (req, res) => {
  const result = await store.unsilenceUser(req.user.id, req.testMode);
  if (result.error) return res.status(400).json(result);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// RALLY ROUTES (send SMS)
// ═══════════════════════════════════════════════════════════════
app.post('/api/send', authMiddleware, async (req, res) => {
  const { messageType, companions, customMessage } = req.body;
  const senderName = req.user.name;
  let messageText = '';

  switch (messageType) {
    case 'heading_now':
      messageText = `${senderName} is heading to Shays right now! Come through!`; break;
    case 'solo_join':
      messageText = `${senderName} is heading to Shays solo — come keep them company!`; break;
    case 'with_friends':
      messageText = companions
        ? `${senderName} is heading to Shays with ${companions}. Join the crew!`
        : `${senderName} is heading to Shays with friends. Join the crew!`; break;
    case 'who_wants':
      messageText = `Who wants to go to Shays? ${senderName} is trying to rally the troops!`; break;
    case 'custom':
      messageText = customMessage
        ? `Shays Alert from ${senderName}: ${customMessage}`
        : `${senderName} sent a Shays alert!`; break;
    default:
      messageText = `${senderName} is heading to Shays! Come through!`;
  }

  try {
    const result = await sendToSubscribers(senderName, messageText, req.user.id, req.testMode);
    res.json({ success: true, message: `Message sent to ${result.sent} people!`, sent: result.sent });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: 'Failed to send messages' });
  }
});

// ═══════════════════════════════════════════════════════════════
// CHECK-IN ROUTES
// ═══════════════════════════════════════════════════════════════
app.post('/api/checkin', authMiddleware, async (req, res) => {
  const { selfie } = req.body;
  if (!selfie) return res.status(400).json({ error: 'Selfie required!' });

  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dateStr = et.toISOString().split('T')[0];

  let selfieValue; // Will be either a Cloudinary URL or a local filename

  if (cloudinary.config().cloud_name) {
    // Upload to Cloudinary
    try {
      const folder = req.testMode ? 'shayprils_test' : 'shayprils';
      const publicId = `${req.user.id}_${dateStr}`;
      const result = await cloudinary.uploader.upload(selfie, {
        folder,
        public_id: publicId,
        overwrite: true,
        transformation: [{ width: 640, height: 640, crop: 'fill', gravity: 'face' }],
      });
      selfieValue = result.secure_url;
      console.log('Uploaded to Cloudinary:', selfieValue);
    } catch (err) {
      console.error('Cloudinary upload failed:', err);
      return res.status(500).json({ error: 'Failed to upload selfie' });
    }
  } else {
    // Fallback: save to local disk (ephemeral on Render)
    const base64Data = selfie.replace(/^data:image\/\w+;base64,/, '');
    const ext = selfie.startsWith('data:image/png') ? 'png' : 'jpg';
    const filename = `${req.user.id}_${dateStr}.${ext}`;
    const filepath = path.join(req.testMode ? store.TEST_SELFIES_DIR : store.SELFIES_DIR, filename);
    try { fs.writeFileSync(filepath, base64Data, 'base64'); }
    catch (err) { console.error('Failed to save selfie:', err); return res.status(500).json({ error: 'Failed to save selfie' }); }
    selfieValue = filename;
  }

  const checkinResult = await store.addCheckin(req.user.id, req.user.name, dateStr, selfieValue, req.testMode);
  if (checkinResult.duplicate) {
    return res.json({ success: true, duplicate: true, message: 'You already checked in today!', checkin: checkinResult.checkin });
  }

  const notifyText = `${req.user.name} just checked in at Shays! That's dedication.`;
  sendToSubscribers(req.user.name, notifyText, req.user.id, req.testMode).catch(console.error);

  res.json({ success: true, duplicate: false, message: `Checked in for ${dateStr}! Selfie saved.`, checkin: checkinResult.checkin });
});

app.get('/api/checkin/mine', authMiddleware, async (req, res) => {
  const checkins = await store.getCheckinsForUser(req.user.id, req.testMode);
  res.json({ checkins });
});

app.delete('/api/checkin/:id', authMiddleware, async (req, res) => {
  const result = await store.deleteCheckin(req.params.id, req.user.id, req.testMode);
  if (result.error) return res.status(400).json(result);
  res.json({ success: true, message: 'Selfie deleted' });
});

app.get('/api/checkin/date/:date', async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const checkins = await store.getCheckinsForDate(req.params.date, testMode);
  res.json({ checkins });
});

// ═══════════════════════════════════════════════════════════════
// ALBUM ROUTES
// ═══════════════════════════════════════════════════════════════
app.get('/api/album', async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const photos = await store.getAllPhotos(testMode);
  res.json({ photos });
});

// ═══════════════════════════════════════════════════════════════
// VOUCH ROUTES
// ═══════════════════════════════════════════════════════════════
app.post('/api/vouch/request', authMiddleware, async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Date required' });

  const aprilWeekdays = store.getAprilWeekdays();
  if (!aprilWeekdays.includes(date)) {
    return res.status(400).json({ error: 'Not a valid April 2026 weekday' });
  }
  const today = new Date().toISOString().split('T')[0];
  if (date >= today) return res.status(400).json({ error: 'Can only request vouches for past days' });

  const result = await store.createVouchRequest(req.user.id, req.user.name, date, req.testMode);
  if (result.already_checked_in) return res.status(400).json({ error: 'You already checked in that day' });
  if (result.duplicate) return res.json({ success: true, message: 'Vouch already requested', vouch: result.vouch });
  if (result.success) return res.json({ success: true, message: 'Vouch request submitted!', vouch: result.vouch });
  res.status(500).json({ error: 'Failed to create vouch request' });
});

app.get('/api/vouch/pending', authMiddleware, async (req, res) => {
  const vouches = await store.getPendingVouchRequests(req.user.id, req.testMode);
  res.json({ vouches });
});

app.get('/api/vouch/list', async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const vouches = await store.getAllVouches(testMode);
  res.json({ vouches });
});

app.post('/api/vouch/approve', authMiddleware, async (req, res) => {
  const { vouchId } = req.body;
  if (!vouchId) return res.status(400).json({ error: 'Vouch ID required' });

  const result = await store.approveVouch(vouchId, req.user.id, req.user.name, req.testMode);
  if (result.error) return res.status(400).json({ error: result.error });

  if (result.vouch) {
    const notifyText = `${req.user.name} vouched for ${result.vouch.requester_name} being at Shays on ${result.vouch.date}!`;
    sendToSubscribers(req.user.name, notifyText, null, req.testMode).catch(console.error);
  }
  res.json({ success: true, message: 'Vouch approved!' });
});

// ═══════════════════════════════════════════════════════════════
// LEADERBOARD & CALENDAR
// ═══════════════════════════════════════════════════════════════
app.get('/api/leaderboard', async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  res.json(await store.getLeaderboard(testMode));
});

app.get('/api/calendar', async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const month = req.query.month || 'april';
  const weekdays = month === 'march' ? store.getMarchWeekdays() : store.getAprilWeekdays();
  const checkins = await store.getAllCheckins(testMode);
  const users = await store.getAllUsers(testMode);

  const calendar = weekdays.map(date => {
    const dayCheckins = checkins.filter(c => c.date === date);
    return {
      date,
      dayOfWeek: new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }),
      dayNum: parseInt(date.split('-')[2]),
      checkins: dayCheckins.map(c => ({ user_id: c.user_id, user_name: c.user_name, selfie: c.selfie })),
    };
  });

  res.json({ calendar, month, users: users.map(u => ({ id: u.id, name: u.name })) });
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════
app.get('/api/admin/users', adminAuth, async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  res.json({ users: await store.adminGetAllUsers(testMode) });
});

app.put('/api/admin/users/:id', adminAuth, async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const result = await store.adminUpdateUser(req.params.id, req.body, testMode);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const result = await store.adminDeleteUser(req.params.id, testMode);
  if (result.error) return res.status(400).json(result);
  res.json({ success: true });
});

app.get('/api/admin/checkins', adminAuth, async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  res.json({ checkins: await store.getAllCheckins(testMode) });
});

app.delete('/api/admin/checkins/:id', adminAuth, async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const result = await store.adminDeleteCheckin(req.params.id, testMode);
  if (result.error) return res.status(400).json(result);
  res.json({ success: true });
});

// OTHER ROUTES
app.get('/api/subscribers/count', async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const subs = await store.getSubscribedUsers(testMode);
  res.json({ count: subs.length });
});

app.get('/api/history', async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  res.json(await store.getRecentMessages(testMode));
});

app.get('/api/health', async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const subs = await store.getSubscribedUsers(testMode);
  const users = await store.getAllUsers(testMode);
  res.json({ status: 'ok', twilio: !!twilioClient, subscribers: subs.length, users: users.length });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ──────────────────────────────────────────────────
async function start() {
  try {
    await store.initDb();
    app.listen(PORT, () => {
      console.log(`\nShayprils is running at http://localhost:${PORT}`);
      console.log(`  Twilio: ${twilioClient ? 'Connected' : 'Demo Mode'}`);
      console.log(`  Database: Connected`);
      console.log(`  April is Shays month!\n`);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}
start();
