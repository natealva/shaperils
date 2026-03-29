require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const twilio = require('twilio');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '8675';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Allow large base64 selfies
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(store.SELFIES_DIR));

// âââ Twilio Client ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_ACCOUNT_SID !== 'your_account_sid_here') {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log('Twilio client initialized');
} else {
  console.warn('Twilio credentials not set â running in demo mode (messages logged to console)');
}

// âââ Auth middleware âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  const user = store.getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid session' });
  req.user = user;
  next();
}

function adminAuth(req, res, next) {
  const pin = req.headers['x-admin-pin'];
  if (pin !== ADMIN_PIN) return res.status(403).json({ error: 'Invalid admin PIN' });
  next();
}

// âââ Helper: Send SMS âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function sendToSubscribers(senderName, messageText, excludeUserId = null) {
  const subscribers = store.getSubscribedUsers();
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

  store.logMessage(senderName, 'broadcast', messageText, sentCount);
  return { sent: sentCount, total: recipients.length };
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// AUTH ROUTES
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// Register / Login (remembered by phone number)
app.post('/api/auth/register', (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });

  try {
    const user = store.createUser(name.trim(), phone);
    res.json({
      success: true,
      token: user.token,
      user: { id: user.id, name: user.name, phone: user.phone, subscribed: user.subscribed },
      message: `Welcome to Shayprils, ${user.name}!`,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Failed to register' });
  }
});

// Get current user from token
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({
    user: { id: req.user.id, name: req.user.name, phone: req.user.phone, subscribed: req.user.subscribed },
  });
});

// Toggle SMS subscription
app.post('/api/auth/subscription', authMiddleware, (req, res) => {
  const { subscribed } = req.body;
  store.updateUserSubscription(req.user.id, !!subscribed);
  res.json({ success: true, subscribed: !!subscribed });
});

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// RALLY ROUTES (send SMS)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.post('/api/send', authMiddleware, async (req, res) => {
  const { messageType, companions, customMessage } = req.body;
  const senderName = req.user.name;
  let messageText = '';

  switch (messageType) {
    case 'heading_now':
      messageText = `${senderName} is heading to Shays right now! Come through!`;
      break;
    case 'solo_join':
      messageText = `${senderName} is heading to Shays solo â come keep them company!`;
      break;
    case 'with_friends':
      messageText = companions
        ? `${senderName} is heading to Shays with ${companions}. Join the crew!`
        : `${senderName} is heading to Shays with friends. Join the crew!`;
      break;
    case 'who_wants':
      messageText = `Who wants to go to Shays? ${senderName} is trying to rally the troops!`;
      break;
    case 'custom':
      messageText = customMessage
        ? `Shays Alert from ${senderName}: ${customMessage}`
        : `${senderName} sent a Shays alert!`;
      break;
    default:
      messageText = `${senderName} is heading to Shays! Come through!`;
  }

  try {
    const result = await sendToSubscribers(senderName, messageText, req.user.id);
    res.json({ success: true, message: `Message sent to ${result.sent} people!`, sent: result.sent });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: 'Failed to send messages' });
  }
});

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// CHECK-IN ROUTES (selfie tracker)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// Upload selfie check-in (one per day)
app.post('/api/checkin', authMiddleware, (req, res) => {
  const { selfie } = req.body;
  if (!selfie) return res.status(400).json({ error: 'Selfie required!' });

  // Get today's date in ET (Shays is in Boston)
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dateStr = et.toISOString().split('T')[0];

  // Save the selfie image
  const base64Data = selfie.replace(/^data:image\/\w+;base64,/, '');
  const ext = selfie.startsWith('data:image/png') ? 'png' : 'jpg';
  const filename = `${req.user.id}_${dateStr}.${ext}`;
  const filepath = path.join(store.SELFIES_DIR, filename);

  try {
    fs.writeFileSync(filepath, base64Data, 'base64');
  } catch (err) {
    console.error('Failed to save selfie:', err);
    return res.status(500).json({ error: 'Failed to save selfie' });
  }

  const result = store.addCheckin(req.user.id, req.user.name, dateStr, filename);

  if (result.duplicate) {
    return res.json({
      success: true,
      duplicate: true,
      message: 'You already checked in today!',
      checkin: result.checkin,
    });
  }

  // Send notification to the group
  const notifyText = `${req.user.name} just checked in at Shays! That's dedication.`;
  sendToSubscribers(req.user.name, notifyText, req.user.id).catch(console.error);

  res.json({
    success: true,
    duplicate: false,
    message: `Checked in for ${dateStr}! Selfie saved.`,
    checkin: result.checkin,
  });
});

// Get my check-ins
app.get('/api/checkin/mine', authMiddleware, (req, res) => {
  const checkins = store.getCheckinsForUser(req.user.id);
  res.json({ checkins });
});


// Delete own checkin/selfie
app.delete('/api/checkin/:id', authMiddleware, (req, res) => {
  const result = store.deleteCheckin(req.params.id, req.user.id);
  if (result.error) return res.status(400).json(result);
  res.json({ success: true, message: 'Selfie deleted' });
});

// Get check-ins for a specific date
app.get('/api/checkin/date/:date', (req, res) => {
  const checkins = store.getCheckinsForDate(req.params.date);
  res.json({ checkins });
});

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// ALBUM ROUTES (communal photo gallery)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.get('/api/album', (req, res) => {
  const photos = store.getAllPhotos();
  res.json({ photos });
});

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// VOUCH ROUTES (retroactive attendance)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// Request a vouch for a missed day
app.post('/api/vouch/request', authMiddleware, (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Date required' });

  // Validate the date is a valid April 2026 weekday in the past
  const aprilWeekdays = store.getAprilWeekdays();
  if (!aprilWeekdays.includes(date)) {
    return res.status(400).json({ error: 'Not a valid April 2026 weekday' });
  }

  const today = new Date().toISOString().split('T')[0];
  if (date >= today) {
    return res.status(400).json({ error: 'Can only request vouches for past days' });
  }

  const result = store.createVouchRequest(req.user.id, req.user.name, date);

  if (result.already_checked_in) {
    return res.status(400).json({ error: 'You already checked in that day' });
  }
  if (result.duplicate) {
    return res.json({ success: true, message: 'Vouch already requested for this day', vouch: result.vouch });
  }
  if (result.success) {
    return res.json({ success: true, message: 'Vouch request submitted!', vouch: result.vouch });
  }

  res.status(500).json({ error: 'Failed to create vouch request' });
});

// Get pending vouch requests (that current user can approve)
app.get('/api/vouch/pending', authMiddleware, (req, res) => {
  const vouches = store.getPendingVouchRequests(req.user.id);
  res.json({ vouches });
});

// Get all vouches (for calendar display)
app.get('/api/vouch/list', (req, res) => {
  const vouches = store.getAllVouches();
  res.json({ vouches });
});

// Approve a vouch
app.post('/api/vouch/approve', authMiddleware, (req, res) => {
  const { vouchId } = req.body;
  if (!vouchId) return res.status(400).json({ error: 'Vouch ID required' });

  const result = store.approveVouch(vouchId, req.user.id, req.user.name);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  // Notify the requester
  if (result.vouch) {
    const notifyText = `${req.user.name} vouched for ${result.vouch.requester_name} being at Shays on ${result.vouch.date}!`;
    sendToSubscribers(req.user.name, notifyText).catch(console.error);
  }

  res.json({ success: true, message: 'Vouch approved!' });
});

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// LEADERBOARD & CALENDAR
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.get('/api/leaderboard', (req, res) => {
  res.json(store.getLeaderboard());
});

app.get('/api/calendar', (req, res) => {
  const weekdays = store.getAprilWeekdays();
  const checkins = store.getAllCheckins();
  const users = store.getAllUsers();

  const calendar = weekdays.map(date => {
    const dayCheckins = checkins.filter(c => c.date === date);
    return {
      date,
      dayOfWeek: new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }),
      dayNum: parseInt(date.split('-')[2]),
      checkins: dayCheckins.map(c => ({
        user_id: c.user_id,
        user_name: c.user_name,
        selfie: c.selfie,
      })),
    };
  });

  res.json({ calendar, users: users.map(u => ({ id: u.id, name: u.name })) });
});

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// ADMIN ROUTES
app.get('/api/admin/users', adminAuth, (req, res) => {
  res.json({ users: store.adminGetAllUsers() });
});

app.put('/api/admin/users/:id', adminAuth, (req, res) => {
  const result = store.adminUpdateUser(req.params.id, req.body);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.delete('/api/admin/users/:id', adminAuth, (req, res) => {
  const result = store.adminDeleteUser(req.params.id);
  if (result.error) return res.status(400).json(result);
  res.json({ success: true });
});

app.get('/api/admin/checkins', adminAuth, (req, res) => {
  res.json({ checkins: store.getAllCheckins() });
});

app.delete('/api/admin/checkins/:id', adminAuth, (req, res) => {
  const result = store.adminDeleteCheckin(req.params.id);
  if (result.error) return res.status(400).json(result);
  res.json({ success: true });
});

// OTHER ROUTES
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.get('/api/subscribers/count', (req, res) => {
  res.json({ count: store.getSubscribedUsers().length });
});

app.get('/api/history', (req, res) => {
  res.json(store.getRecentMessages());
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    twilio: !!twilioClient,
    subscribers: store.getSubscribedUsers().length,
    users: store.getAllUsers().length,
  });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// âââ Start ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.listen(PORT, () => {
  console.log(`\nShayprils is running at http://localhost:${PORT}`);
  console.log(`   Twilio: ${twilioClient ? 'Connected' : 'Demo Mode'}`);
  console.log(`   Users: ${store.getAllUsers().length}`);
  console.log(`   April is Shays month!\n`);
});
