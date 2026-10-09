const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

const TRACKER_URL = "https://donutsmpstats.net/spawners";
const SPawnerS = [
    { name: "Iron Golem Spawner", key: "iron golem spawner", url: "https://donutsmpstats.net/spawners/9" },
    { name: "Skeleton Spawner", key: "skeleton spawner", url: "https://donutsmpstats.net/spawners/1" }
];

const commands = [
    new SlashCommandBuilder()
        .setName("spawnerprices")
        .setDescription("Check current average DonutSMP prices for Iron Golem and Skeleton spawners")
];

function cleanText(html) {
    return html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#160;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&#36;|&dollar;/gi, "$")
        .replace(/\s+/g, " ")
        .trim();
}

function priceNearLabel(text, label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
        new RegExp("\\$\\s*([\\d,]+)\\s*" + escaped, "i"),
        new RegExp(escaped + "[^$]{0,35}\\$\\s*([\\d,]+)", "i"),
        new RegExp("([\\d,]+)\\s*" + escaped, "i")
    ];
    for (const re of patterns) {
        const match = text.match(re);
        if (match) {
            const value = Number(match[1].replace(/,/g, ""));
            if (Number.isFinite(value) && value > 0) return value;
        }
    }
    return null;
}

async function getTrackerPrices() {
    const response = await fetch(TRACKER_URL, {
        headers: { "user-agent": "DSMP-PvP-Discord-Bot/1.0 (spawner price checker)" },
        signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error("Tracker returned HTTP " + response.status);
    const html = await response.text();
    const text = cleanText(html);
    const results = [];
    for (const spawner of SPawnerS) {
        const start = text.toLowerCase().indexOf(spawner.key);
        if (start < 0) throw new Error("Could not find " + spawner.name + " on the tracker page");
        const next = SPawnerS
            .map(item => text.toLowerCase().indexOf(item.key, start + spawner.key.length))
            .filter(position => position > start)
            .sort((a, b) => a - b)[0];
        const section = text.slice(start, next || Math.min(text.length, start + 1800));
        const average = priceNearLabel(section, "Average");
        const bid = priceNearLabel(section, "Avg Bid");
        const ask = priceNearLabel(section, "Avg Ask");
        if (!average) throw new Error("Could not parse " + spawner.name + " average price");
        results.push({ ...spawner, average, bid, ask });
    }
    return results;
}

function money(value) {
    return "$" + Math.round(value).toLocaleString("en-US");
}

async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "spawnerprices") return false;
    await interaction.deferReply();
    try {
        const prices = await getTrackerPrices();
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle("📊 DonutSMP Spawner Price Averages")
            .setDescription("Current community-reported averages from DonutSMP Market. Prices can change; use these as a guide.")
            .setURL(TRACKER_URL)
            .setFooter({ text: "Source: DonutSMP Market • Values are not guaranteed trade prices" })
            .setTimestamp(new Date());
        for (const price of prices) {
            embed.addFields({
                name: price.name,
                value:
                    "**Average:** " + money(price.average) + "\n" +
                    (price.bid ? "**Avg bid:** " + money(price.bid) + "\n" : "") +
                    (price.ask ? "**Avg ask:** " + money(price.ask) + "\n" : "") +
                    "[View tracker details](" + price.url + ")",
                inline: true
            });
        }
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error("❌ Spawner price lookup failed:", error);
        await interaction.editReply({
            content: "⚠️ I couldn't read the latest prices from DonutSMP Market right now. Try again shortly, or check https://donutsmpstats.net/spawners directly."
        });
    }
    return true;
}

module.exports = { commands, handleInteraction, getTrackerPrices };
