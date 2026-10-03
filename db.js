// src/db.js - D1 helpers shared by every module. All SQL uses bound parameters.
// The only interpolated value anywhere is a table name, restricted by chk().

export const all = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results ?? [];
export const one = (db, sql, ...a) => db.prepare(sql).bind(...a).first();
export const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();

export const parse = (s) => {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
};
export const isAdmin = (u) => !!u && (u.role === 'admin' || u.role === 'owner');
export const isOwner = (u) => !!u && u.role === 'owner';

// One query per update (D-9): upsert + RETURNING. The owner is promoted automatically.
export function ensureUser(env, from) {
  const owner = String(from.id) === String(env.OWNER_ID);
  const lc = (from.language_code || '').slice(0, 2);
  const lang = lc === 'ar' || lc === 'fr' ? lc : 'en';
  return one(
    env.DB,
    `INSERT INTO users (tg_id, username, first_name, role, lang)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(tg_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       updated_at = ?6,
       role = CASE WHEN ?7 = 1 THEN 'owner' ELSE users.role END
     RETURNING *`,
    from.id, from.username ?? null, from.first_name ?? null,
    owner ? 'owner' : 'user', lang, Date.now(), owner ? 1 : 0,
  );
}

export const setState = (db, id, state, data = null) =>
  run(db, 'UPDATE users SET state = ?1, state_data = ?2 WHERE tg_id = ?3',
    state, data == null ? null : JSON.stringify(data), id);

export async function getSetting(db, key) {
  const r = await one(db, 'SELECT value FROM settings WHERE key = ?1', key);
  return r ? r.value : null;
}
export const setSetting = (db, key, value) =>
  run(db, 'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);

// ---- tree helpers (bot_menus and support_topics) ----
const TABLES = new Set(['bot_menus', 'support_topics']);
const chk = (t) => {
  if (!TABLES.has(t)) throw new Error('bad table');
  return t;
};
// parent 0 / null = root. `IS ?1` matches NULL when the bound value is NULL.
export const kids = (db, table, parent) =>
  all(db, `SELECT * FROM ${chk(table)} WHERE parent_id IS ?1 ORDER BY position, id`, Number(parent) || null);
export const getItem = (db, table, id) =>
  one(db, `SELECT * FROM ${chk(table)} WHERE id = ?1`, Number(id));
export async function nextPos(db, table, parent) {
  const r = await one(db, `SELECT COALESCE(MAX(position), 0) + 1 AS p FROM ${chk(table)} WHERE parent_id IS ?1`, Number(parent) || null);
  return r.p;
}
// Deleting an item deletes its whole subtree.
export const delTree = (db, table, id) =>
  run(db,
    `WITH RECURSIVE t(id) AS (
       SELECT id FROM ${chk(table)} WHERE id = ?1
       UNION ALL
       SELECT x.id FROM ${table} x JOIN t ON x.parent_id = t.id
     ) DELETE FROM ${table} WHERE id IN (SELECT id FROM t)`, Number(id));
