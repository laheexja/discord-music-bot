# Discord Music Bot — iPhone Setup Guide

This bot plays music in a Discord voice channel via `/play`, `/skip`, `/stop`,
`/pause`, `/resume`, `/queue`, `/nowplaying`, `/leave`. Everything below can be
done from Safari on your iPhone — no computer needed. The bot itself runs on a
free cloud server (Railway), not on your phone, because iOS won't let an app
stay alive in the background to stream audio 24/7. You just manage it from
your phone.

## 1. Create the Discord bot (5 min, in Safari)

1. Go to https://discord.com/developers/applications and log in.
2. Tap **New Application**, name it, create it.
3. Go to the **Bot** tab → **Add Bot**.
4. Under **Privileged Gateway Intents**, turn on **Server Members Intent** and
   **Message Content Intent**.
5. Tap **Reset Token** → copy the token somewhere safe (you'll paste it into
   Railway later). Never share this token.
6. Go to **OAuth2 → URL Generator**. Check scopes: `bot`, `applications.commands`.
   Under Bot Permissions check: `Connect`, `Speak`, `Send Messages`,
   `Embed Links`, `Use Slash Commands`.
7. Copy the generated URL, open it in a new Safari tab, and add the bot to
   your server.
8. On the **General Information** tab, copy the **Application ID**
   (this is your `CLIENT_ID`).

## 2. Put the code on GitHub

1. Go to https://github.com, sign up/log in (works fine in mobile Safari).
2. Tap **+ → New repository**, name it `discord-music-bot`, create it.
3. Tap **Add file → Upload files**, and upload every file from this project
   (`index.js`, `package.json`, `.env.example`, `README.md`, `.gitignore`).
4. Commit the files.

## 3. Deploy on Railway (free tier)

1. Go to https://railway.app in Safari, sign up with your GitHub account.
2. Tap **New Project → Deploy from GitHub repo** and select
   `discord-music-bot`.
3. Once it's created, open the service → **Variables** tab, and add:
   - `DISCORD_TOKEN` = the token from step 1.5
   - `CLIENT_ID` = the Application ID from step 1.8
4. Go to the **Settings** tab and make sure the **Start Command** is
   `npm start` (it should auto-detect this from `package.json`).
5. Railway will build and deploy automatically. Watch the **Deploy Logs** tab
   — you should see `Logged in as YourBot#1234` once it's live.

That's it — the bot now runs continuously in the cloud. You can turn your
phone off and it keeps working. To restart it, redeploy it, or check logs,
just come back to railway.app in Safari any time.

> Railway's free tier includes a monthly usage credit that's normally enough
> for a small always-on bot like this, but check their current pricing page
> since limits change — if you outgrow it, Render.com's free web service tier
> is a similar no-computer-needed alternative.

## 4. Using the bot

In your Discord server, join a voice channel, then type:
- `/play <song name or YouTube URL>`
- `/skip`, `/pause`, `/resume`, `/stop`, `/queue`, `/leave`

## Notes

- This bot streams audio from YouTube for personal use in a private server.
  You're responsible for complying with Discord's and YouTube's Terms of
  Service in how you use it.
- If slash commands don't show up in Discord right away, wait a minute or
  restart Discord — global command registration can take a moment to
  propagate.
