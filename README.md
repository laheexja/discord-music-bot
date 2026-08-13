# Discord Music Bot — 24/7 Playlists + Whitelist + Booster Perks (iPhone Setup)

## What this bot does

- **Lives in one voice channel 24/7**, looping whichever named playlist you've
  enabled (starts with a default Juice WRLD / XXXTentacion playlist).
- `/play` pops up a **form** asking for an artist and (optionally) a song.
  - Artist + song → plays that track.
  - Artist only → queues that artist's full discography, but **only if the
    requester is a server booster**. Non-boosters get told so.
- You (and only you) can manage:
  - `/serverwhitelist add|remove|list` — which servers the bot is allowed in.
    Any non-whitelisted server gets the bot auto-kicked out.
  - `/247playlist make|delete|enable|disable <name>` — create/switch between
    multiple named 24/7 playlists.
  - `/song add|remove|list` — add or remove tracks from any playlist.

Everything below can be done from Safari on your iPhone — no computer needed.

## 1. Get your Discord IDs

Turn on Developer Mode: **Discord app → Settings → Advanced → Developer Mode → on.**

- **Your user ID (OWNER_ID):** already have it — `1509973507688370191`
- **Server ID (AUTO_JOIN_GUILD_ID):** long-press the server icon → Copy Server ID
- **Voice channel ID (AUTO_JOIN_CHANNEL_ID):** long-press the voice channel → Copy Channel ID

## 2. Create the Discord bot application

1. https://discord.com/developers/applications → **New Application**
2. **Bot** tab → **Add Bot** → **Reset Token** → copy it somewhere safe
3. Turn on **Server Members Intent** and **Message Content Intent**
4. **OAuth2 → URL Generator** → scopes: `bot`, `applications.commands`.
   Permissions: `Connect`, `Speak`, `Send Messages`, `Embed Links`, `Use Slash Commands`
5. Open the generated URL, add the bot to your server
6. **General Information** tab → copy the **Application ID** (this is `CLIENT_ID`)

## 3. Upload the code to GitHub

Create a repo, upload all files: `index.js`, `package.json`, `.env.example`, `README.md`, `.gitignore`.

## 4. Deploy on Railway

1. https://railway.app → **New Project → Deploy from GitHub repo**
2. Service → **Variables** tab → add:
   - `DISCORD_TOKEN` — from step 2.2
   - `CLIENT_ID` — from step 2.6
   - `OWNER_ID` — `1509973507688370191`
   - `AUTO_JOIN_GUILD_ID` — your server ID
   - `AUTO_JOIN_CHANNEL_ID` — your voice channel ID
3. Check **Deploy Logs** for `Logged in as YourBot#1234` — it should join
   the voice channel and start playing within a few seconds.

## Using it

**Everyone:**
- `/play` — opens a popup form: type an artist, and optionally a song.
  Boosters can leave the song field blank to queue that artist's whole
  discography (best-effort, pulled from YouTube search).
- `/skip` `/pause` `/resume` `/stop` `/queue` `/nowplaying` `/leave`

**You only (`OWNER_ID`):**
- `/serverwhitelist add <server_id>` — whitelist a server before inviting the
  bot there, or it auto-leaves.
- `/serverwhitelist remove <server_id>` / `/serverwhitelist list`
- `/247playlist make <name>` — new empty playlist
- `/247playlist enable <name>` — make it the active 24/7 loop (switches immediately)
- `/247playlist disable <name>` — stop looping that playlist
- `/247playlist delete <name>` — delete it
- `/song add <playlist> <query>` — add a track (searched on YouTube)
- `/song remove <playlist> <index>` — remove by number (see `/song list`)
- `/song list <playlist>` — see numbered tracks in a playlist

## How the booster check works

A member counts as a "booster" if Discord shows them as currently boosting
**that server** (`member.premiumSince` is set). This is Discord's own boost
status — there's nothing extra to configure.

## Notes & limitations

- `whitelist.json` and `playlists.json` are stored on Railway's disk. They
  survive restarts, but a **fresh redeploy from GitHub can reset them**. For
  permanent storage, add a **Volume** to the service in Railway's Settings
  tab pointed at the project folder, then redo `/serverwhitelist add` /
  `/247playlist enable` once.
- "Full discography" pulls the top ~10 YouTube search results for that
  artist name — it's a best-effort approximation, not a literal complete
  catalog.
- This streams audio from YouTube for personal use in a private server.
  You're responsible for complying with Discord's and YouTube's Terms of
  Service in how you use it.
- If disconnected from the 24/7 channel, the bot automatically rejoins after
  a few seconds.
