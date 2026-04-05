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
// HEALTH / DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  const health = {
    status: 'ok',
    cloudinary: cloudinary.config().cloud_name ? 'configured (' + cloudinary.config().cloud_name + ')' : 'NOT configured',
    twilio: twilioClient ? 'configured' : 'NOT configured',
    timestamp: new Date().toISOString(),
  };
  // Quick Cloudinary connectivity test
  if (cloudinary.config().cloud_name) {
    try {
      await cloudinary.api.ping();
      health.cloudinary_ping = 'ok';
    } catch (err) {
      health.cloudinary_ping = 'FAILED: ' + (err.message || 'unknown error');
    }
  }
  res.json(health);
});

// Diagnostic: inspect stored selfie values (admin only)
app.get('/api/admin/photo-debug', adminAuth, async (req, res) => {
  const testMode = req.query.test === '1';
  const checkins = await store.getAllCheckins(testMode);
  const summary = checkins.map(c => ({
    id: c.id,
    user_name: c.user_name,
    date: c.date,
    selfie_type: !c.selfie ? 'NONE'
      : c.selfie.startsWith('http') ? 'cloudinary_url'
      : 'local_filename',
    selfie_value: c.selfie || '(none)',
  }));
  res.json({ total: summary.length, checkins: summary });
});

// Recovery: list all images in Cloudinary folder and try to match to checkins with broken/local refs
app.post('/api/admin/photo-recover', adminAuth, async (req, res) => {
  if (!cloudinary.config().cloud_name) {
    return res.status(400).json({ error: 'Cloudinary not configured' });
  }
  const testMode = req.query.test === '1';
  const folder = testMode ? 'shayprils_test' : 'shayprils';

  try {
    // List all resources in the Cloudinary folder
    let allResources = [];
    let nextCursor = null;
    do {
      const result = await cloudinary.api.resources({
        type: 'upload',
        prefix: folder + '/',
        max_results: 500,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
      });
      allResources = allResources.concat(result.resources || []);
      nextCursor = result.next_cursor;
    } while (nextCursor);

    // Build a map: public_id => secure_url
    const cloudMap = {};
    for (const r of allResources) {
      // public_id is like "shayprils/userid_2026-04-01"
      const key = r.public_id.replace(folder + '/', '');
      cloudMap[key] = r.secure_url;
    }

    // Get all checkins and try to fix any with local filenames
    const checkins = await store.getAllCheckins(testMode);
    let recovered = 0;
    let alreadyOk = 0;
    let notFound = 0;
    const details = [];

    for (const c of checkins) {
      if (!c.selfie) continue;
      if (c.selfie.startsWith('http')) {
        alreadyOk++;
        continue;
      }
      // This is a local filename — try to find matching Cloudinary image
      // Expected key format: userId_date
      const expectedKey = `${c.user_id}_${c.date}`;
      if (cloudMap[expectedKey]) {
        // Found it! Update the DB
        await store.updateCheckinSelfie(c.id, cloudMap[expectedKey], testMode);
        details.push({ user: c.user_name, date: c.date, status: 'RECOVERED', url: cloudMap[expectedKey] });
        recovered++;
      } else {
        details.push({ user: c.user_name, date: c.date, status: 'NOT_FOUND_IN_CLOUDINARY', local_file: c.selfie });
        notFound++;
      }
    }

    res.json({
      cloudinary_images: allResources.length,
      checkins_total: checkins.length,
      already_ok: alreadyOk,
      recovered,
      not_found: notFound,
      details,
    });
  } catch (err) {
    console.error('Photo recovery error:', err);
    res.status(500).json({ error: err.message });
  }
});

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

  const appLink = 'https://shaperils.onrender.com';

  switch (messageType) {
    case 'heading_now':
      messageText = `${senderName} is heading to Shays right now! Come through!\n${appLink}`; break;
    case 'solo_join':
      messageText = `${senderName} is heading to Shays solo — come keep them company!\n${appLink}`; break;
    case 'with_friends':
      messageText = companions
        ? `${senderName} is heading to Shays with ${companions}. Join the crew!\n${appLink}`
        : `${senderName} is heading to Shays with friends. Join the crew!\n${appLink}`; break;
    case 'who_wants':
      messageText = `Who wants to go to Shays? ${senderName} is trying to rally the troops!\n${appLink}`; break;
    case 'custom':
      messageText = customMessage
        ? `Shays Alert from ${senderName}: ${customMessage}\n${appLink}`
        : `${senderName} sent a Shays alert!\n${appLink}`; break;
    default:
      messageText = `${senderName} is heading to Shays! Come through!\n${appLink}`;
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
// Helper: upload to Cloudinary with retry
// Upload to Cloudinary with retry — NO server-side transformation (already 640x640 from client)
async function uploadToCloudinary(dataUrl, folder, publicId, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await cloudinary.uploader.upload(dataUrl, {
        folder,
        public_id: publicId,
        overwrite: true,
        // No transformation — image is already 640x640 from the client canvas.
        // Removing server-side transforms saves Cloudinary credits.
      });
      return result;
    } catch (err) {
      lastErr = err;
      console.error(`Cloudinary upload attempt ${attempt + 1} failed:`, err.message || err);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

app.post('/api/checkin', authMiddleware, async (req, res) => {
  const { selfie } = req.body;
  if (!selfie) return res.status(400).json({ error: 'Selfie required!' });

  // Validate selfie data
  if (!selfie.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Invalid image data' });
  }

  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dateStr = et.toISOString().split('T')[0];

  // Check how many check-ins exist today to build unique Cloudinary ID
  const existingCheckins = await store.getCheckinsForDate(dateStr, req.testMode);
  const myTodayCheckins = existingCheckins.filter(c => c.user_id === req.user.id);
  const checkinNum = myTodayCheckins.length + 1; // 1 or 2

  if (myTodayCheckins.length >= 2) {
    return res.json({ success: true, max_reached: true, message: 'You\'ve already checked in twice today!' });
  }

  let selfieValue; // Will be a Cloudinary URL

  if (cloudinary.config().cloud_name) {
    // Upload to Cloudinary (with retry) — no local fallback to avoid data loss on redeploy
    try {
      const folder = req.testMode ? 'shayprils_test' : 'shayprils';
      const publicId = `${req.user.id}_${dateStr}_${checkinNum}`;
      const result = await uploadToCloudinary(selfie, folder, publicId);
      selfieValue = result.secure_url;
      console.log('Uploaded to Cloudinary:', selfieValue);
    } catch (err) {
      console.error('Cloudinary upload failed after retries:', err.message || err);
      return res.status(500).json({
        error: 'Photo upload failed — please try again in a moment. (' + (err.message || 'unknown') + ')'
      });
    }
  } else {
    // No Cloudinary configured: save to local disk (WARNING: ephemeral on Render)
    console.warn('WARNING: Saving photo locally — will be lost on next deploy!');
    const base64Data = selfie.replace(/^data:image\/\w+;base64,/, '');
    const ext = selfie.startsWith('data:image/png') ? 'png' : 'jpg';
    const filename = `${req.user.id}_${dateStr}_${checkinNum}.${ext}`;
    const dir = req.testMode ? store.TEST_SELFIES_DIR : store.SELFIES_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    try { fs.writeFileSync(filepath, base64Data, 'base64'); }
    catch (err) { console.error('Failed to save selfie:', err); return res.status(500).json({ error: 'Failed to save selfie' }); }
    selfieValue = filename;
  }

  const checkinResult = await store.addCheckin(req.user.id, req.user.name, dateStr, selfieValue, req.testMode);
  if (checkinResult.max_reached) {
    return res.json({ success: true, max_reached: true, message: 'You\'ve already checked in twice today!' });
  }

  // Note: check-ins do NOT send SMS — only Rally tab buttons trigger texts
  const msg = checkinResult.second_checkin
    ? `Welcome back to Shays! Second check-in for ${dateStr} saved.`
    : `Checked in for ${dateStr}! Selfie saved.`;
  res.json({ success: true, duplicate: false, second_checkin: !!checkinResult.second_checkin, message: msg, checkin: checkinResult.checkin });
});

app.get('/api/checkin/mine', authMiddleware, async (req, res) => {
  const checkins = await store.getCheckinsForUser(req.user.id, req.testMode);
  res.json({ checkins });
});

// Re-upload selfie for an existing check-in (keeps check-in record intact)
app.put('/api/checkin/:id/selfie', authMiddleware, async (req, res) => {
  const { selfie } = req.body;
  if (!selfie) return res.status(400).json({ error: 'Selfie required' });
  if (!selfie.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image data' });

  // Verify this check-in belongs to the user (or user is admin)
  const checkins = await store.getCheckinsForUser(req.user.id, req.testMode);
  const checkin = checkins.find(c => c.id === req.params.id);
  if (!checkin) return res.status(404).json({ error: 'Check-in not found or not yours' });

  if (!cloudinary.config().cloud_name) {
    return res.status(500).json({ error: 'Photo storage not configured' });
  }

  try {
    const folder = req.testMode ? 'shayprils_test' : 'shayprils';
    const publicId = `${req.user.id}_${checkin.date}`;
    const result = await uploadToCloudinary(selfie, folder, publicId);
    await store.updateCheckinSelfie(checkin.id, result.secure_url, req.testMode);
    console.log('Re-uploaded selfie for', req.user.name, 'date', checkin.date, ':', result.secure_url);
    res.json({ success: true, message: 'Photo updated!', url: result.secure_url });
  } catch (err) {
    console.error('Re-upload failed:', err.message || err);
    res.status(500).json({ error: 'Photo upload failed — try again. (' + (err.message || 'unknown') + ')' });
  }
});

// Upload selfie for a vouched day (creates a check-in for that date)
app.post('/api/checkin/vouched', authMiddleware, async (req, res) => {
  const { selfie, date } = req.body;
  if (!selfie || !date) return res.status(400).json({ error: 'Selfie and date required' });
  if (!selfie.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image data' });

  // Verify the user has an approved vouch for this date
  const vouches = (await store.getAllVouches(req.testMode)).filter(
    v => v.requester_id === req.user.id && v.date === date && v.status === 'approved'
  );
  if (vouches.length === 0) return res.status(403).json({ error: 'No approved vouch for this date' });

  // Check if they already have a check-in for this date
  const existing = await store.getCheckinsForDate(date, req.testMode);
  const myExisting = existing.filter(c => c.user_id === req.user.id);
  if (myExisting.length > 0) return res.json({ success: true, duplicate: true, message: 'You already have a check-in for this date' });

  if (!cloudinary.config().cloud_name) return res.status(500).json({ error: 'Photo storage not configured' });

  try {
    const folder = req.testMode ? 'shayprils_test' : 'shayprils';
    const publicId = `${req.user.id}_${date}_vouch`;
    const result = await uploadToCloudinary(selfie, folder, publicId);
    const checkinResult = await store.addCheckin(req.user.id, req.user.name, date, result.secure_url, req.testMode);
    res.json({ success: true, message: 'Selfie uploaded for vouched day!', checkin: checkinResult.checkin });
  } catch (err) {
    console.error('Vouched selfie upload failed:', err.message || err);
    res.status(500).json({ error: 'Photo upload failed — try again.' });
  }
});

// Admin: upload or replace a selfie for any user on any date
app.post('/api/admin/checkin/photo', adminAuth, async (req, res) => {
  const { selfie, user_id, date, checkin_id } = req.body;
  if (!selfie) return res.status(400).json({ error: 'Selfie required' });
  if (!selfie.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image data' });

  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';

  if (!cloudinary.config().cloud_name) return res.status(500).json({ error: 'Photo storage not configured' });

  try {
    const folder = testMode ? 'shayprils_test' : 'shayprils';
    const publicId = `admin_${user_id || 'unknown'}_${date || Date.now()}`;
    const result = await uploadToCloudinary(selfie, folder, publicId);

    if (checkin_id) {
      // Replace existing check-in's selfie
      await store.updateCheckinSelfie(checkin_id, result.secure_url, testMode);
      res.json({ success: true, message: 'Photo replaced!', url: result.secure_url });
    } else if (user_id && date) {
      // Create new check-in for this user/date
      const users = await store.getAllUsers(testMode);
      const user = users.find(u => u.id === user_id);
      const userName = user ? user.name : 'Unknown';
      const checkinResult = await store.addCheckin(user_id, userName, date, result.secure_url, testMode);
      res.json({ success: true, message: 'Photo uploaded!', checkin: checkinResult.checkin });
    } else {
      return res.status(400).json({ error: 'Need checkin_id or user_id+date' });
    }
  } catch (err) {
    console.error('Admin photo upload failed:', err.message || err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Admin: delete a check-in photo from calendar
app.delete('/api/admin/checkin/:id/photo', adminAuth, async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const result = await store.adminDeleteCheckin(req.params.id, testMode);
  res.json(result);
});

// Update drink count for a check-in
app.put('/api/checkin/:id/drinks', authMiddleware, async (req, res) => {
  const { drinks } = req.body;
  if (drinks === undefined || drinks === null) return res.status(400).json({ error: 'Drinks count required' });
  const count = parseInt(drinks, 10);
  if (isNaN(count) || count < 0) return res.status(400).json({ error: 'Invalid drinks count' });

  // Verify this check-in belongs to the user
  const checkins = await store.getCheckinsForUser(req.user.id, req.testMode);
  const checkin = checkins.find(c => c.id === req.params.id);
  if (!checkin) return res.status(404).json({ error: 'Check-in not found or not yours' });

  await store.updateCheckinDrinks(checkin.id, count, req.testMode);
  res.json({ success: true, drinks: count });
});

app.delete('/api/checkin/:id', authMiddleware, async (req, res) => {
  const result = await store.deleteCheckin(req.params.id, req.user.id, req.testMode);
  if (result.error) return res.status(400).json(result);

  // Log the deletion to the activity feed
  const deleteMsg = `${req.user.name} deleted their check-in${result.date ? ' for ' + result.date : ''}`;
  await store.logMessage(req.user.name, 'system', deleteMsg, 0, req.testMode).catch(console.error);

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
  try {
    const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
    const photos = await store.getAllPhotos(testMode);
    // Attach cheers counts to each photo
    let cheersMap = {};
    try {
      const checkinIds = photos.map(p => p.id);
      cheersMap = await store.getCheersForCheckins(checkinIds);
    } catch (e) { console.error('Cheers lookup failed:', e.message); }
    const photosWithCheers = photos.map(p => ({
      ...p,
      cheers: cheersMap[p.id] || [],
      cheers_count: (cheersMap[p.id] || []).length,
    }));
    res.json({ photos: photosWithCheers });
  } catch (err) {
    console.error('Album error:', err);
    res.status(500).json({ error: 'Failed to load album' });
  }
});

// ═══════════════════════════════════════════════════════════════
// CHEERS ROUTES
// ═══════════════════════════════════════════════════════════════
app.post('/api/cheers', authMiddleware, async (req, res) => {
  const { checkin_id } = req.body;
  if (!checkin_id) return res.status(400).json({ error: 'checkin_id required' });
  try {
    const result = await store.toggleCheers(checkin_id, req.user.id, req.user.name);
    // Return updated cheers list for this checkin
    const cheersMap = await store.getCheersForCheckins([checkin_id]);
    const cheers = cheersMap[checkin_id] || [];
    res.json({ success: true, cheered: result.cheered, cheers, cheers_count: cheers.length });
  } catch (err) {
    console.error('Cheers error:', err);
    res.status(500).json({ error: 'Failed to toggle cheers' });
  }
});

app.get('/api/cheers/:checkin_id', async (req, res) => {
  try {
    const cheersMap = await store.getCheersForCheckins([req.params.checkin_id]);
    const cheers = cheersMap[req.params.checkin_id] || [];
    res.json({ cheers, cheers_count: cheers.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get cheers' });
  }
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

  // Note: vouches do NOT send SMS — only Rally tab buttons trigger texts
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

  // Get cheers for all checkins shown in calendar
  let cheersMap = {};
  try {
    const allCheckinIds = checkins.map(c => c.id);
    cheersMap = await store.getCheersForCheckins(allCheckinIds);
  } catch (e) { console.error('Calendar cheers lookup failed:', e.message); }

  const calendar = weekdays.map(date => {
    const dayCheckins = checkins.filter(c => c.date === date);
    return {
      date,
      dayOfWeek: new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }),
      dayNum: parseInt(date.split('-')[2]),
      checkins: dayCheckins.map(c => ({
        id: c.id, user_id: c.user_id, user_name: c.user_name, selfie: c.selfie, drinks: c.drinks,
        cheers_count: (cheersMap[c.id] || []).length,
      })),
    };
  });

  // Compute streak & total check-ins for each user (for calendar user list)
  const allWeekdays = [...store.getMarchWeekdays(), ...store.getAprilWeekdays()];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const enrichedUsers = users.map(u => {
    const userCheckins = checkins.filter(c => c.user_id === u.id);
    const checkedDates = new Set(userCheckins.map(c => c.date));
    // Calculate current streak
    let streak = 0;
    const relevantDays = allWeekdays.filter(d => d <= today).reverse();
    for (const day of relevantDays) {
      if (checkedDates.has(day)) streak++;
      else break;
    }
    return { id: u.id, name: u.name, streak, total_checkins: checkedDates.size };
  });

  res.json({ calendar, month, users: enrichedUsers });
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

// Clear all messages (activity feed)
app.delete('/api/admin/messages', adminAuth, async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const result = await store.adminClearMessages(testMode);
  res.json(result);
});

app.delete('/api/admin/messages/:id', adminAuth, async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const result = await store.adminDeleteMessage(req.params.id, testMode);
  res.json(result);
});

// Fully erase a user account and all their data
app.delete('/api/admin/users/:id/erase', adminAuth, async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const result = await store.adminEraseUser(req.params.id, testMode);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// ─── Admin Settings ────────────────────────────────────────
app.get('/api/admin/settings', adminAuth, async (req, res) => {
  const settings = await store.getAllSettings();
  res.json({ settings });
});

app.put('/api/admin/settings/:key', adminAuth, async (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'Value required' });
  await store.setSetting(req.params.key, String(value));
  res.json({ success: true, key: req.params.key, value: String(value) });
});

// Public settings endpoint (only exposes non-sensitive settings)
app.get('/api/settings/public', async (req, res) => {
  const allowGallery = await store.getSetting('allow_gallery_uploads');
  res.json({ allow_gallery_uploads: allowGallery === 'true' });
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

app.get('/api/status', async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const subs = await store.getSubscribedUsers(testMode);
  const users = await store.getAllUsers(testMode);
  res.json({ status: 'ok', twilio: !!twilioClient, subscribers: subs.length, users: users.length });
});

// ─── Privacy Policy & Terms (required for A2P 10DLC) ───────
app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy — Shayprils</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#333;line-height:1.6}
h1{color:#722F37}h2{color:#722F37;margin-top:1.5em}a{color:#722F37}</style></head><body>
<h1>Shayprils Privacy Policy</h1>
<p><strong>Last updated:</strong> March 31, 2026</p>
<p>Shayprils ("we", "us", "our") is a private social app for a group of friends who check in daily at Shays bar during April 2026. This policy explains how we handle your information.</p>

<h2>Information We Collect</h2>
<p>When you use Shayprils, we collect: your name, phone number, selfie photos you upload, and check-in dates. We use this information solely to operate the app and its features (leaderboard, photo album, SMS notifications).</p>

<h2>SMS Messaging</h2>
<p>If you opt in to SMS notifications, we will send you text messages when a friend checks in at Shays. You can opt out at any time by replying STOP to any message, or by using the Unsubscribe button in the app. Message and data rates may apply. Message frequency varies (typically 1–5 messages per day).</p>

<h2>How We Use Your Information</h2>
<p>We use your information to: display your check-ins and selfies to other participants, calculate leaderboard standings, and send SMS notifications if you opted in. We do not sell, share, or disclose your personal information to any third parties.</p>

<h2>Data Storage</h2>
<p>Photos are stored securely on Cloudinary. App data is stored in a PostgreSQL database hosted on Render. Phone numbers are stored securely and used only for sending notifications through Twilio.</p>

<h2>Data Retention</h2>
<p>We retain your data for the duration of the April 2026 challenge. You may request deletion of your data at any time by contacting us.</p>

<h2>Contact</h2>
<p>Questions about this policy? Contact us at <a href="mailto:nalvarez@mba2026.hbs.edu">nalvarez@mba2026.hbs.edu</a>.</p>
</body></html>`);
});

app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Terms of Service — Shayprils</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#333;line-height:1.6}
h1{color:#722F37}h2{color:#722F37;margin-top:1.5em}a{color:#722F37}</style></head><body>
<h1>Shayprils Terms of Service</h1>
<p><strong>Last updated:</strong> March 31, 2026</p>
<p>By using Shayprils, you agree to these terms.</p>

<h2>Description of Service</h2>
<p>Shayprils is a private social app for a group of friends participating in a daily check-in challenge at Shays bar during April 2026. The app tracks attendance, displays selfie photos, and optionally sends SMS notifications.</p>

<h2>SMS Notifications</h2>
<p>By providing your phone number and opting in to notifications, you consent to receive SMS messages from Shayprils. You may opt out at any time by replying STOP to any message or using the Unsubscribe button in the app. Message and data rates may apply.</p>

<h2>User Content</h2>
<p>You retain ownership of any photos you upload. By uploading a selfie, you grant Shayprils permission to display it within the app to other participants.</p>

<h2>Acceptable Use</h2>
<p>You agree to use Shayprils only for its intended purpose — participating in the April 2026 check-in challenge with friends. You will not misuse the service or attempt to access it in unauthorized ways.</p>

<h2>Limitation of Liability</h2>
<p>Shayprils is provided "as is" for fun among friends. We are not liable for any damages arising from use of the service.</p>

<h2>Contact</h2>
<p>Questions? Contact us at <a href="mailto:nalvarez@mba2026.hbs.edu">nalvarez@mba2026.hbs.edu</a>.</p>
</body></html>`);
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
