"use strict";

const { Pool } = require("pg");
const storage = require("./schematic-storage");

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
  const p = db();
  await p.query(`
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
  // Categories are managed by staff; never recreate deleted defaults during routine schema checks.
}

async function listCategories() {
  await ensureSchema();
  return (await db().query("SELECT c.id,c.name,COUNT(s.id)::int AS schematic_count FROM schematic_categories c LEFT JOIN schematics s ON s.category_id=c.id GROUP BY c.id ORDER BY c.name")).rows;
}
async function listPublished(categoryId) {
  await ensureSchema();
  const q = categoryId
    ? await db().query("SELECT s.id,s.name,s.description,s.category_id,c.name AS category,s.file_name,s.file_key FROM schematics s JOIN schematic_categories c ON c.id=s.category_id WHERE s.status='published' AND s.file_key IS NOT NULL AND s.category_id=$1 ORDER BY s.name LIMIT 100", [categoryId])
    : await db().query("SELECT s.id,s.name,s.description,s.category_id,c.name AS category,s.file_name,s.file_key FROM schematics s JOIN schematic_categories c ON c.id=s.category_id WHERE s.status='published' AND s.file_key IS NOT NULL ORDER BY s.name LIMIT 100");
  return q.rows;
}
async function getById(id) {
  await ensureSchema();
  const r = await db().query("SELECT * FROM schematics WHERE id=$1", [id]);
  return r.rows[0] || null;
}
async function addDraft({ name, description, categoryId, createdBy, buffer, fileName }) {
  await ensureSchema();
  const p = db();
  const category = await p.query("SELECT id FROM schematic_categories WHERE id=$1", [categoryId]);
  if (!category.rowCount) throw new Error("Category not found.");
  // Upload first; only create a record once the permanent object upload succeeds.
  const file = await storage.uploadSchematic(buffer, fileName);
  try {
    const result = await p.query(
      "INSERT INTO schematics(name,description,category_id,file_key,file_name,status,created_by) VALUES($1,$2,$3,$4,$5,'draft',$6) RETURNING id,name,description,category_id,status,created_at",
      [name, description, categoryId, file.key, file.fileName, createdBy]
    );
    return result.rows[0];
  } catch (error) {
    await storage.deleteSchematic(file.key).catch(() => {});
    throw error;
  }
}
async function publish(id) {
  await ensureSchema();
  const r = await db().query("UPDATE schematics SET status='published',updated_at=NOW() WHERE id=$1 AND file_key IS NOT NULL RETURNING id,name", [id]);
  return r.rows[0] || null;
}
async function remove(id) {
  await ensureSchema();
  const p = db();
  const r = await p.query("SELECT id,file_key FROM schematics WHERE id=$1", [id]);
  if (!r.rowCount) return false;
  if (r.rows[0].file_key) await storage.deleteSchematic(r.rows[0].file_key);
  await p.query("DELETE FROM schematics WHERE id=$1", [id]);
  return true;
}
async function addCategory(name) {
  await ensureSchema();
  const r = await db().query("INSERT INTO schematic_categories(name) VALUES($1) ON CONFLICT(name) DO NOTHING RETURNING id,name", [name]);
  if (!r.rowCount) throw new Error("That category already exists.");
  return r.rows[0];
}
async function deleteCategory(id, replacementId) {
  await ensureSchema();
  const p = db();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const exists = await client.query("SELECT id FROM schematic_categories WHERE id=$1 FOR UPDATE", [id]);
    if (!exists.rowCount) throw new Error("Category not found.");
    const count = await client.query("SELECT COUNT(*)::int AS n FROM schematics WHERE category_id=$1", [id]);
    if (count.rows[0].n && !replacementId) throw new Error("This category contains schematics. Choose a replacement category first.");
    if (replacementId) {
      const replacement = await client.query("SELECT id FROM schematic_categories WHERE id=$1 AND id<>$2", [replacementId, id]);
      if (!replacement.rowCount) throw new Error("Replacement category not found.");
      await client.query("UPDATE schematics SET category_id=$1,updated_at=NOW() WHERE category_id=$2", [replacementId, id]);
    }
    await client.query("DELETE FROM schematic_categories WHERE id=$1", [id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally { client.release(); }
}
module.exports = { ensureSchema, listCategories, listPublished, getById, addDraft, publish, remove, addCategory, deleteCategory };
