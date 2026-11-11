// MeetLive — random 1-on-1 video chat server (Chamet-style)
// Node.js + Express + ws
// - Serves the web client (client/ folder)
// - Matchmaking: keeps a queue of waiting users and pairs two at random
// - Signaling: relays WebRTC offers/answers/ICE candidates between a pair
// - Coins & gifts: validates gift costs, deducts from sender, credits receiver
// - Safety: report/block — reported users are logged and can never rematch
//   with the person who reported them.
//
// Run:  npm install && npm start   (then open http://localhost:3000)
// Deploy: any Node host (Render, Railway, VPS). The client is served by
// this same server, so the WebSocket just works with no extra config.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const START_COINS = 100; // coins every new visitor starts with (demo coins)

// ---- admin portal ----
// The admin portal (/admin) is only for the Google account below.
// Change it with the ADMIN_EMAIL env var on Render.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'ravicharan319@gmail.com').toLowerCase();
function isAdmin(profile) { return !!profile && profile.provider === 'google' && (profile.email || '').toLowerCase() === ADMIN_EMAIL; }

// Admin settings that survive a server restart (bans + free trial).
// NOTE: on Render's free tier the disk is ephemeral, so these reset when the
// site is redeployed or the instance restarts. The file is the best we can
// do without a database.
const ADMIN_CONFIG_PATH = path.join(__dirname, 'admin-config.json');
let adminConfig = { trialActive: true, trialUntil: '2026-11-13T23:59:59-05:00', bans: [] };
try {
  const saved = JSON.parse(fs.readFileSync(ADMIN_CONFIG_PATH, 'utf8'));
  if (saved && typeof saved === 'object') {
    adminConfig = { ...adminConfig, ...saved, bans: Array.isArray(saved.bans) ? saved.bans : [] };
  }
} catch {}
function saveAdminConfig() { try { fs.writeFileSync(ADMIN_CONFIG_PATH, JSON.stringify(adminConfig, null, 2)); } catch {} }
const bannedEmails = new Set(adminConfig.bans.map(b => String(b.email || '').toLowerCase()).filter(Boolean));
function isBannedEmail(email) { return !!email && bannedEmails.has(String(email).toLowerCase()); }

// ---- free trial ----
// While the trial is active, all gifts are FREE (cost 0 coins) so people can
// gift as much as they like. The admin portal can turn it off or extend it;
// the setting is stored in admin-config.json.
let FREE_TRIAL = adminConfig.trialActive !== false;
let FREE_TRIAL_UNTIL = new Date(adminConfig.trialUntil || '2026-11-13T23:59:59-05:00');
function trialActive() { return FREE_TRIAL && new Date() < FREE_TRIAL_UNTIL; }

// Gifts catalog — same list the client shows. Cost in coins.
const GIFTS = {
  rose:    { name: 'Rose',    emoji: '🌹', cost: 10 },
  heart:   { name: 'Heart',   emoji: '❤️', cost: 25 },
  diamond: { name: 'Diamond', emoji: '💎', cost: 50 },
  crown:   { name: 'Crown',   emoji: '👑', cost: 100 },
  rocket:  { name: 'Rocket',  emoji: '🚀', cost: 200 },
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'client')));
app.get('/health', (req, res) => res.json({ ok: true, online: clients.size }));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'privacy.html')));

// ---- Sign in with Google / Apple (optional) ----
// Set these as environment variables on Render (see README "Sign in").
// Until they are set, the buttons stay hidden and guest sign-in works as-is.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || ''; // Services ID, e.g. com.meetlive.app
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || '';
const APPLE_KEY_ID = process.env.APPLE_KEY_ID || '';
const APPLE_PRIVATE_KEY = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// Short-lived sign-in sessions: token -> { profile, expires }.
// In-memory only — a server restart signs everyone out (fine for now).
const sessions = new Map();
function createSession(profile) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { profile, expires: Date.now() + 24 * 3600 * 1000 });
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s.profile;
}

// Public sign-in config the web client needs (client IDs are public, not secrets).
app.get('/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null, appleClientId: APPLE_CLIENT_ID || null });
});

// Google: verify the ID token Google gave the browser.
app.post('/auth/google', async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID) return res.status(501).json({ error: 'Google sign-in is not configured yet.' });
    const idToken = String(req.body?.idToken || '');
    if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, { signal: AbortSignal.timeout(10000) });
    const info = await r.json();
    if (!r.ok || info.aud !== GOOGLE_CLIENT_ID) return res.status(401).json({ error: 'Invalid Google sign-in.' });
    if (info.exp && Number(info.exp) * 1000 < Date.now()) return res.status(401).json({ error: 'Google sign-in expired.' });
    const profile = { provider: 'google', name: info.name || 'Google user', email: info.email || '', picture: info.picture || '', sub: info.sub };
    res.json({ ok: true, session: createSession(profile), profile });
  } catch (e) {
    res.status(500).json({ error: 'Google verification failed.' });
  }
});

// Apple: build the client_secret JWT (ES256) Apple requires.
function appleClientSecret() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'ES256', kid: APPLE_KEY_ID, typ: 'JWT' })}.${b64({ iss: APPLE_TEAM_ID, iat: now, exp: now + 3600, aud: 'https://appleid.apple.com', sub: APPLE_CLIENT_ID })}`;
  const sign = crypto.createSign('SHA256');
  sign.update(data);
  sign.end();
  const sig = sign.sign({ key: APPLE_PRIVATE_KEY, dsaEncoding: 'ieee-p1363' });
  return `${data}.${sig.toString('base64url')}`;
}

// Apple: verify the id_token (RS256) against Apple's public keys.
async function verifyAppleIdToken(idToken) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (payload.iss !== 'https://appleid.apple.com') throw new Error('bad issuer');
  if (payload.aud !== APPLE_CLIENT_ID) throw new Error('bad audience');
  if (payload.exp * 1000 < Date.now()) throw new Error('expired');
  const jwks = await (await fetch('https://appleid.apple.com/auth/keys', { signal: AbortSignal.timeout(10000) })).json();
  const key = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!key) throw new Error('unknown key');
  const pub = crypto.createPublicKey({ key, format: 'jwk' });
  const ok = crypto.verify('SHA256', Buffer.from(parts[0] + '.' + parts[1]), pub, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('bad signature');
  return payload;
}

app.post('/auth/apple', async (req, res) => {
  try {
    if (!APPLE_CLIENT_ID || !APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY) {
      return res.status(501).json({ error: 'Apple sign-in is not configured yet.' });
    }
    const code = String(req.body?.code || '');
    if (!code) return res.status(400).json({ error: 'Missing authorization code.' });
    const body = new URLSearchParams({
      client_id: APPLE_CLIENT_ID,
      client_secret: appleClientSecret(),
      code,
      grant_type: 'authorization_code',
    });
    const r = await fetch('https://appleid.apple.com/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const tokens = await r.json();
    if (!r.ok || !tokens.id_token) return res.status(401).json({ error: 'Apple sign-in failed.' });
    const claims = await verifyAppleIdToken(tokens.id_token);
    // Apple only sends the name on the FIRST sign-in, from the browser.
    const first = req.body?.user || {};
    const name = [first?.name?.firstName, first?.name?.lastName].filter(Boolean).join(' ') || 'Apple user';
    const profile = { provider: 'apple', name, email: claims.email || first?.email || '', picture: '', sub: claims.sub };
    res.json({ ok: true, session: createSession(profile), profile });
  } catch (e) {
    res.status(500).json({ error: 'Apple verification failed.' });
  }
});

// ---- Admin portal API ----
// Every route here needs a Google session for the admin account.
// The admin page sends it as: Authorization: Bearer <session token>.
function requireAdmin(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const profile = getSession(token);
  if (!profile || !isAdmin(profile)) return res.status(403).json({ error: 'Admin access only.' });
  req.adminProfile = profile;
  next();
}
function findUserById(id) {
  for (const u of clients.values()) if (u.id === id) return u;
  return null;
}
function kickUser(user, reason) {
  endPair(user, reason || 'kicked');
  removeFromWaiting(user);
  try { user.ws.close(); } catch {}
}
function readReports() {
  try {
    const lines = fs.readFileSync(path.join(__dirname, 'reports.log'), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-100).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return [...reports].reverse(); }
}
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'admin.html')));
app.get('/admin/api/stats', requireAdmin, (req, res) => {
  res.json({
    online: clients.size,
    waiting: waiting.length,
    inCall: pairs.size / 2,
    totalMatches: stats.totalMatches,
    totalMessages: stats.totalMessages,
    totalGifts: stats.totalGifts,
    giftCounts: stats.giftCounts,
    gifts: Object.fromEntries(Object.entries(GIFTS).map(([k, g]) => [k, { name: g.name, emoji: g.emoji, cost: g.cost }])),
    trialActive: trialActive(),
    trialSetting: FREE_TRIAL,
    trialUntil: FREE_TRIAL_UNTIL.toISOString(),
    uptimeSec: Math.floor((Date.now() - stats.startedAt) / 1000),
    serverTime: new Date().toISOString(),
  });
});
app.get('/admin/api/users', requireAdmin, (req, res) => {
  const list = [...clients.values()].map(u => ({
    id: u.id,
    nickname: u.nickname,
    email: u.verified ? u.verified.email : '',
    googlePhoto: u.verified ? u.verified.picture : '', // Google profile photo
    photo: u.photo || null, // profile photo they picked in the app
    gender: u.gender,
    coins: u.coins,
    status: pairs.has(u.id) ? 'in-call' : (waiting.includes(u) ? 'waiting' : 'idle'),
    partnerId: pairs.get(u.id) ? pairs.get(u.id).id : null,
    joinedAt: u.joinedAt,
  }));
  res.json({ users: list });
});
app.get('/admin/api/reports', requireAdmin, (req, res) => {
  res.json({ reports: readReports() });
});
app.get('/admin/api/bans', requireAdmin, (req, res) => {
  res.json({ bans: adminConfig.bans });
});
app.post('/admin/api/ban', requireAdmin, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const userId = Number(req.body?.userId);
  let target = null;
  if (userId) target = findUserById(userId);
  const banEmail = String((target && target.verified ? target.verified.email : email) || '').toLowerCase();
  if (!banEmail) return res.status(400).json({ error: 'Give a user or an email to ban.' });
  if (!adminConfig.bans.some(b => String(b.email).toLowerCase() === banEmail)) {
    adminConfig.bans.push({ email: banEmail, bannedAt: new Date().toISOString(), bannedBy: req.adminProfile.email });
    bannedEmails.add(banEmail);
    saveAdminConfig();
  }
  if (target) kickUser(target, 'banned');
  res.json({ ok: true, banned: banEmail });
});
app.post('/admin/api/unban', requireAdmin, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  adminConfig.bans = adminConfig.bans.filter(b => String(b.email).toLowerCase() !== email);
  bannedEmails.delete(email);
  saveAdminConfig();
  res.json({ ok: true });
});
app.post('/admin/api/kick', requireAdmin, (req, res) => {
  const user = findUserById(Number(req.body?.userId));
  if (!user) return res.status(404).json({ error: 'User is no longer online.' });
  kickUser(user, 'kicked');
  res.json({ ok: true });
});
app.post('/admin/api/trial', requireAdmin, (req, res) => {
  if (typeof req.body?.active === 'boolean') FREE_TRIAL = req.body.active;
  if (req.body?.until) {
    const d = new Date(req.body.until);
    if (!isNaN(d)) FREE_TRIAL_UNTIL = d;
  }
  adminConfig.trialActive = FREE_TRIAL;
  adminConfig.trialUntil = FREE_TRIAL_UNTIL.toISOString();
  saveAdminConfig();
  res.json({ ok: true, trialActive: trialActive(), trialSetting: FREE_TRIAL, trialUntil: FREE_TRIAL_UNTIL.toISOString() });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---- state (in-memory; restart clears it — fine for a first launch) ----
let nextId = 1;
const clients = new Map(); // ws -> user
const waiting = [];        // users waiting for a match
const pairs = new Map();   // userId -> partner user
const reports = [];        // report log (also appended to reports.log)

// Stats for the admin portal (reset when the server restarts).
const stats = { totalMatches: 0, totalMessages: 0, totalGifts: 0, giftCounts: {}, startedAt: Date.now() };

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastOnline() {
  const n = clients.size;
  for (const ws of clients.keys()) send(ws, { type: 'online', count: n });
}

function removeFromWaiting(user) {
  const i = waiting.indexOf(user);
  if (i !== -1) waiting.splice(i, 1);
}

// End a call. The partner is told the stranger left.
function endPair(user, reason) {
  const partner = pairs.get(user.id);
  if (partner) {
    pairs.delete(user.id);
    pairs.delete(partner.id);
    send(partner.ws, { type: 'peer-left', reason: reason || 'left' });
  }
}

// Try to pair `user` with someone waiting. Skips people either side blocked.
function tryMatch(user) {
  for (let i = 0; i < waiting.length; i++) {
    const other = waiting[i];
    if (other === user) continue;
    if (user.blocked.has(other.id) || other.blocked.has(user.id)) continue;
    waiting.splice(i, 1);
    pairs.set(user.id, other);
    pairs.set(other.id, user);
    stats.totalMatches++;
    // `user` is the initiator: they create the WebRTC offer.
    send(user.ws, { type: 'matched', peer: { id: other.id, nickname: other.nickname, gender: other.gender, verified: !!other.verified, photo: other.photo || null }, initiator: true });
    send(other.ws, { type: 'matched', peer: { id: user.id, nickname: user.nickname, gender: user.gender, verified: !!user.verified, photo: user.photo || null }, initiator: false });
    return true;
  }
  return false;
}

wss.on('connection', (ws) => {
  const user = {
    id: nextId++,
    ws,
    nickname: 'Guest',
    gender: 'other',
    coins: START_COINS,
    blocked: new Set(), // user ids this user never wants to match again
    joinedAt: Date.now(),
  };
  clients.set(ws, user);
  send(ws, { type: 'welcome', id: user.id, coins: user.coins, freeTrial: trialActive() });
  broadcastOnline();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const partner = pairs.get(user.id);
    // Google sign-in is required: only 'join' is accepted until the user
    // has a verified Google session.
    if (msg.type !== 'join' && (!user.verified || user.verified.provider !== 'google')) return;

    switch (msg.type) {
      case 'join': {
        // Google sign-in is required: no guest joins.
        const profile = getSession(msg.session);
        if (!profile || profile.provider !== 'google') {
          send(ws, { type: 'auth-required', message: 'Sign in with Google to use MeetLive.' });
          setTimeout(() => { try { ws.close(); } catch {} }, 100);
          break;
        }
        user.verified = profile;
        // Banned accounts cannot join.
        if (isBannedEmail(profile.email)) {
          send(ws, { type: 'auth-required', message: 'This account is banned from MeetLive.' });
          setTimeout(() => { try { ws.close(); } catch {} }, 100);
          break;
        }
        // Display name is editable after sign-in: use the typed name when
        // given, otherwise the Google name. The ✓ badge stays — the user
        // is still a verified Google account.
        const displayName = String(msg.nickname || '').trim().slice(0, 20);
        user.nickname = displayName || profile.name.slice(0, 20);
        user.gender = ['male', 'female', 'other'].includes(msg.gender) ? msg.gender : 'other';
        // Optional profile photo (small data URL or a Google photo URL) —
        // shown to the matched stranger when the camera is off.
        user.photo = typeof msg.photo === 'string' ? msg.photo.slice(0, 200000) : null;
        break;
      }

      case 'find':
        if (pairs.get(user.id)) break; // already in a call
        // Only say "searching" when no match was found. (Bug fix: the old
        // code sent 'searching' even after a match, which kicked the second
        // device back to the "looking for a stranger" screen mid-call.)
        if (!tryMatch(user)) {
          if (!waiting.includes(user)) waiting.push(user);
          send(ws, { type: 'searching' });
        }
        break;

      case 'cancel-find':
        removeFromWaiting(user);
        break;

      // WebRTC signaling — relayed straight to the partner.
      case 'offer':
      case 'answer':
      case 'ice':
        if (partner) send(partner.ws, { type: msg.type, from: user.id, data: msg.data });
        break;

      case 'chat':
        if (partner) {
          stats.totalMessages++;
          send(partner.ws, { type: 'chat', from: user.id, nickname: user.nickname, text: String(msg.text || '').slice(0, 500) });
        }
        break;

      // Camera on/off — relayed so the partner can show a wallpaper
      // placeholder instead of a black video.
      case 'cam-state':
        if (partner) send(partner.ws, { type: 'cam-state', from: user.id, on: msg.on === true });
        break;

      // Floating reaction — relayed so it floats up on the partner's screen.
      case 'reaction': {
        const ok = ['❤️', '🔥', '😂', '😍', '👏', '✨'];
        if (partner) send(partner.ws, { type: 'reaction', from: user.id, nickname: user.nickname, emoji: ok.includes(msg.emoji) ? msg.emoji : '❤️' });
        break;
      }

      // Beauty filter — relayed so the partner renders YOUR filter on
      // their screen (works on every phone, unlike baking it into the
      // sent video, which older browsers can't do).
      case 'filter':
        if (partner) send(partner.ws, { type: 'filter', from: user.id, filter: String(msg.filter || '').slice(0, 200) });
        break;

      case 'gift': {
        const gift = GIFTS[msg.gift];
        if (!gift || !partner) break;
        // During the free trial, gifts cost 0 so everyone can gift freely.
        const cost = trialActive() ? 0 : gift.cost;
        if (user.coins < cost) {
          send(ws, { type: 'error', message: 'Not enough coins — tap + to get free demo coins.' });
          break;
        }
        user.coins -= cost;
        partner.coins += cost; // receiver earns the coins, like a host on Chamet
        stats.totalGifts++;
        stats.giftCounts[msg.gift] = (stats.giftCounts[msg.gift] || 0) + 1;
        send(ws, { type: 'coins', coins: user.coins });
        send(partner.ws, { type: 'coins', coins: partner.coins });
        send(partner.ws, { type: 'gift', from: user.id, nickname: user.nickname, gift: msg.gift, emoji: gift.emoji, name: gift.name });
        send(ws, { type: 'gift-sent', gift: msg.gift, emoji: gift.emoji, name: gift.name });
        break;
      }

      case 'free-coins':
        // Demo only: free coins so people can try gifts without paying.
        // Replace with a real payment flow before launching publicly.
        user.coins += 100;
        send(ws, { type: 'coins', coins: user.coins });
        break;

      case 'report': {
        const reason = String(msg.reason || 'other').slice(0, 100);
        const entry = {
          time: new Date().toISOString(),
          reporter: user.id,
          reporterName: user.nickname,
          reporterEmail: user.verified ? user.verified.email : '',
          reported: partner ? partner.id : null,
          reportedName: partner ? partner.nickname : null,
          reportedEmail: partner && partner.verified ? partner.verified.email : '',
          reason,
        };
        reports.push(entry);
        try { fs.appendFileSync(path.join(__dirname, 'reports.log'), JSON.stringify(entry) + '\n'); } catch {}
        console.log('REPORT:', JSON.stringify(entry));
        if (partner) { user.blocked.add(partner.id); partner.blocked.add(user.id); }
        send(ws, { type: 'reported' });
        endPair(user, 'reported');
        break;
      }

      case 'block':
        if (partner) user.blocked.add(partner.id);
        endPair(user, 'blocked');
        break;

      case 'next':
        endPair(user, 'next');
        if (!tryMatch(user)) {
          if (!waiting.includes(user)) waiting.push(user);
          send(ws, { type: 'searching' });
        }
        break;

      case 'leave':
        endPair(user, 'left');
        break;
    }
  });

  ws.on('close', () => {
    removeFromWaiting(user);
    endPair(user, 'disconnected');
    clients.delete(ws);
    broadcastOnline();
  });
});

server.listen(PORT, () => {
  console.log(`MeetLive server running on http://localhost:${PORT}`);
  console.log('Open it in two browser windows/tabs to test matching.');
});
