import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";


dotenv.config();


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});


client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
  console.log("Bot ID:", client.user?.id);
  console.log("Guild count:", client.guilds.cache.size);
  console.log("Guild names:", client.guilds.cache.map(g => g.name));
});


client.on("messageCreate", (message) => {
  if (message.content === "!ping") {
    message.reply("Pong!");
  }
});

client.login(process.env.TOKEN);