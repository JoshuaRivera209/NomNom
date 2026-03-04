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

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
  console.log("Bot ID:", client.user?.id);
  console.log("Guild count:", client.guilds.cache.size);
  console.log("Guild names:", client.guilds.cache.map(g => g.name));
});


client.on("messageCreate", async (message) => {
  if (message.content === "!ping") {
    message.reply("Pong!");
  }
  if (!message.content.startsWith("!play")) return;
  if (!message.guild) return;

  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) {
    return message.reply("Join a voice channel first.");
  }

  const query = message.content.split(" ").slice(1).join(" ");
  if (!query) {
    return message.reply("Provide something to play.");
  }

  const node = shoukaku.getNode();

  const player = await node.joinChannel({
    guildId: message.guild.id,
    channelId: voiceChannel.id,
    shardId: 0,
  });


  const result = await node.rest.resolve(`scsearch:${query}`);

  if (!result || !result.tracks.length) {
    return message.reply("No results found.");
  }

  await player.playTrack({
    track: result.tracks[0].encoded,
  });

  message.reply(`Now playing: ${result.tracks[0].info.title}`);
});

client.login(process.env.TOKEN);