const { Pool } = require("pg");
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

let pool;
let leaderboardRefreshTimer;
const cooldowns = new Map();
const XP_COOLDOWN_MS = 60_000;
const XP_MIN = 15;
const XP_MAX = 25;

function getPool() {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
            max: 3
        });
    }
    return pool;
}

async function initLevelingDatabase(client) {
    await getPool().query(`
        CREATE TABLE IF NOT EXISTS leveling_xp (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            xp BIGINT NOT NULL DEFAULT 0,
            level INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (guild_id, user_id)
        )
    `);
    await getPool().query(`
        CREATE TABLE IF NOT EXISTS leveling_leaderboards (
            guild_id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            message_id TEXT NOT NULL
        )
    `);
    if (client && !leaderboardRefreshTimer) {
        leaderboardRefreshTimer = setInterval(() => refreshAllLeaderboards(client), 5 * 60 * 1000);
        leaderboardRefreshTimer.unref?.();
    }
}

function xpForLevel(level) {
    return 5 * level * level + 50 * level + 100;
}

function totalXpForLevel(level) {
    let total = 0;
    for (let current = 0; current < level; current++) total += xpForLevel(current);
    return total;
}

function levelFromXp(xp) {
    let level = 0;
    let remaining = Number(xp);
    while (remaining >= xpForLevel(level)) {
        remaining -= xpForLevel(level);
        level++;
    }
    return { level, progressXp: remaining, nextLevelXp: xpForLevel(level) };
}

const LEVEL_ROLES = [
    { level: 5, roleId: "1553787134798856283" },
    { level: 10, roleId: "1553787239677304993" },
    { level: 25, roleId: "1553787307679555777" },
    { level: 50, roleId: "1553787388223037521" }
];

// Roles are matched by their exact names so server staff can create them in Discord
// without needing to add role IDs to Railway environment variables.
async function grantLevelRoles(member, level) {
    if (!member || !member.guild) return [];
    const earned = LEVEL_ROLES.filter(reward => reward.level <= level);
    const granted = [];
    for (const reward of earned) {
        if (!reward.roleId) continue;
        const role = member.guild.roles.cache.get(reward.roleId);
        if (!role) {
            console.warn(`[Leveling] Role ID ${reward.roleId} for level ${reward.level} was not found in guild ${member.guild.id}.`);
            continue;
        }
        if (member.roles.cache.has(role.id)) continue;
        if (role.managed || !role.editable) {
            console.warn(`[Leveling] Cannot assign role ID ${reward.roleId} - check the bot's role hierarchy and permissions.`);
            continue;
        }
        try {
            await member.roles.add(role, `Reached chat level ${reward.level}`);
            granted.push(role.name);
        } catch (error) {
            console.error(`[Leveling] Could not assign role ID ${reward.roleId} to ${member.id}:`, error.message);
        }
    }
    return granted;
}

function relativeRefreshFooter() {
    return "Last refreshed: " + new Date().toLocaleString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC";
}

async function buildLeaderboardEmbed(client, guildId) {
    const result = await getPool().query(
        "SELECT user_id, xp FROM leveling_xp WHERE guild_id = $1 ORDER BY xp DESC LIMIT 10",
        [guildId]
    );
    const lines = await Promise.all(result.rows.map(async (row, index) => {
        const user = await client.users.fetch(row.user_id).catch(() => null);
        const progress = levelFromXp(row.xp);
        return "**" + (index + 1) + ".** " + (user ? user.username : "Unknown user (" + row.user_id + ")") + " — Level **" + progress.level + "** · " + Number(row.xp).toLocaleString() + " XP";
    }));
    return new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle("🏆 AnchorFall Level Leaderboard")
        .setDescription(lines.length ? lines.join("\n") : "No one has earned XP yet. Start chatting to get on the leaderboard!")
        .setFooter({ text: relativeRefreshFooter() });
}

async function refreshAllLeaderboards(client) {
    try {
        const saved = await getPool().query("SELECT guild_id, channel_id, message_id FROM leveling_leaderboards");
        for (const row of saved.rows) {
            try {
                const channel = await client.channels.fetch(row.channel_id);
                if (!channel || !channel.isTextBased() || !channel.messages) continue;
                const message = await channel.messages.fetch(row.message_id);
                const embed = await buildLeaderboardEmbed(client, row.guild_id);
                await message.edit({ embeds: [embed] });
            } catch (error) {
                console.warn("[Leveling] Could not refresh leaderboard for guild " + row.guild_id + ":", error.message);
            }
        }
    } catch (error) {
        console.error("[Leveling] Leaderboard refresh failed:", error.message);
    }
}
async function awardMessageXp(message) {
    if (!message.guild || message.author.bot || !message.content.trim()) return;
    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    if (now - (cooldowns.get(key) || 0) < XP_COOLDOWN_MS) return;
    cooldowns.set(key, now);

    try {
        const amount = XP_MIN + Math.floor(Math.random() * (XP_MAX - XP_MIN + 1));
        const db = getPool();
        const result = await db.query(
            `INSERT INTO leveling_xp (guild_id, user_id, xp, level)
             VALUES ($1, $2, $3, 0)
             ON CONFLICT (guild_id, user_id)
             DO UPDATE SET xp = leveling_xp.xp + EXCLUDED.xp
             RETURNING xp, level`,
            [message.guild.id, message.author.id, amount]
        );
        const row = result.rows[0];
        const calculated = levelFromXp(row.xp);
        const levelIncreased = calculated.level > row.level;
        if (calculated.level !== row.level) {
            await db.query(
                "UPDATE leveling_xp SET level = $3 WHERE guild_id = $1 AND user_id = $2",
                [message.guild.id, message.author.id, calculated.level]
            );
        }

        // Re-check milestone roles on every eligible message, not only on level-ups.
        // This lets members catch up if the bot was missing permissions or a role
        // was temporarily above the bot in the hierarchy.
        let roleRewardText = "";
        try {
            const member = message.member || await message.guild.members.fetch(message.author.id);
            const grantedRoles = await grantLevelRoles(member, calculated.level);
            if (grantedRoles.length) roleRewardText = `\\n🎭 **New level role(s):** ${grantedRoles.join(", ")}`;
        } catch (error) {
            console.error("[Leveling] Role reward processing failed:", error.message);
        }

        if (levelIncreased) {
            await message.channel.send({
                content: `🚨 AYOOO LEVEL UP! 🚨 🔥 <@${message.author.id}> just hit **Level ${calculated.level}**! 💀 Bro is actually grinding AnchorFall 💎 Keep going — the grind never stops.${roleRewardText}`,
                allowedMentions: { users: [message.author.id] }
            }).catch(() => {});
        }
    } catch (error) {
        console.error("Leveling XP award failed:", error.message);
    }
}

const commands = [
    new SlashCommandBuilder()
        .setName("rank")
        .setDescription("View your or another member's level and XP")
        .addUserOption(option => option.setName("user").setDescription("Member to check").setRequired(false)),
    new SlashCommandBuilder()
        .setName("leaderboard")
        .setDescription("Show the server's top 10 chat levels")
];

async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return false;
    if (!["rank", "leaderboard"].includes(interaction.commandName)) return false;

    try {
        await initLevelingDatabase(interaction.client);
        if (interaction.commandName === "rank") {
            const user = interaction.options.getUser("user") || interaction.user;
            const result = await getPool().query(
                "SELECT xp FROM leveling_xp WHERE guild_id = $1 AND user_id = $2",
                [interaction.guildId, user.id]
            );
            const xp = Number(result.rows[0]?.xp || 0);
            const progress = levelFromXp(xp);
            const needed = progress.nextLevelXp;
            const filled = Math.min(10, Math.floor((progress.progressXp / needed) * 10));
            const bar = "▰".repeat(filled) + "▱".repeat(10 - filled);
            const embed = new EmbedBuilder()
                .setColor(0x7c3aed)
                .setTitle(`💎 ${user.username}'s AnchorFall Rank`)
                .setThumbnail(user.displayAvatarURL())
                .addFields(
                    { name: "Level", value: String(progress.level), inline: true },
                    { name: "Total XP", value: xp.toLocaleString(), inline: true },
                    { name: "Progress", value: `${bar} ${progress.progressXp}/${needed} XP` }
                );
            await interaction.reply({ embeds: [embed] });
        } else {
            const channel = interaction.channel;
            if (!channel || !channel.isTextBased() || !channel.messages) {
                await interaction.reply({ content: "Please run this command in a normal text channel.", ephemeral: true });
                return true;
            }
            const embed = await buildLeaderboardEmbed(interaction.client, interaction.guildId);
            const saved = await getPool().query(
                "SELECT channel_id, message_id FROM leveling_leaderboards WHERE guild_id = $1",
                [interaction.guildId]
            );
            let leaderboardMessage = null;
            if (saved.rows[0] && saved.rows[0].channel_id === channel.id) {
                leaderboardMessage = await channel.messages.fetch(saved.rows[0].message_id).catch(() => null);
            }
            if (leaderboardMessage) {
                await leaderboardMessage.edit({ embeds: [embed] });
            } else {
                leaderboardMessage = await channel.send({ embeds: [embed] });
            }
            await getPool().query(
                `INSERT INTO leveling_leaderboards (guild_id, channel_id, message_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (guild_id) DO UPDATE SET channel_id = EXCLUDED.channel_id, message_id = EXCLUDED.message_id`,
                [interaction.guildId, channel.id, leaderboardMessage.id]
            );
            await interaction.reply({ content: "🏆 Leaderboard posted in <#" + channel.id + ">. It refreshes automatically every 5 minutes.", ephemeral: true });
        }
    } catch (error) {
        console.error("Level command failed:", error.message);
        const reply = { content: "The leveling system is temporarily unavailable. Please try again later.", ephemeral: true };
        if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
        else await interaction.reply(reply).catch(() => {});
    }
    return true;
}

module.exports = { commands, initLevelingDatabase, awardMessageXp, handleInteraction };