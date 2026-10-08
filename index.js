const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ChannelType
} = require("discord.js");

const fs = require("fs");

const TICKET_CHANNEL_ID = "1553777212170178570";

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
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    new SlashCommandBuilder()
        .setName("purge")
        .setDescription("Delete messages from the current channel")
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription("Number of messages to delete (1-100)")
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    new SlashCommandBuilder()
        .setName("lock")
        .setDescription("Lock the current channel")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    new SlashCommandBuilder()
        .setName("unlock")
        .setDescription("Unlock the current channel")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    new SlashCommandBuilder()
        .setName("slowmode")
        .setDescription("Set slowmode in the current channel")
        .addIntegerOption(option =>
            option
                .setName("seconds")
                .setDescription("Slowmode delay in seconds (0 to disable)")
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(21600)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    new SlashCommandBuilder()
        .setName("ticketpanel")
        .setDescription("Post the private ticket panel")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
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

async function createTicket(interaction, ticketType) {
    const parent = await interaction.guild.channels.fetch(TICKET_CHANNEL_ID);

    if (!parent || parent.type !== ChannelType.GuildText) {
        throw new Error("Ticket channel is missing or is not a text channel.");
    }

    const activeThreads = await parent.threads.fetchActive();
    const existingTicket = activeThreads.threads.find(
        thread => thread.ownerId === interaction.user.id
    );

    if (existingTicket) {
        return existingTicket;
    }

    const thread = await parent.threads.create({
        name: `${ticketType.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${interaction.user.username}`,
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: `${ticketType} ticket opened by ${interaction.user.tag}`
    });

    await thread.members.add(interaction.user.id);

    const ticketButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("close_ticket")
            .setLabel("Close Ticket")
            .setEmoji("🔒")
            .setStyle(ButtonStyle.Danger)
    );

    await thread.send({
        content:
            `🎫 **${ticketType} Ticket**\n\n` +
            `Opened by <@${interaction.user.id}>.\n\n` +
            "Please explain what you need help with. Staff will be able to respond here.\n\n" +
            "Use **Close Ticket** when you are finished.",
        components: [ticketButtons]
    });

    return thread;
}

client.on("interactionCreate", async interaction => {
    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === "ticket_type") {
            await interaction.deferReply({ ephemeral: true });

            const ticketType = interaction.values[0];

            try {
                const thread = await createTicket(interaction, ticketType);

                if (thread.archived) {
                    await interaction.editReply(
                        `🎫 You already have an open ticket: <#${thread.id}>`
                    );
                } else {
                    await interaction.editReply(
                        `✅ Your private **${ticketType}** ticket has been opened: <#${thread.id}>`
                    );
                }
            } catch (error) {
                console.error("❌ Ticket creation failed:", error);

                await interaction.editReply(
                    "❌ I couldn't create your ticket. Make sure I have **Create Private Threads**, **Send Messages in Threads**, and **Manage Threads** permissions."
                );
            }

            return;
        }

        return;
    }

    if (interaction.isButton()) {
        if (interaction.customId === "close_ticket") {
            try {
                if (!interaction.channel.isThread()) {
                    await interaction.reply({
                        content: "❌ This button can only be used inside a ticket.",
                        ephemeral: true
                    });
                    return;
                }

                await interaction.reply("🔒 **Ticket closed.** This thread is now archived.");

                await interaction.channel.setLocked(true);
                await interaction.channel.setArchived(true);
            } catch (error) {
                console.error("❌ Ticket close failed:", error);

                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: "❌ I couldn't close this ticket. Make sure I have **Manage Threads** permission.",
                        ephemeral: true
                    });
                }
            }

            return;
        }

        return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "ping") {
        await interaction.reply("🏓 Pong!");
        return;
    }

    if (interaction.commandName === "ticketpanel") {
        try {
            const parent = await interaction.guild.channels.fetch(TICKET_CHANNEL_ID);

            if (!parent || parent.type !== ChannelType.GuildText) {
                await interaction.reply({
                    content: "❌ The configured ticket channel is missing or is not a text channel.",
                    ephemeral: true
                });
                return;
            }

            const menu = new StringSelectMenuBuilder()
                .setCustomId("ticket_type")
                .setPlaceholder("Select what you need help with")
                .addOptions(
                    {
                        label: "Giveaway Claim",
                        description: "Claim a prize from a giveaway",
                        value: "Giveaway Claim",
                        emoji: "🎁"
                    },
                    {
                        label: "General Support",
                        description: "Get help with the server",
                        value: "General Support",
                        emoji: "❓"
                    },
                    {
                        label: "Report a User",
                        description: "Report a member or rule violation",
                        value: "Report a User",
                        emoji: "🚨"
                    },
                    {
                        label: "Scam Report",
                        description: "Report a scam or suspicious trade",
                        value: "Scam Report",
                        emoji: "⚠️"
                    },
                    {
                        label: "Partnership",
                        description: "Ask about partnering with DSMP PvP",
                        value: "Partnership",
                        emoji: "🤝"
                    }
                );

            const row = new ActionRowBuilder().addComponents(menu);

            await parent.send({
                content:
                    "## 🎫 DSMP PvP Support\n\n" +
                    "Select the reason for your ticket below. A private support thread will be created for you.",
                components: [row]
            });

            await interaction.reply({
                content: "✅ Ticket panel posted.",
                ephemeral: true
            });
        } catch (error) {
            console.error("❌ Ticket panel failed:", error);

            await interaction.reply({
                content: "❌ I couldn't post the ticket panel. Make sure I can view and send messages in the ticket channel.",
                ephemeral: true
            });
        }

        return;
    }

    if (interaction.commandName === "purge") {
        const amount = interaction.options.getInteger("amount");

        try {
            const deleted = await interaction.channel.bulkDelete(amount, true);

            await interaction.reply({
                content: `🧹 Deleted **${deleted.size}** message(s).`,
                ephemeral: true
            });
        } catch (error) {
            console.error("❌ Purge failed:", error);

            await interaction.reply({
                content: "❌ I couldn't delete those messages. Make sure I have **Manage Messages** permission.",
                ephemeral: true
            });
        }

        return;
    }

    if (interaction.commandName === "lock") {
        try {
            await interaction.channel.permissionOverwrites.edit(
                interaction.guild.roles.everyone,
                { SendMessages: false }
            );

            await interaction.reply("🔒 **Channel locked.**");
        } catch (error) {
            console.error("❌ Lock failed:", error);

            await interaction.reply({
                content: "❌ I couldn't lock this channel. Make sure I have **Manage Channels** permission.",
                ephemeral: true
            });
        }

        return;
    }

    if (interaction.commandName === "unlock") {
        try {
            await interaction.channel.permissionOverwrites.edit(
                interaction.guild.roles.everyone,
                { SendMessages: true }
            );

            await interaction.reply("🔓 **Channel unlocked.**");
        } catch (error) {
            console.error("❌ Unlock failed:", error);

            await interaction.reply({
                content: "❌ I couldn't unlock this channel. Make sure I have **Manage Channels** permission.",
                ephemeral: true
            });
        }

        return;
    }

    if (interaction.commandName === "slowmode") {
        const seconds = interaction.options.getInteger("seconds");

        try {
            await interaction.channel.setRateLimitPerUser(seconds);

            if (seconds === 0) {
                await interaction.reply("🔓 **Slowmode disabled.**");
            } else {
                await interaction.reply(
                    `🐌 **Slowmode set to ${seconds} second(s).**`
                );
            }
        } catch (error) {
            console.error("❌ Slowmode failed:", error);

            await interaction.reply({
                content: "❌ I couldn't change slowmode. Make sure I have **Manage Channels** permission.",
                ephemeral: true
            });
        }

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

        return;
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
