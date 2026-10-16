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
        if (url.pathname === "/api/giveaways/create" && req.method === "POST") {
            let input; try { input = await readJson(req); } catch (e) { return sendJson(res, 400, { ok:false, error:e.message }); }
            const guildId=String(input.guildId||""), channelId=String(input.channelId||""), prize=typeof input.prize==="string"?input.prize.trim():"", durationText=typeof input.duration==="string"?input.duration.trim():"";
            const dm=durationText.match(/^(\d+)(s|m|h|d)$/i), duration=dm?Number(dm[1])*({s:1000,m:60000,h:3600000,d:86400000}[dm[2].toLowerCase()]):0;
            const winnerCount=Number(input.winnerCount), maxEntries=Number(input.maxEntries);
            if(!/^\d{17,20}$/.test(guildId)||!/^\d{17,20}$/.test(channelId)||!prize||prize.length>200||!duration||duration<10000||duration>604800000||!Number.isInteger(winnerCount)||winnerCount<1||winnerCount>20||!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>10000) return sendJson(res,400,{ok:false,error:"invalid_giveaway",message:"Check channel, prize, winners, entry limit and duration (10s–7d)."});
            try {
                const guild=await client.guilds.fetch(guildId), channel=await client.channels.fetch(channelId);
                if(!guild||!channel||!channel.isTextBased()||channel.guildId!==guildId) return sendJson(res,400,{ok:false,error:"invalid_channel",message:"Choose a text channel in the selected server."});
                let all={};try{all=JSON.parse(fs.readFileSync("./giveaways.json","utf8"))}catch{}
                const id=Date.now().toString(36)+"-"+crypto.randomBytes(4).toString("hex"),hostId=/^\d{17,20}$/.test(String(input.hostId||""))?String(input.hostId):client.user.id;
                const g={id,hostId,prize,winnerCount,duration,maxEntries,entries:[],winners:[],channelId,messageId:null,endAt:Date.now()+duration,ended:false};
                const {ActionRowBuilder,ButtonBuilder,ButtonStyle}=require("discord.js");
                const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("giveaway_enter:"+id).setLabel("Enter Giveaway").setEmoji("🎉").setStyle(ButtonStyle.Primary));
                const message=await channel.send({content:"# 🎉 GIVEAWAY\n\n🎁 **Prize:** "+prize+"\n👤 **Hosted by:** <@"+hostId+">\n🏆 **Winners:** "+winnerCount+"\n⏱️ **Time:** "+durationText+"\n👥 **Max entries:** "+maxEntries+"\n\nClick **Enter Giveaway** below to enter!",components:[row]});
                g.messageId=message.id;all[id]=g;fs.writeFileSync("./giveaways.json",JSON.stringify(all,null,2),{mode:0o600});
                return sendJson(res,200,{ok:true,message:"Giveaway started in #"+channel.name+".",giveaway:{id,prize,endAt:g.endAt}});
            }catch(error){console.error("[Dashboard API] Giveaway creation failed:",error.message);return sendJson(res,502,{ok:false,error:"giveaway_create_failed",message:"Could not post the giveaway. Check bot permissions and storage."});}
        }
        if (url.pathname === "/api/giveaways/edit" && req.method === "POST") {
            let input;try{input=await readJson(req)}catch(e){return sendJson(res,400,{ok:false,error:e.message})}
            const id=typeof input.id==="string"?input.id:"",prize=typeof input.prize==="string"?input.prize.trim():"",durationText=typeof input.duration==="string"?input.duration.trim():"";
            const dm=durationText.match(/^(\d+)(s|m|h|d)$/i),duration=dm?Number(dm[1])*({s:1000,m:60000,h:3600000,d:86400000}[dm[2].toLowerCase()]):0,winnerCount=Number(input.winnerCount),maxEntries=Number(input.maxEntries);
            if(!/^[a-z0-9-]{5,80}$/i.test(id)||!prize||prize.length>200||!duration||duration<10000||duration>604800000||!Number.isInteger(winnerCount)||winnerCount<1||winnerCount>20||!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>10000)return sendJson(res,400,{ok:false,error:"invalid_giveaway",message:"Check prize, winners, entry limit and duration (10s–7d)."});
            try{
                const all=JSON.parse(fs.readFileSync("./giveaways.json","utf8")),g=all[id];
                if(!g)return sendJson(res,404,{ok:false,error:"giveaway_not_found"});
                if(g.ended)return sendJson(res,409,{ok:false,error:"giveaway_ended",message:"Ended giveaways cannot be edited."});
                if((g.entries||[]).length>maxEntries)return sendJson(res,400,{ok:false,error:"entry_limit_below_entries",message:"Maximum entries cannot be lower than current entries."});
                const channel=await client.channels.fetch(g.channelId),message=channel&&await channel.messages.fetch(g.messageId);
                if(!message)return sendJson(res,502,{ok:false,error:"giveaway_message_missing",message:"Could not find the original giveaway message."});
                g.prize=prize;g.winnerCount=winnerCount;g.maxEntries=maxEntries;g.duration=duration;g.endAt=Date.now()+duration;
                await message.edit({content:"# 🎉 GIVEAWAY\n\n🎁 **Prize:** "+prize+"\n👤 **Hosted by:** <@"+g.hostId+">\n🏆 **Winners:** "+winnerCount+"\n⏱️ **Time remaining:** "+durationText+"\n👥 **Max entries:** "+maxEntries+"\n\nClick **Enter Giveaway** below to enter!"});
                fs.writeFileSync("./giveaways.json",JSON.stringify(all,null,2),{mode:0o600});
                setTimeout(async()=>{try{const latestAll=JSON.parse(fs.readFileSync("./giveaways.json","utf8")),latest=latestAll[id];if(!latest||latest.ended||latest.endAt>Date.now())return;const entrants=[...new Set(latest.entries||[])];for(let i=entrants.length-1;i>0;i--){const j=crypto.randomInt(i+1);[entrants[i],entrants[j]]=[entrants[j],entrants[i]]}latest.winners=entrants.slice(0,Math.min(latest.winnerCount,entrants.length));latest.ended=true;fs.writeFileSync("./giveaways.json",JSON.stringify(latestAll,null,2),{mode:0o600});const ch=await client.channels.fetch(latest.channelId),winnerText=latest.winners.length?latest.winners.map(x=>"<@"+x+">").join(", "):"No valid entrants.";if(ch&&ch.isTextBased()){await ch.send({content:"🎉 **GIVEAWAY ENDED**\n\n🎁 **Prize:** "+latest.prize+"\n🏆 **Winner(s):** "+winnerText});try{const original=await ch.messages.fetch(latest.messageId);await original.edit({content:"🎉 **GIVEAWAY ENDED**\n\n🎁 **Prize:** "+latest.prize+"\n👤 **Hosted by:** <@"+latest.hostId+">\n🏆 **Winner(s):** "+winnerText,components:[]})}catch{}}}catch(e){console.error("[Dashboard API] Edited giveaway timer failed:",e.message)}},duration);
                return sendJson(res,200,{ok:true,message:"Giveaway edited. The Discord post and deadline were updated."});
            }catch(error){console.error("[Dashboard API] Giveaway edit failed:",error.message);return sendJson(res,502,{ok:false,error:"giveaway_edit_failed",message:"Could not update the giveaway in Discord."});}
        }
        if (url.pathname === "/api/giveaways/action" && req.method === "POST") {
            let input;
            try { input = await readJson(req); } catch (e) { return sendJson(res, e.message === "body_too_large" ? 413 : 400, { error: e.message }); }
            const id = typeof input.id === "string" ? input.id : "";
            const action = input.action;
            if (!/^\d{1,30}$/.test(id) || !["end", "redraw"].includes(action)) return sendJson(res, 400, { error: "invalid_giveaway_action" });
            let all;
            try { all = JSON.parse(fs.readFileSync("./giveaways.json", "utf8")); } catch { return sendJson(res, 500, { error: "giveaways_unavailable" }); }
            const g = all[id];
            if (!g) return sendJson(res, 404, { error: "giveaway_not_found" });
            if (action === "end" && g.ended) return sendJson(res, 409, { error: "giveaway_already_ended" });
            if (action === "redraw" && !g.ended) return sendJson(res, 409, { error: "giveaway_not_ended" });
            const entrants = [...new Set(Array.isArray(g.entries) ? g.entries.filter(x => typeof x === "string" && /^\d{17,20}$/.test(x)) : [])];
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
        if (url.pathname === "/api/spawners/panel" && req.method === "GET") {
            const spawnerPrices = require("./spawner-prices");
            const panel = spawnerPrices.loadPanelContent();
            let registered = false;
            try { const ref = JSON.parse(fs.readFileSync("./spawner-panel.json", "utf8")); registered = Boolean(ref.channelId && ref.messageId); } catch {}
            return sendJson(res, 200, { ok: true, panel, registered });
        }
        if (url.pathname === "/api/spawners/panel" && req.method === "POST") {
            let data;
            try { data = await readJson(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
            const title = typeof data.title === "string" ? data.title.trim() : "";
            const description = typeof data.description === "string" ? data.description.trim() : "";
            if (!title || title.length > 200 || description.length > 3500) return sendJson(res, 400, { error: "invalid_panel_content", message: "Enter a title (max 200 characters) and description (max 3,500 characters)." });
            try {
                const spawnerPrices = require("./spawner-prices");
                spawnerPrices.savePanelContent({ title, description });
                await spawnerPrices.updateSpawnerPanel(client);
                return sendJson(res, 200, { ok: true, panel: { title, description }, message: "Spawner message edited successfully." });
            } catch (error) {
                console.error("[Dashboard API] Spawner panel edit failed:", error.message);
                return sendJson(res, 502, { error: "spawner_panel_edit_failed", message: "Saved the panel text, but could not edit the Discord message. Run /spawnerprices once to register the message, then retry." });
            }
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
            if (!/^\d{17,20}$/.test(guildId)) return sendJson(res, 400, { error: "guild_id_required" });
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
        // Schematic library endpoints are isolated from ticket and giveaway handlers.
        if (url.pathname.startsWith("/api/schematics")) {
            if (!process.env.DATABASE_URL) return sendJson(res, 503, { error: "database_not_configured" });
            let pool;
            try {
                const { Pool } = require("pg");
                pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }, max: 2 });
                await pool.query(`
                    CREATE TABLE IF NOT EXISTS schematic_categories (
                        id BIGSERIAL PRIMARY KEY,
                        name VARCHAR(80) NOT NULL UNIQUE,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS schematics (
                        id BIGSERIAL PRIMARY KEY,
                        name VARCHAR(100) NOT NULL,
                        description VARCHAR(1000) NOT NULL DEFAULT '',
                        category_id BIGINT REFERENCES schematic_categories(id) ON DELETE RESTRICT,
                        file_url TEXT,
                        file_key TEXT,
                        file_name VARCHAR(180),
                        status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
                        created_by VARCHAR(30),
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                `);
                // Do not recreate default categories on every API request: staff must be able to delete them permanently.
                if (req.method === "GET" && url.pathname === "/api/schematics/categories") {
                    const result = await pool.query("SELECT c.id,c.name,COUNT(s.id)::int AS schematic_count FROM schematic_categories c LEFT JOIN schematics s ON s.category_id=c.id GROUP BY c.id ORDER BY c.id");
                    return sendJson(res, 200, { ok: true, categories: result.rows });
                }
                if (req.method === "GET" && url.pathname === "/api/schematics") {
                    const result = await pool.query("SELECT s.id,s.name,s.description,s.category_id,c.name AS category,s.file_name,s.file_url,s.status,s.created_by,s.created_at FROM schematics s LEFT JOIN schematic_categories c ON c.id=s.category_id ORDER BY s.created_at DESC LIMIT 500");
                    return sendJson(res, 200, { ok: true, schematics: result.rows });
                }
                if (req.method === "POST" && url.pathname === "/api/schematics") {
                    let data;
                    try { data = await readJson(req, 10000); } catch (e) { return sendJson(res, e.message === "body_too_large" ? 413 : 400, { error: e.message }); }
                    const name = typeof data.name === "string" ? data.name.trim() : "";
                    const description = typeof data.description === "string" ? data.description.trim() : "";
                    const categoryId = Number(data.categoryId);
                    if (!name || name.length > 100 || description.length > 1000 || !Number.isSafeInteger(categoryId) || categoryId < 1) return sendJson(res, 400, { error: "invalid_schematic", message: "Provide a name, description (up to 1,000 characters), and category." });
                    const category = await pool.query("SELECT id FROM schematic_categories WHERE id=$1", [categoryId]);
                    if (!category.rowCount) return sendJson(res, 400, { error: "category_not_found" });
                    // No draft can be published until a permanent file has been attached.
                    const result = await pool.query("INSERT INTO schematics(name,description,category_id,status,created_by) VALUES($1,$2,$3,'draft',$4) RETURNING id,name,description,category_id,status,created_at", [name, description, categoryId, typeof data.createdBy === "string" ? data.createdBy.slice(0,30) : null]);
                    return sendJson(res, 201, { ok: true, schematic: result.rows[0], message: "Draft saved. Attach a permanent .litematic file before publishing." });
                }
                if (req.method === "POST" && url.pathname === "/api/schematics/category") {
                    let data;
                    try { data = await readJson(req, 2000); } catch (e) { return sendJson(res, 400, { error: e.message }); }
                    const name = typeof data.name === "string" ? data.name.trim() : "";
                    if (!name || name.length > 80) return sendJson(res, 400, { error: "invalid_category" });
                    const result = await pool.query("INSERT INTO schematic_categories(name) VALUES($1) ON CONFLICT(name) DO NOTHING RETURNING id,name", [name]);
                    if (!result.rowCount) return sendJson(res, 409, { error: "category_exists" });
                    return sendJson(res, 201, { ok: true, category: result.rows[0] });
                }
                if (req.method === "POST" && url.pathname === "/api/schematics/publish") {
                    let data;
                    try { data = await readJson(req, 2000); } catch (e) { return sendJson(res, 400, { error: e.message }); }
                    const id = Number(data.id);
                    if (!Number.isSafeInteger(id) || id < 1) return sendJson(res, 400, { error: "invalid_id" });
                    const result = await pool.query("UPDATE schematics SET status='published',updated_at=NOW() WHERE id=$1 AND file_key IS NOT NULL RETURNING id,name,status", [id]);
                    if (!result.rowCount) return sendJson(res, 409, { error: "file_required_or_not_found", message: "A stored .litematic file is required before publishing." });
                    return sendJson(res, 200, { ok: true, schematic: result.rows[0] });
                }
                if (req.method === "POST" && url.pathname === "/api/schematics/category/delete") {
                    let data;
                    try { data = await readJson(req, 2000); } catch (e) { return sendJson(res, 400, { error: e.message }); }
                    const id = Number(data.id);
                    const replacementId = data.replacementCategoryId == null || data.replacementCategoryId === "" ? null : Number(data.replacementCategoryId);
                    if (!Number.isSafeInteger(id) || id < 1 || (replacementId !== null && (!Number.isSafeInteger(replacementId) || replacementId < 1 || replacementId === id))) return sendJson(res, 400, { error: "invalid_category_id" });
                    const count = await pool.query("SELECT COUNT(*)::int AS n FROM schematics WHERE category_id=$1", [id]);
                    if (!count.rowCount) return sendJson(res, 404, { error: "category_not_found" });
                    if (count.rows[0].n && !replacementId) return sendJson(res, 409, { error: "category_in_use", message: "Choose a replacement category before deleting this category." });
                    if (replacementId) {
                        const replacement = await pool.query("SELECT id FROM schematic_categories WHERE id=$1", [replacementId]);
                        if (!replacement.rowCount) return sendJson(res, 400, { error: "replacement_category_not_found" });
                    }
                    const tx = await pool.connect();
                    try {
                        await tx.query("BEGIN");
                        if (replacementId) await tx.query("UPDATE schematics SET category_id=$1,updated_at=NOW() WHERE category_id=$2", [replacementId, id]);
                        await tx.query("DELETE FROM schematic_categories WHERE id=$1", [id]);
                        await tx.query("COMMIT");
                    } catch (e) { await tx.query("ROLLBACK"); throw e; } finally { tx.release(); }
                    return sendJson(res, 200, { ok: true, message: "Category deleted." });
                }
                if (req.method === "POST" && url.pathname === "/api/schematics/delete") {
                    let data;
                    try { data = await readJson(req, 2000); } catch (e) { return sendJson(res, 400, { error: e.message }); }
                    const id = Number(data.id);
                    if (!Number.isSafeInteger(id) || id < 1) return sendJson(res, 400, { error: "invalid_id" });
                    const result = await pool.query("DELETE FROM schematics WHERE id=$1 RETURNING id", [id]);
                    if (!result.rowCount) return sendJson(res, 404, { error: "schematic_not_found" });
                    return sendJson(res, 200, { ok: true, message: "Schematic removed from the library." });
                }
                return sendJson(res, 404, { error: "not_found" });
            } catch (error) {
                console.error("[Schematic API] Request failed:", error.message);
                return sendJson(res, 500, { error: "schematic_api_failed" });
            } finally {
                if (pool) await pool.end().catch(() => {});
            }
        }
        const commandNames = ["ping","rules","serverinfo","giveawayinfo","warnings","warn","kick","ban","timeout","userinfo","unwarn","unban","untimeout","settings","announce","stats","report","purge","lock","unlock","slowmode","ticketpanel","schematic","game","giveaway","spawnerprices","editstock","vouchpanel","vouchreview"];
        if (req.method === "GET" && url.pathname === "/api/commands") {
            let saved = {};
            try { saved = JSON.parse(fs.readFileSync("./command-settings.json", "utf8")); } catch {}
            return sendJson(res, 200, { ok: true, commands: commandNames.map(name => ({ name, enabled: saved[name]?.enabled !== false, channelId: saved[name]?.channelId || "", settings: saved[name]?.settings || {} })) });
        }
        if (req.method === "POST" && url.pathname === "/api/commands/settings") {
            let input;
            try { input = await readJson(req, 6000); } catch (error) { return sendJson(res, 400, { ok: false, error: error.message }); }
            const allowed = new Set(commandNames);
            if (!input || typeof input.name !== "string" || !allowed.has(input.name)) return sendJson(res, 400, { ok: false, error: "invalid_command_setting" });
            let saved = {};
            try { saved = JSON.parse(fs.readFileSync("./command-settings.json", "utf8")); } catch {}
            const previous = saved[input.name] || { enabled: true, channelId: "" };
            if (input.action === "reset") {
                saved[input.name] = { enabled: true, channelId: "" };
            } else {
                if (input.enabled !== undefined && typeof input.enabled !== "boolean") return sendJson(res, 400, { ok: false, error: "invalid_enabled_value" });
                if (input.channelId !== undefined && typeof input.channelId !== "string") return sendJson(res, 400, { ok: false, error: "invalid_channel_id" });
                const channelId = input.channelId === undefined ? (previous.channelId || "") : input.channelId.trim();
                if (input.settings !== undefined && (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings))) return sendJson(res, 400, { ok: false, error: "invalid_command_settings" });
                const settings = input.settings === undefined ? (previous.settings || {}) : input.settings;
                for (const [key, value] of Object.entries(settings)) {
                    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) || !["string","number","boolean"].includes(typeof value) || (typeof value === "string" && value.length > 1000) || (typeof value === "number" && !Number.isFinite(value))) return sendJson(res, 400, { ok: false, error: "invalid_command_setting_value" });
                }
                if (channelId && !/^\d{17,20}$/.test(channelId)) return sendJson(res, 400, { ok: false, error: "invalid_channel_id" });
                saved[input.name] = { enabled: input.enabled === undefined ? previous.enabled !== false : input.enabled, channelId, settings };
            }
            try {
                const temp = "./command-settings.json.tmp";
                fs.writeFileSync(temp, JSON.stringify(saved, null, 2), { mode: 0o600 });
                fs.renameSync(temp, "./command-settings.json");
                return sendJson(res, 200, { ok: true, name: input.name, ...saved[input.name], message: input.action === "reset" ? "/" + input.name + " settings reset to defaults." : "/" + input.name + " settings saved." });
            } catch (error) {
                console.error("[Dashboard API] Command settings save failed:", error.message);
                return sendJson(res, 500, { ok: false, error: "command_settings_save_failed" });
            }
        }
        if (req.method === "POST" && url.pathname === "/api/commands/resend") {
            let input;
            try { input = await readJson(req, 2000); } catch (error) { return sendJson(res, 400, { ok: false, error: error.message }); }
            if (!input || typeof input.name !== "string" || !commandNames.includes(input.name)) return sendJson(res, 400, { ok: false, error: "invalid_command_name" });
            try {
                const registered = await client.application.commands.fetch();
                const command = registered.find(item => item.name === input.name);
                if (!command) return sendJson(res, 404, { ok: false, error: "command_not_registered", message: "This command is not registered globally. Resync the bot's command definitions during deployment." });
                await command.edit({ name: command.name, description: command.description, options: command.options, defaultMemberPermissions: command.defaultMemberPermissions, dmPermission: command.dmPermission, nsfw: command.nsfw });
                return sendJson(res, 200, { ok: true, message: "/" + input.name + " was resent to Discord." });
            } catch (error) {
                console.error("[Dashboard API] Command resend failed:", error.message);
                return sendJson(res, 500, { ok: false, error: "command_resend_failed", message: error.message });
            }
        }
        if (req.method === "GET" && url.pathname === "/api/tickets") {
            const parentId = "1553777212170178570";
            try {
                const parent = await client.channels.fetch(parentId);
                if (!parent || !parent.isTextBased() || !parent.threads) {
                    return sendJson(res, 200, { ok: true, tickets: [], openCount: 0, message: "Ticket channel is unavailable." });
                }
                const active = await parent.threads.fetchActive();
                const tickets = active.threads
                    .filter(thread => thread.name.startsWith("ticket-"))
                    .map(thread => ({
                        id: thread.id,
                        name: thread.name,
                        parentId: thread.parentId,
                        createdAt: thread.createdAt ? thread.createdAt.toISOString() : null,
                        archived: Boolean(thread.archived),
                        memberCount: thread.memberCount ?? null,
                        url: "https://discord.com/channels/" + thread.guildId + "/" + thread.id
                    }))
                    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
                    .slice(0, 100);
                return sendJson(res, 200, { ok: true, tickets, openCount: tickets.length, checkedAt: new Date().toISOString() });
            } catch (error) {
                console.error("[Dashboard API] Ticket fetch failed:", error.message);
                return sendJson(res, 502, { error: "ticket_fetch_failed" });
            }
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
