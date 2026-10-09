const { Pool } = require("pg");
const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    UserSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    EmbedBuilder
} = require("discord.js");

let pool;

function db() {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing");
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
        });
    }
    return pool;
}

async function initVouchDatabase() {
    await db().query(
        "CREATE TABLE IF NOT EXISTS vouches (" +
        "id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, target_id TEXT NOT NULL, " +
        "giver_id TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('normal','scam')), " +
        "reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), active BOOLEAN NOT NULL DEFAULT TRUE, " +
        "UNIQUE (guild_id, target_id, giver_id, type))"
    );
}

const commands = [
    new SlashCommandBuilder()
        .setName("vouchpanel")
        .setDescription("Post the DSMP PvP vouch panels")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
];

function makePanel(type) {
    const scam = type === "scam";
    const embed = new EmbedBuilder()
        .setColor(scam ? 0xED4245 : 0x57F287)
        .setTitle(scam ? "🚨 DSMP PvP — Scam Vouches" : "🤝 DSMP PvP — Player Vouches")
        .setDescription(scam
            ? "Submit a genuine scam-related allegation or view a member's trust profile. Scam vouches affect trust immediately. False or misleading submissions may be removed by staff."
            : "Vouch for a player you have genuinely traded or worked with, or view a member's trust profile and vouch history.")
        .addFields(
            { name: "How to use", value: "1. Choose an action below.\n2. Select a member.\n3. Enter a clear, honest reason.\n4. Submit. The bot saves it permanently." },
            { name: "Trust score", value: "Trust is **N/A** until the member has at least one active vouch. Normal vouches add 5 points; scam vouches subtract 15 points. Scores stay between 0% and 100%." }
        )
        .setFooter({ text: "Vouches are community reports, not proof by themselves." });
    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId("vouch_action:" + type)
            .setPlaceholder(scam ? "Choose a scam-vouch action..." : "Choose a vouch action...")
            .addOptions(
                { label: scam ? "Submit Scam Vouch" : "Submit Normal Vouch", value: "submit", description: "Select a member and explain why" },
                { label: "View a Member's Profile", value: "view", description: "See trust score, totals and full history" }
            )
    );
    return { embeds: [embed], components: [row] };
}

async function trustFor(guildId, targetId) {
    const result = await db().query(
        "SELECT type, COUNT(*)::int AS count FROM vouches WHERE guild_id=$1 AND target_id=$2 AND active=TRUE GROUP BY type",
        [guildId, targetId]
    );
    if (!result.rows.length) return null;
    const counts = { normal: 0, scam: 0 };
    for (const row of result.rows) counts[row.type] = row.count;
    return Math.max(0, Math.min(100, 100 + counts.normal * 5 - counts.scam * 15));
}

async function showProfile(interaction, targetId, page, edit) {
    const gid = interaction.guild.id;
    const countsResult = await db().query(
        "SELECT type, COUNT(*)::int AS count FROM vouches WHERE guild_id=$1 AND target_id=$2 AND active=TRUE GROUP BY type",
        [gid, targetId]
    );
    const counts = { normal: 0, scam: 0 };
    for (const row of countsResult.rows) counts[row.type] = row.count;
    const total = counts.normal + counts.scam;
    const trust = total ? Math.max(0, Math.min(100, 100 + counts.normal * 5 - counts.scam * 15)) + "%" : "N/A";
    const pageSize = 5;
    const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
    page = Math.max(0, Math.min(Number(page) || 0, maxPage));
    const history = await db().query(
        "SELECT giver_id,type,reason,created_at FROM vouches WHERE guild_id=$1 AND target_id=$2 AND active=TRUE ORDER BY created_at DESC LIMIT $3 OFFSET $4",
        [gid, targetId, pageSize, page * pageSize]
    );
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("🛡️ DSMP PvP — Trust Profile")
        .setDescription("Member: <@" + targetId + ">\nTrust score: **" + trust + "**")
        .addFields(
            { name: "Normal vouches", value: String(counts.normal), inline: true },
            { name: "Scam vouches", value: String(counts.scam), inline: true },
            { name: "Total", value: String(total), inline: true }
        );
    if (history.rows.length) {
        embed.addFields({
            name: "Vouch history · Page " + (page + 1) + "/" + (maxPage + 1),
            value: history.rows.map(row =>
                (row.type === "scam" ? "🚨 **Scam allegation**" : "🤝 **Normal vouch**") +
                "\nFrom: <@" + row.giver_id + ">\nReason: " + row.reason.slice(0, 500) +
                "\nDate: <t:" + Math.floor(new Date(row.created_at).getTime() / 1000) + ":R>"
            ).join("\n\n").slice(0, 3900)
        });
    } else {
        embed.addFields({ name: "Vouch history", value: "No active vouches yet." });
    }
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("vouch_page:" + gid + ":" + targetId + ":" + (page - 1))
            .setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
        new ButtonBuilder().setCustomId("vouch_page:" + gid + ":" + targetId + ":" + (page + 1))
            .setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page >= maxPage)
    );
    if (edit) await interaction.update({ embeds: [embed], components: [row] });
    else await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function handleVouchInteraction(interaction) {
    if (interaction.isChatInputCommand() && interaction.commandName === "vouchpanel") {
        await interaction.deferReply({ ephemeral: true });
        try {
            const normalChannel = await interaction.client.channels.fetch("1550440006378725406");
            const scamChannel = await interaction.client.channels.fetch("1550440036669980762");
            if (!normalChannel || !normalChannel.isTextBased() || !scamChannel || !scamChannel.isTextBased()) {
                await interaction.editReply("❌ I couldn't find one or both configured vouch channels. Check the channel IDs.");
                return true;
            }
            await normalChannel.send(makePanel("normal"));
            await scamChannel.send(makePanel("scam"));
            await interaction.editReply("✅ Normal vouch panel posted in <#1550440006378725406> and scam vouch panel posted in <#1550440036669980762>.");
        } catch (error) {
            console.error("Vouch panel posting failed:", error);
            await interaction.editReply("❌ I couldn't post the panels. Make sure I can view and send messages in both vouch channels.");
        }
        return true;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("vouch_action:")) {
        const type = interaction.customId.split(":")[1];
        const action = interaction.values[0];
        const row = new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
                .setCustomId("vouch_member:" + type + ":" + action)
                .setPlaceholder("Choose a server member...")
                .setMinValues(1).setMaxValues(1)
        );
        await interaction.reply({
            content: action === "submit"
                ? "Choose the member you want to " + (type === "scam" ? "submit a scam vouch about" : "vouch for") + "."
                : "Choose the member whose profile you want to view.",
            components: [row], ephemeral: true
        });
        return true;
    }

    if (interaction.isUserSelectMenu() && interaction.customId.startsWith("vouch_member:")) {
        const parts = interaction.customId.split(":");
        const type = parts[1], action = parts[2], targetId = interaction.values[0];
        if (action === "submit" && targetId === interaction.user.id) {
            await interaction.reply({ content: "❌ You cannot vouch for yourself.", ephemeral: true });
            return true;
        }
        const target = await interaction.guild.members.fetch(targetId).catch(() => null);
        if (!target || target.user.bot) {
            await interaction.reply({ content: "❌ Choose a real server member, not a bot.", ephemeral: true });
            return true;
        }
        if (action === "view") {
            await showProfile(interaction, targetId, 0, false);
            return true;
        }
        const modal = new ModalBuilder()
            .setCustomId("vouch_reason:" + type + ":" + targetId)
            .setTitle(type === "scam" ? "Submit Scam Vouch" : "Submit Normal Vouch")
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("reason").setLabel("Explain your reason")
                    .setStyle(TextInputStyle.Paragraph).setMinLength(5).setMaxLength(1000).setRequired(true)
            ));
        await interaction.showModal(modal);
        return true;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("vouch_reason:")) {
        const parts = interaction.customId.split(":");
        const type = parts[1], targetId = parts[2];
        const reason = interaction.fields.getTextInputValue("reason").trim();
        if (reason.length < 5) {
            await interaction.reply({ content: "❌ Please provide a more detailed reason.", ephemeral: true });
            return true;
        }
        try {
            const result = await db().query(
                "INSERT INTO vouches (guild_id,target_id,giver_id,type,reason) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (guild_id,target_id,giver_id,type) DO NOTHING RETURNING id",
                [interaction.guild.id, targetId, interaction.user.id, type, reason]
            );
            if (!result.rowCount) {
                await interaction.reply({ content: "⚠️ You've already submitted this type of vouch for that member.", ephemeral: true });
                return true;
            }
            const score = await trustFor(interaction.guild.id, targetId);
            await interaction.reply({
                content: (type === "scam" ? "🚨 Scam vouch saved. Trust has decreased immediately." : "🤝 Vouch saved.") +
                    "\nCurrent trust: **" + (score === null ? "N/A" : score + "%") + "**",
                ephemeral: true
            });
        } catch (error) {
            console.error("Vouch save failed:", error);
            await interaction.reply({ content: "❌ Could not save this vouch. Ask an administrator to check the database connection.", ephemeral: true });
        }
        return true;
    }

    if (interaction.isButton() && interaction.customId.startsWith("vouch_page:")) {
        const parts = interaction.customId.split(":");
        if (!interaction.guild || interaction.guild.id !== parts[1]) {
            await interaction.reply({ content: "This profile belongs to another server.", ephemeral: true });
            return true;
        }
        await showProfile(interaction, parts[2], Number(parts[3]), true);
        return true;
    }
    return false;
}

module.exports = { commands, initVouchDatabase, handleVouchInteraction };
