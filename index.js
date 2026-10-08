const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits
} = require("discord.js");

const fs = require("fs");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

const warningsFile = "./warnings.json";

function loadWarnings() {
    try {
        return JSON.parse(fs.readFileSync(warningsFile, "utf8"));
    } catch {
        return {};
    }
}

function saveWarnings(warnings) {
    fs.writeFileSync(
        warningsFile,
        JSON.stringify(warnings, null, 2)
    );
}

const commands = [
    new SlashCommandBuilder()
        .setName("ping")
        .setDescription("Check if the bot is online"),

    new SlashCommandBuilder()
        .setName("warn")
        .setDescription("Warn a member")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("The member to warn")
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("reason")
                .setDescription("Reason for the warning")
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName("level")
                .setDescription("Warning level")
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(6)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
].map(command => command.toJSON());

const rest = new REST({ version: "10" })
    .setToken(process.env.BOT_TOKEN);

client.once("ready", async () => {
    console.log(`🔥 DSMP PvP Mod Bot online as ${client.user.tag}`);

    try {
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );

        console.log("✅ Commands registered!");
    } catch (error) {
        console.error("❌ Failed to register commands:", error);
    }
});

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "ping") {
        await interaction.reply("🏓 Pong!");
        return;
    }

    if (interaction.commandName === "warn") {
        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason");
        const level = interaction.options.getInteger("level");

        const warnings = loadWarnings();

        if (!warnings[user.id]) {
            warnings[user.id] = [];
        }

        warnings[user.id].push({
            reason: reason,
            level: level,
            moderator: interaction.user.id,
            date: new Date().toISOString()
        });

        saveWarnings(warnings);

        let punishment = "⚠️ Warning only";

        if (level === 2) {
            punishment = "⏱️ 10-minute timeout";
        } else if (level === 3) {
            punishment = "⏱️ 1-hour timeout";
        } else if (level === 4) {
            punishment = "⏱️ 1-day timeout";
        } else if (level === 5) {
            punishment = "👢 Kick";
        } else if (level === 6) {
            punishment = "🔨 Ban";
        }

        await interaction.reply(
            `⚠️ **${user.tag} has been warned!**\n\n` +
            `**Reason:** ${reason}\n` +
            `**Level:** ${level}\n` +
            `**Punishment:** ${punishment}`
        );
    }
});

client.on("error", console.error);

client.login(process.env.BOT_TOKEN);
