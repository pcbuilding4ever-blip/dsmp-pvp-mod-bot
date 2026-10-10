"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

function constantTimeTokenMatch(provided, expected) {
    if (typeof provided !== "string" || typeof expected !== "string") return false;
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer"
    });
    res.end(JSON.stringify(data));
}

function startDashboardApi(client) {
    const apiKey = process.env.DASHBOARD_API_KEY;
    if (!apiKey || apiKey.length < 32) {
        console.warn("[Dashboard API] Disabled: set DASHBOARD_API_KEY to a random secret of at least 32 characters.");
        return null;
    }

    const server = http.createServer((req, res) => {
        const url = new URL(req.url || "/", "http://localhost");

        if (req.method === "GET" && url.pathname === "/health") {
            return sendJson(res, 200, { ok: true });
        }

        if (req.method !== "GET") {
            res.setHeader("Allow", "GET");
            return sendJson(res, 405, { error: "method_not_allowed" });
        }

        const auth = req.headers.authorization || "";
        const match = auth.match(/^Bearer (.+)$/i);
        if (!match || !constantTimeTokenMatch(match[1], apiKey)) {
            return sendJson(res, 401, { error: "unauthorized" });
        }

        if (url.pathname === "/api/status") {
            return sendJson(res, 200, {
                ok: true,
                ready: client.isReady(),
                bot: client.user ? { username: client.user.username, id: client.user.id } : null,
                guildCount: client.guilds.cache.size,
                uptimeSeconds: process.uptime(),
                checkedAt: new Date().toISOString()
            });
        }

        if (url.pathname === "/api/guilds") {
            return sendJson(res, 200, {
                guilds: client.guilds.cache.map(guild => ({
                    id: guild.id,
                    name: guild.name,
                    memberCount: guild.memberCount
                }))
            });
        }

        return sendJson(res, 404, { error: "not_found" });
    });

    const port = Number(process.env.PORT) || 3000;
    server.listen(port, "0.0.0.0", () => {
        console.log(`[Dashboard API] Listening on port ${port}`);
    });

    server.on("error", error => {
        console.error("[Dashboard API] Server error:", error.message);
    });

    return server;
}

module.exports = { startDashboardApi };
