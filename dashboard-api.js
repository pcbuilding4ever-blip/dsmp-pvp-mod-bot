"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
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
