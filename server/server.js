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
let adminConfig = { trialActive: false, trialUntil: '2026-11-13T23:59:59-05:00', bans: [] };
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

// ---- call billing: the first 55s of every call are free, then it costs diamonds ----
// Each person pays for their own time: 1 diamond per 30s after the free 55s.
// When someone runs out of diamonds mid-call, the call ends for both.
// (Demo currency for now: everyone starts with free diamonds and can tap
// for more. Plug in a real payment flow before charging real money.)
const FREE_CALL_SECONDS = 55;
const DIAMOND_RATE_SECONDS = 30; // 1 diamond per 30s after the free period
const START_DIAMONDS = 0; // new accounts start with no diamonds — they buy them

// Gifts catalog — same list the client shows. Cost in coins.
const GIFTS = {
  rose:    { name: 'Rose',    emoji: '🌹', cost: 10 },
  heart:   { name: 'Heart',   emoji: '❤️', cost: 25 },
  diamond: { name: 'Diamond', emoji: '💎', cost: 50 },
  crown:   { name: 'Crown',   emoji: '👑', cost: 100 },
  rocket:  { name: 'Rocket',  emoji: '🚀', cost: 200 },
};

// ---- diamond buying (Stripe Checkout) ----
// The diamond packages sold through Stripe. Price IDs are the test-mode
// prices in the connected Stripe account; swap them for live-mode price IDs
// when going live. Set STRIPE_SECRET_KEY on Render to turn buying on —
// without it the buy buttons tell the user buying isn't set up yet.
// (The webhook secret lets the server verify Stripe's payment notices.)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;
const DIAMOND_PACKS = [
  { diamonds: 50,   price: 0.99,  priceId: 'price_1UaTRGRzfiKGDM2jo3v8Att7' },
  { diamonds: 120,  price: 1.99,  priceId: 'price_1UaTXfRzfiKGDM2j6hHsYzec' },
  { diamonds: 300,  price: 4.99,  priceId: 'price_1UaTXfRzfiKGDM2j1bDGvkA8' },
  { diamonds: 1000, price: 14.99, priceId: 'price_1UaTXfRzfiKGDM2jX794TjFD' },
];

// Bought diamonds must survive reconnects and restarts, so balances live in
// a file keyed by email (same ephemeral-disk caveat as the admin config).
// Processed checkout IDs are stored too, so a retried payment notice can
// never credit the same purchase twice.
const DIAMOND_STORE_PATH = path.join(__dirname, 'diamond-balances.json');
let diamondBalances = {};
const processedCheckouts = new Set();
try {
  const saved = JSON.parse(fs.readFileSync(DIAMOND_STORE_PATH, 'utf8'));
  if (saved && typeof saved === 'object') {
    if (saved.balances && typeof saved.balances === 'object') diamondBalances = saved.balances;
    if (Array.isArray(saved.processedCheckouts)) saved.processedCheckouts.forEach(id => processedCheckouts.add(id));
  }
} catch {}
function saveDiamondStore() {
  try { fs.writeFileSync(DIAMOND_STORE_PATH, JSON.stringify({ balances: diamondBalances, processedCheckouts: [...processedCheckouts] })); } catch {}
}
function getDiamondBalance(email) {
  const key = String(email || '').toLowerCase();
  if (!key) return START_DIAMONDS;
  if (diamondBalances[key] == null) diamondBalances[key] = START_DIAMONDS;
  return diamondBalances[key];
}
function setDiamondBalance(email, n) {
  const key = String(email || '').toLowerCase();
  if (!key) return;
  diamondBalances[key] = Math.max(0, Math.floor(n));
  saveDiamondStore();
}
// Keep a connected user's stored balance in step with their live balance.
function syncDiamonds(user) {
  if (user.verified && user.verified.email) setDiamondBalance(user.verified.email, user.diamonds);
}

const app = express();
// Stripe's payment webhook needs the raw body to verify its signature, so
// it is registered before the JSON parser.
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(501).json({ error: 'Stripe is not configured.' });
  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (e) {
    return res.status(400).send('Bad webhook.');
  }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    // Never credit the same checkout twice (Stripe can retry deliveries).
    if (s.id && processedCheckouts.has(s.id)) return res.json({ received: true, duplicate: true });
    if (s.id) processedCheckouts.add(s.id);
    const email = String(s.metadata?.email || s.customer_email || '').toLowerCase();
    const diamonds = parseInt(s.metadata?.diamonds || '0', 10);
    if (email && diamonds > 0) {
      const bal = getDiamondBalance(email) + diamonds;
      setDiamondBalance(email, bal);
      saveDiamondStore();
      // If the buyer is online right now, top up their live balance too.
      for (const u of clients.values()) {
        if (u.verified && String(u.verified.email || '').toLowerCase() === email) {
          u.diamonds = bal;
          send(u.ws, { type: 'diamonds', diamonds: u.diamonds });
          send(u.ws, { type: 'purchase-complete', diamonds });
        }
      }
      console.log('DIAMONDS SOLD:', email, '+', diamonds);
    }
  }
  res.json({ received: true });
});
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

// ---- sign-in sessions (signed tokens, not stored server-side) ----
// The old sessions lived in memory, so every redeploy wiped them and signed
// everyone out. Now a session is a signed token: the server can verify it
// without storing it, so it survives restarts and redeploys. The signing
// secret MUST be set as SESSION_SECRET on Render (any long random string) —
// it stays the same across deploys. Without it, sessions fall back to
// in-memory only and a restart signs everyone out again.
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_TTL_MS = 24 * 3600 * 1000; // sessions last 24 hours
const sessions = new Map(); // fallback store, only used when no SESSION_SECRET
function createSession(profile) {
  if (SESSION_SECRET) {
    const payload = { profile, exp: Date.now() + SESSION_TTL_MS };
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
    return data + '.' + sig;
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { profile, expires: Date.now() + SESSION_TTL_MS });
  return token;
}
function getSession(token) {
  if (!token) return null;
  if (SESSION_SECRET) {
    const parts = String(token).split('.');
    if (parts.length !== 2) return null;
    const [data, sig] = parts;
    const expect = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
    if (sig.length !== expect.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    try {
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
      if (!payload || !payload.profile || !payload.exp || payload.exp < Date.now()) return null;
      return payload.profile;
    } catch { return null; }
  }
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
    diamonds: u.diamonds,
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

// ---- Diamond buying API ----
// The packages the app shows, and whether buying is switched on.
app.get('/api/diamond-packs', (req, res) => {
  res.json({ buyingEnabled: !!stripe, packs: DIAMOND_PACKS.map(p => ({ diamonds: p.diamonds, price: p.price, priceId: p.priceId })) });
});
// Start a Stripe Checkout for a diamond package. Returns the payment URL.
app.post('/api/buy-diamonds', async (req, res) => {
  if (!stripe) return res.status(501).json({ error: 'Diamond buying is not set up yet.' });
  const profile = getSession(req.body?.session);
  if (!profile || profile.provider !== 'google') return res.status(401).json({ error: 'Sign in first.' });
  const priceId = String(req.body?.priceId || '');
  const pack = DIAMOND_PACKS.find(p => p.priceId === priceId);
  if (!pack) return res.status(400).json({ error: 'Unknown diamond package.' });
  try {
    const base = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { email: profile.email, diamonds: String(pack.diamonds) },
      customer_email: profile.email,
      success_url: `${base}/?bought=1`,
      cancel_url: `${base}/?cancelled=1`,
    });
    res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error('Checkout failed:', e.message);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
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
  // The billing clock stops with the call.
  user.callStartAt = null; user.diamondsBilled = 0;
  if (partner) { partner.callStartAt = null; partner.diamondsBilled = 0; }
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
    // Start the billing clock for both: 55s free, then diamonds.
    user.callStartAt = Date.now(); user.diamondsBilled = 0;
    other.callStartAt = Date.now(); other.diamondsBilled = 0;
    // `user` is the initiator: they create the WebRTC offer.
    send(user.ws, { type: 'matched', peer: { id: other.id, nickname: other.nickname, gender: other.gender, verified: !!other.verified, photo: other.photo || null }, initiator: true, freeSeconds: FREE_CALL_SECONDS, diamonds: user.diamonds });
    send(other.ws, { type: 'matched', peer: { id: user.id, nickname: user.nickname, gender: user.gender, verified: !!user.verified, photo: user.photo || null }, initiator: false, freeSeconds: FREE_CALL_SECONDS, diamonds: other.diamonds });
    return true;
  }
  return false;
}

// ---- call billing (runs every 5s) ----
// After the free 55s, each 30s block costs 1 diamond from each person.
// Someone who cannot pay has their call ended.
function billPair(user, partner) {
  const now = Date.now();
  for (const u of [user, partner]) {
    if (!u.callStartAt) continue;
    const elapsed = (now - u.callStartAt) / 1000;
    const billable = Math.max(0, elapsed - FREE_CALL_SECONDS);
    const blocks = Math.floor(billable / DIAMOND_RATE_SECONDS);
    const owed = blocks - (u.diamondsBilled || 0);
    if (owed <= 0) continue;
    if (u.diamonds >= owed) {
      u.diamonds -= owed;
      u.diamondsBilled = blocks;
      syncDiamonds(u);
      send(u.ws, { type: 'diamonds', diamonds: u.diamonds });
    } else {
      // Out of diamonds — end the call for both.
      send(u.ws, { type: 'time-up', message: 'Out of diamonds — the call has ended.' });
      endPair(u, 'out-of-diamonds');
      return;
    }
  }
}
setInterval(() => {
  // Snapshot the pairs first (each pair appears twice in the map).
  const done = new Set();
  const list = [];
  for (const [id, partner] of pairs) {
    if (done.has(id) || done.has(partner.id)) continue;
    const user = findUserById(id);
    if (!user) continue;
    done.add(id); done.add(partner.id);
    list.push([user, partner]);
  }
  for (const [user, partner] of list) billPair(user, partner);
}, 5000);

wss.on('connection', (ws) => {
  const user = {
    id: nextId++,
    ws,
    nickname: 'Guest',
    gender: 'other',
    coins: START_COINS,
    diamonds: START_DIAMONDS, // pays for call time after the free 55s
    callStartAt: null,         // set when matched; drives the billing clock
    diamondsBilled: 0,        // 30s blocks already charged for this call
    blocked: new Set(), // user ids this user never wants to match again
    joinedAt: Date.now(),
  };
  clients.set(ws, user);
  send(ws, { type: 'welcome', id: user.id, coins: user.coins, diamonds: user.diamonds, freeTrial: trialActive() });
  broadcastOnline();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const partner = pairs.get(user.id);
    // Ignore everything until the user has joined (guest or signed in).
    if (msg.type !== 'join' && !user.joined) return;

    switch (msg.type) {
      case 'join': {
        // Sign-in is optional now: guests join with just a nickname.
        // A valid Google session still gives the ✓ badge and loads
        // their bought diamonds.
        const profile = getSession(msg.session);
        const displayName = String(msg.nickname || '').trim().slice(0, 20);
        if (profile && profile.provider === 'google') {
          user.verified = profile;
          // Banned accounts cannot join.
          if (isBannedEmail(profile.email)) {
            send(ws, { type: 'auth-required', message: 'This account is banned from MeetLive.' });
            setTimeout(() => { try { ws.close(); } catch {} }, 100);
            break;
          }
          // Load their bought diamonds.
          user.diamonds = getDiamondBalance(profile.email);
          send(ws, { type: 'diamonds', diamonds: user.diamonds });
          // Display name is editable after sign-in: use the typed name
          // when given, otherwise the Google name. The ✓ badge stays —
          // the user is still a verified Google account.
          user.nickname = displayName || profile.name.slice(0, 20);
        } else {
          // Guest: no verification, no bought diamonds, just a nickname.
          user.verified = null;
          user.diamonds = START_DIAMONDS;
          user.nickname = displayName || ('Guest' + Math.floor(1000 + Math.random() * 9000));
        }
        user.gender = ['male', 'female', 'other'].includes(msg.gender) ? msg.gender : 'other';
        // Optional profile photo (small data URL or a Google photo URL) —
        // shown to the matched stranger when the camera is off.
        user.photo = typeof msg.photo === 'string' ? msg.photo.slice(0, 200000) : null;
        user.joined = true;
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
