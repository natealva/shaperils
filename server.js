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
// Twilio inbound SMS webhook posts application/x-www-form-urlencoded bodies.
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
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

// ─── Twilio A2P Campaign Gate ───────────────────────────────
// Blocks outbound SMS until the US A2P 10DLC campaign is approved by
// carriers, so we don't get billed for attempts that will be rejected.
// Status is cached for 6 hours and auto-refreshes, so once Twilio
// approves the campaign, sends automatically resume with no action.
const TWILIO_MESSAGING_SERVICE_SID =
  process.env.TWILIO_MESSAGING_SERVICE_SID || 'BNdaf937f16d19b9ba50dc0c17597297c9';
const TWILIO_CAMPAIGN_SID =
  process.env.TWILIO_CAMPAIGN_SID || 'CM81b6798d82734e3207181d0598bb7866';
const CAMPAIGN_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
let _campaignCache = { status: null, checkedAt: 0 };

async function isA2pCampaignApproved() {
  // Emergency override — set SMS_GATE_DISABLED=true to force-allow sends
  // (e.g. if we want to bypass the check during troubleshooting).
  if (process.env.SMS_GATE_DISABLED === 'true') return true;

  if (!twilioClient || !TWILIO_MESSAGING_SERVICE_SID || !TWILIO_CAMPAIGN_SID) {
    return false;
  }

  const now = Date.now();
  const cacheFresh = _campaignCache.status &&
    (now - _campaignCache.checkedAt) < CAMPAIGN_CACHE_TTL_MS;
  if (cacheFresh) {
    return _campaignCache.status === 'VERIFIED';
  }

  try {
    const campaign = await twilioClient.messaging.v1
      .services(TWILIO_MESSAGING_SERVICE_SID)
      .usAppToPerson(TWILIO_CAMPAIGN_SID)
      .fetch();
    const status = campaign.campaignStatus || campaign.campaign_status || 'UNKNOWN';
    _campaignCache = { status, checkedAt: now };
    console.log(`[A2P Gate] Campaign status refreshed: ${status}`);
    return status === 'VERIFIED';
  } catch (err) {
    console.error('[A2P Gate] Failed to fetch campaign status:', err.message);
    // On fetch error, fall back to last known status if we have one,
    // otherwise block to be safe.
    if (_campaignCache.status) {
      return _campaignCache.status === 'VERIFIED';
    }
    return false;
  }
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
// Sending strategy (in priority order):
//   1. If TWILIO_TFN_FROM is set, send from the toll-free number. Toll-free
//      has its own verification track (not 10DLC) and can send right away
//      at reduced throughput while verification is pending. This BYPASSES
//      the A2P 10DLC campaign gate because it isn't subject to it.
//   2. Otherwise, fall back to the 10DLC long code, gated by the A2P
//      campaign status check so we don't get billed for carrier-rejected
//      attempts while the campaign is still pending.
async function sendToSubscribers(senderName, messageText, excludeUserId = null, testMode = false) {
  const subscribers = await store.getSubscribedUsers(testMode);
  const recipients = excludeUserId
    ? subscribers.filter(s => s.id !== excludeUserId)
    : subscribers;

  // Always post to the in-app activity feed, even if there are no SMS
  // recipients. The rally blast is a social signal for everyone looking at
  // the feed, not just SMS subscribers.
  if (recipients.length === 0) {
    await store.logMessage(senderName, 'broadcast', messageText, 0, testMode);
    return { sent: 0, total: 0 };
  }

  const tfnFrom = process.env.TWILIO_TFN_FROM; // e.g. "+18446852640"
  const longFrom = process.env.TWILIO_PHONE_NUMBER;
  const fromNumber = tfnFrom || longFrom;
  const usingTfn = !!tfnFrom;

  // Only gate on A2P if we're sending from the 10DLC long code. Toll-free
  // isn't subject to the 10DLC campaign review at all.
  if (!usingTfn) {
    const approved = await isA2pCampaignApproved();
    if (!approved) {
      const status = _campaignCache.status || 'unknown';
      console.log(`[A2P Gate] Blocked broadcast to ${recipients.length} subscriber(s) — campaign status: ${status}`);
      await store.logMessage(senderName, 'broadcast_blocked', messageText, 0, testMode);
      return {
        sent: 0,
        total: recipients.length,
        blocked: true,
        reason: 'campaign_not_approved',
        campaign_status: status,
      };
    }
  }

  let sentCount = 0;
  for (const sub of recipients) {
    try {
      if (twilioClient && fromNumber) {
        await twilioClient.messages.create({
          body: messageText,
          from: fromNumber,
          to: sub.phone,
        });
        console.log(`Sent to ${sub.name} (${sub.phone}) from ${usingTfn ? 'TFN' : '10DLC'} ${fromNumber}`);
      } else {
        console.log(`[DEMO] -> ${sub.name} (${sub.phone}): ${messageText}`);
      }
      sentCount++;
    } catch (err) {
      console.error(`Failed to send to ${sub.phone}:`, err.message);
    }
  }
  await store.logMessage(senderName, 'broadcast', messageText, sentCount, testMode);
  return { sent: sentCount, total: recipients.length, from: usingTfn ? 'tfn' : '10dlc' };
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
  const { name, phone, smsConsent, agreeTerms } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (!agreeTerms) return res.status(400).json({ error: 'You must agree to the Terms of Service and Privacy Policy' });
  // Phone is now required (so we can distinguish users with the same name).
  // SMS opt-in is still separate — the smsConsent checkbox gates actual subscription.
  const cleanPhone = (typeof phone === 'string' && phone.trim()) ? phone.trim() : null;
  if (!cleanPhone) return res.status(400).json({ error: 'Phone number required' });
  const wantsSms = !!smsConsent && !!cleanPhone;
  try {
    const user = await store.createUser(name.trim(), cleanPhone, wantsSms, req.testMode);
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

  // Append the TOGGLE tagline so recipients can mute/unmute by reply.
  messageText += `\n\nText TOGGLE to turn notifications on/off`;

  try {
    // Include the sender in the recipient list — Nate wants the sender to
    // also receive the text so the blast is a shared signal to the whole
    // group, sender included.
    const result = await sendToSubscribers(senderName, messageText, null, req.testMode);
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
  const etDay = et.getDay(); // 0=Sun, 6=Sat
  const isWeekend = (etDay === 0 || etDay === 6);
  const msg = isWeekend
    ? `Weekend check-in bonus! 🎉 Selfie saved.`
    : checkinResult.second_checkin
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
// Owner can update their own. Admin (via x-admin-pin) can update anyone's.
app.put('/api/checkin/:id/drinks', async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const isAdmin = req.headers['x-admin-pin'] === ADMIN_PIN;

  const { drinks } = req.body;
  if (drinks === undefined || drinks === null) return res.status(400).json({ error: 'Drinks count required' });
  const count = parseInt(drinks, 10);
  if (isNaN(count) || count < 0 || count > 99) return res.status(400).json({ error: 'Invalid drinks count' });

  if (isAdmin) {
    // Admin path — locate the check-in across all users
    const all = await store.getAllCheckins(testMode);
    const checkin = all.find(c => c.id === req.params.id);
    if (!checkin) return res.status(404).json({ error: 'Check-in not found' });
    await store.updateCheckinDrinks(checkin.id, count, testMode);
    return res.json({ success: true, drinks: count });
  }

  // Owner path — must be authenticated
  return authMiddleware(req, res, async () => {
    const checkins = await store.getCheckinsForUser(req.user.id, req.testMode);
    const checkin = checkins.find(c => c.id === req.params.id);
    if (!checkin) return res.status(404).json({ error: 'Check-in not found or not yours' });
    await store.updateCheckinDrinks(checkin.id, count, req.testMode);
    res.json({ success: true, drinks: count });
  });
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

// Message (feed post) cheers
app.post('/api/message-cheers', authMiddleware, async (req, res) => {
  const { message_id } = req.body;
  if (!message_id) return res.status(400).json({ error: 'message_id required' });
  try {
    const result = await store.toggleMessageCheers(message_id, req.user.id, req.user.name);
    const cheers = await store.getMessageCheers(message_id);
    res.json({ success: true, cheered: result.cheered, cheers, cheers_count: cheers.length });
  } catch (err) {
    console.error('Message cheers error:', err);
    res.status(500).json({ error: 'Failed to toggle message cheers' });
  }
});

app.get('/api/message-cheers/:message_id', async (req, res) => {
  try {
    const cheers = await store.getMessageCheers(req.params.message_id);
    res.json({ cheers, cheers_count: cheers.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get message cheers' });
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
  // Only the admin sees pending vouch requests. Non-admins get an empty
  // list so the UI card stays hidden for them without erroring out.
  if (req.headers['x-admin-pin'] !== ADMIN_PIN) {
    return res.json({ vouches: [] });
  }
  const vouches = await store.getPendingVouchRequests(req.user.id, req.testMode);
  res.json({ vouches });
});

app.get('/api/vouch/list', async (req, res) => {
  const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
  const vouches = await store.getAllVouches(testMode);
  res.json({ vouches });
});

app.post('/api/vouch/approve', authMiddleware, async (req, res) => {
  // Only the admin can approve vouches.
  if (req.headers['x-admin-pin'] !== ADMIN_PIN) {
    return res.status(403).json({ error: 'Only the admin can approve vouches' });
  }
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
    // Calculate current streak. Today gets the benefit of the doubt:
    // if it's still in progress and the user hasn't checked in yet, we
    // skip today instead of treating it as a miss. Any prior unchecked
    // weekday is still a hard streak-breaker.
    let streak = 0;
    const relevantDays = allWeekdays.filter(d => d <= today).reverse();
    for (const day of relevantDays) {
      if (checkedDates.has(day)) {
        streak++;
      } else if (day === today) {
        continue;
      } else {
        break;
      }
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

// ─── Hype Bot: recap data + post-to-feed ───────────────────
// GET /api/admin/recap?date=YYYY-MM-DD
// Returns everything the Hype Bot needs to write a daily recap.
// If date is omitted, defaults to "yesterday in America/New_York".
app.get('/api/admin/recap', adminAuth, async (req, res) => {
  try {
    const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';

    // Default to yesterday in ET
    let targetDate = req.query.date;
    if (!targetDate) {
      const nowEt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      nowEt.setDate(nowEt.getDate() - 1);
      targetDate = nowEt.toISOString().slice(0, 10);
    }

    const [checkins, users] = await Promise.all([
      store.getAllCheckins(testMode),
      store.getAllUsers(testMode),
    ]);

    const dayCheckins = checkins.filter(c => c.date === targetDate);
    const checkinIds = dayCheckins.map(c => c.id);

    let cheersMap = {};
    try { cheersMap = await store.getCheersForCheckins(checkinIds); } catch (e) {}

    const userMap = {};
    users.forEach(u => { userMap[u.id] = u; });

    // Per-checkin breakdown w/ cheers
    const checkinDetails = dayCheckins.map(c => ({
      id: c.id,
      user_id: c.user_id,
      user_name: c.user_name || (userMap[c.user_id] && userMap[c.user_id].name) || 'Unknown',
      selfie: c.selfie || null,
      drinks: c.drinks != null ? c.drinks : null,
      cheers_count: (cheersMap[c.id] || []).length,
      cheers: (cheersMap[c.id] || []).map(x => x.user_name),
    }));

    // Per-user totals for the day
    const perUserMap = {};
    for (const c of checkinDetails) {
      if (!perUserMap[c.user_id]) {
        perUserMap[c.user_id] = { user_id: c.user_id, user_name: c.user_name, count: 0, total_drinks: 0, total_cheers: 0 };
      }
      perUserMap[c.user_id].count += 1;
      if (c.drinks != null) perUserMap[c.user_id].total_drinks += Number(c.drinks) || 0;
      perUserMap[c.user_id].total_cheers += c.cheers_count;
    }
    const perUser = Object.values(perUserMap).sort((a, b) => b.count - a.count || b.total_drinks - a.total_drinks);

    // Top cheered photo of the day
    let topCheered = null;
    for (const c of checkinDetails) {
      if (!topCheered || c.cheers_count > topCheered.cheers_count) topCheered = c;
    }
    if (topCheered && topCheered.cheers_count === 0) topCheered = null;

    // Streaks/leaderboard, computed the same way as the calendar endpoint
    const allWeekdays = [...store.getMarchWeekdays(), ...store.getAprilWeekdays()];
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const leaderboard = users.map(u => {
      const userCheckins = checkins.filter(c => c.user_id === u.id);
      const checkedDates = new Set(userCheckins.map(c => c.date));
      let streak = 0;
      const relevantDays = allWeekdays.filter(d => d <= today).reverse();
      for (const day of relevantDays) {
        if (checkedDates.has(day)) streak++;
        else if (day === today) continue;
        else break;
      }
      return { id: u.id, name: u.name, streak, total_checkins: checkedDates.size };
    }).sort((a, b) => b.streak - a.streak || b.total_checkins - a.total_checkins);

    // Vouches approved on this date (if helper exists)
    let vouches = [];
    try {
      const all = await store.getAllVouches(testMode);
      vouches = (all || []).filter(v => v.date === targetDate && v.status === 'approved');
    } catch (e) {}

    // Yesterday-vs-day-before delta
    const dayBefore = (() => {
      const d = new Date(targetDate + 'T12:00:00');
      d.setDate(d.getDate() - 1);
      return d.toISOString().slice(0, 10);
    })();
    const dayBeforeCount = checkins.filter(c => c.date === dayBefore).length;

    res.json({
      date: targetDate,
      day_of_week: new Date(targetDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }),
      total_checkins: dayCheckins.length,
      unique_visitors: perUser.length,
      day_before: { date: dayBefore, total_checkins: dayBeforeCount },
      per_user: perUser,
      checkins: checkinDetails,
      top_cheered: topCheered,
      vouches_approved: vouches,
      leaderboard,
    });
  } catch (err) {
    console.error('[recap] failed:', err);
    res.status(500).json({ error: 'Failed to build recap', details: err.message });
  }
});

// POST /api/admin/post-feed { sender_name, message_text }
// Drops a system message into the activity feed (does NOT send any SMS).
app.post('/api/admin/post-feed', adminAuth, async (req, res) => {
  try {
    const testMode = req.query.test === '1' || req.headers['x-test-mode'] === '1';
    const senderName = (req.body && req.body.sender_name) || 'Shayprils Hype Bot';
    const messageText = req.body && req.body.message_text;
    if (!messageText || !messageText.trim()) {
      return res.status(400).json({ error: 'message_text is required' });
    }
    await store.logMessage(senderName, 'system', messageText, 0, testMode);
    res.json({ success: true, posted_at: new Date().toISOString() });
  } catch (err) {
    console.error('[post-feed] failed:', err);
    res.status(500).json({ error: 'Failed to post to feed', details: err.message });
  }
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
  const messages = await store.getRecentMessages(testMode);
  // Attach cheers info per message
  let cheersMap = {};
  try {
    cheersMap = await store.getCheersForMessages(messages.map(m => m.id));
  } catch (e) {}
  for (const m of messages) {
    const cheers = cheersMap[m.id] || [];
    m.cheers = cheers;
    m.cheers_count = cheers.length;
  }
  res.json(messages);
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

// ═══════════════════════════════════════════════════════════════
// QUESTION OF THE DAY
// ═══════════════════════════════════════════════════════════════
const QOTD_FALLBACKS = [
  "What's the best gift you've ever received?",
  "What's something you learned from your parents?",
  "Who was your favorite teacher, and why?",
  "Tell me about your childhood best friend.",
  "What's the last thing that made you laugh out loud?",
  "What's a song that always puts you in a good mood?",
  "What was your favorite family trip growing up?",
  "What's a compliment you've never forgotten?",
  "What's the best meal you've had in the last year?",
  "What's a skill you wish you had picked up as a kid?",
  "Who was your first real crush?",
  "What's the most beautiful place you've ever been?",
  "What's a book or movie you keep coming back to?",
  "What did you want to be when you grew up?",
  "What was your favorite cartoon as a kid?",
  "What's the best advice a stranger ever gave you?",
  "What's a totally irrational fear you have?",
  "What's the weirdest job you've ever had?",
  "What's your earliest memory?",
  "What's the best concert you've ever been to?",
  "What was your hype song in college?",
  "Who's the most interesting person you've ever sat next to on a plane?",
  "What's the longest you've gone without sleep?",
  "What's a hill you'll die on?",
  "What's a food you hated as a kid and love now?",
  "What was your first car, and how do you feel about it?",
  "What's a tradition you want to carry into your family?",
  "What's the last thing you splurged on and don't regret?",
  "What's a talent of yours that nobody knows about?",
  "What's the nicest thing a friend has ever done for you?",
  "What was your worst haircut?",
  "What's the most unexpected friendship you've made?",
  "What's something you miss about being a kid?",
  "What's the best wrong turn you've ever taken?",
  "What's your go-to karaoke song?",
  "If you could relive one year of your life, which one?",
  "What's the nicest hotel or Airbnb you've ever stayed in?",
  "What's a small thing that instantly makes your day better?",
  "What's a piece of advice you'd give your 18-year-old self?",
  "What was your favorite teacher's catchphrase?",
  "What's the most impulsive thing you've ever done?",
  "What's the best birthday you've ever had?",
  "Who in your life gives the best hugs?",
  "What's the weirdest food combination you secretly love?",
  "What's a trip you're still planning in your head?",
  "What was your family's holiday tradition growing up?",
  "What's the last thing you learned that surprised you?",
  "What's your favorite thing about where you grew up?",
  "Who taught you how to drive, and how'd that go?",
  "What's a story about your parents you love to tell?",
  "What was your childhood bedroom like?",
  "What's the best decision you've made in the last year?",
  "What's a song that reminds you of high school?",
  "If you had to eat one cuisine for the rest of your life, what would it be?",
  "What's a place you've been that everyone should see once?",
  "What's the best thing you've ever cooked?",
  "Who's someone you'd love to have dinner with, living or not?",
  "What's a memory from this year you want to hold onto?",
  "What's a small risk that paid off big for you?",
  "What's your favorite smell, and why?",
];

function qotdTodayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function qotdPickFallback(exclude) {
  const set = new Set((exclude || []).map(q => (q || '').trim().toLowerCase()));
  const pool = QOTD_FALLBACKS.filter(q => !set.has(q.trim().toLowerCase()));
  const choices = pool.length ? pool : QOTD_FALLBACKS;
  return choices[Math.floor(Math.random() * choices.length)];
}

async function generateQotDWithClaude(recent) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const exclusions = (recent || []).map(r => `- ${r.question_text}`).join('\n') || '(none yet)';
  const prompt = `Generate ONE conversation-starter question for a casual bar check-in app used by a group of friends. The question should be thought-provoking but casual — the kind of thing friends might actually ask each other over a beer that sparks a short story or longer conversation.

Vibe examples (do not repeat, just use for tone):
- What's the best gift you've ever received?
- What's something you learned from your parents?
- Who was your favorite teacher, and why?
- Tell me about your childhood best friend.

Rules:
- Exactly one question, 15 words or fewer.
- Warm, curious, not intrusive. No politics, religion, trauma, or sex.
- No "would you rather" or game-show framing.
- Not generic ("how was your day?"). Should invite a real story.
- Avoid any of these recent questions:
${exclusions}

Respond with ONLY the question — no quotes, no preamble, no trailing commentary.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_QOTD_MODEL || 'claude-sonnet-4-5',
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('[qotd] Anthropic API error:', r.status, body.slice(0, 200));
      return null;
    }
    const j = await r.json();
    let text = j && j.content && j.content[0] && j.content[0].text;
    if (!text) return null;
    text = text.trim().replace(/^["'\s]+|["'\s]+$/g, '');
    if (text.length < 5 || text.length > 200) return null;
    return text;
  } catch (err) {
    console.error('[qotd] Claude generation failed:', err.message);
    return null;
  }
}

async function generateQotD() {
  const recent = await store.getRecentQotDs(30).catch(() => []);
  const fromClaude = await generateQotDWithClaude(recent);
  if (fromClaude) return { text: fromClaude, source: 'claude' };
  const fallback = qotdPickFallback(recent.map(r => r.question_text));
  return { text: fallback, source: 'fallback' };
}

// Public: get today's question. Auto-generates on first hit of the day.
app.get('/api/question-of-day', async (req, res) => {
  try {
    const date = qotdTodayET();
    let row = await store.getQotD(date);
    if (!row) {
      const { text, source } = await generateQotD();
      row = await store.upsertQotD(date, text, false);
      console.log(`[qotd] auto-generated for ${date} via ${source}: ${text}`);
    }
    res.json({
      date: row.date,
      question: row.question_text,
      is_manual: !!row.is_manual,
    });
  } catch (err) {
    console.error('[qotd] failed to load:', err);
    res.status(500).json({ error: 'Failed to load question of the day' });
  }
});

// Admin: regenerate today's question (AI, with fallback bank).
app.post('/api/admin/question-of-day/refresh', adminAuth, async (req, res) => {
  try {
    const date = qotdTodayET();
    const { text, source } = await generateQotD();
    const row = await store.upsertQotD(date, text, false);
    res.json({
      success: true,
      date: row.date,
      question: row.question_text,
      is_manual: false,
      source,
    });
  } catch (err) {
    console.error('[qotd] refresh failed:', err);
    res.status(500).json({ error: 'Failed to refresh question' });
  }
});

// Admin: set today's question manually.
app.post('/api/admin/question-of-day', adminAuth, async (req, res) => {
  try {
    const { question } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'Question text required' });
    }
    const trimmed = question.trim();
    if (trimmed.length > 280) {
      return res.status(400).json({ error: 'Keep it under 280 characters' });
    }
    const date = qotdTodayET();
    const row = await store.upsertQotD(date, trimmed, true);
    res.json({
      success: true,
      date: row.date,
      question: row.question_text,
      is_manual: true,
    });
  } catch (err) {
    console.error('[qotd] manual set failed:', err);
    res.status(500).json({ error: 'Failed to save question' });
  }
});

// ═══════════════════════════════════════════════════════════════
// TWILIO INBOUND SMS WEBHOOK
// ═══════════════════════════════════════════════════════════════
// Twilio POSTs here whenever someone replies to a Shayprils text. We watch
// for "TOGGLE" and flip the sender's subscribed flag. All other words are
// ignored (Twilio auto-handles STOP/HELP itself for compliance).
//
// Twilio payload fields we use:
//   - From: "+15551234567" (E.164, always)
//   - Body: "toggle" or whatever they typed
//
// Response is TwiML — a tiny XML <Response> that Twilio sends back to the
// user as a reply SMS.
function twiml(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${escaped}</Message></Response>`;
}

app.post('/api/twilio/inbound', async (req, res) => {
  try {
    const from = (req.body && req.body.From) || '';
    const body = ((req.body && req.body.Body) || '').trim();
    const cmd = body.toUpperCase();

    console.log(`[inbound] from=${from} body=${JSON.stringify(body)}`);

    // Only act on TOGGLE. Twilio auto-handles STOP/START/HELP on our behalf,
    // so we don't reimplement those — they shouldn't hit this route anyway.
    if (cmd !== 'TOGGLE') {
      res.type('text/xml').send(twiml(
        `Text TOGGLE to turn Shayprils notifications on/off. Reply STOP to unsubscribe, HELP for help.`
      ));
      return;
    }

    const user = await store.getUserByPhone(from);
    if (!user) {
      res.type('text/xml').send(twiml(
        `We couldn't find a Shayprils account for this number. Sign up at https://shaperils.onrender.com`
      ));
      return;
    }

    const updated = await store.toggleUserSubscribed(user.id);
    if (!updated) {
      res.type('text/xml').send(twiml(`Something went wrong. Try again in a minute.`));
      return;
    }

    const reply = updated.subscribed
      ? `Shayprils notifications ON. You'll get a text when friends rally. Text TOGGLE again to turn off.`
      : `Shayprils notifications OFF. Text TOGGLE again to turn back on.`;
    res.type('text/xml').send(twiml(reply));
  } catch (err) {
    console.error('[inbound] error:', err);
    // Still return valid TwiML so Twilio doesn't retry-spam us.
    res.type('text/xml').send(twiml(`Shayprils is having a moment. Try again soon.`));
  }
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

      // Keep-alive: ping ourselves every 10 minutes to prevent Render free-tier sleep
      const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://shaperils.onrender.com';
      if (RENDER_URL) {
        setInterval(() => {
          fetch(RENDER_URL + '/api/health').catch(() => {});
        }, 10 * 60 * 1000); // every 10 minutes
        console.log('  Keep-alive: pinging ' + RENDER_URL + ' every 10 min');
      }
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}
start();
