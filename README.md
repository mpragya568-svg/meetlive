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

## Sign in with Google / Apple

The profile screen shows **"Sign in with Google"** and **"Sign in with
Apple"** buttons — but only after you add the credentials below. Until then
the buttons stay hidden and everyone signs in as a guest (nickname only),
exactly as before. Sign-in is optional, never required.

A signed-in user gets their real name (and Google photo) as their profile,
and a **✓** badge next to their name on the other person's screen.
The server verifies every sign-in itself (Google ID token via Google,
Apple code + id_token via Apple) before trusting it — the browser never
decides who someone is.

### Google (free)

1. Go to [Google Cloud Console](https://console.cloud.google.com/) →
   create a project (any name) → **APIs & Services → Credentials**.
2. **Configure consent screen** (External, fill in the app name) — needed
   before you can create a client.
3. **Create Credentials → OAuth client ID → Web application**.
4. Under **Authorized JavaScript origins** add your site URL, e.g.
   `https://meetlive-3cgk.onrender.com` (for local testing also add
   `http://localhost:3000`).
5. Copy the **Client ID** (looks like `…apps.googleusercontent.com`).
6. On Render: your service → **Environment** → add
   `GOOGLE_CLIENT_ID` = that Client ID → **Save** (Render redeploys).
7. Refresh the site — the Google button appears on the profile screen.

### Apple (needs a paid Apple Developer account — $99/year)

1. Join the [Apple Developer Program](https://developer.apple.com/programs/)
   ($99/year) — Sign in with Apple for the web is not available on a free
   account.
2. **Certificates, Identifiers & Profiles → Identifiers → + → Services IDs**
   → create one (e.g. `com.meetlive.app`) and check **Sign in with Apple**.
3. Click **Configure** on it → set **Primary App ID** to your App ID (create
   one if needed) → under **Website URLs** add your domain
   `meetlive-3cgk.onrender.com` and **Return URL**
   `https://meetlive-3cgk.onrender.com` → Save. Apple will ask you to
   verify the domain (it gives you a file to host or a DNS record).
4. **Keys → +** → check **Sign in with Apple** → Configure → pick the
   Primary App ID → Save → **Download** the `.p8` key file (only once!)
   and note the **Key ID** shown.
5. Note your **Team ID** (top-right of the developer portal, or in
   Membership details).
6. On Render: your service → **Environment** → add these four variables
   and **Save**:
   - `APPLE_CLIENT_ID` = the Services ID (e.g. `com.meetlive.app`)
   - `APPLE_TEAM_ID` = your Team ID
   - `APPLE_KEY_ID` = the Key ID from step 4
   - `APPLE_PRIVATE_KEY` = the whole contents of the `.p8` file
     (paste it with its `-----BEGIN PRIVATE KEY-----` lines; if it shows
     up as one line, keep the `\n` characters — the server converts them)
7. Refresh the site — the Apple button appears on the profile screen.

### How it works (for developers)

- `GET /config` returns the public client IDs so the page knows which
  buttons to show.
- `POST /auth/google { idToken }` verifies the token with Google's
  tokeninfo endpoint and returns a 24h session token + profile.
- `POST /auth/apple { code, user }` exchanges the code with Apple using a
  signed ES256 `client_secret` JWT, then verifies Apple's `id_token`
  (RS256) against Apple's JWKS. No extra npm packages — Node's built-in
  `crypto` does the signing and verification.
- The browser sends the session token in its `join` message; the server
  attaches the verified profile to the user and uses the verified name.
  Sessions live in memory, so a server restart signs everyone out.
