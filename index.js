// Discord Music Bot
// - Auto-joins a set voice channel 24/7, looping whichever named playlist is enabled
// - /play opens a popup form (artist + optional song). Blank song = full
//   discography request, restricted to server boosters.
// - /247playlist make|delete|enable|disable  (owner only)
// - /song add|remove|list                    (owner only)
// - /serverwhitelist add|remove|list          (owner only)

require('dotenv').config();
process.env.FFMPEG_PATH = require('ffmpeg-static');

const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const play = require('play-dl');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;
const AUTO_JOIN_GUILD_ID = process.env.AUTO_JOIN_GUILD_ID;
const AUTO_JOIN_CHANNEL_ID = process.env.AUTO_JOIN_CHANNEL_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in environment variables.');
  process.exit(1);
}
if (!OWNER_ID) {
  console.warn('WARNING: OWNER_ID is not set — owner-only commands will be unusable.');
}

function isOwner(interaction) {
  return interaction.user.id === OWNER_ID;
}

// ---------------- Whitelist persistence ----------------
const WHITELIST_PATH = path.join(__dirname, 'whitelist.json');

function loadWhitelist() {
  try {
    return new Set(JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8')));
  } catch {
    const initial = AUTO_JOIN_GUILD_ID ? [AUTO_JOIN_GUILD_ID] : [];
    fs.writeFileSync(WHITELIST_PATH, JSON.stringify(initial, null, 2));
    return new Set(initial);
  }
}
function saveWhitelist(set) {
  fs.writeFileSync(WHITELIST_PATH, JSON.stringify([...set], null, 2));
}
let whitelist = loadWhitelist();

// ---------------- Playlist persistence ----------------
const PLAYLISTS_PATH = path.join(__dirname, 'playlists.json');

const SEED_PLAYLIST = [
  'Juice WRLD Lucid Dreams', 'Juice WRLD All Girls Are The Same', 'Juice WRLD Robbery',
  'Juice WRLD Righteous', 'Juice WRLD Wishing Well', 'Juice WRLD Hear Me Calling',
  'Juice WRLD Bandit', 'Juice WRLD Come And Go', 'Juice WRLD Legends', 'Juice WRLD Fast',
  'Juice WRLD Empty', 'Juice WRLD Titanic', 'Juice WRLD Conversations',
  'XXXTENTACION SAD', 'XXXTENTACION Moonlight', 'XXXTENTACION Changes',
  'XXXTENTACION Jocelyn Flores', 'XXXTENTACION Fuck Love', 'XXXTENTACION Revenge',
  'XXXTENTACION Look At Me', 'XXXTENTACION Numb', 'XXXTENTACION Falling Down',
  'XXXTENTACION Hope', 'XXXTENTACION Arms Around You', 'XXXTENTACION Train Food',
  'XXXTENTACION Infinity 888',
];

function loadPlaylists() {
  try {
    return JSON.parse(fs.readFileSync(PLAYLISTS_PATH, 'utf8'));
  } catch {
    const initial = { playlists: { default: SEED_PLAYLIST }, active: 'default' };
    fs.writeFileSync(PLAYLISTS_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
}
function savePlaylists(data) {
  fs.writeFileSync(PLAYLISTS_PATH, JSON.stringify(data, null, 2));
}
let playlistsData = loadPlaylists();

// NOTE: whitelist.json and playlists.json live on Railway's local disk.
// They survive restarts, but a fresh redeploy from GitHub can reset them.
// For permanent storage, add a Volume to the service in Railway settings.

// Optional: signing in with a YouTube cookie makes play-dl's requests look
// authenticated instead of anonymous, which drastically cuts down on 429
// (rate limit) errors from cloud server IPs like Railway's. See README.
if (process.env.YT_COOKIE) {
  play.setToken({ youtube: { cookie: process.env.YT_COOKIE } }).catch((err) =>
    console.warn('Failed to set YouTube cookie for play-dl:', err.message)
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries transient failures (rate limits, brief network blips) with backoff.
async function withRetry(fn, { attempts = 3, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const is429 = /429/.test(err.message || '');
      if (i < attempts - 1) {
        const delay = baseDelayMs * Math.pow(2, i);
        console.warn(`Request failed (${is429 ? 'rate limited' : err.message}), retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// ---------------- Per-guild session state ----------------
const sessions = new Map();
function getSession(guildId) {
  if (!sessions.has(guildId)) {
    sessions.set(guildId, {
      queue: [],
      player: createAudioPlayer(),
      connection: null,
      playing: false,
      textChannel: null,
      shuffledDefaults: [],
    });
  }
  return sessions.get(guildId);
}
function isAutoJoinGuild(guildId) {
  return AUTO_JOIN_GUILD_ID && guildId === AUTO_JOIN_GUILD_ID;
}

async function resolveTrack(query) {
  return withRetry(async () => {
    if (play.yt_validate(query) === 'video') {
      const info = await play.video_info(query);
      return { url: query, title: info.video_details.title };
    }
    const results = await play.search(query, { limit: 1, source: { youtube: 'video' } });
    if (!results.length) return null;
    return { url: results[0].url, title: results[0].title };
  });
}

async function playNext(guildId) {
  const session = getSession(guildId);
  let next = session.queue.shift();

  if (!next && isAutoJoinGuild(guildId)) {
    const activeName = playlistsData.active;
    const songs = activeName ? playlistsData.playlists[activeName] : null;
    if (songs && songs.length) {
      if (!session.shuffledDefaults.length) session.shuffledDefaults = shuffled(songs);
      const query = session.shuffledDefaults.shift();
      const resolved = await resolveTrack(query).catch(() => null);
      if (resolved) next = { ...resolved, requestedBy: `playlist: ${activeName}` };
    }
  }

  if (!next) {
    session.playing = false;
    return;
  }

  try {
    const stream = await withRetry(() => play.stream(next.url));
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
    session.player.play(resource);
    session.playing = true;

    if (session.textChannel) {
      const embed = new EmbedBuilder()
        .setTitle('Now Playing')
        .setDescription(`[${next.title}](${next.url})`)
        .setFooter({ text: `Requested by ${next.requestedBy}` })
        .setColor(0x1db954);
      session.textChannel.send({ embeds: [embed] }).catch(() => {});
    }
  } catch (err) {
    console.error('Playback error:', err);
    playNext(guildId);
  }
}

async function ensureConnected(guild, voiceChannel) {
  const session = getSession(guild.id);
  if (session.connection) return session;

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (err) {
    // Clean up the half-open connection so a future retry can try again
    // instead of getting stuck thinking we're already connected.
    connection.destroy();
    throw err;
  }

  session.connection = connection;
  session.connection.subscribe(session.player);

  session.player.on(AudioPlayerStatus.Idle, () => playNext(guild.id));
  session.player.on('error', (err) => {
    console.error('Player error:', err);
    playNext(guild.id);
  });
  session.connection.on(VoiceConnectionStatus.Disconnected, () => {
    session.connection = null;
    session.playing = false;
    if (isAutoJoinGuild(guild.id)) {
      setTimeout(() => connectToAutoJoinChannel().catch(console.error), 5000);
    }
  });

  return session;
}

async function connectToAutoJoinChannel(attempt = 1) {
  if (!AUTO_JOIN_GUILD_ID || !AUTO_JOIN_CHANNEL_ID) return;
  if (!whitelist.has(AUTO_JOIN_GUILD_ID)) return;

  const guild = client.guilds.cache.get(AUTO_JOIN_GUILD_ID);
  if (!guild) return console.warn('AUTO_JOIN_GUILD_ID set, but bot is not in that guild.');
  const channel = guild.channels.cache.get(AUTO_JOIN_CHANNEL_ID);
  if (!channel) return console.warn('AUTO_JOIN_CHANNEL_ID not found in that guild.');

  try {
    const session = await ensureConnected(guild, channel);
    if (!session.playing) playNext(guild.id);
    console.log(`Connected to the 24/7 voice channel (attempt ${attempt}).`);
  } catch (err) {
    const delay = Math.min(60_000, 5_000 * attempt); // back off up to 60s
    console.warn(`Auto-join attempt ${attempt} failed (${err.message}), retrying in ${delay / 1000}s...`);
    setTimeout(() => connectToAutoJoinChannel(attempt + 1).catch(console.error), delay);
  }
}

// ---------------- Slash commands ----------------
const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Request a song (opens a form)'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Clear the queue'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing song'),
  new SlashCommandBuilder().setName('leave').setDescription('Disconnect the bot from voice'),

  new SlashCommandBuilder()
    .setName('serverwhitelist')
    .setDescription('Owner only: manage which servers the bot is allowed in')
    .addSubcommand((s) => s.setName('add').setDescription('Whitelist a server')
      .addStringOption((o) => o.setName('guild_id').setDescription('Server ID').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a server from the whitelist')
      .addStringOption((o) => o.setName('guild_id').setDescription('Server ID').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List whitelisted servers')),

  new SlashCommandBuilder()
    .setName('247playlist')
    .setDescription('Owner only: manage named 24/7 playlists')
    .addSubcommand((s) => s.setName('make').setDescription('Create a new empty playlist')
      .addStringOption((o) => o.setName('name').setDescription('Playlist name').setRequired(true)))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete a playlist')
      .addStringOption((o) => o.setName('name').setDescription('Playlist name').setRequired(true)))
    .addSubcommand((s) => s.setName('enable').setDescription('Make this the active 24/7 playlist')
      .addStringOption((o) => o.setName('name').setDescription('Playlist name').setRequired(true)))
    .addSubcommand((s) => s.setName('disable').setDescription('Disable the active 24/7 playlist')
      .addStringOption((o) => o.setName('name').setDescription('Playlist name').setRequired(true))),

  new SlashCommandBuilder()
    .setName('song')
    .setDescription('Owner only: add or remove songs from a 24/7 playlist')
    .addSubcommand((s) => s.setName('add').setDescription('Add a song to a playlist')
      .addStringOption((o) => o.setName('playlist').setDescription('Playlist name').setRequired(true))
      .addStringOption((o) => o.setName('query').setDescription('Song/artist to search for').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a song from a playlist by number')
      .addStringOption((o) => o.setName('playlist').setDescription('Playlist name').setRequired(true))
      .addIntegerOption((o) => o.setName('index').setDescription('Song number (see /song list)').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List songs in a playlist')
      .addStringOption((o) => o.setName('playlist').setDescription('Playlist name').setRequired(true))),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Slash commands registered.');
}

// ---------------- Whitelist enforcement ----------------
async function enforceWhitelist() {
  for (const [id, guild] of client.guilds.cache) {
    if (!whitelist.has(id)) {
      console.log(`Leaving non-whitelisted guild: ${guild.name} (${id})`);
      await guild.leave().catch(() => {});
    }
  }
}
client.on('guildCreate', async (guild) => {
  if (!whitelist.has(guild.id)) {
    console.log(`Auto-leaving non-whitelisted guild on join: ${guild.name} (${guild.id})`);
    await guild.leave().catch(() => {});
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
  await enforceWhitelist();
  setTimeout(() => {
    connectToAutoJoinChannel().catch((err) => console.error('Auto-join failed:', err));
  }, 3000);
});

// ---------------- Interaction handling ----------------
client.on('interactionCreate', async (interaction) => {
  // ---- /play opens a modal instead of taking a text option ----
  if (interaction.isChatInputCommand() && interaction.commandName === 'play') {
    if (interaction.guildId && !whitelist.has(interaction.guildId)) {
      return interaction.reply({ content: 'This server is not whitelisted.', ephemeral: true });
    }
    const modal = new ModalBuilder().setCustomId('play_modal').setTitle('Request a Song');
    const artistInput = new TextInputBuilder()
      .setCustomId('artist').setLabel('Artist name').setStyle(TextInputStyle.Short)
      .setRequired(true).setPlaceholder('e.g. Juice WRLD');
    const songInput = new TextInputBuilder()
      .setCustomId('song').setLabel('Song name (blank = full discography)').setStyle(TextInputStyle.Short)
      .setRequired(false).setPlaceholder('Leave blank — boosters only');
    modal.addComponents(
      new ActionRowBuilder().addComponents(artistInput),
      new ActionRowBuilder().addComponents(songInput)
    );
    return interaction.showModal(modal);
  }

  // ---- Handle the submitted form ----
  if (interaction.isModalSubmit() && interaction.customId === 'play_modal') {
    const guildId = interaction.guildId;
    if (guildId && !whitelist.has(guildId)) {
      return interaction.reply({ content: 'This server is not whitelisted.', ephemeral: true });
    }

    const artist = interaction.fields.getTextInputValue('artist').trim();
    const song = interaction.fields.getTextInputValue('song').trim();
    const member = interaction.member;
    const voiceChannel = member.voice?.channel;
    const session = getSession(guildId);

    if (!voiceChannel && !session.connection) {
      return interaction.reply({ content: 'Join a voice channel first!', ephemeral: true });
    }

    await interaction.deferReply();

    const isBooster = !!member.premiumSince;

    try {
      if (!song) {
        // Full discography request — boosters only
        if (!isBooster) {
          return interaction.editReply('Only boosted members can play an entire playlist.');
        }
        const results = await withRetry(() => play.search(artist, { limit: 10, source: { youtube: 'video' } }));
        if (!results.length) return interaction.editReply(`Couldn't find anything for **${artist}**.`);

        for (const r of results) {
          session.queue.push({ url: r.url, title: r.title, requestedBy: interaction.user.tag });
        }
        session.textChannel = interaction.channel;
        if (voiceChannel) await ensureConnected(interaction.guild, voiceChannel);
        if (!session.playing) await playNext(guildId);

        await interaction.editReply(`Queued ${results.length} tracks from **${artist}** (booster perk).`);
      } else {
        const resolved = await resolveTrack(`${artist} ${song}`);
        if (!resolved) return interaction.editReply(`No results for **${artist} - ${song}**.`);

        session.queue.push({ ...resolved, requestedBy: interaction.user.tag });
        session.textChannel = interaction.channel;
        if (voiceChannel) await ensureConnected(interaction.guild, voiceChannel);

        if (!session.playing) {
          session.queue.unshift(session.queue.pop()); // play this one immediately
          await playNext(guildId);
          await interaction.editReply(`Playing **${resolved.title}**`);
        } else {
          await interaction.editReply(`Added **${resolved.title}** to the queue.`);
        }
      }
    } catch (err) {
      console.error('Play modal error:', err);
      await interaction.editReply('Something went wrong trying to play that.');
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName, guildId } = interaction;

  // ---- Owner-only: server whitelist ----
  if (commandName === 'serverwhitelist') {
    if (!isOwner(interaction)) return interaction.reply({ content: "You're not authorized to use this.", ephemeral: true });
    const sub = interaction.options.getSubcommand();
    if (sub === 'add') {
      const id = interaction.options.getString('guild_id');
      whitelist.add(id);
      saveWhitelist(whitelist);
      return interaction.reply({ content: `Added \`${id}\` to the whitelist.`, ephemeral: true });
    }
    if (sub === 'remove') {
      const id = interaction.options.getString('guild_id');
      whitelist.delete(id);
      saveWhitelist(whitelist);
      const g = client.guilds.cache.get(id);
      if (g) await g.leave().catch(() => {});
      return interaction.reply({ content: `Removed \`${id}\` from the whitelist.`, ephemeral: true });
    }
    if (sub === 'list') {
      return interaction.reply({ content: `Whitelisted servers:\n${[...whitelist].join('\n') || '(empty)'}`, ephemeral: true });
    }
  }

  // ---- Owner-only: 24/7 playlist management ----
  if (commandName === '247playlist') {
    if (!isOwner(interaction)) return interaction.reply({ content: "You're not authorized to use this.", ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const name = interaction.options.getString('name');

    if (sub === 'make') {
      if (playlistsData.playlists[name]) return interaction.reply({ content: `Playlist \`${name}\` already exists.`, ephemeral: true });
      playlistsData.playlists[name] = [];
      savePlaylists(playlistsData);
      return interaction.reply({ content: `Created empty playlist \`${name}\`. Add songs with /song add.`, ephemeral: true });
    }
    if (sub === 'delete') {
      if (!playlistsData.playlists[name]) return interaction.reply({ content: `No playlist named \`${name}\`.`, ephemeral: true });
      delete playlistsData.playlists[name];
      if (playlistsData.active === name) playlistsData.active = null;
      savePlaylists(playlistsData);
      return interaction.reply({ content: `Deleted playlist \`${name}\`.`, ephemeral: true });
    }
    if (sub === 'enable') {
      if (!playlistsData.playlists[name]) return interaction.reply({ content: `No playlist named \`${name}\`.`, ephemeral: true });
      playlistsData.active = name;
      savePlaylists(playlistsData);
      if (AUTO_JOIN_GUILD_ID) {
        const s = getSession(AUTO_JOIN_GUILD_ID);
        s.shuffledDefaults = [];
        if (s.playing) s.player.stop(); // jump to the newly enabled playlist right away
      }
      return interaction.reply({ content: `\`${name}\` is now the active 24/7 playlist.`, ephemeral: true });
    }
    if (sub === 'disable') {
      if (playlistsData.active !== name) return interaction.reply({ content: `\`${name}\` isn't currently active.`, ephemeral: true });
      playlistsData.active = null;
      savePlaylists(playlistsData);
      if (AUTO_JOIN_GUILD_ID) {
        const s = getSession(AUTO_JOIN_GUILD_ID);
        s.shuffledDefaults = [];
        if (s.playing) s.player.stop();
      }
      return interaction.reply({ content: `Disabled \`${name}\`. The bot will go quiet until you enable another.`, ephemeral: true });
    }
  }

  // ---- Owner-only: song add/remove/list ----
  if (commandName === 'song') {
    if (!isOwner(interaction)) return interaction.reply({ content: "You're not authorized to use this.", ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const playlistName = interaction.options.getString('playlist');
    const list = playlistsData.playlists[playlistName];
    if (!list) return interaction.reply({ content: `No playlist named \`${playlistName}\`.`, ephemeral: true });

    if (sub === 'add') {
      const query = interaction.options.getString('query');
      list.push(query);
      savePlaylists(playlistsData);
      return interaction.reply({ content: `Added **${query}** to \`${playlistName}\` (${list.length} songs total).`, ephemeral: true });
    }
    if (sub === 'remove') {
      const index = interaction.options.getInteger('index');
      if (index < 1 || index > list.length) return interaction.reply({ content: `Index out of range (1-${list.length}).`, ephemeral: true });
      const removed = list.splice(index - 1, 1);
      savePlaylists(playlistsData);
      return interaction.reply({ content: `Removed **${removed[0]}** from \`${playlistName}\`.`, ephemeral: true });
    }
    if (sub === 'list') {
      if (!list.length) return interaction.reply({ content: `\`${playlistName}\` is empty.`, ephemeral: true });
      const text = list.map((s, i) => `${i + 1}. ${s}`).join('\n');
      return interaction.reply({ content: `**${playlistName}**:\n${text}`, ephemeral: true });
    }
  }

  if (guildId && !whitelist.has(guildId)) {
    return interaction.reply({ content: 'This server is not whitelisted.', ephemeral: true });
  }
  const session = getSession(guildId);

  if (commandName === 'skip') {
    if (!session.playing) return interaction.reply('Nothing is playing.');
    session.player.stop();
    return interaction.reply('Skipped.');
  }
  if (commandName === 'stop') {
    session.queue = [];
    session.player.stop();
    if (!isAutoJoinGuild(guildId) && session.connection) {
      session.connection.destroy();
      session.connection = null;
      session.playing = false;
    }
    return interaction.reply(isAutoJoinGuild(guildId) ? 'Cleared the queue — back to the 24/7 playlist.' : 'Stopped and cleared the queue.');
  }
  if (commandName === 'pause') {
    session.player.pause();
    return interaction.reply('Paused.');
  }
  if (commandName === 'resume') {
    session.player.unpause();
    return interaction.reply('Resumed.');
  }
  if (commandName === 'queue') {
    if (!session.queue.length) return interaction.reply('The queue is empty (playing the active 24/7 playlist).');
    const list = session.queue.map((t, i) => `${i + 1}. ${t.title} — requested by ${t.requestedBy}`).join('\n');
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle('Queue').setDescription(list).setColor(0x1db954)] });
  }
  if (commandName === 'nowplaying') {
    if (!session.playing) return interaction.reply('Nothing is playing.');
    return interaction.reply('Check the "Now Playing" message above for the current track.');
  }
  if (commandName === 'leave') {
    if (session.connection) {
      session.connection.destroy();
      session.connection = null;
    }
    session.queue = [];
    session.playing = false;
    return interaction.reply('Left the voice channel.');
  }
});

client.login(TOKEN);
