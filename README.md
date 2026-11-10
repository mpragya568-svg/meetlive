# MeetLive — Random 1-on-1 Video Chat (Chamet-style)

A complete, working random video-chat app: tap **Start**, get matched with a
random stranger on live video, chat, send gifts, hit **Next** for someone new.
Built the way Chamet works — a matchmaking server + peer-to-peer video
(WebRTC). Not affiliated with Chamet.

## Features

- **18+ age gate** + community rules screen
- **Random matching** — a server-side queue pairs two waiting users
- **Live 1-on-1 video calls** (WebRTC, peer-to-peer, no video passes through the server)
- **Next / End** — skip to a new stranger or leave the call
- **Text chat** during the call
- **Coins & gifts** — Rose, Heart, Diamond, Crown, Rocket. Gifts cost coins;
  the receiver *earns* the coins, like a host on Chamet. Demo coins are free
  (+100 button); wire in real payments before launching publicly.
- **Mic / camera toggles, beauty filter**
- **Report & Block** — reports are logged to `server/reports.log`, and a
  reported/blocked person can never match with you again
- **Live online counter**

## Free trial — gifts are free

For the first 2–3 days after launch (until **Nov 13, 2026**), all gifts are
**FREE** — no coins needed, gift as much as you like. The app shows a
"🎉 Free trial — all gifts are free!" badge and FREE on every gift button.

This is controlled by `FREE_TRIAL` / `FREE_TRIAL_UNTIL` at the top of
`server/server.js`. Turn it off any time by setting `FREE_TRIAL` to `false`,
or extend it by moving the date. After the trial ends, gifts go back to
costing coins (and the +100 free coins button still lets people top up).

## How it works

```
You ──WebSocket──▶  MeetLive server (matchmaking queue)
   ◀── "matched" ──  pairs you with a stranger
You ◀──WebRTC (video/audio, peer-to-peer)──▶ Stranger
```

The server only exchanges matchmaking + signaling messages (offers, answers,
ICE candidates). The video itself goes directly between the two browsers,
which keeps server costs low — exactly how Chamet/Omegle-style apps do it.
Google's free public STUN servers are used so the two phones can find each
other. (On strict networks, add a TURN server — see "Going live" below.)

## Run it locally (2 minutes)

```bash
cd server
npm install
npm start
```

Open http://localhost:3000 in **two** browser windows/tabs (or two devices on
the same Wi-Fi — use your computer's LAN IP, e.g. `http://192.168.1.5:3000`).
Confirm 18+, pick a nickname, allow camera/mic, tap **Start** in both — the
two windows match each other on live video.

## Going live (so real strangers can join)

1. **Deploy the server** — any Node host works, e.g. Render (free tier):
   create a Web Service from this folder, build command `npm install`
   (run in `server/`), start command `npm start`. The client is served by
   the same server, so the WebSocket connects automatically.
2. **Share the link.** Random matching only works when 2+ people are online
   at the same time — strangers appear once people start using it.
3. **Add a TURN server** for users on strict mobile networks (otherwise
   some calls fail to connect, or video works only one way). A free test TURN
   server (Open Relay) is already included in the app's `RTC_CONFIG` —
   replace it with a paid TURN (Metered / Twilio / Cloudflare) for a big
   public launch.
4. **Moderation is your responsibility.** This ships with an 18+ gate,
   reporting and blocking, but a public random video chat needs real
   moderation: review `server/reports.log`, add automated nudity detection
   (e.g. a moderation API) before opening it to the public, and follow your
   country's laws (age verification, data, and app-store rules).
5. **Payments.** Coins are demo-only. To sell coins for real money, add a
   payment provider (Stripe, in-app purchases) and store balances in a real
   database — the in-memory balances here reset on restart.

## Project structure

```
meetlive-chamet-clone/
├── client/
│   └── index.html      # the whole app (UI + WebRTC + signaling), single file
├── server/
│   ├── package.json    # dependencies: express, ws
│   ├── server.js       # matchmaking, signaling, coins/gifts, report/block
│   └── reports.log     # created automatically — every report lands here
└── README.md
```

## Extending it

- **Gender / country filters** (Chamet charges coins for these): add a
  `filter` field to `join`/`find` and only pair users whose filters match.
- **Accounts & friends**: add login, persist coins + blocks in SQLite.
- **Live streaming**: same WebRTC setup, one-to-many instead of one-to-one.
- **Mobile app**: wrap the client with Capacitor, or rebuild it in Flutter /
  React Native using the same server API.
