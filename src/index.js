import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import { Shoukaku, Connectors } from "shoukaku";

dotenv.config();

// Search source order. SoundCloud is listed first because standard Lavalink
// builds cannot handle YouTube's cipher
const SEARCH_SOURCES = ["scsearch", "ytmsearch", "ytsearch"];

/** Try each search source until one returns a usable result. */
async function resolveTrack(node, query) {
  for (const source of SEARCH_SOURCES) {
    const result = await node.rest.resolve(`${source}:${query}`);
    let track;
    if (result?.loadType === "track") {
      track = result.data;
    } else if (result?.loadType === "search") {
      track = result.data[0];
    } else if (result?.loadType === "playlist") {
      track = result.data.tracks[0];
    }
    if (track) return track;
  }
  return null;
}

/** Formats a track as "Artist - Title (MM:SS)" for use in all bot messages. */
function trackLabel(track) {
  const { author, title, length } = track.info;
  const totalSecs = Math.floor((length ?? 0) / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = String(totalSecs % 60).padStart(2, "0");
  return `**${author}** - **${title}** (${mins}:${secs})`;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const nodes = [
  {
    name: "local",
    url: "localhost:2333",
    auth: "supersecret",
  },
];

const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), nodes);

// Per-guild state: { player, queue: [], textChannel }
const guildStates = new Map();

shoukaku.on("ready", (name) => {
  console.log(`✅ Lavalink node ${name} is ready`);
});

shoukaku.on("error", (name, error) => {
  console.error(`❌ Lavalink node ${name} error:`, error);
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
  console.log("Bot ID:", client.user?.id);
  console.log("Guild count:", client.guilds.cache.size);
  console.log("Guild names:", client.guilds.cache.map((g) => g.name));
});

/**
 * Plays the next track in the guild's queue.
 * Cleans up state if the queue is empty.
 */
async function playNext(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  if (state.queue.length === 0) {
    state.playing = false;
    state.currentTrack = null;
    state.textChannel?.send("✅ Queue finished. Leaving voice channel.");
    await shoukaku.leaveVoiceChannel(guildId);
    guildStates.delete(guildId);
    return;
  }

  const track = state.queue.shift();
  state.currentTrack = track;
  state.playing = true;

  await state.player.playTrack({ track: { encoded: track.encoded } });
  state.textChannel?.send(`🎵 Now playing: ${trackLabel(track)}`);
}

/**
 * Lavalink fires the "end" event with different reasons:
 *   - "finished"  : track played to completion → advance queue
 *   - "loadFailed": Lavalink couldn't stream the track → skip & report
 *   - "replaced"  : a new track was force-started (e.g. !skip) → do nothing
 *   - "stopped"   : stopTrack() called explicitly (e.g. !stop) → do nothing
 *   - "cleanup"   : player destroyed → do nothing
 */
function attachPlayerListeners(player, guildId) {
  player.on("end", (data) => {
    const reason = data?.reason ?? "finished";

    if (reason === "finished" || reason === "loadFailed") {
      if (reason === "loadFailed") {
        const state = guildStates.get(guildId);
        const label = state?.currentTrack ? trackLabel(state.currentTrack) : "Unknown track";
        state?.textChannel?.send(`⚠️ Could not play ${label} — skipping.`);
      }
      playNext(guildId);
    }
    // "replaced", "stopped", "cleanup" → do nothing, queue is already handled
  });

  player.on("exception", (error) => {
    const state = guildStates.get(guildId);
    const label = state?.currentTrack ? trackLabel(state.currentTrack) : "Unknown track";
    console.error(`[${guildId}] Player exception on "${state?.currentTrack?.info?.title}":`, error);
    state?.textChannel?.send(`❌ Playback error on ${label}: ${error?.message ?? error}`);
  });

  player.on("stuck", (data) => {
    const state = guildStates.get(guildId);
    const label = state?.currentTrack ? trackLabel(state.currentTrack) : "Unknown track";
    console.warn(`[${guildId}] Track stuck (threshold: ${data?.thresholdMs}ms), skipping.`);
    state?.textChannel?.send(`⏭️ ${label} got stuck — skipping.`);
    playNext(guildId);
  });
}

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // ── !ping ──────────────────────────────────────────────────────────────
    if (message.content === "!ping") {
      return message.reply("Pong!");
    }

    // ── !queue ──────────────────────────────────────────────────────────────
    if (message.content === "!queue") {
      const state = guildStates.get(message.guild?.id);
      if (!state || state.queue.length === 0) {
        return message.reply("The queue is currently empty.");
      }
      const list = state.queue
        .map((t, i) => `**${i + 1}.** ${trackLabel(t)}`)
        .join("\n");
      return message.reply(`**Upcoming songs:**\n${list}`);
    }

    // ── !skip ──────────────────────────────────────────────────────────────
    if (message.content === "!skip") {
      const state = guildStates.get(message.guild?.id);
      if (!state || !state.playing) return message.reply("Nothing is playing right now.");
      // Call playNext directly — stopTrack() fires end with reason "stopped"
      // which the event handler intentionally ignores, so we bypass it here.
      await playNext(message.guild.id);
      return message.reply("⏭️ Skipped!");
    }

    // ── !stop ──────────────────────────────────────────────────────────────
    if (message.content === "!stop") {
      const guildId = message.guild?.id;
      const state = guildStates.get(guildId);
      if (!state) return message.reply("Nothing is playing right now.");
      state.queue.length = 0;
      state.playing = false;
      await state.player.stopTrack();
      await shoukaku.leaveVoiceChannel(guildId);
      guildStates.delete(guildId);
      return message.reply("⏹️ Stopped, cleared the queue, and left the channel.");
    }

    // ── !play ──────────────────────────────────────────────────────────────
    if (!message.content.startsWith("!play")) return;
    if (!message.guild || !message.member) return;

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply("Join a voice channel first.");
    }

    const query = message.content.split(" ").slice(1).join(" ");
    if (!query) {
      return message.reply("Provide something to play.");
    }

    const node = shoukaku.getIdealNode();
    if (!node) {
      return message.reply("No Lavalink node is currently available.");
    }

    // Resolve the track before touching the player
    const track = await resolveTrack(node, query);

    if (!track) {
      return message.reply("No results found.");
    }

    const guildId = message.guild.id;
    let state = guildStates.get(guildId);

    if (!state) {
      // First song: join the voice channel and set up state
      const player = await shoukaku.joinVoiceChannel({
        guildId,
        channelId: voiceChannel.id,
        shardId: 0,
      });

      state = { player, queue: [], currentTrack: null, playing: false, textChannel: message.channel };
      guildStates.set(guildId, state);

      // Wire up end / exception / stuck handlers
      attachPlayerListeners(player, guildId);

      // Play immediately
      state.queue.push(track);
      await playNext(guildId);
    } else {
      // Bot is already connected — enqueue the track
      state.textChannel = message.channel;
      state.queue.push(track);
      if (!state.playing) {
        // Player is idle (e.g. after !stop) — kick off playback immediately
        await playNext(guildId);
      } else {
        message.reply(`✅ Added to queue: ${trackLabel(track)} (position ${state.queue.length})`);
      }
    }
  } catch (error) {
    console.error("Command error:", error);
    message.reply("Something went wrong. Try again.");
  }
});

client.login(process.env.TOKEN);