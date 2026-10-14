"use strict";

const { Pool } = require("pg");
let pool;
function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  if (!pool) pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    max: 3
  });
  return pool;
}
async function ensureSchema() {
  await db().query(`
    CREATE TABLE IF NOT EXISTS schematic_requests (
      id BIGSERIAL PRIMARY KEY,
      guild_id VARCHAR(30) NOT NULL,
      user_id VARCHAR(30) NOT NULL,
      user_tag VARCHAR(100) NOT NULL,
      name VARCHAR(100) NOT NULL,
      category VARCHAR(80) NOT NULL,
      description VARCHAR(1000) NOT NULL,
      reference_url VARCHAR(300),
      status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
      reviewed_by VARCHAR(30),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );
  `);
}
async function create(data) {
  await ensureSchema();
  const r = await db().query(
    "INSERT INTO schematic_requests(guild_id,user_id,user_tag,name,category,description,reference_url) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [data.guild_id,data.user_id,data.user_tag,data.name,data.category,data.description,data.reference_url]
  );
  return r.rows[0];
}
async function get(id) {
  await ensureSchema();
  const r = await db().query("SELECT * FROM schematic_requests WHERE id=$1", [id]);
  return r.rows[0] || null;
}
async function setStatus(id, status, reviewerId) {
  await ensureSchema();
  const r = await db().query(
    "UPDATE schematic_requests SET status=$2,reviewed_by=$3,reviewed_at=NOW() WHERE id=$1 AND status='pending' RETURNING *",
    [id,status,reviewerId]
  );
  return r.rows[0] || null;
}
module.exports = { ensureSchema, create, get, setStatus };
