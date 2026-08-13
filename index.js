// Discord Music Bot
// Commands: /play, /skip, /stop, /pause, /resume, /queue, /nowplaying

require('dotenv').config();
process.env.FFMPEG_PATH = require('ffmpeg-static');

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const play = require('play-dl');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in environment variables.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// Per-guild music session state
const sessions = new Map();

function getSession(guildId) {
  if (!sessions.has(guildId)) {
    sessions.set(guildId, {
      queue: [],
      player: createAudioPlayer(),
      connection: null,
      playing: false,
      textChannel: null,
    });
  }
  return sessions.get(guildId);
}

async function playNext(guildId) {
  const session = getSession(guildId);
  const next = session.queue.shift();

  if (!next) {
    session.playing = false;
    return;
  }

  try {
    const stream = await play.stream(next.url);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
    });
    session.player.play(resource);
    session.playing = true;

    if (session.textChannel) {
      const embed = new EmbedBuilder()
        .setTitle('Now Playing')
        .setDescription(`[${next.title}](${next.url})`)
        .setFooter({ text: `Requested by ${next.requestedBy}` })
        .setColor(0x1db954);
      session.textChannel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('Playback error:', err);
    if (session.textChannel) {
      session.textChannel.send(`Couldn't play **${next.title}**, skipping.`);
    }
    playNext(guildId);
  }
}

// Slash command definitions
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from YouTube (URL or search terms)')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('YouTube URL or search terms').setRequired(true)
    ),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause the current song'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing song'),
  new SlashCommandBuilder().setName('leave').setDescription('Disconnect the bot from voice'),
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, member } = interaction;
  const session = getSession(guildId);

  if (commandName === 'play') {
    const query = interaction.options.getString('query');
    const voiceChannel = member.voice.channel;

    if (!voiceChannel) {
      return interaction.reply('Join a voice channel first!');
    }

    await interaction.deferReply();

    try {
      let url = query;
      let title = query;

      if (!play.yt_validate(query)) {
        const results = await play.search(query, { limit: 1, source: { youtube: 'video' } });
        if (!results.length) {
          return interaction.editReply(`No results found for **${query}**.`);
        }
        url = results[0].url;
        title = results[0].title;
      } else {
        const info = await play.video_info(url);
        title = info.video_details.title;
      }

      session.queue.push({
        url,
        title,
        requestedBy: interaction.user.tag,
      });
      session.textChannel = interaction.channel;

      if (!session.connection) {
        session.connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator,
        });

        await entersState(session.connection, VoiceConnectionStatus.Ready, 20_000);
        session.connection.subscribe(session.player);

        session.player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
        session.player.on('error', (err) => {
          console.error('Player error:', err);
          playNext(guildId);
        });

        session.connection.on(VoiceConnectionStatus.Disconnected, () => {
          session.connection = null;
          session.queue = [];
          session.playing = false;
        });
      }

      if (!session.playing) {
        await playNext(guildId);
        await interaction.editReply(`Playing **${title}**`);
      } else {
        await interaction.editReply(`Added **${title}** to the queue (position ${session.queue.length}).`);
      }
    } catch (err) {
      console.error('Play command error:', err);
      await interaction.editReply('Something went wrong trying to play that.');
    }
  }

  if (commandName === 'skip') {
    if (!session.playing) return interaction.reply('Nothing is playing.');
    session.player.stop();
    return interaction.reply('Skipped.');
  }

  if (commandName === 'stop') {
    session.queue = [];
    session.player.stop();
    if (session.connection) {
      session.connection.destroy();
      session.connection = null;
    }
    session.playing = false;
    return interaction.reply('Stopped and cleared the queue.');
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
    if (!session.queue.length) return interaction.reply('The queue is empty.');
    const list = session.queue
      .map((t, i) => `${i + 1}. ${t.title} — requested by ${t.requestedBy}`)
      .join('\n');
    return interaction.reply({
      embeds: [new EmbedBuilder().setTitle('Queue').setDescription(list).setColor(0x1db954)],
    });
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
