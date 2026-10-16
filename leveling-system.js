const { Pool } = require("pg");
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

let pool;
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

async function initLevelingDatabase() {
    await getPool().query(`
        CREATE TABLE IF NOT EXISTS leveling_xp (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            xp BIGINT NOT NULL DEFAULT 0,
            level INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (guild_id, user_id)
        )
    `);
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
        if (calculated.level > row.level) {
            await db.query(
                "UPDATE leveling_xp SET level = $3 WHERE guild_id = $1 AND user_id = $2",
                [message.guild.id, message.author.id, calculated.level]
            );
            await message.channel.send({
                content: `🎉 <@${message.author.id}> leveled up to **Level ${calculated.level}**! Keep chatting!`,
                allowedMentions: { users: [message.author.id] }
            }).catch(() => {});
        } else if (calculated.level !== row.level) {
            await db.query(
                "UPDATE leveling_xp SET level = $3 WHERE guild_id = $1 AND user_id = $2",
                [message.guild.id, message.author.id, calculated.level]
            );
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
].map(command => command.toJSON());

async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return false;
    if (!["rank", "leaderboard"].includes(interaction.commandName)) return false;

    try {
        await initLevelingDatabase();
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
                .setTitle(`💎 ${user.username}'s DSMP PvP Rank`)
                .setThumbnail(user.displayAvatarURL())
                .addFields(
                    { name: "Level", value: String(progress.level), inline: true },
                    { name: "Total XP", value: xp.toLocaleString(), inline: true },
                    { name: "Progress", value: `${bar} ${progress.progressXp}/${needed} XP` }
                );
            await interaction.reply({ embeds: [embed] });
        } else {
            const result = await getPool().query(
                "SELECT user_id, xp FROM leveling_xp WHERE guild_id = $1 ORDER BY xp DESC LIMIT 10",
                [interaction.guildId]
            );
            if (!result.rows.length) {
                await interaction.reply({ content: "No one has earned XP yet. Start chatting to get on the leaderboard!" });
                return true;
            }
            const lines = await Promise.all(result.rows.map(async (row, index) => {
                const user = await interaction.client.users.fetch(row.user_id).catch(() => null);
                const progress = levelFromXp(row.xp);
                return `**${index + 1}.** ${user ? user.username : `Unknown user (${row.user_id})`} — Level **${progress.level}** · ${Number(row.xp).toLocaleString()} XP`;
            }));
            const embed = new EmbedBuilder()
                .setColor(0x7c3aed)
                .setTitle("🏆 DSMP PvP Level Leaderboard")
                .setDescription(lines.join("\n"));
            await interaction.reply({ embeds: [embed] });
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