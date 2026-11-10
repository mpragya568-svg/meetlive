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
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const START_COINS = 100; // coins every new visitor starts with (demo coins)

// ---- free trial ----
// While the trial is active, all gifts are FREE (cost 0 coins) so people can
// gift as much as they like. Turn it off by setting FREE_TRIAL to false,
// or extend it by moving FREE_TRIAL_UNTIL to a later date.
const FREE_TRIAL = true;
const FREE_TRIAL_UNTIL = new Date('2026-11-13T23:59:59-05:00'); // trial ends Nov 13, 2026
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
app.use(express.static(path.join(__dirname, '..', 'client')));
app.get('/health', (req, res) => res.json({ ok: true, online: clients.size }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---- state (in-memory; restart clears it — fine for a first launch) ----
let nextId = 1;
const clients = new Map(); // ws -> user
const waiting = [];        // users waiting for a match
const pairs = new Map();   // userId -> partner user
const reports = [];        // report log (also appended to reports.log)

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
    // `user` is the initiator: they create the WebRTC offer.
    send(user.ws, { type: 'matched', peer: { id: other.id, nickname: other.nickname, gender: other.gender }, initiator: true });
    send(other.ws, { type: 'matched', peer: { id: user.id, nickname: user.nickname, gender: user.gender }, initiator: false });
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
  };
  clients.set(ws, user);
  send(ws, { type: 'welcome', id: user.id, coins: user.coins, freeTrial: trialActive() });
  broadcastOnline();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const partner = pairs.get(user.id);

    switch (msg.type) {
      case 'join':
        user.nickname = String(msg.nickname || 'Guest').slice(0, 20);
        user.gender = ['male', 'female', 'other'].includes(msg.gender) ? msg.gender : 'other';
        break;

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
          send(partner.ws, { type: 'chat', from: user.id, nickname: user.nickname, text: String(msg.text || '').slice(0, 500) });
        }
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
          reported: partner ? partner.id : null,
          reportedName: partner ? partner.nickname : null,
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
