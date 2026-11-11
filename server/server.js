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

// Gifts catalog — costs are in DIAMONDS now (not coins) and live in
// gifts.json so the admin can change the prices without a redeploy.
// Same gift ids/emojis/names the client shows.
const GIFTS_PATH = path.join(__dirname, 'gifts.json');
const DEFAULT_GIFTS = {
  rose:    { name: 'Rose',    emoji: '🌹', cost: 1 },
  heart:   { name: 'Heart',   emoji: '❤️', cost: 2 },
  diamond: { name: 'Diamond', emoji: '💎', cost: 5 },
  crown:   { name: 'Crown',   emoji: '👑', cost: 10 },
  rocket:  { name: 'Rocket',  emoji: '🚀', cost: 20 },
};
let GIFTS = {};
for (const [id, g] of Object.entries(DEFAULT_GIFTS)) GIFTS[id] = { ...g };
let giftsLoaded = false;
try {
  const saved = JSON.parse(fs.readFileSync(GIFTS_PATH, 'utf8'));
  if (saved && typeof saved === 'object') {
    for (const [id, g] of Object.entries(saved)) {
      if (g && typeof g === 'object' && typeof g.cost === 'number') {
        GIFTS[id] = { name: g.name || id, emoji: g.emoji || '🎁', cost: Math.max(0, Math.floor(g.cost)) };
      }
    }
    giftsLoaded = true;
  }
} catch {}
// Create the file with the defaults if it was missing (or unreadable).
if (!giftsLoaded) saveGifts();
function saveGifts() { try { fs.writeFileSync(GIFTS_PATH, JSON.stringify(GIFTS, null, 2)); } catch {} }
function giftCatalog() { return Object.entries(GIFTS).map(([id, g]) => ({ id, name: g.name, emoji: g.emoji, cost: g.cost })); }

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
  { diamonds: 50,   price: 0.99,  priceId: 'price_1UadwJ2LyeHfZCaiPS9fVJI3' },
  { diamonds: 120,  price: 1.99,  priceId: 'price_1UadxM2LyeHfZCaiEjy7UJHr' },
  { diamonds: 300,  price: 4.99,  priceId: 'price_1UadyF2LyeHfZCaiXp7cZ2tn' },
  { diamonds: 1000, price: 14.99, priceId: 'price_1Uadz22LyeHfZCaiO4l98jH1' },
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

// ---- profiles: each user's public listing + what they charge to be called ----
// Chamet-style: anyone can set their own diamonds-per-minute price, and
// callers pay that rate while the callee earns it. Keyed by lowercase email.
// Same ephemeral-disk caveat as the diamond balances.
const DEFAULT_CALL_PRICE = 2; // diamonds per minute to call someone
const PROFILES_PATH = path.join(__dirname, 'profiles.json');
let profiles = {};
try {
  const saved = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
  if (saved && typeof saved === 'object') profiles = saved;
} catch {}
function saveProfiles() { try { fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2)); } catch {} }

// ---- follows: who each user follows (Chamet-style friend list) ----
const FOLLOWS_PATH = path.join(__dirname, 'follows.json');
let follows = {};
try {
  const saved = JSON.parse(fs.readFileSync(FOLLOWS_PATH, 'utf8'));
  if (saved && typeof saved === 'object') follows = saved;
} catch {}
function saveFollows() { try { fs.writeFileSync(FOLLOWS_PATH, JSON.stringify(follows, null, 2)); } catch {} }

// ---- direct messages: one conversation per pair of emails ----
// Key is the two lowercase emails sorted and joined with '|', so both
// directions share the same conversation. Capped at 200 messages each.
const DMS_PATH = path.join(__dirname, 'dms.json');
let dms = {};
try {
  const saved = JSON.parse(fs.readFileSync(DMS_PATH, 'utf8'));
  if (saved && typeof saved === 'object') dms = saved;
} catch {}
function saveDMs() { try { fs.writeFileSync(DMS_PATH, JSON.stringify(dms, null, 2)); } catch {} }
// Unread counts live in memory only (a restart clears badges, not messages).
const unreadCounts = new Map(); // recipientEmail -> Map senderEmail -> count
function bumpUnread(to, from) {
  const t = String(to).toLowerCase(), f = String(from).toLowerCase();
  let m = unreadCounts.get(t);
  if (!m) { m = new Map(); unreadCounts.set(t, m); }
  m.set(f, (m.get(f) || 0) + 1);
}
function clearUnread(userEmail, fromEmail) {
  const m = unreadCounts.get(String(userEmail).toLowerCase());
  if (m) m.delete(String(fromEmail).toLowerCase());
}
function totalUnread(userEmail) {
  const m = unreadCounts.get(String(userEmail).toLowerCase());
  if (!m) return 0;
  let t = 0;
  for (const n of m.values()) t += n;
  return t;
}
function dmKey(a, b) { return [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('|'); }

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
    gifts: giftCatalog(), // same array shape as GET /api/gifts
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
// Gift prices (diamonds) — the admin can change what each gift costs.
app.post('/admin/api/gifts', requireAdmin, (req, res) => {
  const incoming = req.body?.gifts;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Send { gifts: { id: { cost } } }.' });
  for (const [id, g] of Object.entries(incoming)) {
    if (!GIFTS[id]) continue; // unknown gift id — ignore it
    const cost = Math.floor(Number(g && g.cost));
    if (!Number.isFinite(cost) || cost < 0 || cost > 1000) {
      return res.status(400).json({ error: 'Each gift cost must be an integer 0..1000.' });
    }
    GIFTS[id].cost = cost;
  }
  saveGifts();
  res.json({ ok: true, gifts: giftCatalog() });
});

// ---- Gift catalog API ----
// The client fetches this to render the gift tray (diamond costs).
app.get('/api/gifts', (req, res) => {
  res.json({ gifts: giftCatalog() });
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
      // Managed Payments is on by default and demands a product tax code
      // on every product; these are simple virtual diamonds with no tax
      // set up yet, so turn it off for these sessions.
      managed_payments: { enabled: false },
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
const pendingCalls = new Map(); // target user id -> { from: user } (direct call requests)

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
  // The billing clock stops with the call, and so does direct-call billing.
  user.callStartAt = null; user.diamondsBilled = 0; user.direct = null;
  if (partner) { partner.callStartAt = null; partner.diamondsBilled = 0; partner.direct = null; }
}

// Find an online user by their (lowercase) email, or null.
function findUserByEmail(email) {
  const key = String(email || '').toLowerCase();
  if (!key) return null;
  for (const u of clients.values()) {
    if (u.verified && String(u.verified.email).toLowerCase() === key) return u;
  }
  return null;
}

// One directory entry for the Discover / Following lists and the DM inbox.
// Live data when the person is online, their saved profile when offline.
// Returns null when there is no profile at all (nothing to show).
function resolveDirectoryEntry(email) {
  const key = String(email || '').toLowerCase();
  if (!key) return null;
  const online = findUserByEmail(key);
  if (online) {
    return { email: key, nickname: online.nickname, photo: online.photo || null, callPrice: online.callPrice != null ? online.callPrice : DEFAULT_CALL_PRICE, gender: online.gender, verified: true, online: true };
  }
  const p = profiles[key];
  if (!p) return null;
  return { email: key, nickname: p.nickname || 'MeetLive user', photo: p.photo || null, callPrice: p.callPrice != null ? p.callPrice : DEFAULT_CALL_PRICE, gender: p.gender || 'other', verified: true, online: false };
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
    // Random matches are never direct calls.
    user.direct = null; other.direct = null;
    // Start the billing clock for both: 55s free, then diamonds.
    user.callStartAt = Date.now(); user.diamondsBilled = 0;
    other.callStartAt = Date.now(); other.diamondsBilled = 0;
    // `user` is the initiator: they create the WebRTC offer.
    send(user.ws, { type: 'matched', peer: { id: other.id, nickname: other.nickname, gender: other.gender, verified: !!other.verified, photo: other.photo || null, email: other.verified ? String(other.verified.email).toLowerCase() : '', callPrice: other.callPrice }, initiator: true, freeSeconds: FREE_CALL_SECONDS, diamonds: user.diamonds });
    send(other.ws, { type: 'matched', peer: { id: user.id, nickname: user.nickname, gender: user.gender, verified: !!user.verified, photo: user.photo || null, email: user.verified ? String(user.verified.email).toLowerCase() : '', callPrice: user.callPrice }, initiator: false, freeSeconds: FREE_CALL_SECONDS, diamonds: other.diamonds });
    return true;
  }
  return false;
}

// ---- call billing (runs every 5s) ----
// Random matches: after the free 55s, each 30s block costs 1 diamond from
// each person. Someone who cannot pay has their call ended.
// Direct calls (Chamet-style): there is NO free period — the CALLER pays
// the callee's rate (ratePerMin / 2 diamonds per 30s block) and the CALLEE
// earns exactly that amount. The callee is never charged.
function billPair(user, partner) {
  const now = Date.now();
  const direct = user.direct && partner.direct
    && user.direct.partnerId === partner.id && partner.direct.partnerId === user.id;
  if (direct) {
    const caller = user.direct.role === 'caller' ? user : partner;
    const callee = caller === user ? partner : user;
    if (!caller.callStartAt) return;
    const elapsed = (now - caller.callStartAt) / 1000;
    const blocks = Math.floor(elapsed / DIAMOND_RATE_SECONDS); // no free period
    const perBlock = caller.direct.ratePerMin / 2;
    const owed = (blocks - (caller.diamondsBilled || 0)) * perBlock;
    if (owed <= 0) return;
    if (caller.diamonds >= owed) {
      caller.diamonds -= owed;
      caller.diamondsBilled = blocks;
      callee.diamonds += owed;
      syncDiamonds(caller);
      syncDiamonds(callee);
      send(caller.ws, { type: 'diamonds', diamonds: caller.diamonds });
      send(callee.ws, { type: 'diamonds', diamonds: callee.diamonds });
    } else {
      // Caller is out of diamonds — end the call for both.
      send(caller.ws, { type: 'time-up', message: 'Out of diamonds — the call has ended.' });
      endPair(caller, 'out-of-diamonds');
    }
    return;
  }
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
    callPrice: DEFAULT_CALL_PRICE, // diamonds per minute others pay to call this user
    direct: null, // direct-call billing { role, ratePerMin, partnerId } while in one
    callStartAt: null,         // set when matched; drives the billing clock
    diamondsBilled: 0,        // 30s blocks already charged for this call
    blocked: new Set(), // user ids this user never wants to match again
    joinedAt: Date.now(),
  };
  clients.set(ws, user);
  send(ws, { type: 'welcome', id: user.id, coins: user.coins, diamonds: user.diamonds, freeTrial: trialActive(), callPrice: DEFAULT_CALL_PRICE, gifts: giftCatalog() });
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
        // Load their bought diamonds.
        user.diamonds = getDiamondBalance(profile.email);
        send(ws, { type: 'diamonds', diamonds: user.diamonds });
        // Display name is editable after sign-in: use the typed name when
        // given, otherwise the Google name. The ✓ badge stays — the user
        // is still a verified Google account.
        const displayName = String(msg.nickname || '').trim().slice(0, 20);
        user.nickname = displayName || profile.name.slice(0, 20);
        user.gender = ['male', 'female', 'other'].includes(msg.gender) ? msg.gender : 'other';
        // Optional profile photo (small data URL or a Google photo URL) —
        // shown to the matched stranger when the camera is off.
        user.photo = typeof msg.photo === 'string' ? msg.photo.slice(0, 200000) : null;
        user.joined = true;
        // Call price + public profile: load their own rate (default 2) and
        // keep their nickname/photo on file so follows and DMs can show
        // them even when they are offline.
        const emailKey = String(profile.email).toLowerCase();
        const savedProfile = profiles[emailKey];
        user.callPrice = savedProfile && typeof savedProfile.callPrice === 'number'
          ? Math.max(0, Math.min(100, Math.floor(savedProfile.callPrice)))
          : DEFAULT_CALL_PRICE;
        profiles[emailKey] = {
          callPrice: user.callPrice,
          nickname: user.nickname,
          photo: user.photo || null,
          gender: user.gender,
        };
        saveProfiles();
        // Silent: this just (re)states the saved price after login — the
        // client pre-fills the input without a "Call price set" toast.
        send(ws, { type: 'call-price', price: user.callPrice, silent: true });
        // Unread DMs badge for the Messages tab.
        send(ws, { type: 'dm-unread', total: totalUnread(emailKey) });
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
        // Cost is in DIAMONDS now — the receiver earns them, like a host.
        const cost = trialActive() ? 0 : gift.cost;
        if (user.diamonds < cost) {
          send(ws, { type: 'error', message: 'Not enough diamonds — tap Buy to get more.' });
          break;
        }
        user.diamonds -= cost;
        partner.diamonds += cost;
        syncDiamonds(user);
        syncDiamonds(partner);
        stats.totalGifts++;
        stats.giftCounts[msg.gift] = (stats.giftCounts[msg.gift] || 0) + 1;
        send(ws, { type: 'diamonds', diamonds: user.diamonds });
        send(partner.ws, { type: 'diamonds', diamonds: partner.diamonds });
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

      // ---- Chamet-style social: call price, follows, DMs, direct calls ----

      // Your own diamonds-per-minute price to be called (0..100).
      case 'set-call-price': {
        let price = parseInt(msg.price, 10);
        if (isNaN(price)) break;
        price = Math.max(0, Math.min(100, price));
        user.callPrice = price;
        const email = String(user.verified.email).toLowerCase();
        const p = profiles[email] || (profiles[email] = { callPrice: DEFAULT_CALL_PRICE, nickname: user.nickname, photo: user.photo || null, gender: user.gender });
        p.callPrice = price;
        saveProfiles();
        send(ws, { type: 'call-price', price });
        break;
      }

      case 'follow': {
        const me = String(user.verified.email).toLowerCase();
        const target = String(msg.email || '').trim().toLowerCase();
        if (target && target !== me) {
          const list = follows[me] || (follows[me] = []);
          if (!list.includes(target)) { list.push(target); saveFollows(); }
        }
        send(ws, { type: 'following', following: (follows[me] || []).slice() });
        break;
      }

      case 'unfollow': {
        const me = String(user.verified.email).toLowerCase();
        const target = String(msg.email || '').trim().toLowerCase();
        if (target && follows[me]) {
          follows[me] = follows[me].filter(e => e !== target);
          saveFollows();
        }
        send(ws, { type: 'following', following: (follows[me] || []).slice() });
        break;
      }

      // The people you follow, with live data when they are online.
      case 'get-following': {
        const me = String(user.verified.email).toLowerCase();
        const users = (follows[me] || []).map(e => resolveDirectoryEntry(e)).filter(Boolean);
        send(ws, { type: 'following-list', users });
        break;
      }

      // Everyone online right now (except you) — the Discover list.
      case 'get-online-users': {
        const me = String(user.verified.email).toLowerCase();
        const users = [];
        for (const u of clients.values()) {
          if (!u.verified || u === user) continue;
          const email = String(u.verified.email).toLowerCase();
          if (!email || email === me) continue;
          users.push({ email, nickname: u.nickname, photo: u.photo || null, callPrice: u.callPrice != null ? u.callPrice : DEFAULT_CALL_PRICE, gender: u.gender, verified: true });
        }
        send(ws, { type: 'online-users', users });
        break;
      }

      // Send a direct message. Stored even when the other person is
      // offline, so it is waiting for them; delivered live when online.
      case 'dm': {
        const to = String(msg.to || '').trim().toLowerCase();
        const text = String(msg.text || '').slice(0, 500);
        if (!to || !text) break;
        const from = String(user.verified.email).toLowerCase();
        if (to === from) break;
        const key = dmKey(from, to);
        const conv = dms[key] || (dms[key] = []);
        const entry = { from, to, text, time: Date.now() };
        conv.push(entry);
        if (conv.length > 200) conv.splice(0, conv.length - 200); // keep newest 200
        saveDMs();
        bumpUnread(to, from);
        const target = findUserByEmail(to);
        if (target) send(target.ws, { type: 'dm', from, fromName: user.nickname, text, time: entry.time });
        send(ws, { type: 'dm-sent', to, text, time: entry.time });
        break;
      }

      // One conversation's history (oldest first). Opening it clears
      // that conversation's unread count for you.
      case 'get-dms': {
        const other = String(msg.with || '').trim().toLowerCase();
        const me = String(user.verified.email).toLowerCase();
        clearUnread(me, other);
        send(ws, { type: 'dms', with: other, messages: (dms[dmKey(me, other)] || []).slice() });
        send(ws, { type: 'dm-unread', total: totalUnread(me) });
        break;
      }

      // Inbox: one entry per conversation, newest first.
      case 'get-conversations': {
        const me = String(user.verified.email).toLowerCase();
        const list = [];
        for (const key of Object.keys(dms)) {
          const parts = key.split('|');
          if (parts.length !== 2 || !parts.includes(me)) continue;
          const other = parts[0] === me ? parts[1] : parts[0];
          const conv = dms[key];
          if (!conv || !conv.length) continue;
          const last = conv[conv.length - 1];
          const resolved = resolveDirectoryEntry(other);
          list.push({
            email: other,
            nickname: resolved ? resolved.nickname : 'MeetLive user',
            photo: resolved ? resolved.photo : null,
            lastText: last.text,
            lastTime: last.time,
            unread: (unreadCounts.get(me) && unreadCounts.get(me).get(other)) || 0,
          });
        }
        list.sort((a, b) => b.lastTime - a.lastTime);
        send(ws, { type: 'conversations', list });
        break;
      }

      // Call a specific person: they get a request and can accept or
      // decline. The caller pays the callee's per-minute rate; the
      // callee earns it. Nobody is paired until the callee accepts.
      case 'call-request': {
        const to = String(msg.to || '').trim().toLowerCase();
        const me = String(user.verified.email).toLowerCase();
        if (!to || to === me) { send(ws, { type: 'call-error', message: 'You cannot call yourself.' }); break; }
        const target = findUserByEmail(to);
        if (!target) { send(ws, { type: 'call-error', message: 'User is offline right now.' }); break; }
        if (user.blocked.has(target.id) || target.blocked.has(user.id)) { send(ws, { type: 'call-error', message: 'Cannot call this user.' }); break; }
        if (pairs.has(user.id) || pairs.has(target.id)) { send(ws, { type: 'call-error', message: 'Busy — already in a call.' }); break; }
        pendingCalls.set(target.id, { from: user });
        send(target.ws, { type: 'incoming-call', from: { id: user.id, nickname: user.nickname, photo: user.photo || null, email: me }, callPrice: user.callPrice });
        break;
      }

      case 'call-accept': {
        const req = pendingCalls.get(user.id);
        if (!req || req.from.id !== Number(msg.fromId)) break;
        const caller = req.from;
        pendingCalls.delete(user.id);
        // Pair like tryMatch, but as a direct call: no free seconds, and
        // the caller pays the callee's rate while the callee earns it.
        pairs.set(caller.id, user);
        pairs.set(user.id, caller);
        stats.totalMatches++;
        caller.callStartAt = Date.now(); caller.diamondsBilled = 0;
        user.callStartAt = Date.now(); user.diamondsBilled = 0;
        const rate = user.callPrice; // the callee's rate
        caller.direct = { role: 'caller', ratePerMin: rate, partnerId: user.id };
        user.direct = { role: 'callee', ratePerMin: rate, partnerId: caller.id };
        const calleeEmail = String(user.verified.email).toLowerCase();
        const callerEmail = String(caller.verified.email).toLowerCase();
        send(caller.ws, { type: 'matched', peer: { id: user.id, nickname: user.nickname, gender: user.gender, verified: !!user.verified, photo: user.photo || null, email: calleeEmail, callPrice: user.callPrice }, initiator: true, freeSeconds: 0, diamonds: caller.diamonds, direct: true, rate, role: 'caller' });
        send(user.ws, { type: 'matched', peer: { id: caller.id, nickname: caller.nickname, gender: caller.gender, verified: !!caller.verified, photo: caller.photo || null, email: callerEmail, callPrice: caller.callPrice }, initiator: false, freeSeconds: 0, diamonds: user.diamonds, direct: true, rate, role: 'callee' });
        break;
      }

      case 'call-decline': {
        const req = pendingCalls.get(user.id);
        if (!req || req.from.id !== Number(msg.fromId)) break;
        pendingCalls.delete(user.id);
        send(req.from.ws, { type: 'call-declined', message: 'They declined your call.' });
        break;
      }
    }
  });

  ws.on('close', () => {
    removeFromWaiting(user);
    endPair(user, 'disconnected');
    // A pending direct-call request dies with either side. If the caller
    // left, the person waiting gets told instead of waiting forever.
    for (const [targetId, req] of pendingCalls) {
      if (req.from === user) {
        const target = findUserById(targetId);
        if (target) send(target.ws, { type: 'call-error', message: 'Caller disconnected.' });
        pendingCalls.delete(targetId);
      } else if (targetId === user.id) {
        pendingCalls.delete(targetId);
      }
    }
    clients.delete(ws);
    broadcastOnline();
  });
});

server.listen(PORT, () => {
  console.log(`MeetLive server running on http://localhost:${PORT}`);
  console.log('Open it in two browser windows/tabs to test matching.');
});
