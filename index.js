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
    ChannelType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require("discord.js");

const fs = require("fs");

const TICKET_CHANNEL_ID = "1553777212170178570";
const GIVEAWAY_APPLICATION_CHANNEL_ID = "1557812749382193223";
const PARTNER_APPLICATION_CHANNEL_ID = "1557813451034988646";
const GIVEAWAYS_FILE = "./giveaways.json";
const giveawayTimers = new Map();
const spamTracker = new Map();
const modLogChannelName = "mod-logs";
const SETTINGS_FILE = "./settings.json";

function loadSettings(guildId) {
    try {
        const all = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));

        return all[guildId] || {
            logChannelId: null,
            flaggedWords: []
        };
    } catch {
        return {
            logChannelId: null,
            flaggedWords: []
        };
    }
}

function saveSettings(guildId, settings) {
    let all = {};

    try {
        all = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    } catch {}

    all[guildId] = settings;

    fs.writeFileSync(
        SETTINGS_FILE,
        JSON.stringify(all, null, 2)
    );
}
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const warningsFile = "./warnings.json";

async function sendModLog(guild, message) {
    try {
        const settings = loadSettings(guild.id);

const channel = settings.logChannelId
    ? guild.channels.cache.get(settings.logChannelId)
    : guild.channels.cache.find(
        ch => ch.name === modLogChannelName && ch.isTextBased()
    );
        if (channel) await channel.send({ content: message });
    } catch (error) {
        console.error("❌ Mod log failed:", error.message);
    }
}

function formatMember(member) {
    return `**User:** <@${member.id}> (${member.user.tag})\\n**ID:** ${member.id}\\n**Joined:** ${member.joinedAt ? member.joinedAt.toISOString() : "Unknown"}`;
}



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

function loadGiveaways() {
    try { return JSON.parse(fs.readFileSync(GIVEAWAYS_FILE, "utf8")); } catch { return {}; }
}

function saveGiveaways(giveaways) {
    fs.writeFileSync(GIVEAWAYS_FILE, JSON.stringify(giveaways, null, 2));
}

function parseGiveawayDuration(input) {
    const match = String(input).trim().toLowerCase().match(/^(\\d+)\\s*(s|m|h|d)$/);
    if (!match) return null;
    const amount = Number(match[1]);
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    const ms = amount * multipliers[match[2]];
    if (!Number.isFinite(ms) || ms < 10000 || ms > 7 * 86400000) return null;
    return ms;
}

function giveawayDurationLabel(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds % 86400 === 0) return `${seconds / 86400}d`;
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    if (seconds % 60 === 0) return `${seconds / 60}m`;
    return `${seconds}s`;
}

async function finishGiveaway(giveawayId) {
    const giveaways = loadGiveaways();
    const giveaway = giveaways[giveawayId];
    if (!giveaway || giveaway.ended) return;
    giveaway.ended = true;
    const entrants = [...new Set(giveaway.entries || [])];
    entrants.sort(() => Math.random() - 0.5);
    giveaway.winners = entrants.slice(0, Math.min(giveaway.winnerCount, entrants.length));
    saveGiveaways(giveaways);
    if (giveawayTimers.has(giveawayId)) {
        clearTimeout(giveawayTimers.get(giveawayId));
        giveawayTimers.delete(giveawayId);
    }
    try {
        const channel = await client.channels.fetch(giveaway.channelId);
        if (!channel || !channel.isTextBased()) return;
        const winnerText = giveaway.winners.length ? giveaway.winners.map(id => `<@${id}>`).join(", ") : "No valid entrants.";
        const row = giveaway.winners.length ? new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`giveaway_claim:${giveawayId}`).setLabel("Claim Prize").setEmoji("🎁").setStyle(ButtonStyle.Success)
        ) : undefined;
        await channel.send({
            content: `🎉 **GIVEAWAY ENDED!**\\n\\n🎁 **Prize:** ${giveaway.prize}\\n🏆 **Winner(s):** ${winnerText}\\n\\n${giveaway.winners.length ? "Winners can use **Claim Prize** to open a private claim ticket." : "There were no entrants."}`,
            components: row ? [row] : []
        });
        try {
            const original = await channel.messages.fetch(giveaway.messageId);
            await original.edit({ content: `🎉 **GIVEAWAY ENDED**\\n\\n🎁 **Prize:** ${giveaway.prize}\\n👤 **Hosted by:** <@${giveaway.hostId}>\\n🏆 **Winner(s):** ${winnerText}`, components: [] });
        } catch (error) { console.error("❌ Could not update giveaway message:", error.message); }
    } catch (error) { console.error("❌ Could not finish giveaway:", error); }
}

function scheduleGiveaway(giveaway) {
    if (!giveaway || giveaway.ended) return;
    const remaining = giveaway.endAt - Date.now();
    if (remaining <= 0) { finishGiveaway(giveaway.id); return; }
    if (giveawayTimers.has(giveaway.id)) clearTimeout(giveawayTimers.get(giveaway.id));
    giveawayTimers.set(giveaway.id, setTimeout(() => finishGiveaway(giveaway.id), remaining));
}

async function createGiveawayClaimTicket(interaction, giveaway) {
    const parent = await interaction.guild.channels.fetch(TICKET_CHANNEL_ID);
    if (!parent || parent.type !== ChannelType.GuildText) throw new Error("Ticket channel is missing or is not a text channel.");
    const activeThreads = await parent.threads.fetchActive();
    const existing = activeThreads.threads.find(thread => thread.ownerId === interaction.user.id && thread.name.startsWith(`giveaway-claim-${giveaway.id}`));
    if (existing) return existing;
    const thread = await parent.threads.create({
        name: `giveaway-claim-${giveaway.id}-${interaction.user.username}`,
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: `Giveaway prize claim for ${interaction.user.tag}`
    });
    await thread.members.add(interaction.user.id);
    await thread.send({
        content: `🎁 **Giveaway Prize Claim**\\n\\n**Winner:** <@${interaction.user.id}>\\n**Prize:** ${giveaway.prize}\\n**Hosted by:** <@${giveaway.hostId}>\\n\\nStaff will verify your win and provide the prize. Only the winning user can open this claim ticket.`,
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("close_ticket").setLabel("Close Ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger))]
    });
    return thread;
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
    .setName("kick")
    .setDescription("Kick a member")
    .addUserOption(option =>
        option
            .setName("user")
            .setDescription("Member to kick")
            .setRequired(true)
    )
    .addStringOption(option =>
        option
            .setName("reason")
            .setDescription("Reason for the kick")
            .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .addUserOption(option =>
        option
            .setName("user")
            .setDescription("Member to ban")
            .setRequired(true)
    )
    .addStringOption(option =>
        option
            .setName("reason")
            .setDescription("Reason for the ban")
            .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a member")
    .addUserOption(option =>
        option
            .setName("user")
            .setDescription("Member to timeout")
            .setRequired(true)
    )
    .addIntegerOption(option =>
        option
            .setName("minutes")
            .setDescription("Timeout duration in minutes")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(40320)
    )
    .addStringOption(option =>
        option
            .setName("reason")
            .setDescription("Reason for the timeout")
            .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    new SlashCommandBuilder()
        .setName("userinfo")
        .setDescription("View information about a member")
        .addUserOption(option => option.setName("user").setDescription("Member to inspect").setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    new SlashCommandBuilder()
        .setName("unwarn")
        .setDescription("Remove a warning from a member")
        .addUserOption(option => option.setName("user").setDescription("Member").setRequired(true))
        .addIntegerOption(option => option.setName("number").setDescription("Warning number to remove").setRequired(true).setMinValue(1))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    new SlashCommandBuilder()
        .setName("unban")
        .setDescription("Unban a user")
        .addStringOption(option => option.setName("user_id").setDescription("User ID to unban").setRequired(true))
        .addStringOption(option => option.setName("reason").setDescription("Reason").setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    new SlashCommandBuilder()
        .setName("untimeout")
        .setDescription("Remove a member's timeout")
        .addUserOption(option => option.setName("user").setDescription("Member").setRequired(true))
        .addStringOption(option => option.setName("reason").setDescription("Reason").setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    
new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Configure bot settings")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName("announce")
        .setDescription("Send an announcement")
        .addChannelOption(option => option.setName("channel").setDescription("Announcement channel").setRequired(true))
.addStringOption(option => option.setName("message").setDescription("Announcement text").setRequired(true))
.addRoleOption(option => option.setName("role").setDescription("DM members with this role").setRequired(true))
.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
        .setName("stats")
        .setDescription("Show server statistics"),

    new SlashCommandBuilder()
        .setName("report")
        .setDescription("Report a member")
        .addUserOption(option => option.setName("user").setDescription("Member to report").setRequired(true))
        .addStringOption(option => option.setName("reason").setDescription("Reason for the report").setRequired(true)),

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
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    new SlashCommandBuilder()
        .setName("giveaway")
        .setDescription("Start a giveaway")
        .addUserOption(option => option.setName("host").setDescription("Who is hosting the giveaway?").setRequired(true))
        .addStringOption(option => option.setName("prize").setDescription("What is the prize?").setRequired(true))
        .addIntegerOption(option => option.setName("winners").setDescription("Number of winners (1-20)").setRequired(true).setMinValue(1).setMaxValue(20))
        .addStringOption(option => option.setName("time").setDescription("Duration, e.g. 10m, 1h, 1d").setRequired(true))
        .addIntegerOption(option => option.setName("max_entries").setDescription("Maximum number of entries (1-10000)").setRequired(true).setMinValue(1).setMaxValue(10000))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName("staffapply")
        .setDescription("Post the staff application panel")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
].map(command => command.toJSON());

const rest = new REST({ version: "10" })
    .setToken(process.env.BOT_TOKEN);

client.once("ready", async () => {
    console.log(`🔥 DSMP PvP Mod Bot online as ${client.user.tag}`);

    const activeGiveaways = loadGiveaways();
    for (const giveaway of Object.values(activeGiveaways)) scheduleGiveaway(giveaway);

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
        thread =>
            thread.ownerId === interaction.user.id &&
            thread.name.startsWith("ticket-")
    );

    if (existingTicket) {
        return { thread: existingTicket, existing: true };
    }

    const thread = await parent.threads.create({
        name: `ticket-${ticketType.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${interaction.user.username}`,
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

    return { thread, existing: false };
}

client.on("interactionCreate", async interaction => {
    try {
        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === "settings_menu") {
    const choice = interaction.values[0];

    if (choice === "logs") {
        const modal = new ModalBuilder()
            .setCustomId("settings_logs")
            .setTitle("Set Mod Logs Channel");

        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("channel_id")
                    .setLabel("Channel ID")
                    .setPlaceholder("Paste the channel ID")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
            )
        );

        await interaction.showModal(modal);
        return;
    }

    if (choice === "words") {
        const modal = new ModalBuilder()
            .setCustomId("settings_words")
            .setTitle("Set AutoMod Flagged Words");

        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("words")
                    .setLabel("Flagged words")
                    .setPlaceholder("word1, word2, word3")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
            )
        );

        await interaction.showModal(modal);
        return;
    }

    if (choice === "view") {
        const settings = loadSettings(interaction.guild.id);

        await interaction.reply({
            content:
                `⚙️ **Current Settings**\n\n` +
                `📋 **Logs:** ${
                    settings.logChannelId
                        ? `<#${settings.logChannelId}>`
                        : "Default #mod-logs"
                }\n` +
                `🚫 **Flagged words:** ${
                    settings.flaggedWords.length
                        ? settings.flaggedWords.join(", ")
                        : "None"
                }`,
            ephemeral: true
        });

        return;
    }
}
            if (interaction.customId === "ticket_type") {
                await interaction.deferReply({ ephemeral: true });

                const ticketType = interaction.values[0];
                const result = await createTicket(interaction, ticketType);

                await interaction.editReply(
                    result.existing
                        ? `🎫 You already have an open ticket: <#${result.thread.id}>`
                        : `✅ Your private **${ticketType}** ticket has been opened: <#${result.thread.id}>`
                );
                return;
            }

            if (interaction.customId === "staff_application_type") {
                const type = interaction.values[0];

                const configs = {
                    staff: {
                        id: "application_staff",
                        title: "DSMP PvP Staff Application",
                        fields: [
                            ["app_age", "How old are you?", TextInputStyle.Short, 3],
                            ["app_timezone", "What is your timezone?", TextInputStyle.Short, 50],
                            ["app_why", "Why do you want to be staff?", TextInputStyle.Paragraph, 1000],
                            ["app_contribute", "What will you contribute?", TextInputStyle.Paragraph, 1000],
                            ["app_pick", "Why should we pick you?", TextInputStyle.Paragraph, 1000]
                        ]
                    },
                    giveaway: {
                        id: "application_giveaway",
                        title: "Giveaway Mod Application",
                        fields: [
                            ["app_age", "How old are you?", TextInputStyle.Short, 3],
                            ["app_timezone", "What is your timezone?", TextInputStyle.Short, 50],
                            ["app_experience", "Any giveaway/mod experience?", TextInputStyle.Paragraph, 1000],
                            ["app_reliable", "Why can we trust you with giveaways?", TextInputStyle.Paragraph, 1000],
                            ["app_sponsor", "How much can you sponsor a week?", TextInputStyle.Short, 100]
                        ]
                    },
                    partner: {
                        id: "application_partner",
                        title: "Partner Manager Application",
                        fields: [
                            ["app_age", "How old are you?", TextInputStyle.Short, 3],
                            ["app_timezone", "What is your timezone?", TextInputStyle.Short, 50],
                            ["app_experience", "Any partnership experience?", TextInputStyle.Paragraph, 1000],
                            ["app_value", "What makes a good partner?", TextInputStyle.Paragraph, 1000],
                            ["app_contribute", "How would you grow our partnerships?", TextInputStyle.Paragraph, 1000]
                        ]
                    }
                };

                const config = configs[type];
                if (!config) return;

                const modal = new ModalBuilder()
                    .setCustomId(config.id)
                    .setTitle(config.title);

                modal.addComponents(...config.fields.map(([id, label, style, max]) =>
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId(id)
                            .setLabel(label)
                            .setStyle(style)
                            .setRequired(true)
                            .setMaxLength(max)
                    )
                ));

                await interaction.showModal(modal);
                return;
            }

            return;
        }

        if (interaction.isButton()) {
            if (interaction.customId.startsWith("giveaway_enter:")) {
                const giveawayId = interaction.customId.split(":")[1];
                const giveaways = loadGiveaways();
                const giveaway = giveaways[giveawayId];
                if (!giveaway || giveaway.ended || giveaway.endAt <= Date.now()) { await interaction.reply({ content: "❌ This giveaway has ended.", ephemeral: true }); return; }
                if (giveaway.entries.includes(interaction.user.id)) { await interaction.reply({ content: "⚠️ You are already entered in this giveaway.", ephemeral: true }); return; }
                if (giveaway.entries.length >= giveaway.maxEntries) { await interaction.reply({ content: "❌ This giveaway has reached the maximum number of entries.", ephemeral: true }); return; }
                giveaway.entries.push(interaction.user.id);
                saveGiveaways(giveaways);
                await interaction.reply({ content: "✅ You are entered in the giveaway! Good luck 🤝🔥", ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith("giveaway_claim:")) {
                const giveawayId = interaction.customId.split(":")[1];
                const giveaways = loadGiveaways();
                const giveaway = giveaways[giveawayId];
                if (!giveaway || !giveaway.ended) { await interaction.reply({ content: "❌ This giveaway has not finished yet.", ephemeral: true }); return; }
                if (!giveaway.winners.includes(interaction.user.id)) { await interaction.reply({ content: "❌ You did not win this giveaway, so you cannot claim this prize.", ephemeral: true }); return; }
                const thread = await createGiveawayClaimTicket(interaction, giveaway);
                await interaction.reply({ content: `🎁 Your private giveaway claim ticket is ready: <#${thread.id}>`, ephemeral: true });
                return;
            }
            if (interaction.customId !== "close_ticket") return;

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
            return;
        }

        if (interaction.isModalSubmit()) {
            if (
    interaction.customId === "settings_logs" ||
    interaction.customId === "settings_words"
) {
    await interaction.deferReply({ ephemeral: true });

    const settings = loadSettings(interaction.guild.id);

    if (interaction.customId === "settings_logs") {
        const channelId = interaction.fields
            .getTextInputValue("channel_id")
            .trim();

        const channel = interaction.guild.channels.cache.get(channelId);

        if (!channel || !channel.isTextBased()) {
            await interaction.editReply(
                "❌ That isn't a valid text channel ID."
            );
            return;
        }

        settings.logChannelId = channelId;

        saveSettings(
            interaction.guild.id,
            settings
        );

        await interaction.editReply(
            `✅ Mod logs are now sent to <#${channelId}>.`
        );

        return;
    }

    if (interaction.customId === "settings_words") {
        const rawWords =
            interaction.fields.getTextInputValue("words") || "";

        settings.flaggedWords = rawWords
            .split(",")
            .map(word => word.trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 100);

        saveSettings(
            interaction.guild.id,
            settings
        );

        await interaction.editReply(
            `✅ AutoMod flagged words updated.\n` +
            `**${settings.flaggedWords.length}** word(s) configured.`
        );

        return;
    }
}
            const configs = {
                application_staff: {
                    type: "staff",
                    logChannel: "1557812559174963312",
                    title: "🛡️ New Staff Application",
                    fields: [
                        ["app_age", "Age"],
                        ["app_timezone", "Timezone"],
                        ["app_why", "Why do you want to be staff?"],
                        ["app_contribute", "What will you contribute?"],
                        ["app_pick", "Why should we pick you?"]
                    ]
                },
                application_giveaway: {
                    type: "giveaway",
                    logChannel: GIVEAWAY_APPLICATION_CHANNEL_ID,
                    title: "🎁 New Giveaway Mod Application",
                    fields: [
                        ["app_age", "Age"],
                        ["app_timezone", "Timezone"],
                        ["app_experience", "Giveaway/mod experience"],
                        ["app_reliable", "Why can we trust you with giveaways?"],
                        ["app_sponsor", "How much can you sponsor a week?"]
                    ]
                },
                application_partner: {
                    type: "partner",
                    logChannel: PARTNER_APPLICATION_CHANNEL_ID,
                    title: "🤝 New Partner Manager Application",
                    fields: [
                        ["app_age", "Age"],
                        ["app_timezone", "Timezone"],
                        ["app_experience", "Partnership experience"],
                        ["app_value", "What makes a good partner?"],
                        ["app_contribute", "How would you grow our partnerships?"]
                    ]
                }
            };

            const config = configs[interaction.customId];
            if (!config) return;

            await interaction.deferReply({ ephemeral: true });

            const applicationChannel = await interaction.guild.channels.fetch(config.logChannel);
            if (!applicationChannel || applicationChannel.type !== ChannelType.GuildText) {
                await interaction.editReply("❌ The configured application log channel is missing or is not a text channel.");
                return;
            }

            let content = `## ${config.title}\\n\\n**Applicant:** <@${interaction.user.id}> (${interaction.user.tag})\\n`;
            for (const [id, label] of config.fields) {
                content += `\\n**${label}:**\\n${interaction.fields.getTextInputValue(id)}\\n`;
            }

            await applicationChannel.send({ content });

            const notificationChannel = await interaction.guild.channels.fetch(TICKET_CHANNEL_ID);
            if (notificationChannel && notificationChannel.isTextBased()) {
                await notificationChannel.send({
                    content: `${config.title} submitted by <@${interaction.user.id}>. Full application logged in <#${applicationChannel.id}>.`
                });
            }

            await interaction.editReply(`✅ Your ${config.type === "giveaway" ? "Giveaway Mod" : config.type === "partner" ? "Partner Manager" : "Staff"} application has been submitted! Good luck 🤝🔥`);
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === "ping") {
            await interaction.reply("🏓 Pong!");
            return;
        }

        if (interaction.commandName === "staffapply") {
            const applicationPanelChannel = await interaction.guild.channels.fetch(TICKET_CHANNEL_ID);

            if (!applicationPanelChannel || applicationPanelChannel.type !== ChannelType.GuildText) {
                await interaction.reply({ content: "❌ The application panel channel is missing or is not a text channel.", ephemeral: true });
                return;
            }

            const menu = new StringSelectMenuBuilder()
                .setCustomId("staff_application_type")
                .setPlaceholder("Choose what you want to apply for")
                .addOptions(
                    {
                        label: "Staff Team",
                        description: "Apply for general server staff",
                        value: "staff",
                        emoji: "🛡️"
                    },
                    {
                        label: "Giveaway Mod",
                        description: "Help run and manage giveaways",
                        value: "giveaway",
                        emoji: "🎁"
                    },
                    {
                        label: "Partner Manager",
                        description: "Manage partnerships and partner relations",
                        value: "partner",
                        emoji: "🤝"
                    }
                );

            await applicationPanelChannel.send({
                content: "## 🛡️ DSMP PvP Applications\n\nChoose the position you want to apply for below.",
                components: [new ActionRowBuilder().addComponents(menu)]
            });

            await interaction.reply({ content: "✅ Application panel posted.", ephemeral: true });
            return;
        }

        if (interaction.commandName === "ticketpanel") {
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

            await parent.send({
                content:
                    "## 🎫 DSMP PvP Support\n\n" +
                    "Select the reason for your ticket below. A private support thread will be created for you.",
                components: [
                    new ActionRowBuilder().addComponents(menu)
                ]
            });

            await interaction.reply({
                content: "✅ Ticket panel posted.",
                ephemeral: true
            });
            return;
        }

        if (interaction.commandName === "giveaway") {
            const host = interaction.options.getUser("host");
            const prize = interaction.options.getString("prize");
            const winnerCount = interaction.options.getInteger("winners");
            const durationInput = interaction.options.getString("time");
            const maxEntries = interaction.options.getInteger("max_entries");
            const duration = parseGiveawayDuration(durationInput);
            if (!duration) { await interaction.reply({ content: "❌ Invalid giveaway time. Use **10s**, **10m**, **1h**, or **1d**. Maximum is 7 days.", ephemeral: true }); return; }
            const giveawayId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            const giveaway = { id: giveawayId, hostId: host.id, prize, winnerCount, duration, maxEntries, entries: [], winners: [], channelId: interaction.channelId, messageId: null, endAt: Date.now() + duration, ended: false };
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`giveaway_enter:${giveawayId}`).setLabel("Enter Giveaway").setEmoji("🎉").setStyle(ButtonStyle.Primary));
            const message = await interaction.channel.send({ content: `# 🎉 GIVEAWAY\\n\\n🎁 **Prize:** ${prize}\\n👤 **Hosted by:** <@${host.id}>\\n🏆 **Winners:** ${winnerCount}\\n⏱️ **Time:** ${giveawayDurationLabel(duration)}\\n👥 **Max entries:** ${maxEntries}\\n\\nClick **Enter Giveaway** below to enter!`, components: [row] });
            giveaway.messageId = message.id;
            const giveaways = loadGiveaways();
            giveaways[giveawayId] = giveaway;
            saveGiveaways(giveaways);
            scheduleGiveaway(giveaway);
            await interaction.reply({ content: `✅ Giveaway started! ID: ${giveawayId}`, ephemeral: true });
            return;
        }
if (interaction.commandName === "kick") {
    const user = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const member = await interaction.guild.members.fetch(user.id);

    if (!member.kickable) {
        await interaction.reply({
            content: "❌ I cannot kick that member. Check my role hierarchy.",
            ephemeral: true
        });
        return;
    }

    await member.kick(reason);

    await interaction.reply(
        `👢 **${user.tag}** has been kicked.\n**Reason:** ${reason}`
    );
    return;
}

if (interaction.commandName === "ban") {
    const user = interaction.options.getUser("user");
    const reason = interaction.options.getString("reason");
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    if (member && !member.bannable) {
        await interaction.reply({
            content: "❌ I cannot ban that member. Check my role hierarchy.",
            ephemeral: true
        });
        return;
    }

    await interaction.guild.members.ban(user.id, { reason });

    await interaction.reply(
        `🔨 **${user.tag}** has been banned.\n**Reason:** ${reason}`
    );
    return;
}

if (interaction.commandName === "timeout") {
    const user = interaction.options.getUser("user");
    const minutes = interaction.options.getInteger("minutes");
    const reason = interaction.options.getString("reason");
    const member = await interaction.guild.members.fetch(user.id);

    if (!member.moderatable) {
        await interaction.reply({
            content: "❌ I cannot timeout that member. Check my role hierarchy.",
            ephemeral: true
        });
        return;
    }

    await member.timeout(minutes * 60 * 1000, reason);

    await interaction.reply(
        `⏱️ **${user.tag}** has been timed out for **${minutes} minute(s)**.\n**Reason:** ${reason}`
    );
    return;
}

        if (interaction.commandName === "userinfo") {
            const user = interaction.options.getUser("user");
            const member = await interaction.guild.members.fetch(user.id);
            const warnings = loadWarnings()[user.id] || [];
            await interaction.reply({
                content: `👤 **User Info**\\n\\n${formatMember(member)}\\n**Account created:** ${user.createdAt.toISOString()}\\n**Roles:** ${member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => r.name).join(", ") || "None"}\\n**Warnings:** ${warnings.length}`,
                ephemeral: true
            });
            return;
        }

        if (interaction.commandName === "unwarn") {
            const user = interaction.options.getUser("user");
            const number = interaction.options.getInteger("number");
            const warnings = loadWarnings();
            const list = warnings[user.id] || [];
            if (number > list.length) {
                await interaction.reply({ content: "❌ That warning number does not exist.", ephemeral: true });
                return;
            }
            const removed = list.splice(number - 1, 1)[0];
            warnings[user.id] = list;
            saveWarnings(warnings);
            await sendModLog(interaction.guild, `🧹 **Warning removed**\\n**User:** <@${user.id}>\\n**Moderator:** <@${interaction.user.id}>\\n**Reason:** ${removed.reason}`);
            await interaction.reply(`✅ Removed warning **#${number}** from **${user.tag}**.`);
            return;
        }

        if (interaction.commandName === "unban") {
            const userId = interaction.options.getString("user_id").trim();
            const reason = interaction.options.getString("reason");
            await interaction.guild.members.unban(userId, reason);
            await sendModLog(interaction.guild, `🔓 **Unban**\\n**User ID:** ${userId}\\n**Moderator:** <@${interaction.user.id}>\\n**Reason:** ${reason}`);
            await interaction.reply(`🔓 **${userId}** has been unbanned.`);
            return;
        }

        if (interaction.commandName === "untimeout") {
            const user = interaction.options.getUser("user");
            const reason = interaction.options.getString("reason");
            const member = await interaction.guild.members.fetch(user.id);
            if (!member.moderatable) {
                await interaction.reply({ content: "❌ I cannot remove that timeout. Check my role hierarchy.", ephemeral: true });
                return;
            }
            await member.timeout(null, reason);
            await sendModLog(interaction.guild, `🔓 **Timeout removed**\\n**User:** <@${user.id}>\\n**Moderator:** <@${interaction.user.id}>\\n**Reason:** ${reason}`);
            await interaction.reply(`🔓 **${user.tag}** is no longer timed out.`);
            return;
        }
if (interaction.commandName === "settings") {
    const menu = new StringSelectMenuBuilder()
        .setCustomId("settings_menu")
        .setPlaceholder("Choose a setting")
        .addOptions(
            {
                label: "Logs Channel",
                description: "Choose where moderation logs go",
                value: "logs",
                emoji: "📋"
            },
            {
                label: "AutoMod Flagged Words",
                description: "Set words AutoMod should flag",
                value: "words",
                emoji: "🚫"
            },
            {
                label: "View Current Settings",
                description: "See the current configuration",
                value: "view",
                emoji: "👀"
            }
        );

    await interaction.reply({
        content:
            "⚙️ **DSMP PvP Bot Settings**\n\n" +
            "Choose a setting below.",
        components: [
            new ActionRowBuilder().addComponents(menu)
        ],
        ephemeral: true
    });

    return;
}
if (interaction.commandName === "announce") {
    const channel = interaction.options.getChannel("channel");
    const message = interaction.options.getString("message");
    const role = interaction.options.getRole("role");

    if (!channel.isTextBased()) {
        await interaction.reply({
            content: "❌ That is not a text channel.",
            ephemeral: true
        });
        return;
    }

    if (role.id === interaction.guild.id || role.managed) {
        await interaction.reply({
            content: "❌ Please choose a normal server role, not @everyone or a managed role.",
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    await channel.send({
        content:
            `📢 **ANNOUNCEMENT**\n\n` +
            `${message}\n\n` +
            `— <@${interaction.user.id}>`
    });

    await interaction.editReply(
        `📨 Sending announcement DMs to members with ${role}...`
    );

    await interaction.guild.members.fetch();

    const membersWithRole = interaction.guild.members.cache.filter(
        member =>
            member.roles.cache.has(role.id) &&
            !member.user.bot
    );

    let sent = 0;
    let failed = 0;

    for (const member of membersWithRole.values()) {
        try {
            await member.send(
                `📢 **DSMP PvP Announcement**\n\n${message}`
            );
            sent++;
        } catch {
            failed++;
        }
    }

    await interaction.editReply(
        `✅ Announcement posted in <#${channel.id}> and DMed to **${sent}** member(s).` +
        (failed
            ? `\n⚠️ Could not DM **${failed}** member(s).`
            : "")
    );

    return;
}

if (interaction.commandName === "stats") {
            const guild = interaction.guild;
            const humans = guild.members.cache.filter(m => !m.user.bot).size;
            const bots = guild.members.cache.filter(m => m.user.bot).size;
            await interaction.reply(`📊 **DSMP PvP Stats**\\n\\n👥 Members: **${guild.memberCount}**\\n👤 Humans cached: **${humans}**\\n🤖 Bots cached: **${bots}**\\n💬 Channels: **${guild.channels.cache.size}**\\n🎭 Roles: **${guild.roles.cache.size - 1}**\\n🎫 Active tickets: **${guild.channels.cache.filter(c => c.isThread() && !c.archived).size}**`);
            return;
        }

        if (interaction.commandName === "report") {
            const user = interaction.options.getUser("user");
            const reason = interaction.options.getString("reason");
            const result = await createTicket(interaction, "Report a User");
            if (result.existing) {
                await interaction.reply({ content: `🎫 You already have an open report/support ticket: <#${result.thread.id}>`, ephemeral: true });
                return;
            }
            await result.thread.send({ content: `🚨 **Report submitted**\\nReported user: <@${user.id}>\\nReason: ${reason}\\nReported by: <@${interaction.user.id}>` });
            await interaction.reply({ content: `✅ Your report has been sent privately: <#${result.thread.id}>`, ephemeral: true });
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

                await interaction.reply(
                    seconds === 0
                        ? "🔓 **Slowmode disabled.**"
                        : `🐌 **Slowmode set to ${seconds} second(s).**`
                );
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
                reason,
                level,
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
                } else if (level === 3) {
                    await member.timeout(60 * 60 * 1000, reason);
                    punishment = "⏱️ 1-hour timeout";
                } else if (level === 4) {
                    await member.timeout(24 * 60 * 60 * 1000, reason);
                    punishment = "⏱️ 1-day timeout";
                } else if (level === 5) {
                    await member.kick(reason);
                    punishment = "👢 Kick";
                } else if (level === 6) {
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
                await interaction.reply(`📋 **${user.tag} has no warnings.**`);
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
    } catch (error) {
        console.error("❌ Interaction handler failed:", error);

        if (!interaction.replied && !interaction.deferred) {
            try {
                await interaction.reply({
                    content: "❌ Something went wrong while processing that interaction.",
                    ephemeral: true
                });
            } catch (replyError) {
                console.error("❌ Could not send error reply:", replyError);
            }
        } else if (interaction.deferred) {
            try {
                await interaction.editReply(
                    "❌ Something went wrong while processing that interaction."
                );
            } catch (replyError) {
                console.error("❌ Could not edit error reply:", replyError);
            }
        }
    }
});

client.on("messageCreate", async message => {
    if (!message.guild || message.author.bot) return;
    const now = Date.now();
    const history = spamTracker.get(message.author.id) || [];
    const recent = history.filter(t => now - t < 8000);
    recent.push(now);
    spamTracker.set(message.author.id, recent);
const settings = loadSettings(message.guild.id);

const flaggedWord = settings.flaggedWords.find(
    word =>
        word &&
        message.content.toLowerCase().includes(word)
);
    const invite = /(?:discord\.gg|discord\.com\/invite)\/[^\s]+/i.test(message.content);
    const mentionSpam = message.mentions.users.size >= 5;

if (flaggedWord || invite || mentionSpam || recent.length >= 6) {
        try {
            await message.delete();
            const member = message.member;
            if (member && member.moderatable) {
                await member.timeout(5 * 60 * 1000, "AutoMod: spam, mass mentions, or Discord invite");
            }
await sendModLog(
    message.guild,
    `🤖 **AutoMod action**\n` +
    `**User:** <@${message.author.id}>\n` +
    `**Reason:** ${
        flaggedWord
            ? `Flagged word: ${flaggedWord}`
            : invite
                ? "Discord invite link"
                : mentionSpam
                    ? "Mass mentions"
                    : "Spam"
    }\n` +
    `**Action:** Message deleted + 5 minute timeout`
);
        } catch (error) {
            console.error("❌ AutoMod action failed:", error.message);
        }
    }
});

client.on("error", console.error);

client.login(process.env.BOT_TOKEN);
