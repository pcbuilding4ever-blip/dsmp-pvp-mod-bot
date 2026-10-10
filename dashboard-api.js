"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { ChannelType, PermissionFlagsBits } = require("discord.js");

function constantTimeTokenMatch(provided, expected) {
    if (typeof provided !== "string" || typeof expected !== "string") return false;
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    res.end(JSON.stringify(data));
}
function readJson(req, maxBytes = 20000) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
            if (Buffer.byteLength(body) > maxBytes) { reject(new Error("body_too_large")); req.destroy(); }
        });
        req.on("end", () => {
            try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("invalid_json")); }
        });
        req.on("error", reject);
    });
}
function startDashboardApi(client) {
    const apiKey = process.env.DASHBOARD_API_KEY;
    if (!apiKey || apiKey.length < 32) {
        console.warn("[Dashboard API] Disabled: set DASHBOARD_API_KEY to a random secret of at least 32 characters.");
        return null;
    }
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true });
        const auth = req.headers.authorization || "";
        const match = auth.match(/^Bearer (.+)$/i);
        if (!match || !constantTimeTokenMatch(match[1], apiKey)) return sendJson(res, 401, { error: "unauthorized" });

        if (req.method === "GET" && url.pathname === "/api/status") {
            return sendJson(res, 200, { ok: true, ready: client.isReady(), bot: client.user ? { username: client.user.username, id: client.user.id } : null, guildCount: client.guilds.cache.size, uptimeSeconds: process.uptime(), checkedAt: new Date().toISOString() });
        }
        if (req.method === "GET" && url.pathname === "/api/members") {
            const guildId = url.searchParams.get("guildId") || "";
            const query = (url.searchParams.get("q") || "").toLowerCase().slice(0, 80);
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return sendJson(res, 404, { ok: false, error: "guild_not_found" });
            try {
                const members = await guild.members.fetch({ limit: 1000 });
                const results = members.filter(m => !m.user.bot && (!query || m.user.username.toLowerCase().includes(query) || m.displayName.toLowerCase().includes(query) || m.id.includes(query))).first(100);
                return sendJson(res, 200, { ok: true, members: results.map(m => ({ id: m.id, username: m.user.username, displayName: m.displayName, joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null, roles: m.roles.cache.filter(r => r.id !== guild.id).map(r => r.name).slice(0, 20) })) });
            } catch (error) { console.error("[Dashboard API] Member fetch failed:", error.message); return sendJson(res, 502, { ok: false, error: "member_fetch_failed" }); }
        }
        if (req.method === "GET" && url.pathname === "/api/giveaways") {
            try {
                const data = JSON.parse(fs.readFileSync("./giveaways.json", "utf8"));
                return sendJson(res, 200, { ok: true, giveaways: Object.values(data).map(g => ({ id: g.id, prize: g.prize, hostId: g.hostId, channelId: g.channelId, messageId: g.messageId, winnerCount: g.winnerCount, entries: (g.entries || []).length, winners: g.winners || [], endAt: g.endAt, ended: Boolean(g.ended) })).sort((a,b) => Number(b.endAt || 0) - Number(a.endAt || 0)).slice(0, 100) });
            } catch { return sendJson(res, 200, { ok: true, giveaways: [] }); }
        }
        if (url.pathname === "/api/giveaways/action" && req.method === "POST") {
            let input;
            try { input = await readJson(req); } catch (e) { return sendJson(res, e.message === "body_too_large" ? 413 : 400, { error: e.message }); }
            const id = typeof input.id === "string" ? input.id : "";
            const action = input.action;
            if (!/^\\d{1,30}$/.test(id) || !["end", "redraw"].includes(action)) return sendJson(res, 400, { error: "invalid_giveaway_action" });
            let all;
            try { all = JSON.parse(fs.readFileSync("./giveaways.json", "utf8")); } catch { return sendJson(res, 500, { error: "giveaways_unavailable" }); }
            const g = all[id];
            if (!g) return sendJson(res, 404, { error: "giveaway_not_found" });
            if (action === "end" && g.ended) return sendJson(res, 409, { error: "giveaway_already_ended" });
            if (action === "redraw" && !g.ended) return sendJson(res, 409, { error: "giveaway_not_ended" });
            const entrants = [...new Set(Array.isArray(g.entries) ? g.entries.filter(x => typeof x === "string" && /^\\d{17,20}$/.test(x)) : [])];
            for (let i = entrants.length - 1; i > 0; i--) { const k = crypto.randomInt(i + 1); [entrants[i], entrants[k]] = [entrants[k], entrants[i]]; }
            g.winners = entrants.slice(0, Math.max(0, Math.min(Number(g.winnerCount) || 1, entrants.length)));
            g.ended = true;
            try {
                const temp = "./giveaways.json.tmp";
                fs.writeFileSync(temp, JSON.stringify(all, null, 2), { mode: 0o600 });
                fs.renameSync(temp, "./giveaways.json");
                const channel = await client.channels.fetch(g.channelId);
                const winnerText = g.winners.length ? g.winners.map(x => "<@" + x + ">").join(", ") : "No valid entrants.";
                if (channel && channel.isTextBased()) {
                    await channel.send({ content: (action === "redraw" ? "🔄 **GIVEAWAY WINNERS REDRAWN**" : "🎉 **GIVEAWAY ENDED**") + "\\n\\n🎁 **Prize:** " + String(g.prize || "Prize") + "\\n🏆 **Winner(s):** " + winnerText });
                    try { const original = await channel.messages.fetch(g.messageId); await original.edit({ content: "🎉 **GIVEAWAY ENDED**\\n\\n🎁 **Prize:** " + String(g.prize || "Prize") + "\\n👤 **Hosted by:** <@" + g.hostId + ">\\n🏆 **Winner(s):** " + winnerText, components: [] }); } catch (e) { console.warn("[Dashboard API] Original giveaway message update failed:", e.message); }
                }
                return sendJson(res, 200, { ok: true, giveaway: { id, ended: true, winners: g.winners }, message: action === "redraw" ? "Winners redrawn." : "Giveaway ended." });
            } catch (error) { console.error("[Dashboard API] Giveaway action failed:", error.message); return sendJson(res, 500, { error: "giveaway_action_failed" }); }
        }
        if (url.pathname === "/api/spawners" && req.method === "GET") {
            try {
                const data = JSON.parse(fs.readFileSync("./spawner-stock.json", "utf8"));
                return sendJson(res, 200, { ok: true, stock: { iron_golem: Number.isSafeInteger(data.iron_golem) && data.iron_golem >= 0 ? data.iron_golem : 0, skeleton: Number.isSafeInteger(data.skeleton) && data.skeleton >= 0 ? data.skeleton : 0 } });
            } catch { return sendJson(res, 200, { ok: true, stock: { iron_golem: 0, skeleton: 0 } }); }
        }
        if (url.pathname === "/api/spawners" && req.method === "POST") {
            let data;
            try { data = await readJson(req); } catch (e) { return sendJson(res, e.message === "body_too_large" ? 413 : 400, { error: e.message }); }
            const stock = data && data.stock;
            if (!stock || !Number.isSafeInteger(stock.iron_golem) || stock.iron_golem < 0 || stock.iron_golem > 1000000 || !Number.isSafeInteger(stock.skeleton) || stock.skeleton < 0 || stock.skeleton > 1000000) {
                return sendJson(res, 400, { error: "invalid_stock", message: "Stock values must be whole numbers between 0 and 1,000,000." });
            }
            try {
                const file = "./spawner-stock.json";
                const temp = file + ".tmp";
                fs.writeFileSync(temp, JSON.stringify({ iron_golem: stock.iron_golem, skeleton: stock.skeleton }, null, 2), { mode: 0o600 });
                fs.renameSync(temp, file);
                let panelUpdated = false;
                try { const spawnerPrices = require("./spawner-prices"); if (typeof spawnerPrices.updateSpawnerPanel === "function") { await spawnerPrices.updateSpawnerPanel(client); panelUpdated = true; } } catch (error) { console.warn("[Dashboard API] Stock saved, but public panel refresh failed:", error.message); }
                return sendJson(res, 200, { ok: true, stock: { iron_golem: stock.iron_golem, skeleton: stock.skeleton }, panelUpdated, message: panelUpdated ? "Stock saved and public panel refreshed." : "Stock saved. Run /spawnerprices to refresh the public panel." });
            } catch (error) {
                console.error("[Dashboard API] Stock save failed:", error.message);
                return sendJson(res, 500, { error: "stock_save_failed" });
            }
        }
        if (req.method === "GET" && url.pathname === "/api/vouches") {
            const guildId = url.searchParams.get("guildId") || "";
            if (!/^\\d{17,20}$/.test(guildId)) return sendJson(res, 400, { error: "guild_id_required" });
            try {
                const { Pool } = require("pg");
                if (!process.env.DATABASE_URL) return sendJson(res, 503, { error: "database_not_configured" });
                const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }, max: 2 });
                try {
                    const result = await pool.query("SELECT id, target_id, giver_id, type, reason, created_at, active, flag_reason, reviewed FROM vouches WHERE guild_id=$1 ORDER BY created_at DESC LIMIT 100", [guildId]);
                    return sendJson(res, 200, { ok: true, vouches: result.rows.map(v => ({ id: String(v.id), targetId: v.target_id, giverId: v.giver_id, type: v.type, reason: v.reason, createdAt: v.created_at, active: v.active, flagReason: v.flag_reason, reviewed: v.reviewed })) });
                } finally { await pool.end(); }
            } catch (error) {
                console.error("[Dashboard API] Vouch query failed:", error.message);
                return sendJson(res, 502, { error: "vouch_query_failed" });
            }
        }
        if (req.method === "GET" && url.pathname === "/api/commands") {
            return sendJson(res, 200, { ok: true, commands: ["ping","rules","serverinfo","giveawayinfo","warnings","warn","kick","ban","timeout","userinfo","unwarn","unban","untimeout","settings","announce","stats","report","purge","lock","unlock","slowmode","ticketpanel","game","giveaway","spawnerprices","editstock","vouchpanel","vouchreview"] });
        }
        if (req.method === "GET" && url.pathname === "/api/guilds") {
            return sendJson(res, 200, { ok: true, guilds: client.guilds.cache.map(guild => ({ id: guild.id, name: guild.name, memberCount: guild.memberCount })) });
        }
        if (req.method === "GET" && url.pathname === "/api/channels") {
            const guildId = url.searchParams.get("guildId") || "";
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return sendJson(res, 404, { error: "guild_not_found", message: "The bot cannot find that server. Check that it is still a member." });
            try { await guild.channels.fetch(); } catch (error) { console.error("[Dashboard API] Channel fetch failed:", error.message); return sendJson(res, 502, { error: "channel_fetch_failed", message: "Discord did not return the server channels. Check the bot connection and server access." }); }
            const channels = guild.channels.cache
                .filter(ch => [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(ch.type))
                .map(ch => ({ id: ch.id, name: ch.name, type: ch.type, canSend: Boolean(ch.permissionsFor(client.user)?.has(PermissionFlagsBits.ViewChannel) && ch.permissionsFor(client.user)?.has(PermissionFlagsBits.SendMessages)) }))
                .filter(ch => ch.canSend)
                .sort((a, b) => a.name.localeCompare(b.name));
            return sendJson(res, 200, { ok: true, channels });
        }
        if (req.method === "POST" && url.pathname === "/api/send-message") {
            let data;
            try { data = await readJson(req); } catch (e) {
                return sendJson(res, e.message === "body_too_large" ? 413 : 400, { error: e.message });
            }
            const channelId = typeof data.channelId === "string" ? data.channelId : "";
            const channel = client.channels.cache.get(channelId);
            if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return sendJson(res, 400, { error: "invalid_channel" });
            const permissions = channel.permissionsFor(client.user);
            if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages) || !permissions?.has(PermissionFlagsBits.EmbedLinks)) return sendJson(res, 403, { error: "missing_channel_permissions" });
            const payload = data.payload;
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) return sendJson(res, 400, { error: "invalid_payload" });
            const content = typeof payload.content === "string" ? payload.content.trim() : "";
            if (content.length > 2000) return sendJson(res, 400, { error: "content_too_long" });
            const embeds = Array.isArray(payload.embeds) ? payload.embeds.slice(0, 1) : [];
            if (embeds.length > 0) {
                const e = embeds[0];
                if (!e || typeof e !== "object" || (e.title && String(e.title).length > 256) || (e.description && String(e.description).length > 4096) || (Array.isArray(e.fields) && e.fields.length > 25)) return sendJson(res, 400, { error: "invalid_embed" });
                for (const f of (e.fields || [])) if (!f.name || !f.value || String(f.name).length > 256 || String(f.value).length > 1024) return sendJson(res, 400, { error: "invalid_embed_field" });
            }
            if (!content && !embeds.length) return sendJson(res, 400, { error: "empty_message" });
            try {
                const sent = await channel.send({ content: content || undefined, embeds });
                return sendJson(res, 200, { ok: true, messageId: sent.id, channelId: channel.id, channelName: channel.name, url: sent.url });
            } catch (error) {
                console.error("[Dashboard API] Message send failed:", error.message);
                return sendJson(res, 502, { error: "discord_send_failed" });
            }
        }
        if (req.method !== "GET" && req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return sendJson(res, 405, { error: "method_not_allowed" }); }
        return sendJson(res, 404, { error: "not_found" });
    });
    const port = Number(process.env.PORT) || 3000;
    server.listen(port, "0.0.0.0", () => console.log(`[Dashboard API] Listening on port ${port}`));
    server.on("error", error => console.error("[Dashboard API] Server error:", error.message));
    return server;
}
module.exports = { startDashboardApi };
