const {
    Client,
    AttachmentBuilder,
    EmbedBuilder,
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
const vouchSystem = require("./vouch-system");
const spawnerPrices = require("./spawner-prices");
const { startDashboardApi } = require("./dashboard-api");
const schematicLibrary = require("./schematic-library");
const schematicStorage = require("./schematic-storage");
const levelingSystem = require("./leveling-system");

const TICKET_CHANNEL_ID = "1553777212170178570";
const AI_TICKET_BOT_ID = process.env.AI_TICKET_BOT_ID;
const RULES_CHANNEL_ID = "1550441311621095495";
const SERVER_INFO_CHANNEL_ID = "1553771441462186004";
const GIVEAWAY_APPLICATION_CHANNEL_ID = "1557812749382193223";
const PARTNER_APPLICATION_CHANNEL_ID = "1557813451034988646";
const SCAM_REPORT_LOG_CHANNEL_ID = "1565309407598743652";
const SCAM_REPORT_CATEGORIES = [
    ["item_theft", "In-Game Item Theft"],
    ["fake_trade", "Fake Trade"],
    ["payment", "Payment Scam"],
    ["impersonation", "Impersonation"],
    ["other", "Other"]
];
const GIVEAWAYS_FILE = "./giveaways.json";
const GAMES_FILE = "./games.json";
const giveawayTimers = new Map();
const spamTracker = new Map();
const modLogChannelName = "mod-logs";
const SETTINGS_FILE = "./settings.json";

function loadSettings(guildId) {
    try {
        const all = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));

        return all[guildId] || {
            logChannelId: null,
            flaggedWords: [],
            honeypotChannelId: null
        };
    } catch {
        return {
            logChannelId: null,
            flaggedWords: [],
            honeypotChannelId: null
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

startDashboardApi(client);

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

async function sendCommandLog(guild, commandName, message) {
    try {
        let commandSettings = {};
        try { commandSettings = JSON.parse(fs.readFileSync("./command-settings.json", "utf8")); } catch {}
        const channelId = commandSettings[commandName]?.settings?.logChannelId;
        const channel = channelId
            ? await guild.channels.fetch(channelId).catch(() => null)
            : null;
        if (channel && channel.isTextBased()) {
            await channel.send({ content: message });
        } else {
            await sendModLog(guild, message);
        }
    } catch (error) {
        console.error("[Command log] Failed:", error.message);
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

function loadGames() {
    try { return JSON.parse(fs.readFileSync(GAMES_FILE, "utf8")); } catch { return {}; }
}

function saveGames(games) {
    fs.writeFileSync(GAMES_FILE, JSON.stringify(games, null, 2));
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
    // Dashboard edits can move the deadline after this timer was first scheduled.
    if (Number(giveaway.endAt) > Date.now()) { scheduleGiveaway(giveaway); return; }
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
        .setName("rules")
        .setDescription("Post the server rules in the rules channel")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName("serverinfo")
        .setDescription("Post AnchorFall server information in the server-info channel")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName("giveawayinfo")
        .setDescription("Post giveaway entry and prize-claim rules")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

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
    .addStringOption(option =>
        option
            .setName("reason")
            .setDescription("Reason for the timeout")
            .setRequired(true)
    )
    .addIntegerOption(option =>
        option
            .setName("minutes")
            .setDescription("Timeout duration in minutes (uses dashboard default if omitted)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(40320)
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
        .setName("verification-panel")
        .setDescription("Post the AnchorFall verification panel")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName("ticketpanel")
        .setDescription("Post the private ticket panel")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    new SlashCommandBuilder()
        .setName("schematic")
        .setDescription("Browse published schematics")
        .addSubcommand(subcommand => subcommand.setName("post").setDescription("Post the interactive schematic library panel").addChannelOption(option => option.setName("channel").setDescription("Channel for the panel").addChannelTypes(ChannelType.GuildText).setRequired(true)))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    new SlashCommandBuilder()
        .setName("schematic-request-panel")
        .setDescription("Post the schematic browsing panel")
        .addChannelOption(option => option.setName("channel").setDescription("Channel where members can browse schematics").addChannelTypes(ChannelType.GuildText).setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    new SlashCommandBuilder()
        .setName("game")
        .setDescription("Start a prize competition for the community")
        .addStringOption(option => option.setName("game").setDescription("Which game will people compete in?").setRequired(true).setMaxLength(100))
        .addStringOption(option => option.setName("prize").setDescription("What is the prize?").setRequired(true).setMaxLength(200)),

new SlashCommandBuilder()
        .setName("skillgame")
        .setDescription("Staff: start a skill-based prize challenge")
        .addStringOption(option => option.setName("game").setDescription("Choose the game").setRequired(true).addChoices(
            { name: "Guess the Flag (100 points)", value: "flag" },
            { name: "Guess the Number (5 points)", value: "number" },
            { name: "Minecraft Trivia (10 points)", value: "trivia" },
            { name: "Crystal PvP Quiz (10 points)", value: "crystal" }
        ))
        .addStringOption(option => option.setName("prize").setDescription("Prize for the winner").setRequired(true).setMaxLength(200))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

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
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    new SlashCommandBuilder()
        .setName("scamreport")
        .setDescription("Post the scam report button in this channel")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName("honeypot")
        .setDescription("Manage a channel that bans anyone who posts in it, then DMs a rejoin invite")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName("create")
                .setDescription("Create a bot-check channel")
                .addStringOption(option =>
                    option
                        .setName("name")
                        .setDescription("Channel name (default: bot-check)")
                        .setRequired(false)
                        .setMaxLength(100)
                )
                .addChannelOption(option =>
                    option
                        .setName("category")
                        .setDescription("Category to place the channel in")
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("set")
                .setDescription("Mark an existing channel as the honeypot")
                .addChannelOption(option =>
                    option
                        .setName("channel")
                        .setDescription("Channel to use as honeypot")
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("disable")
                .setDescription("Stop using the current honeypot (does not delete the channel)")
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("status")
                .setDescription("Show the current honeypot channel")
        ),

    ...vouchSystem.commands,
    ...spawnerPrices.commands,
    ...levelingSystem.commands
].map(command => command.toJSON());

const rest = new REST({ version: "10" })
    .setToken(process.env.BOT_TOKEN);

client.once("ready", async () => {
    console.log(`🔥 AnchorFall Mod Bot online as ${client.user.tag}`);

    try {
        await vouchSystem.initVouchDatabase();
        console.log("✅ Vouch database ready!");
    } catch (error) {
        console.error("❌ Vouch database setup failed:", error.message);
    }

    try {
        await levelingSystem.initLevelingDatabase(client);
        console.log("✅ Leveling database ready!");
    } catch (error) {
        console.error("❌ Leveling database setup failed:", error.message);
    }

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
    const aiHelperAdded = await addAiTicketBotToThread(thread);

    const ticketButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("close_ticket")
            .setLabel("Close Ticket")
            .setEmoji("🔒")
            .setStyle(ButtonStyle.Danger)
    );

    const openingMessage = aiHelperAdded
        ? `🎫 **New ${ticketType} Ticket**\n\n` +
          `Opened by <@${interaction.user.id}>.\n\n` +
          "Please explain what you need help with. An AI helper powered by OpenAI will read this ticket and gather details. Type **staff** any time for a human.\n\n" +
          "Use **Close Ticket** when you are finished."
        : `<@&1553780133867814982> 🎫 **New ${ticketType} Ticket**\n\n` +
          `Opened by <@${interaction.user.id}>.\n\n` +
          "Please explain what you need help with. Staff, please respond when available.\n\n" +
          "Use **Close Ticket** when you are finished.";

    await thread.send({
        content: openingMessage,
        allowedMentions: {
            parse: [],
            users: [interaction.user.id],
            roles: aiHelperAdded ? [] : ["1553780133867814982"]
        },
        components: [ticketButtons]
    });

    return { thread, existing: false };
}

async function addAiTicketBotToThread(thread) {
    if (!AI_TICKET_BOT_ID) return false;
    try {
        await thread.members.add(AI_TICKET_BOT_ID);
        return true;
    } catch (error) {
        console.error("Could not add the AI ticket bot to thread " + thread.id + ":", error.message);
        return false;
    }
}

async function addAiTicketBotToActiveTickets() {
    if (!AI_TICKET_BOT_ID) return;
    const parent = await client.channels.fetch(TICKET_CHANNEL_ID).catch(() => null);
    if (!parent || parent.type !== ChannelType.GuildText) {
        console.error("AI ticket bot could not find the ticket parent channel.");
        return;
    }

    const activeThreads = await parent.threads.fetchActive();
    for (const thread of activeThreads.threads.values()) {
        if (!thread.name.startsWith("ticket-")) continue;
        await addAiTicketBotToThread(thread);
    }
}

client.once("ready", () => {
    addAiTicketBotToActiveTickets().catch(error =>
        console.error("Could not add the AI ticket bot to active tickets:", error.message)
    );
});

client.on("interactionCreate", async interaction => {
    if (interaction.isAutocomplete()) {
        try {

        } catch (error) {
            console.error("Schematic category autocomplete failed:", error);
            try { await interaction.respond([]); } catch (_) {}
        }
        return;
    }
    try {
        if (await spawnerPrices.handleInteraction(interaction)) return;
        if (await vouchSystem.handleVouchInteraction(interaction)) return;
        if (await levelingSystem.handleInteraction(interaction)) return;
        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === "schematic_category") {
                const builds = await schematicLibrary.listPublished(Number(interaction.values[0]));
                if (!builds.length) { await interaction.reply({ content: "📚 No published schematics in this category yet.", ephemeral: true }); return; }
                const menu = new StringSelectMenuBuilder().setCustomId("schematic_build").setPlaceholder("Choose a schematic to download").addOptions(builds.slice(0,25).map(s => ({ label:s.name.slice(0,100), value:String(s.id), description:(s.description || "Download schematic").slice(0,100) })));
                await interaction.reply({ content:"📚 Published schematics — choose one to get a secure download link.", components:[new ActionRowBuilder().addComponents(menu)], ephemeral:true });
                return;
            }
            if (interaction.customId === "schematic_build") {
                const build = await schematicLibrary.getById(Number(interaction.values[0]));
                if (!build || build.status !== "published" || !build.file_key) { await interaction.reply({ content:"That schematic is unavailable.", ephemeral:true }); return; }
                const link = await schematicStorage.createDownloadUrl(build.file_key, build.file_name || (build.name + ".litematic"));
                await interaction.reply({ content:"Download **"+build.name+"**\n"+(build.description || "")+"\n[Download .litematic]("+link+")\nThis private link expires in 5 minutes.", ephemeral:true });
                return;
            }
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
                        title: "AnchorFall Staff Application",
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

            if (interaction.customId === "scam_report:categorize") {
                const label = SCAM_REPORT_CATEGORIES.find(entry => entry[0] === interaction.values[0])?.[1];
                if (!label) return;
                if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
                    await interaction.reply({ content: "You need Moderate Members to categorize this report.", ephemeral: true });
                    return;
                }
                if (interaction.message.hasThread) {
                    await interaction.reply({ content: `This report is already open in <#${interaction.message.thread.id}>.`, ephemeral: true });
                    return;
                }

                const source = interaction.message.embeds[0];
                const ign = source?.fields?.find(field => field.name === "Accused IGN")?.value?.trim() || "Not Provided";
                const accusedId = source?.fields?.find(field => field.name === "Accused User ID")?.value?.trim() || "unknown";
                const subject = ign === "Not Provided" ? accusedId : ign;
                const threadName = `[${label}] - ${subject}`.slice(0, 100);

                await interaction.deferUpdate();
                const thread = await interaction.message.startThread({
                    name: threadName,
                    type: ChannelType.PrivateThread,
                    reason: `Scam report opened by ${interaction.user.tag}`
                });
                await thread.members.add(interaction.user.id).catch(() => {});
                await thread.send({
                    content: `<@${interaction.user.id}> claimed this case (**${label}**).`,
                    embeds: source ? [EmbedBuilder.from(source)] : [],
                    allowedMentions: { users: [interaction.user.id] }
                });
                const opened = source
                    ? EmbedBuilder.from(source).setColor(0x57f287).setFooter({ text: "Case Opened / Under Review" })
                    : new EmbedBuilder().setColor(0x57f287).setDescription("Case Opened / Under Review");
                await interaction.message.edit({
                    content: "🟢 Case Opened / Under Review",
                    embeds: [opened],
                    components: []
                });
                return;
            }

            return;
        }

        if (interaction.isButton()) {
            if (interaction.customId === "support_ticket_open") {
                await interaction.deferReply({ ephemeral: true });
                try {
                    const result = await createTicket(interaction, "Support");
                    await interaction.editReply(
                        result.existing
                            ? `🎫 You already have an open ticket: <#${result.thread.id}>`
                            : `✅ Your private support ticket has been opened: <#${result.thread.id}>`
                    );
                } catch (error) {
                    console.error("Support ticket button failed:", error);
                    await interaction.editReply("❌ I couldn't open a ticket. Please notify staff.");
                }
                return;
            }

            if (interaction.customId === "anchorfall_verify") {
                if (!interaction.inGuild() || !interaction.member) {
                    await interaction.reply({ content: "❌ Verification only works inside the server.", ephemeral: true });
                    return;
                }
                await interaction.deferReply({ ephemeral: true });
                try {
                    const member = await interaction.guild.members.fetch(interaction.user.id);
                    const verifiedRole = await interaction.guild.roles.fetch("1562149545604026468");
                    if (!verifiedRole) {
                        await interaction.editReply("❌ The verification role wasn't found. Please tell staff.");
                        return;
                    }
                    if (member.roles.cache.has(verifiedRole.id)) {
                        await interaction.editReply("✅ You're already verified!");
                        return;
                    }
                    const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
                    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
                        botMember.roles.highest.comparePositionTo(verifiedRole) <= 0) {
                        await interaction.editReply("❌ Verification is temporarily unavailable. Staff need to check the bot's Manage Roles permission and role order.");
                        return;
                    }
                    await member.roles.add(verifiedRole, "Member completed AnchorFall verification");
                    await interaction.editReply("✅ You're verified! Welcome to AnchorFall.");
                } catch (error) {
                    console.error("Verification button failed:", error);
                    await interaction.editReply("❌ Verification failed. Please contact staff.");
                }
                return;
            }
            if (interaction.customId.startsWith("schematic_request_open_ticket:")) {
                if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
                    await interaction.reply({ content: "❌ Only staff can open request tickets.", ephemeral: true });
                    return;
                }
                const requesterId = interaction.customId.split(":")[1];
                const parent = await interaction.guild.channels.fetch(TICKET_CHANNEL_ID).catch(() => null);
                if (!parent || parent.type !== ChannelType.GuildText) {
                    await interaction.reply({ content: "❌ The ticket channel could not be found.", ephemeral: true });
                    return;
                }
                const thread = await parent.threads.create({
                    name: ("schematic-" + interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40)).slice(0, 100),
                    type: ChannelType.PrivateThread,
                    invitable: false,
                    reason: "Schematic request ticket opened by " + interaction.user.tag
                }).catch(error => {
                    console.error("Schematic ticket thread creation failed:", error);
                    throw new Error("Couldn't create the private ticket thread. Check the bot's Create Private Threads permission in the ticket channel.");
                });
                await thread.members.add(requesterId).catch(() => {});
                await thread.members.add(interaction.user.id).catch(() => {});
                const originalEmbed = interaction.message.embeds[0]
                    ? EmbedBuilder.from(interaction.message.embeds[0]).toJSON()
                    : null;
                const allowedUserMentions = [...new Set([requesterId, interaction.user.id])];
                await thread.send({
                    content: "<@&1559818368742334524> <@" + requesterId + "> A schematic request ticket has been opened by <@" + interaction.user.id + ">.",
                    embeds: originalEmbed ? [originalEmbed] : [],
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId("close_ticket")
                            .setLabel("Close Ticket")
                            .setEmoji("🔒")
                            .setStyle(ButtonStyle.Danger)
                    )],
                    allowedMentions: { users: allowedUserMentions, roles: ["1559818368742334524"], parse: [] }
                }).catch(error => {
                    console.error("Schematic ticket first message failed:", error);
                    throw new Error("The ticket was created, but I couldn't send its first message. Check Send Messages in Threads and Embed Links permissions.");
                });
                await interaction.reply({ content: "✅ Ticket opened: <#" + thread.id + ">", ephemeral: true });
                return;
            }

            if (interaction.customId.startsWith("schematic_request_deny:")) {
                if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
                    await interaction.reply({ content: "❌ Only staff can deny requests.", ephemeral: true });
                    return;
                }
                const requesterId = interaction.customId.split(":")[1];
                const requester = await client.users.fetch(requesterId).catch(() => null);
                if (requester) {
                    await requester.send("Sorry, we didn't do your schematic. You can request it again if you would like!").catch(() => {});
                }
                await interaction.message.edit({ components: [] });
                await interaction.reply({ content: "🗑️ Request denied.", ephemeral: true });
                return;
            }
            if (interaction.customId === "schematic_request_start") {
                const modal = new ModalBuilder()
                    .setCustomId("schematic_request_form")
                    .setTitle("Schematic Request")
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId("schematic_theme")
                                .setLabel("Theme")
                                .setStyle(TextInputStyle.Short)
                                .setPlaceholder("e.g. medieval, modern, fantasy")
                                .setRequired(true)
                                .setMaxLength(100)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId("schematic_colours")
                                .setLabel("Colours")
                                .setStyle(TextInputStyle.Short)
                                .setPlaceholder("e.g. white, blue, grey")
                                .setRequired(true)
                                .setMaxLength(150)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId("schematic_max_size")
                                .setLabel("Maximum size")
                                .setStyle(TextInputStyle.Short)
                                .setPlaceholder("e.g. 50x50x30 blocks")
                                .setRequired(true)
                                .setMaxLength(100)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId("schematic_use")
                                .setLabel("What will you use it for?")
                                .setStyle(TextInputStyle.Paragraph)
                                .setPlaceholder("e.g. base, farm, decoration, PvP")
                                .setRequired(true)
                                .setMaxLength(1000)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId("schematic_ref_images")
                                .setLabel("Reference image links")
                                .setStyle(TextInputStyle.Paragraph)
                                .setPlaceholder("Paste image URLs, or write None")
                                .setRequired(true)
                                .setMaxLength(1000)
                        )
                    );
                await interaction.showModal(modal);
                return;
            }
            if (interaction.customId.startsWith("skillplay:")) {
                const id = interaction.customId.slice("skillplay:".length);
                const events = loadGames(); const event = events[id];
                if (!event || event.ended) { await interaction.reply({ content: "This challenge has ended.", ephemeral: true }); return; }
                const questions = {
                    flag: [
                        ["https://flagcdn.com/w320/jp.png",["Japan","China","South Korea","Thailand"],0],["https://flagcdn.com/w320/ca.png",["United States","Canada","Denmark","Austria"],1],
                        ["https://flagcdn.com/w320/br.png",["Portugal","Brazil","Argentina","Mexico"],1],["https://flagcdn.com/w320/fr.png",["France","Netherlands","Russia","Italy"],0],
                        ["https://flagcdn.com/w320/au.png",["New Zealand","Australia","Fiji","United Kingdom"],1],["https://flagcdn.com/w320/de.png",["Belgium","Germany","Spain","Poland"],1],
                        ["https://flagcdn.com/w320/in.png",["India","Ireland","Niger","Pakistan"],0],["https://flagcdn.com/w320/se.png",["Finland","Norway","Sweden","Iceland"],2],
                        ["https://flagcdn.com/w320/mx.png",["Mexico","Italy","Hungary","Bulgaria"],0],["https://flagcdn.com/w320/za.png",["Kenya","South Africa","Nigeria","Ghana"],1]
                    ],
                    number: [
                        ["What comes next: 2, 4, 6, 8, ?",["9","10","12","14"],1],["What is 7 × 6?",["36","40","42","48"],2],
                        ["What comes next: 1, 1, 2, 3, 5, ?",["6","7","8","9"],2],["What is 81 ÷ 9?",["7","8","9","10"],2],
                        ["What is 15 + 17?",["30","31","32","33"],2]
                    ],
                    trivia: [
                        ["Which material is used to craft a standard torch?",["Coal or charcoal","Iron","Redstone","Flint"],0],
                        ["Which dimension contains Endermen naturally?",["Overworld only","Nether only","The End","None"],2],
                        ["What tool is best for mining stone?",["Hoe","Pickaxe","Shovel","Sword"],1],
                        ["Which mob explodes near players?",["Skeleton","Creeper","Spider","Slime"],1],
                        ["What do you need to enter the End portal in survival?",["Eyes of Ender","Blaze rods only","Diamonds","Ghast tears"],0],
                        ["Which ore drops experience when mined without Silk Touch?",["Iron ore","Coal ore","Ancient debris","None"],1],
                        ["What does a shield help block?",["Many incoming attacks","Fall damage","Hunger","All status effects"],0],
                        ["Which mob trades with gold in the Nether?",["Villager","Piglin","Witch","Allay"],1],
                        ["What grows into a tree?",["Sapling","Stick","Vine","Bamboo only"],0],
                        ["Which item repairs elytra in an anvil?",["Leather","Phantom membranes","Feathers","String"],1]
                    ],
                    crystal: [
                        ["What block is required to place an End Crystal?",["Obsidian or bedrock","Stone","Dirt","Glass"],0],
                        ["What item is commonly used to respawn the Ender Dragon?",["End crystal","Totem","Beacon","Ender pearl"],0],
                        ["What can protect you from one lethal hit?",["Totem of Undying","Compass","Spyglass","Lead"],0],
                        ["What effect does a golden apple provide?",["Regeneration/absorption effects","Mining fatigue","Levitation","Bad omen"],0],
                        ["Which item helps you move quickly between positions?",["Ender pearl","Bucket","Shield","Anvil"],0],
                        ["What armor material generally offers strong protection?",["Leather","Netherite","Gold","Chainmail"],1],
                        ["What is the main risk of placing crystals too close?",["Self-damage","Losing hunger instantly","Weather changes","Villagers despawn"],0],
                        ["What can reduce explosion damage?",["Blast Protection","Feather Falling only","Aqua Affinity","Thorns only"],0],
                        ["Which item can save you from a fatal hit if charged?",["Totem of Undying","Clock","Map","Fishing rod"],0],
                        ["Why do players use obsidian in crystal PvP?",["It supports crystal placement","It heals players","It disables armor","It prevents all damage"],0]
                    ]
                };
                const qs = questions[event.type];
                if (!qs) { await interaction.reply({ content: "Unknown quiz type.", ephemeral: true }); return; }
                event.players = [...new Set([...(event.players || []), interaction.user.id])];
                event.sessions = event.sessions || {};
                if (event.sessions[interaction.user.id]?.complete) { await interaction.reply({ content: "You've already completed this challenge. Your score is **" + event.sessions[interaction.user.id].score + "**.", ephemeral: true }); return; }
                event.sessions[interaction.user.id] = { index: 0, score: 0, complete: false };
                saveGames(events);
                const q = qs[0];
                const row = new ActionRowBuilder().addComponents(q[1].map((answer,i) => new ButtonBuilder().setCustomId("skillanswer:" + id + ":" + i).setLabel(answer).setStyle(ButtonStyle.Secondary)));
                await interaction.reply({ content: "**Question 1/" + qs.length + "**" + (event.type === "flag" ? "\nIdentify the flag shown in the image:" : "\n" + q[0]), embeds: event.type === "flag" ? [new EmbedBuilder().setColor(0x7c3aed).setTitle("🇺🇳 Guess the Flag").setImage(q[0])] : [], components: [row], ephemeral: true });
                return;
            }
            if (interaction.customId.startsWith("skillanswer:")) {
                const parts = interaction.customId.split(":"); const id = parts[1]; const choice = Number(parts[2]);
                const events = loadGames(); const event = events[id];
                const questions = {
                    flag: [["https://flagcdn.com/w320/jp.png",["Japan","China","South Korea","Thailand"],0],["https://flagcdn.com/w320/ca.png",["United States","Canada","Denmark","Austria"],1],["https://flagcdn.com/w320/br.png",["Portugal","Brazil","Argentina","Mexico"],1],["https://flagcdn.com/w320/fr.png",["France","Netherlands","Russia","Italy"],0],["https://flagcdn.com/w320/au.png",["New Zealand","Australia","Fiji","United Kingdom"],1],["https://flagcdn.com/w320/de.png",["Belgium","Germany","Spain","Poland"],1],["https://flagcdn.com/w320/in.png",["India","Ireland","Niger","Pakistan"],0],["https://flagcdn.com/w320/se.png",["Finland","Norway","Sweden","Iceland"],2],["https://flagcdn.com/w320/mx.png",["Mexico","Italy","Hungary","Bulgaria"],0],["https://flagcdn.com/w320/za.png",["Kenya","South Africa","Nigeria","Ghana"],1]],
                    number: [["What comes next: 2, 4, 6, 8, ?",["9","10","12","14"],1],["What is 7 × 6?",["36","40","42","48"],2],["What comes next: 1, 1, 2, 3, 5, ?",["6","7","8","9"],2],["What is 81 ÷ 9?",["7","8","9","10"],2],["What is 15 + 17?",["30","31","32","33"],2]],
                    trivia: [["Which material is used to craft a standard torch?",["Coal or charcoal","Iron","Redstone","Flint"],0],["Which dimension contains Endermen naturally?",["Overworld only","Nether only","The End","None"],2],["What tool is best for mining stone?",["Hoe","Pickaxe","Shovel","Sword"],1],["Which mob explodes near players?",["Skeleton","Creeper","Spider","Slime"],1],["What do you need to enter the End portal in survival?",["Eyes of Ender","Blaze rods only","Diamonds","Ghast tears"],0],["Which ore drops experience when mined without Silk Touch?",["Iron ore","Coal ore","Ancient debris","None"],1],["What does a shield help block?",["Many incoming attacks","Fall damage","Hunger","All status effects"],0],["Which mob trades with gold in the Nether?",["Villager","Piglin","Witch","Allay"],1],["What grows into a tree?",["Sapling","Stick","Vine","Bamboo only"],0],["Which item repairs elytra in an anvil?",["Leather","Phantom membranes","Feathers","String"],1]],
                    crystal: [["What block is required to place an End Crystal?",["Obsidian or bedrock","Stone","Dirt","Glass"],0],["What item is commonly used to respawn the Ender Dragon?",["End crystal","Totem","Beacon","Ender pearl"],0],["What can protect you from one lethal hit?",["Totem of Undying","Compass","Spyglass","Lead"],0],["What effect does a golden apple provide?",["Regeneration/absorption effects","Mining fatigue","Levitation","Bad omen"],0],["Which item helps you move quickly between positions?",["Ender pearl","Bucket","Shield","Anvil"],0],["What armor material generally offers strong protection?",["Leather","Netherite","Gold","Chainmail"],1],["What is the main risk of placing crystals too close?",["Self-damage","Losing hunger instantly","Weather changes","Villagers despawn"],0],["What can reduce explosion damage?",["Blast Protection","Feather Falling only","Aqua Affinity","Thorns only"],0],["Which item can save you from a fatal hit if charged?",["Totem of Undying","Clock","Map","Fishing rod"],0],["Why do players use obsidian in crystal PvP?",["It supports crystal placement","It heals players","It disables armor","It prevents all damage"],0]]
                };
                if (!event || event.ended) { await interaction.reply({ content: "This challenge has ended.", ephemeral: true }); return; }
                const qs = questions[event.type]; const session = event.sessions?.[interaction.user.id];
                if (!session || session.complete) { await interaction.reply({ content: "Press Play Challenge to start your own attempt.", ephemeral: true }); return; }
                const q = qs[session.index];
                if (!q) { await interaction.reply({ content: "Your attempt is already complete.", ephemeral: true }); return; }
                if (choice === q[2]) session.score += event.type === "flag" ? 10 : 1;
                session.index++;
                if (session.index >= qs.length) {
                    session.complete = true; event.scores[interaction.user.id] = session.score; saveGames(events);
                    await interaction.update({ content: "✅ **Quiz complete!** Your score: **" + session.score + "/" + (event.type === "flag" ? 100 : event.type === "number" ? 5 : 10) + "**. Staff can end the event when everyone has played.", components: [] });
                    return;
                }
                saveGames(events);
                const next = qs[session.index];
                const row = new ActionRowBuilder().addComponents(next[1].map((answer,i) => new ButtonBuilder().setCustomId("skillanswer:" + id + ":" + i).setLabel(answer).setStyle(ButtonStyle.Secondary)));
                await interaction.update({ content: "**Question " + (session.index + 1) + "/" + qs.length + "**" + (event.type === "flag" ? "\nIdentify the flag shown in the image:" : "\n" + next[0]), embeds: event.type === "flag" ? [new EmbedBuilder().setColor(0x7c3aed).setTitle("🇺🇳 Guess the Flag").setImage(next[0])] : [], components: [row] });
                return;
            }
            if (interaction.customId.startsWith("skillfinish:")) {
                const id = interaction.customId.slice("skillfinish:".length);
                const events = loadGames(); const event = events[id];
                const isStaff = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
                    || interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)
                    || interaction.member?.roles?.cache?.some(role => role.name.toLowerCase() === "giveaway mod");
                if (!isStaff) { await interaction.reply({ content: "Only staff can end this event.", ephemeral: true }); return; }
                if (!event || event.ended) { await interaction.reply({ content: "This event is already ended.", ephemeral: true }); return; }
                const scores = Object.entries(event.scores || {}).sort((a,b) => b[1] - a[1]);
                if (!scores.length) { await interaction.reply({ content: "Nobody has completed a quiz yet.", ephemeral: true }); return; }
                const best = scores[0][1]; const winners = scores.filter(([,score]) => score === best);
                if (winners.length > 1) { await interaction.reply({ content: "It's tied at " + best + " points. Please run a skill-based tiebreaker; random draws aren't allowed.", ephemeral: true }); return; }
                event.ended = true; event.winnerId = winners[0][0]; saveGames(events);
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("skillclaim:" + id).setLabel("Claim Prize").setEmoji("🎟️").setStyle(ButtonStyle.Success));
                await interaction.message.edit({ components: [] }).catch(() => {});
                await interaction.channel.send({ embeds: [new EmbedBuilder().setColor(0x22c55e).setTitle("🏆 Skill Challenge Results").setDescription("**Winner:** <@" + event.winnerId + ">\n**Score:** " + best + "\n**Prize:** " + event.prize + "\n\nThe winner can claim through a private ticket.")], components: [row] });
                await interaction.reply({ content: "Winner announced.", ephemeral: true }); return;
            }
            if (interaction.customId.startsWith("skillclaim:")) {
                const id = interaction.customId.slice("skillclaim:".length);
                const events = loadGames(); const event = events[id];
                if (!event || !event.ended || event.winnerId !== interaction.user.id) { await interaction.reply({ content: "Only the winner can claim this prize.", ephemeral: true }); return; }
                const parent = await interaction.guild.channels.fetch(TICKET_CHANNEL_ID).catch(() => null);
                if (!parent || parent.type !== ChannelType.GuildText) { await interaction.reply({ content: "Prize ticket channel is not configured. Contact staff.", ephemeral: true }); return; }
                const thread = await parent.threads.create({ name: ("skill-prize-" + interaction.user.username).slice(0,100), type: ChannelType.PrivateThread, invitable: false, reason: "Skill challenge prize claim" });
                await thread.members.add(interaction.user.id);
                await thread.send({ content: "🎟️ **Skill Game Prize Claim**\nWinner: <@" + interaction.user.id + ">\nGame: " + event.type + "\nPrize: " + event.prize + "\nScore: " + event.scores[interaction.user.id] + "\nHosted by: <@" + event.hostId + ">\nStaff: verify the score before awarding the prize.", components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("close_ticket").setLabel("Close Ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger))] });
                await interaction.reply({ content: "Prize claim ticket opened: <#" + thread.id + ">", ephemeral: true }); return;
            }

            if (interaction.customId.startsWith("game_join:")) {
                const gameId = interaction.customId.split(":")[1];
                const games = loadGames();
                const competition = games[gameId];
                if (!competition || competition.ended) {
                    await interaction.reply({ content: "❌ This competition has ended or no longer exists.", ephemeral: true });
                    return;
                }
                if (competition.players.includes(interaction.user.id)) {
                    await interaction.reply({ content: "⚠️ You're already signed up for this competition.", ephemeral: true });
                    return;
                }
                competition.players.push(interaction.user.id);
                saveGames(games);
                await interaction.reply({ content: `✅ You're signed up to compete in **${competition.game}** for **${competition.prize}**! The host will share match details.`, ephemeral: true });
                return;
            }

            if (interaction.customId.startsWith("giveaway_enter:")) {
                const giveawayId = interaction.customId.split(":")[1];
                const giveaways = loadGiveaways();
                const giveaway = giveaways[giveawayId];
                if (!giveaway || giveaway.ended || giveaway.endAt <= Date.now()) { await interaction.reply({ content: "❌ This giveaway has ended.", ephemeral: true }); return; }
                if (giveaway.entries.includes(interaction.user.id)) { await interaction.reply({ content: "⚠️ You are already entered in this giveaway.", ephemeral: true }); return; }
                if (Number(giveaway.maxEntries) > 0 && giveaway.entries.length >= giveaway.maxEntries) { await interaction.reply({ content: "❌ This giveaway has reached the maximum number of entries.", ephemeral: true }); return; }
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
            if (interaction.customId === "scam_report:init") {
                const modal = new ModalBuilder()
                    .setCustomId("scam_report:modal")
                    .setTitle("Submit Scam Report")
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId("scam_target_id")
                                .setLabel("Offender's Discord ID or Mention")
                                .setStyle(TextInputStyle.Short)
                                .setRequired(true)
                                .setMaxLength(100)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId("scam_target_ign")
                                .setLabel("Offender's In-Game Name (IGN)")
                                .setStyle(TextInputStyle.Short)
                                .setRequired(false)
                                .setPlaceholder("Leave blank if unknown")
                                .setMaxLength(64)
                        ),
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId("scam_details")
                                .setLabel("Details & Proof Links")
                                .setStyle(TextInputStyle.Paragraph)
                                .setRequired(true)
                                .setPlaceholder("What happened, and links to screenshots or clips")
                                .setMaxLength(1000)
                        )
                    );
                await interaction.showModal(modal);
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

            await interaction.deferReply({ ephemeral: true });

            const ticketThread = interaction.channel;
            const transcriptChannelId = "1557830798609223760";

            try {
                const transcriptChannel = await interaction.guild.channels.fetch(transcriptChannelId);
                if (!transcriptChannel || !transcriptChannel.isTextBased()) {
                    throw new Error("Transcript log channel not found or not text-based.");
                }

                const allMessages = [];
                let before;
                while (true) {
                    const batch = await ticketThread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
                    if (batch.size === 0) break;
                    allMessages.push(...batch.values());
                    before = batch.last().id;
                    if (batch.size < 100) break;
                }

                allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
                const transcriptLines = [
                    `Ticket transcript: #${ticketThread.name}`,
                    `Ticket ID: ${ticketThread.id}`,
                    `Closed by: ${interaction.user.tag} (${interaction.user.id})`,
                    `Closed at: ${new Date().toISOString()}`,
                    "=".repeat(72),
                    ""
                ];

                for (const msg of allMessages) {
                    const timestamp = new Date(msg.createdTimestamp).toISOString();
                    const author = msg.author ? `${msg.author.tag} (${msg.author.id})` : "Unknown author";
                    transcriptLines.push(`[${timestamp}] ${author}:`);
                    if (msg.content) transcriptLines.push(msg.content);
                    for (const attachment of msg.attachments.values()) {
                        transcriptLines.push(`Attachment: ${attachment.name || "file"} — ${attachment.url}`);
                    }
                    if (msg.embeds.length) transcriptLines.push(`[Message contains ${msg.embeds.length} embed(s)]`);
                    if (msg.stickers.size) transcriptLines.push(`[Stickers: ${[...msg.stickers.values()].map(s => s.name).join(", ")}]`);
                    transcriptLines.push("");
                }

                const transcript = Buffer.from(transcriptLines.join("\n"), "utf8");
                const safeName = ticketThread.name.replace(/[^a-z0-9-_]/gi, "-").slice(0, 80);
                await transcriptChannel.send({
                    content: `📄 Transcript for **#${ticketThread.name}** (closed by <@${interaction.user.id}>)`,
                    files: [new AttachmentBuilder(transcript, { name: `${safeName}-transcript.txt` })]
                });
            } catch (error) {
                console.error("❌ Ticket transcript failed:", error);
                await interaction.editReply("⚠️ I couldn't save the transcript. Check the bot's access to the logs channel; the ticket has not been archived.");
                return;
            }

            await ticketThread.setLocked(true);
            await ticketThread.setArchived(true);
            await interaction.editReply("🔒 Ticket closed and transcript saved to the logs channel.");
            return;
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === "scam_report:modal") {
                const target = interaction.fields.getTextInputValue("scam_target_id").trim();
                const ign = interaction.fields.getTextInputValue("scam_target_ign").trim();
                const details = interaction.fields.getTextInputValue("scam_details").trim();
                const logChannel = await interaction.guild.channels.fetch(SCAM_REPORT_LOG_CHANNEL_ID).catch(() => null);
                if (!logChannel || !logChannel.isTextBased()) {
                    await interaction.reply({ content: "I couldn't find the staff scam-report channel. Please tell staff.", ephemeral: true });
                    return;
                }
                const menu = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId("scam_report:categorize")
                        .setPlaceholder("Categorize this report")
                        .addOptions(SCAM_REPORT_CATEGORIES.map(([value, name, description]) => ({
                            label: name,
                            value,
                            description
                        })))
                );
                await logChannel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0xed4245)
                            .setTitle("Scam Report")
                            .addFields(
                                { name: "Reporter", value: `<@${interaction.user.id}> (\`${interaction.user.id}\`)` },
                                { name: "Accused User ID", value: target.slice(0, 1024) },
                                { name: "Accused IGN", value: (ign || "Not Provided").slice(0, 1024) },
                                { name: "Details & proof", value: details.slice(0, 1024) }
                            )
                            .setTimestamp()
                    ],
                    components: [menu]
                });
                await interaction.reply({ content: "Report sent to staff. Thanks.", ephemeral: true });
                return;
            }
            if (interaction.customId === "schematic_request_form") {
                const theme = interaction.fields.getTextInputValue("schematic_theme");
                const colours = interaction.fields.getTextInputValue("schematic_colours");
                const maxSize = interaction.fields.getTextInputValue("schematic_max_size");
                const use = interaction.fields.getTextInputValue("schematic_use");
                const refImages = interaction.fields.getTextInputValue("schematic_ref_images");
                const requestChannel = await interaction.guild.channels.fetch("1559819140514971668").catch(() => null);

                if (!requestChannel || !requestChannel.isTextBased()) {
                    await interaction.reply({
                        content: "❌ I couldn't find the schematic request channel. Please tell staff.",
                        ephemeral: true
                    });
                    return;
                }

                const requestMessage = await requestChannel.send({
                    content: "📐 **New Schematic Request**\nSubmitted by: <@"
                        + interaction.user.id + ">",
                    embeds: [{
                        color: 0x5865F2,
                        title: "Schematic Request",
                        fields: [
                            { name: "Theme", value: theme.slice(0, 1024) },
                            { name: "Colours", value: colours.slice(0, 1024) },
                            { name: "Maximum size", value: maxSize.slice(0, 1024) },
                            { name: "Use", value: use.slice(0, 1024) },
                            { name: "Reference images", value: refImages.slice(0, 1024) }
                        ],
                        footer: { text: "Requester ID: " + interaction.user.id },
                        timestamp: new Date().toISOString()
                    }],
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId("schematic_request_open_ticket:" + interaction.user.id)
                            .setLabel("Open ticket")
                            .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                            .setCustomId("schematic_request_deny:" + interaction.user.id)
                            .setLabel("Deny")
                            .setStyle(ButtonStyle.Danger)
                    )]
                });

                await interaction.reply({
                    content: "✅ Your schematic request has been sent to staff!",
                    ephemeral: true
                });
                return;
            }
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

        let allCommandSettings = {};
        try {
            allCommandSettings = JSON.parse(fs.readFileSync("./command-settings.json", "utf8"));
            if (allCommandSettings[interaction.commandName]?.enabled === false) {
                await interaction.reply({ content: "This command is currently disabled by an administrator.", ephemeral: true });
                return;
            }
        } catch (error) {
            if (error.code !== "ENOENT") console.warn("[Command settings] Could not read settings:", error.message);
        }

        const moderationCommands = new Set([
            "warn", "warnings", "unwarn", "kick", "ban", "unban", "timeout",
            "untimeout", "purge", "lock", "unlock", "slowmode"
        ]);
        const activeCommandSettings = allCommandSettings[interaction.commandName] || {};
        const requiredStaffRoleId = activeCommandSettings.settings?.staffRoleId;
        if (moderationCommands.has(interaction.commandName) && requiredStaffRoleId) {
            const hasStaffRole = interaction.member?.roles?.cache?.has(requiredStaffRoleId);
            const isGuildOwner = interaction.guild?.ownerId === interaction.user.id;
            if (!hasStaffRole && !isGuildOwner) {
                await interaction.reply({ content: "⛔ You need the staff role configured for this command to use it.", ephemeral: true });
                return;
            }
        }

        if (interaction.commandName === "ping") {
            await interaction.reply("🏓 Pong!");
            return;
        }

        if (interaction.commandName === "rules") {
            await interaction.deferReply({ ephemeral: true });
            try {
                let rulesChannelId = RULES_CHANNEL_ID;
                try { const commandSettings = JSON.parse(fs.readFileSync("./command-settings.json", "utf8")); if (commandSettings.rules?.channelId) rulesChannelId = commandSettings.rules.channelId; } catch {}
                const rulesChannel = await interaction.guild.channels.fetch(rulesChannelId);
                if (!rulesChannel || !rulesChannel.isTextBased()) {
                    await interaction.editReply("❌ I couldn't find the rules channel. Check the channel ID.");
                    return;
                }

                const rulesEmbed = {
                    color: 0x7c3aed,
                    title: "📜 AnchorFall Server Rules",
                    description: [
                        "**1. Respect everyone** — No harassment, hate speech, threats, or targeted abuse.",
                        "**2. No spam** — Avoid flooding chat, excessive pings, or unsolicited advertising.",
                        "**3. No scams or deception** — Be honest in trades and vouches. Never impersonate others.",
                        "**4. Keep content appropriate** — No NSFW, illegal content, or disturbing material.",
                        "**5. Use channels correctly** — Keep messages in the relevant channels and follow channel-specific instructions.",
                        "**6. No exploiting** — Don't abuse bugs, cheats, or exploits to harm the community.",
                        "**7. Listen to staff** — Follow moderator instructions and use tickets or reports for disputes.",
                        "**8. Protect your account** — Never share passwords, tokens, or private personal information.",
                        "**9. Trade at your own risk** — Check terms carefully before agreeing to a deal.",
                        "**10. Use common sense** — Staff may act on behaviour that seriously disrupts the community."
                    ].join("\n\n"),
                    footer: { text: "AnchorFall • Stay fair. Fight smart." }
                };

                await rulesChannel.send({ embeds: [rulesEmbed] });
                await interaction.editReply("✅ Rules posted in <#" + rulesChannelId + ">.");
            } catch (error) {
                console.error("Failed to post rules:", error);
                await interaction.editReply("❌ I couldn't post the rules. Check that I have permission to view and send messages in the rules channel.");
            }
            return;
        }


        if (interaction.commandName === "serverinfo") {
            await interaction.deferReply({ ephemeral: true });
            try {
                const infoChannel = await interaction.guild.channels.fetch(SERVER_INFO_CHANNEL_ID);
                if (!infoChannel || !infoChannel.isTextBased()) {
                    await interaction.editReply("❌ I couldn't find the server-info channel. Check the channel ID.");
                    return;
                }

                const infoEmbed = {
                    color: 0x7c3aed,
                    title: "⚔️ Welcome to AnchorFall",
                    description: [
                        "**Welcome!** AnchorFall is a community for meeting players, finding teammates, and enjoying competitive Minecraft PvP.",
                        "**🤝 Community** — Be respectful, make friends, and find people to play with.",
                        "**🛒 Spawner Market** — Use the buy/sell spawner panel if you want to trade. Check the details before agreeing to a deal.",
                        "**🎫 Need help?** — Open a support ticket if you need staff assistance.",
                        "**📜 Read the rules** — Please read the server rules and follow them while participating in the community.",
                        "**💜 Have fun!** — Keep things fair, help the community grow, and enjoy your time here."
                    ].join("\n\n"),
                    footer: { text: "AnchorFall • Break the Anchor. Own the Void." }
                };

                await infoChannel.send({ embeds: [infoEmbed] });
                await interaction.editReply("✅ Server information posted in <#" + SERVER_INFO_CHANNEL_ID + ">.");
            } catch (error) {
                console.error("Failed to post server info:", error);
                await interaction.editReply("❌ I couldn't post the server information. Check that I have permission to view and send messages in the server-info channel.");
            }
            return;
        }

        if (interaction.commandName === "giveawayinfo") {
            await interaction.deferReply({ ephemeral: true });
            try {
                const giveawayInfoChannel = await interaction.guild.channels.fetch("1553777764472201237");
                if (!giveawayInfoChannel || !giveawayInfoChannel.isTextBased()) {
                    await interaction.editReply("❌ I couldn't find the server-info channel.");
                    return;
                }

                const giveawayInfoEmbed = {
                    color: 0x7c3aed,
                    title: "🎁 AnchorFall Giveaway Info & Claim Rules",
                    description: [
                        "**🎟️ Entering giveaways**",
                        "• Follow the entry instructions listed in each giveaway.",
                        "• One genuine entry per person. Alternate accounts, fake entries, or attempts to manipulate the result are not allowed.",
                        "• Make sure you meet any requirements stated in the giveaway post.",
                        "",
                        "**🏆 If you win**",
                        "• Winners are selected using the method stated in the giveaway.",
                        "• Check Discord messages and the giveaway post so you don't miss the result.",
                        "• You must claim your prize within the deadline stated by the host. If no deadline is listed, contact staff promptly.",
                        "• Staff may ask you to verify your win before giving you the prize.",
                        "",
                        "**🎫 Claiming your prize**",
                        "• Open a giveaway prize-claim ticket using the bot's provided claim option, or contact staff if you cannot access it.",
                        "• Only the actual winner can claim the prize. Do not share claim tickets or pretend to be a winner.",
                        "• Be patient while staff verify the result and arrange the prize.",
                        "",
                        "**⚠️ Fair play**",
                        "Giveaway abuse, fake accounts, or dishonest claims may lead to disqualification. Staff may disqualify entries that break these rules."
                    ].join("\n"),
                    footer: { text: "AnchorFall • Good luck, and play fair!" }
                };

                await giveawayInfoChannel.send({ embeds: [giveawayInfoEmbed] });
                await interaction.editReply("✅ Giveaway information posted in <#" + "1553771441462186004" + ">.");
            } catch (error) {
                console.error("Failed to post giveaway info:", error);
                await interaction.editReply("❌ I couldn't post the giveaway information. Check the bot's channel permissions.");
            }
            return;
        }

        if (interaction.commandName === "verification-panel") {
            await interaction.deferReply({ ephemeral: true });
            try {
                const channel = interaction.channel;
                if (!channel || !channel.isTextBased()) {
                    await interaction.editReply("❌ Run this command in a text channel.");
                    return;
                }
                const panelEmbed = new EmbedBuilder()
                    .setColor(0x7c3aed)
                    .setTitle("🛡️ AnchorFall Verification")
                    .setDescription("Welcome to **AnchorFall**! Press the button below to verify and receive access to the server.")
                    .setFooter({ text: "AnchorFall • Break the Anchor. Own the Void." });
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId("anchorfall_verify")
                        .setLabel("Verify")
                        .setEmoji("🛡️")
                        .setStyle(ButtonStyle.Success)
                );
                await channel.send({ embeds: [panelEmbed], components: [row] });
                await interaction.editReply("✅ Verification panel posted.");
            } catch (error) {
                console.error("Verification panel post failed:", error);
                await interaction.editReply("❌ I couldn't post the verification panel. Check my channel permissions.");
            }
            return;
        }

        if (interaction.commandName === "ticketpanel") {
            await interaction.deferReply({ ephemeral: true });
            try {
                const channel = interaction.channel;
                if (!channel || !channel.isTextBased()) {
                    await interaction.editReply("❌ Run this command in a text channel.");
                    return;
                }
                const panelEmbed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle("🎫 Support Tickets")
                    .setDescription("Need help from staff? Use the button below to open a private support ticket. Please explain your issue clearly and wait for a staff member to respond.")
                    .setFooter({ text: "AnchorFall • Support" });
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId("support_ticket_open")
                        .setLabel("Open Ticket")
                        .setEmoji("🎫")
                        .setStyle(ButtonStyle.Primary)
                );
                await channel.send({ embeds: [panelEmbed], components: [row] });
                await interaction.editReply("✅ Ticket panel posted.");
            } catch (error) {
                console.error("Failed to post ticket panel:", error);
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply("❌ Couldn't post the ticket panel. Check the bot's channel permissions.");
                } else {
                    await interaction.reply({ content: "❌ Couldn't post the ticket panel. Check the bot's channel permissions.", ephemeral: true });
                }
            }
            return;
        }

        if (interaction.commandName === "scamreport") {
            if (!interaction.channel?.isTextBased()) {
                await interaction.reply({ content: "Use this in the #report-here channel.", ephemeral: true });
                return;
            }
            await interaction.channel.send({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xed4245)
                        .setTitle("Report a Scammer")
                        .setDescription("Press the button below. A form will ask for the offender, their in-game name, and your proof.")
                ],
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId("scam_report:init")
                            .setLabel("Report a Scammer")
                            .setEmoji("⚠️")
                            .setStyle(ButtonStyle.Danger)
                    )
                ]
            });
            await interaction.reply({ content: "Scam report panel posted.", ephemeral: true });
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
                embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle("🛡️ AnchorFall Applications").setDescription("Choose the position you want to apply for below.")],
                components: [new ActionRowBuilder().addComponents(menu)]
            });

            await interaction.reply({ content: "✅ Application panel posted.", ephemeral: true });
            return;
        }

        if (interaction.commandName === "schematic-request-panel") {
            await interaction.deferReply({ ephemeral: true });
            const channel = interaction.options.getChannel("channel", true);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId("schematic_request_start")
                    .setLabel("Request a Schematic")
                    .setEmoji("🏗️")
                    .setStyle(ButtonStyle.Primary)
            );
            await channel.send({
                embeds: [new EmbedBuilder().setColor(0x8B5CF6).setTitle("📐 Request a Schematic").setDescription("Have a schematic you want us to consider? Click the button below to get started.")],
                components: [row]
            });
            await interaction.editReply(`✅ Schematic request panel sent to <#${channel.id}>.`);
            return;
        }

        if (interaction.commandName === "schematic") {
            const channel = interaction.options.getChannel("channel", true);
            const cats = await schematicLibrary.listCategories();
            if (!cats.length) {
                await interaction.reply({ content: "No schematic categories are available yet.", ephemeral: true });
                return;
            }
            const menu = new StringSelectMenuBuilder()
                .setCustomId("schematic_category")
                .setPlaceholder("Choose a schematic category")
                .addOptions(cats.slice(0, 25).map(cat => ({
                    label: cat.name.slice(0, 100),
                    value: String(cat.id),
                    description: (cat.schematic_count + " published schematics").slice(0, 100)
                })));
            await channel.send({
                embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle("AnchorFall Schematic Library").setDescription("Choose a category to browse published .litematic files.")],
                components: [new ActionRowBuilder().addComponents(menu)]
            });
            await interaction.reply({ content: "Schematic library panel posted.", ephemeral: true });
            return;
        }

        if (interaction.commandName === "skillgame") {
            const member = interaction.member;
            const isStaff = member?.permissions?.has(PermissionFlagsBits.ManageGuild)
                || member?.permissions?.has(PermissionFlagsBits.ModerateMembers)
                || member?.roles?.cache?.some(role => role.name.toLowerCase() === "giveaway mod");
            if (!isStaff) {
                await interaction.reply({ content: "❌ Only staff can start skill-game prize events.", ephemeral: true });
                return;
            }
            const type = interaction.options.getString("game", true);
            const prize = interaction.options.getString("prize", true).trim();
            const id = "skill-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
            const titles = { flag: "🇺🇳 Guess the Flag", number: "🔢 Guess the Number", trivia: "🧠 Minecraft Trivia", crystal: "⚔️ Crystal PvP Quiz" };
            const events = loadGames();
            events[id] = { id, type, prize, hostId: interaction.user.id, channelId: interaction.channelId, messageId: null, players: [], scores: {}, sessions: {}, ended: false, createdAt: Date.now() };
            const instructions = { flag: "10 flag questions • 10 points each • 100 points maximum", number: "5 logic-based number puzzles • 1 point each • 5 points maximum", trivia: "10 Minecraft knowledge questions • 1 point each", crystal: "10 Crystal PvP knowledge questions • 1 point each" };
            const embed = new EmbedBuilder().setColor(0x7c3aed).setTitle("🏆 SKILL GAME CHALLENGE")
                .setDescription("**Game:** " + titles[type] + "\n**Prize:** " + prize + "\n**Hosted by:** <@" + interaction.user.id + ">\n\n" + instructions[type] + "\n\nPress **Play** to take the quiz. Your answers are scored automatically. Highest score wins; ties require a skill-based tiebreaker, never a random draw.")
                .setFooter({ text: "AnchorFall • Skill decides the winner" });
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("skillplay:" + id).setLabel("Play Challenge").setEmoji("🎮").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("skillfinish:" + id).setLabel("End & Pick Winner").setEmoji("🏆").setStyle(ButtonStyle.Success)
            );
            const message = await interaction.channel.send({ embeds: [embed], components: [row] });
            events[id].messageId = message.id;
            saveGames(events);
            await interaction.reply({ content: "✅ Challenge posted: **" + titles[type] + "** • Prize: **" + prize + "**", ephemeral: true });
            return;
        }

        if (interaction.commandName === "game") {
            const member = interaction.member;
            const isModerator = member?.permissions?.has(PermissionFlagsBits.ModerateMembers)
                || member?.permissions?.has(PermissionFlagsBits.ManageGuild)
                || member?.roles?.cache?.some(role => role.name.toLowerCase() === "giveaway mod");

            if (!isModerator) {
                await interaction.reply({ content: "❌ Only moderators or members with the Giveaway Mod role can start a competition.", ephemeral: true });
                return;
            }

            const gameName = interaction.options.getString("game", true).trim();
            const prize = interaction.options.getString("prize", true).trim();
            const gameId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            const games = loadGames();
            const competition = {
                id: gameId,
                game: gameName,
                prize,
                hostId: interaction.user.id,
                channelId: interaction.channelId,
                messageId: null,
                players: [],
                createdAt: Date.now(),
                ended: false
            };

            const embed = {
                color: 0x7c3aed,
                title: "🎮 ANCHORFALL COMPETITION",
                description: [
                    `**🕹️ Game:** ${gameName}`,
                    `**🎁 Prize:** ${prize}`,
                    `**🎤 Hosted by:** <@${interaction.user.id}>`,
                    "",
                    "Press **Join Competition** below if you want to compete!",
                    "The host will organise the match and announce the winner."
                ].join("\n\n"),
                footer: { text: "AnchorFall • Break the Anchor. Own the Void." }
            };
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`game_join:${gameId}`).setLabel("Join Competition").setEmoji("🎮").setStyle(ButtonStyle.Primary)
            );

            const message = await interaction.channel.send({ embeds: [embed], components: [row] });
            competition.messageId = message.id;
            games[gameId] = competition;
            saveGames(games);
            await interaction.reply({ content: `✅ Competition posted! Game: **${gameName}** • Prize: **${prize}** • ID: ${gameId}`, ephemeral: true });
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
            const message = await interaction.channel.send({ content: `# 🎉 GIVEAWAY\\n\\n🎁 **Prize:** ${prize}\\n👤 **Hosted by:** <@${host.id}>\\n🏆 **Winners:** ${winnerCount}\\n⏱️ **Time:** ${giveawayDurationLabel(duration)}\\n👥 **Max entries:** ${maxEntries === 0 ? "Unlimited" : maxEntries}\\n\\nClick **Enter Giveaway** below to enter!`, components: [row] });
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
    await sendCommandLog(interaction.guild, "kick", `👢 ${user.tag} was kicked by <@${interaction.user.id}>. Reason: ${reason}`);

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
    await sendCommandLog(interaction.guild, "ban", `🔨 ${user.tag} was banned by <@${interaction.user.id}>. Reason: ${reason}`);

    await interaction.reply(
        `🔨 **${user.tag}** has been banned.\n**Reason:** ${reason}`
    );
    return;
}

if (interaction.commandName === "timeout") {
    const user = interaction.options.getUser("user");
    const timeoutSettings = allCommandSettings.timeout?.settings || {};
    const requestedMinutes = interaction.options.getInteger("minutes");
    const configuredDefault = Number(timeoutSettings.defaultMinutes);
    const minutes = requestedMinutes ?? (Number.isFinite(configuredDefault) && configuredDefault > 0 ? Math.min(40320, Math.floor(configuredDefault)) : 10);
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
    await sendCommandLog(interaction.guild, "timeout", `⏱️ ${user.tag} was timed out for ${minutes} minute(s) by <@${interaction.user.id}>. Reason: ${reason}`);

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
            await sendCommandLog(interaction.guild, "unwarn", `🧹 Warning #${number} removed from ${user.tag} by <@${interaction.user.id}>. Reason: ${removed.reason}`);
            await interaction.reply(`✅ Removed warning **#${number}** from **${user.tag}**.`);
            return;
        }

        if (interaction.commandName === "unban") {
            const userId = interaction.options.getString("user_id").trim();
            const reason = interaction.options.getString("reason");
            await interaction.guild.members.unban(userId, reason);
            await sendCommandLog(interaction.guild, "unban", `🔓 User ID ${userId} unbanned by <@${interaction.user.id}>. Reason: ${reason}`);
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
            await sendCommandLog(interaction.guild, "untimeout", `🔓 Timeout removed for ${user.tag} by <@${interaction.user.id}>. Reason: ${reason}`);
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
            "⚙️ **AnchorFall Bot Settings**\n\n" +
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
            `<@&${role.id}>\n\n` +
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
                `📢 **AnchorFall Announcement**\n\n${message}`
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
            await interaction.reply(`📊 **AnchorFall Stats**\\n\\n👥 Members: **${guild.memberCount}**\\n👤 Humans cached: **${humans}**\\n🤖 Bots cached: **${bots}**\\n💬 Channels: **${guild.channels.cache.size}**\\n🎭 Roles: **${guild.roles.cache.size - 1}**\\n🎫 Active tickets: **${guild.channels.cache.filter(c => c.isThread() && !c.archived).size}**`);
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
            await result.thread.send({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle("🚨 Report submitted").addFields({ name: "Reported user", value: `<@${user.id}>` }, { name: "Reason", value: reason.slice(0, 1024) }, { name: "Reported by", value: `<@${interaction.user.id}>` }).setTimestamp()] });
            await interaction.reply({ content: `✅ Your report has been sent privately: <#${result.thread.id}>`, ephemeral: true });
            return;
        }

        if (interaction.commandName === "purge") {
            const requestedAmount = interaction.options.getInteger("amount");
            const purgeSettings = allCommandSettings.purge?.settings || {};
            const configuredMaximum = Number(purgeSettings.maxMessages);
            const maximum = Number.isFinite(configuredMaximum) && configuredMaximum > 0 ? Math.min(100, Math.floor(configuredMaximum)) : 100;
            const amount = Math.min(requestedAmount, maximum);
            try {
                const deleted = await interaction.channel.bulkDelete(amount, true);
                await sendCommandLog(interaction.guild, "purge", `🧹 <@${interaction.user.id}> purged ${deleted.size} message(s) in <#${interaction.channelId}>.`);

                await interaction.reply({
                    content: amount < requestedAmount
                        ? `⚠️ Dashboard limit: ${maximum} messages. Deleted **${deleted.size}** message(s).`
                        : `🧹 Deleted **${deleted.size}** message(s).`,
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
                await sendCommandLog(interaction.guild, "lock", `🔒 Channel <#${interaction.channelId}> locked by <@${interaction.user.id}>.`);
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
                await sendCommandLog(interaction.guild, "unlock", `🔓 Channel <#${interaction.channelId}> unlocked by <@${interaction.user.id}>.`);
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
                await sendCommandLog(interaction.guild, "slowmode", `🐌 Slowmode set to ${seconds}s in <#${interaction.channelId}> by <@${interaction.user.id}>.`);

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
            await sendCommandLog(interaction.guild, "warn", `⚠️ <@${user.id}> was warned by <@${interaction.user.id}> (level ${level}). Reason: ${reason}`);

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

        if (interaction.commandName === "honeypot") {
            const sub = interaction.options.getSubcommand();
            const settings = loadSettings(interaction.guild.id);

            if (sub === "status") {
                if (!settings.honeypotChannelId) {
                    await interaction.reply({
                        content: "🕳 No honeypot channel is set. Use `/honeypot create` or `/honeypot set`.",
                        ephemeral: true
                    });
                    return;
                }
                const ch = interaction.guild.channels.cache.get(settings.honeypotChannelId);
                await interaction.reply({
                    content: ch
                        ? `Current honeypot: ${ch} (\`${ch.id}\`)\nAnyone who posts there is banned, their messages from the last 7 days are deleted, and they are DM'd a server invite.`
                        : `Honeypot channel ID \`${settings.honeypotChannelId}\` is set but the channel is missing. Use \`/honeypot disable\` or recreate it.`,
                    ephemeral: true
                });
                return;
            }

            if (sub === "disable") {
                if (!settings.honeypotChannelId) {
                    await interaction.reply({
                        content: "🕳 No honeypot is currently active.",
                        ephemeral: true
                    });
                    return;
                }
                const oldId = settings.honeypotChannelId;
                settings.honeypotChannelId = null;
                saveSettings(interaction.guild.id, settings);
                await interaction.reply({
                    content: `🕳 Honeypot disabled. Channel \`${oldId}\` is no longer monitored (channel was not deleted).`,
                    ephemeral: true
                });
                await sendModLog(
                    interaction.guild,
                    `🕳 **Honeypot disabled** by <@${interaction.user.id}> (was channel \`${oldId}\`)`
                );
                return;
            }

            if (sub === "set") {
                const channel = interaction.options.getChannel("channel");
                settings.honeypotChannelId = channel.id;
                saveSettings(interaction.guild.id, settings);
                await interaction.reply({
                    content: `${channel} is now the honeypot. Anyone who posts there is banned, their recent messages are deleted, and they get a DM with a server invite.`,
                    ephemeral: true
                });
                await sendModLog(
                    interaction.guild,
                    `🕳 **Honeypot set** by <@${interaction.user.id}> → ${channel} (\`${channel.id}\`)`
                );
                return;
            }

            if (sub === "create") {
                const name = (interaction.options.getString("name") || "bot-check")
                    .toLowerCase()
                    .replace(/[^a-z0-9-_]/g, "-")
                    .slice(0, 100) || "bot-check";
                const category = interaction.options.getChannel("category");

                const me = interaction.guild.members.me;
                if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
                    await interaction.reply({
                        content: "❌ I need **Manage Channels** to create a honeypot channel.",
                        ephemeral: true
                    });
                    return;
                }

                await interaction.deferReply({ ephemeral: true });

                const channel = await interaction.guild.channels.create({
                    name,
                    type: ChannelType.GuildText,
                    parent: category?.id ?? null,
                    topic: "Bot detection. Humans: do not post.",
                    permissionOverwrites: [
                        {
                            id: interaction.guild.id,
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory
                            ]
                        },
                        {
                            id: me.id,
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ManageMessages,
                                PermissionFlagsBits.ManageChannels,
                                PermissionFlagsBits.BanMembers
                            ]
                        }
                    ],
                    reason: `Honeypot created by ${interaction.user.tag}`
                });

                settings.honeypotChannelId = channel.id;
                saveSettings(interaction.guild.id, settings);

                await channel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0xed4245)
                            .setTitle("Bot check")
                            .setDescription(
                                "This channel is monitored.\n\n" +
                                "If you type here you will be banned and your recent messages will be removed. A rejoin link is sent by DM."
                            )
                    ]
                });

                await interaction.editReply(
                    `Honeypot created: ${channel}\nAnyone who posts here is banned, their messages from the last 7 days are deleted, and they are DM'd a server invite. Use \`/honeypot disable\` to stop monitoring.`
                );
                await sendModLog(
                    interaction.guild,
                    `🕳 **Honeypot created** by <@${interaction.user.id}> → ${channel} (\`${channel.id}\`)`
                );
                return;
            }
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

    // Honeypot: ban anyone who posts, DM a rejoin invite first, wipe recent messages
    try {
        const hpSettings = loadSettings(message.guild.id);
        if (hpSettings.honeypotChannelId && message.channel.id === hpSettings.honeypotChannelId) {
            const contentPreview = (message.content || "[no text / attachment]").slice(0, 500);

            let inviteUrl = null;
            try {
                if (message.guild.vanityURLCode) {
                    inviteUrl = `https://discord.gg/${message.guild.vanityURLCode}`;
                } else {
                    const rulesChannel = await message.guild.channels.fetch(RULES_CHANNEL_ID).catch(() => null);
                    const inviteChannel =
                        rulesChannel && rulesChannel.isTextBased()
                            ? rulesChannel
                            : message.guild.channels.cache.find(
                                ch =>
                                    ch.isTextBased() &&
                                    ch.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite)
                            );
                    if (inviteChannel) {
                        const invite = await inviteChannel.createInvite({
                            maxAge: 0,
                            maxUses: 0,
                            unique: false,
                            reason: "Honeypot rejoin invite"
                        });
                        inviteUrl = invite.url;
                    }
                }
            } catch (inviteError) {
                console.error("Honeypot invite failed:", inviteError.message);
            }

            let dmOk = false;
            try {
                await message.author.send(
                    inviteUrl
                        ? `You were removed from **${message.guild.name}** for posting in a monitored channel.\nRejoin: ${inviteUrl}`
                        : `You were removed from **${message.guild.name}** for posting in a monitored channel.`
                );
                dmOk = true;
            } catch (dmError) {
                console.error("Honeypot DM failed:", dmError.message);
            }

            let banOk = false;
            try {
                await message.guild.members.ban(message.author.id, {
                    reason: "Honeypot: posted in monitored channel",
                    deleteMessageSeconds: 7 * 24 * 60 * 60
                });
                banOk = true;
            } catch (banErr) {
                console.error("Honeypot ban failed:", banErr.message);
            }

            await sendModLog(
                message.guild,
                `**Honeypot ban**\n` +
                `**User:** <@${message.author.id}> (\`${message.author.tag}\` / \`${message.author.id}\`)\n` +
                `**Channel:** <#${message.channel.id}>\n` +
                `**Message:** ${contentPreview}\n` +
                `**DM:** ${dmOk ? (inviteUrl || "sent, no invite") : "failed"}\n` +
                `**Action:** ${banOk ? "Banned and deleted messages from the last 7 days" : "Ban failed (check role hierarchy / Ban Members)"}`
            );
            return;
        }
    } catch (hpError) {
        console.error("Honeypot handler failed:", hpError.message);
    }

    levelingSystem.awardMessageXp(message).catch(error => console.error("Leveling message handler failed:", error.message));
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
