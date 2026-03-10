import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import { Shoukaku, Connectors } from "shoukaku";


dotenv.config();


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
const shoukaku = new Shoukaku(
  new Connectors.DiscordJS(client),
  nodes
);

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
  console.log("Guild names:", client.guilds.cache.map(g => g.name));
});


client.on("messageCreate", async (message) => {
  try {
    if (message.content === "!ping") {
      message.reply("Pong!");
    }
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

    const player = await shoukaku.joinVoiceChannel({
      guildId: message.guild.id,
      channelId: voiceChannel.id,
      shardId: 0,
    });

    const result = await node.rest.resolve(`scsearch:${query}`);

    let track;
    if (result?.loadType === "track") {
      track = result.data;
    } else if (result?.loadType === "search") {
      track = result.data[0];
    } else if (result?.loadType === "playlist") {
      track = result.data.tracks[0];
    }

    if (!track) {
      return message.reply("No results found.");
    }

    await player.playTrack({
      track: track.encoded,
    });

    message.reply(`Now playing: ${track.info.title}`);
  } catch (error) {
    console.error("Play command error:", error);
    message.reply("Could not play that track right now.");
  }
});

client.login(process.env.TOKEN);