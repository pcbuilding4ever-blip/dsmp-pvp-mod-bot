const { Client, GatewayIntentBits } = require("discord.js");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once("ready", () => {
    console.log(`🔥 DSMP PvP Mod Bot online as ${client.user.tag}`);
});

client.on("error", console.error);

client.login(process.env.BOT_TOKEN);
