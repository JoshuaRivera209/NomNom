import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import { Shoukaku, Connectors } from "shoukaku";

dotenv.config();

// Search source order
const SEARCH_SOURCES = ["ytsearch", "ytmsearch", "scsearch"];

/**
 * Picks the first usable track from a single Lavalink resolve result.
 * @returns {object|null}
 */
function pickTrack(result) {
  if (result?.loadType === "track") return result.data;
  if (result?.loadType === "search") return result.data[0] ?? null;
  if (result?.loadType === "playlist") return result.data.tracks[0] ?? null;
  return null;
}

/**
 * Try each search source in order until one returns a usable result.
 * @returns {{ track: object, sourceIndex: number } | null}
 */
async function resolveTrack(node, query) {
  for (let i = 0; i < SEARCH_SOURCES.length; i++) {
    const result = await node.rest.resolve(`${SEARCH_SOURCES[i]}:${query}`);
    const track = pickTrack(result);
    if (track) return { track, sourceIndex: i };
  }
  return null;
}

/**
 * Like resolveTrack but starts searching from the source *after* startIndex.
 * Used for retrying a failed track with the next untried source.
 * @returns {{ track: object, sourceIndex: number } | null}
 */
async function resolveTrackFrom(node, query, startIndex) {
  for (let i = startIndex + 1; i < SEARCH_SOURCES.length; i++) {
    const result = await node.rest.resolve(`${SEARCH_SOURCES[i]}:${query}`);
    const track = pickTrack(result);
    if (track) return { track, sourceIndex: i };
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
 *   - "loadFailed": track failed — handled exclusively by the "exception" event
 *   - "replaced"  : a new track was force-started (e.g. !skip) → do nothing
 *   - "stopped"   : stopTrack() called explicitly (e.g. !stop) → do nothing
 *   - "cleanup"   : player destroyed → do nothing
 *
 * NOTE: When a track fails, Lavalink fires BOTH "exception" AND "end: loadFailed".
 * The "exception" handler is async (it does a network retry search) so we dont
 * act on "loadFailed" here — doing so would delete guild state before the retry
 * completes, leaving the retry with nothing to work with.
 */
function attachPlayerListeners(player, guildId, node) {
  player.on("end", (data) => {
    const reason = data?.reason ?? "finished";

    if (reason === "finished") {
      playNext(guildId);
    }
    // "loadFailed" is handled by the "exception" event below.
    // "replaced", "stopped", "cleanup" → do nothing, queue is already handled
  });

  player.on("exception", async (error) => {
    const state = guildStates.get(guildId);
    const failed = state?.currentTrack;
    const label = failed ? trackLabel(failed) : "Unknown track";
    const lastSourceIndex = failed?._sourceIndex ?? -1;

    console.error(`[${guildId}] Player exception on "${failed?.info?.title}":`, error);

    // Attempt retry using the next untried search source
    if (failed && lastSourceIndex + 1 < SEARCH_SOURCES.length) {
      const query = `${failed.info.author} ${failed.info.title}`;
      const retryResult = await resolveTrackFrom(node, query, lastSourceIndex);

      if (retryResult) {
        const { track: retryTrack, sourceIndex: retrySourceIndex } = retryResult;
        retryTrack._sourceIndex = retrySourceIndex;
        // Splice the retry track in as the very next to play
        state.queue.unshift(retryTrack);
        state.textChannel?.send(
          `⚠️ Failed via \`${SEARCH_SOURCES[lastSourceIndex]}\` — retrying with \`${SEARCH_SOURCES[retrySourceIndex]}\`…`
        );
        await playNext(guildId);
        return;
      }
    }

    // All sources exhausted — skip this track
    state?.textChannel?.send(`❌ Playback error on ${label} (no sources left to try) — skipping.`);
    playNext(guildId);
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

    // ── !clear ──────────────────────────────────────────────────────────────
    if (message.content === "!clear") {
      const state = guildStates.get(message.guild?.id);
      if (!state) return message.reply("Nothing is playing right now.");
      state.queue.length = 0;
      return message.reply("⏹️ Cleared the queue.");
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
    const resolved = await resolveTrack(node, query);

    if (!resolved) {
      return message.reply("No results found.");
    }

    // Tag the track with the source index so the retry handler knows where to resume
    const track = resolved.track;
    track._sourceIndex = resolved.sourceIndex;

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
      attachPlayerListeners(player, guildId, node);

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