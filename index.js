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
        .setName("warnings")
        .setDescription("View a member's warning history")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("The member to check")
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    
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
        await interaction.deferReply();

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

        try {
            const member = await interaction.guild.members.fetch(user.id);

            if (level === 2) {
                await member.timeout(10 * 60 * 1000, reason);
                punishment = "⏱️ 10-minute timeout";
            }

            else if (level === 3) {
                await member.timeout(60 * 60 * 1000, reason);
                punishment = "⏱️ 1-hour timeout";
            }

            else if (level === 4) {
                await member.timeout(24 * 60 * 60 * 1000, reason);
                punishment = "⏱️ 1-day timeout";
            }

            else if (level === 5) {
                await member.kick(reason);
                punishment = "👢 Kick";
            }

            else if (level === 6) {
                await member.ban({ reason });
                punishment = "🔨 Ban";
            }

        } catch (error) {
            console.error("❌ Punishment failed:", error);
console.error("Error code:", error.code);
console.error("Error message:", error.message);
            punishment = "⚠️ Warning recorded, but punishment failed";
        }

        await interaction.editReply(
            `⚠️ **${user.tag} has been warned!**\n\n` +
            `**Reason:** ${reason}\n` +
            `**Level:** ${level}\n` +
            `**Punishment:** ${punishment}`
        );
    }
        if (interaction.commandName === "warnings") {
        const user = interaction.options.getUser("user");
        const warnings = loadWarnings();

        const userWarnings = warnings[user.id] || [];

        if (userWarnings.length === 0) {
            await interaction.reply(
                `📋 **${user.tag} has no warnings.**`
            );
            return;
        }

        let message = `📋 **Warnings for ${user.tag}**\n\n`;
        message += `**Total warnings:** ${userWarnings.length}\n\n`;

        userWarnings.forEach((warning, index) => {
            message +=
                `**${index + 1}.** Level ${warning.level}\n` +
                `Reason: ${warning.reason}\n` +
                `Moderator: <@${warning.moderator}>\n\n`;
        });

        await interaction.reply(message);
    }
});

client.on("error", console.error);

client.login(process.env.BOT_TOKEN);
