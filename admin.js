// src/admin.js - the admin side. Everything is driven by inline buttons ("⚙️ Admin panel");
// text input is only requested inside short wizards, each with a Cancel button.
// Commands exist only as optional shortcuts and are listed in /help.
import { makeTg, btn, link, ik, ADMIN_COMMANDS } from './tg.js';
import {
  all, one, run, parse, isOwner, setState, getSetting, setSetting,
  kids, nextPos, delTree, getItem,
} from './db.js';
import { sendMain } from './user.js';

const URL_RE = /^(https?:\/\/|tg:\/\/)\S+$/i;
const MAXLAB = 60;
const clip = (s, n = 60) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const fmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const panelRow = [btn('⚙️ Admin panel', 'ad:home')];
const cancelKb = (to) => ik([[btn('❌ Cancel', to)]]);

// ---------- tree editor: main menu (m) and help center (t) share one editor ----------
const K = {
  m: {
    table: 'bot_menus', lab: 'button_text', typ: 'action_type', val: 'action_value', container: 'sub',
    name: 'Main menu', icon: '📋', labName: 'button text',
    types: [['text', '💬 Text reply'], ['url', '🔗 Link button'], ['topics', '📚 Help center'], ['live', '🎧 Live support'], ['sub', '📂 Sub-menu']],
    needVal: { text: 'Send the reply text customers should receive.', url: 'Send the link (it must start with https://).' },
    example: '[\n {"text":"Pricing","type":"text","value":"Our prices..."},\n {"text":"Links","type":"sub","children":[\n  {"text":"Website","type":"url","value":"https://example.com"}\n ]}\n]\n\nTypes: text, url, topics, live, sub',
  },
  t: {
    table: 'support_topics', lab: 'title', typ: 'content_type', val: 'payload', container: 'category',
    name: 'Help center', icon: '📚', labName: 'title',
    types: [['category', '📂 Category'], ['answer', '📄 Answer'], ['link', '🔗 Link'], ['live', '🎧 Live support']],
    needVal: { answer: 'Send the answer text.', link: 'Send the link (it must start with https://).' },
    example: '[\n {"title":"Orders","type":"category","children":[\n  {"title":"Track my order","type":"answer","value":"Open Account > Orders..."}\n ]},\n {"title":"Our site","type":"link","value":"https://example.com"}\n]\n\nTypes: category, answer, link, live',
  },
};
const ICON = { text: '💬', url: '🔗', topics: '📚', live: '🎧', sub: '📂', category: '📂', answer: '📄', link: '🔗' };

function checkVal(type, val) {
  if ((type === 'url' || type === 'link') && !URL_RE.test(val)) return '⚠️ Invalid link. It must start with https:// (or tg://).';
  if (val.length > 3500) return '⚠️ Too long (max 3500 characters).';
  return null;
}

async function treeList(env, tg, chat, mid, k, parent) {
  const c = K[k];
  if (!c) return;
  parent = Number(parent) || 0;
  let p = null;
  if (parent) {
    p = await getItem(env.DB, c.table, parent);
    if (!p) parent = 0;
  }
  const items = await kids(env.DB, c.table, parent);
  const where = p ? `${c.name} › ${clip(p[c.lab], 30)}` : `${c.name} (top level)`;
  let text = `${c.icon} ${where}\n\n` + (items.length ? 'Tap an item to open it.' : 'Nothing here yet. Tap ➕ Add.');
  if (k === 'm' && !p) text += '\n\nTop-level items appear as buttons under the chat box.';
  const rows = items.map((i) => [btn(`${ICON[i[c.typ]]} ${clip(i[c.lab], 40)}`, `ad:it:${k}:${i.id}`)]);
  rows.push([btn('➕ Add', `ad:add:${k}:${parent}`), btn('📥 Import JSON', `ad:imp:${k}:${parent}`)]);
  rows.push([btn('⬅️ Back', p ? `ad:tr:${k}:${p.parent_id || 0}` : 'ad:home')]);
  return tg.view(chat, mid, text, ik(rows));
}

async function itemScreen(env, tg, chat, mid, k, id) {
  const c = K[k];
  const it = await getItem(env.DB, c.table, id);
  if (!it) return treeList(env, tg, chat, mid, k, 0);
  const type = it[c.typ];
  let text = `${ICON[type]} ${it[c.lab]}\n\nType: ${type}\n`;
  if (c.needVal[type]) text += `Value: ${clip(it[c.val], 300)}\n`;
  const rows = [];
  const edit = [btn(`✏️ Edit ${c.labName}`, `ad:ed:${k}:l:${it.id}`)];
  if (c.needVal[type]) edit.push(btn('✏️ Edit value', `ad:ed:${k}:v:${it.id}`));
  rows.push(edit);
  if (type === c.container) {
    const n = await one(env.DB, `SELECT COUNT(*) AS n FROM ${c.table} WHERE parent_id = ?1`, it.id);
    text += `Items inside: ${n.n}\n`;
    rows.push([btn('📂 Open', `ad:tr:${k}:${it.id}`)]);
  }
  rows.push([btn('⬆️ Up', `ad:mv:${k}:${it.id}:u`), btn('⬇️ Down', `ad:mv:${k}:${it.id}:d`)]);
  rows.push([btn('🗑 Delete', `ad:rm:${k}:${it.id}`)]);
  rows.push([btn('⬅️ Back', `ad:tr:${k}:${it.parent_id || 0}`)]);
  return tg.view(chat, mid, text, ik(rows));
}

async function moveItem(env, k, id, dir) {
  const c = K[k];
  const it = await getItem(env.DB, c.table, id);
  if (!it) return;
  const sibs = await kids(env.DB, c.table, it.parent_id);
  const i = sibs.findIndex((s) => s.id === it.id);
  const j = dir === 'u' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= sibs.length) return;
  [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
  await env.DB.batch(sibs.map((s, n) =>
    env.DB.prepare(`UPDATE ${c.table} SET position = ?1 WHERE id = ?2`).bind(n + 1, s.id)));
}

// ----- JSON import (optional bulk setup) -----
function checkNodes(k, nodes, depth, counter) {
  const c = K[k];
  if (!Array.isArray(nodes)) return 'Expected a list: [ ... ]';
  if (depth > 4) return 'Too deep (max 4 levels).';
  for (const n of nodes) {
    if (++counter.n > 100) return 'Too many items (max 100).';
    if (!n || typeof n !== 'object') return 'Every item must be an object { ... }.';
    const label = String(n.text ?? n.title ?? '').trim();
    if (!label || label.length > MAXLAB) return `Bad text "${label.slice(0, 20)}" (1-${MAXLAB} characters).`;
    if (!c.types.some(([x]) => x === n.type)) return `Unknown type "${n.type}" for "${label}".`;
    const val = n.value == null ? '' : String(n.value);
    if (c.needVal[n.type]) {
      if (!val) return `"${label}" needs a "value".`;
      const e = checkVal(n.type, val);
      if (e) return `"${label}": ${e.replace('⚠️ ', '')}`;
    }
    if (n.children != null) {
      if (n.type !== c.container) return `"${label}" cannot have children.`;
      const e = checkNodes(k, n.children, depth + 1, counter);
      if (e) return e;
    }
  }
  return null;
}
async function insertNodes(db, k, nodes, parent) {
  const c = K[k];
  let pos = await nextPos(db, c.table, parent);
  for (const n of nodes) {
    const label = String(n.text ?? n.title).trim();
    const r = await run(db,
      `INSERT INTO ${c.table} (parent_id, ${c.lab}, ${c.typ}, ${c.val}, position) VALUES (?1, ?2, ?3, ?4, ?5)`,
      Number(parent) || null, label, n.type, c.needVal[n.type] ? String(n.value) : null, pos++);
    if (n.children && n.children.length) await insertNodes(db, k, n.children, r.meta.last_row_id);
  }
}

// ---------- panel ----------
export function sendPanel(env, tg, chat, mid) {
  return tg.view(chat, mid, '⚙️ Admin panel\nChoose what you want to manage:', ik([
    [btn('📋 Main menu', 'ad:tr:m:0'), btn('📚 Help center', 'ad:tr:t:0')],
    [btn('👋 Welcome text', 'ad:w'), btn('📱 Mini App', 'ad:ma')],
    [btn('✍️ New post', 'np:start'), btn('🗓 Scheduled', 'ad:q')],
    [btn('📣 Channels', 'ad:c'), btn('👥 Team', 'ad:a')],
    [btn('📢 Broadcast', 'ad:bc'), btn('🚫 Banned', 'ad:b')],
    [btn('📊 Stats', 'ad:s'), btn('👁 Preview', 'ad:pv')],
    [btn('❓ Help', 'ad:help')],
  ]));
}

const HELP = `❓ Admin help

Everything is available from the ⚙️ Admin panel. No commands needed.

Optional shortcuts:
/help - this screen
/panel - open the admin panel
/newpost - create a post
/schedule - scheduled posts
/stats - statistics
/ban <id> - ban (or reply to a ticket)
/unban <id> - unban
/cancel - cancel the current step

Tips:
• Reply to a ticket in the admin group to answer the customer.
• Tap 🚫 Ban under a ticket header to block that user.
• Forwarding a customer's message (or a ticket header) to the bot works wherever an ID is asked.
• Scheduled times are in UTC.`;

export async function helpScreen(env, tg, chat, mid, priv) {
  let extra = {};
  if (priv) extra = ik([panelRow]);
  else {
    const me = await tg.call('getMe');
    if (me.ok) extra = ik([[link('⚙️ Open admin panel', `https://t.me/${me.result.username}?start=panel`)]]);
  }
  return tg.view(chat, mid, HELP, extra);
}

async function statsScreen(env, tg, chat, mid, priv) {
  const s = await one(env.DB, `SELECT
    (SELECT COUNT(*) FROM users WHERE banned = 0) AS users,
    (SELECT COUNT(*) FROM users WHERE banned = 1) AS banned,
    (SELECT COUNT(*) FROM users WHERE role IN ('admin','owner')) AS admins,
    (SELECT COUNT(*) FROM targets) AS channels,
    (SELECT COUNT(*) FROM post_queue WHERE status = 'pending') AS pending,
    (SELECT COUNT(*) FROM post_queue WHERE status = 'failed') AS failed,
    (SELECT COUNT(*) FROM post_queue WHERE status = 'sending') AS stuck`);
  const text = `📊 Stats\n\n👥 Users: ${s.users}\n🚫 Banned: ${s.banned}\n🛡 Admins: ${s.admins}\n📣 Channels: ${s.channels}\n🗓 Pending posts: ${s.pending}\n⚠️ Failed posts: ${s.failed}` +
    (s.stuck ? `\n⏳ Stuck sending: ${s.stuck}` : '');
  return tg.view(chat, mid, text, priv ? ik([[btn('⬅️ Back', 'ad:home')]]) : {});
}

// ---------- ban / unban ----------
async function banUser(env, id, ban) {
  if (String(id) === String(env.OWNER_ID)) return '⚠️ Admins cannot be banned.';
  const row = await one(env.DB, 'SELECT role FROM users WHERE tg_id = ?1', id);
  if (row && (row.role === 'admin' || row.role === 'owner')) return '⚠️ Admins cannot be banned.';
  if (ban) {
    await run(env.DB, 'INSERT INTO users (tg_id, banned) VALUES (?1, 1) ON CONFLICT(tg_id) DO UPDATE SET banned = 1', id);
    return `🚫 Banned ${id}`;
  }
  await run(env.DB, 'UPDATE users SET banned = 0 WHERE tg_id = ?1', id);
  return `✅ Unbanned ${id}`;
}

async function toggleBan(env, tg, cq, uid) {
  const row = await one(env.DB, 'SELECT banned FROM users WHERE tg_id = ?1', uid);
  const ban = !(row && row.banned);
  const msg = await banUser(env, uid, ban);
  await tg.answer(cq.id, msg);
  if (msg.startsWith('⚠️')) return;
  return tg.call('editMessageReplyMarkup', {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id,
    reply_markup: { inline_keyboard: [[btn(ban ? '✅ Unban' : '🚫 Ban', 'ad:bn:' + uid)]] },
  });
}

async function banScreen(env, tg, chat, mid) {
  const rows = await all(env.DB, 'SELECT tg_id, first_name, username FROM users WHERE banned = 1 ORDER BY updated_at DESC LIMIT 10');
  const kb = rows.map((r) => [btn(`✅ Unban ${clip(r.first_name || r.username || r.tg_id, 30)}`, 'ad:ub:' + r.tg_id)]);
  kb.push([btn('🚫 Ban a user', 'ad:ba')]);
  kb.push([btn('⬅️ Back', 'ad:home')]);
  const text = `🚫 Banned users (${rows.length}${rows.length === 10 ? '+' : ''})\n\n` +
    (rows.length ? 'Tap a name to unban.' : 'Nobody is banned.') +
    '\n\nTip: use the 🚫 Ban button under any ticket in the admin group.';
  return tg.view(chat, mid, text, ik(kb));
}

// Works from a forwarded message, a forwarded ticket header ("🆔 123"), or a typed ID.
function userIdFrom(m) {
  const fo = m.forward_origin;
  if (m.forward_from && !m.forward_from.is_bot) return m.forward_from.id;
  if (fo && fo.type === 'user' && fo.sender_user && !fo.sender_user.is_bot) return fo.sender_user.id;
  const s = (m.text || '').trim();
  const h = s.match(/🆔\s*(\d{5,})/);
  if (h) return Number(h[1]);
  if (/^\d{5,}$/.test(s)) return Number(s);
  return null;
}

// ---------- channels ----------
async function channelsScreen(env, tg, chat, mid) {
  const rows = await all(env.DB, 'SELECT id, title, type FROM targets ORDER BY title');
  const kb = rows.map((r) => [btn(`🗑 Remove: ${clip(r.title, 40)}`, 'ad:cd:' + r.id)]);
  kb.push([btn('➕ Add channel or group', 'ad:ca')]);
  kb.push([btn('⬅️ Back', 'ad:home')]);
  const list = rows.map((r) => `• ${r.title} (${r.type})`).join('\n');
  return tg.view(chat, mid, `📣 Channels and groups (${rows.length})\n\n${list || 'None yet.'}`, ik(kb));
}

// ---------- team ----------
async function teamScreen(env, tg, u, chat, mid) {
  const rows = await all(env.DB, "SELECT tg_id, first_name, username, role FROM users WHERE role IN ('owner','admin') ORDER BY role DESC, tg_id");
  const nm = (r) => `${r.first_name || 'Admin'}${r.username ? ' @' + r.username : ''} (${r.tg_id})`;
  const text = '👥 Team\n\n' + (rows.map((r) => `${r.role === 'owner' ? '👑' : '🛡'} ${nm(r)}`).join('\n') || 'No admins yet.');
  const kb = [];
  if (isOwner(u)) {
    for (const r of rows) if (r.role === 'admin') kb.push([btn(`🗑 Remove ${clip(r.first_name || r.tg_id, 30)}`, 'ad:ar:' + r.tg_id)]);
    kb.push([btn('➕ Add admin', 'ad:aa')]);
  } else {
    kb.push([btn('Only the owner can add or remove admins', 'ad:a')]);
  }
  kb.push([btn('⬅️ Back', 'ad:home')]);
  return tg.view(chat, mid, text, ik(kb));
}

export function syncCommands(env, tg, chatId, admin) {
  const scope = { type: 'chat', chat_id: Number(chatId) };
  return admin
    ? tg.call('setMyCommands', { commands: ADMIN_COMMANDS, scope })
    : tg.call('deleteMyCommands', { scope });
}

// ---------- posting ----------
export async function startPost(env, tg, u, chat, mid) {
  const n = await one(env.DB, 'SELECT COUNT(*) AS n FROM targets');
  if (!n.n) {
    return tg.view(chat, mid, '📣 Add a channel or group first, then create posts.',
      ik([[btn('➕ Add channel or group', 'ad:ca')], panelRow]));
  }
  await setState(env.DB, u.tg_id, 'NP_CONTENT');
  return tg.view(chat, mid, '✍️ New post\n\nSend the content now: text, photo, video, file, voice... anything.', cancelKb('np:x'));
}

const expired = (tg, chat, mid) =>
  tg.view(chat, mid, '⌛ This step expired.', ik([[btn('✍️ New post', 'np:start')], panelRow]));

function parseUtc(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec((s || '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  const dt = new Date(ms);
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return ms;
}

export async function onPostCallback(env, tg, u, cq) {
  const chat = cq.message.chat.id;
  const mid = cq.message.message_id;
  if (cq.message.chat.type !== 'private') return;
  const [, a, v] = cq.data.split(':');
  const d = parse(u.state_data);
  if (a === 'start') return startPost(env, tg, u, chat, mid);
  if (a === 'x') {
    await setState(env.DB, u.tg_id, 'IDLE');
    return tg.view(chat, mid, '✅ Cancelled.', ik([panelRow]));
  }
  if (a === 't') {
    if (u.state !== 'NP_TARGET') return expired(tg, chat, mid);
    if (v !== 'all') {
      const target = await one(env.DB, 'SELECT id FROM targets WHERE id = ?1', Number(v));
      if (!target) return tg.view(chat, mid, '⚠️ That channel no longer exists.', ik([panelRow]));
    }
    await setState(env.DB, u.tg_id, 'NP_TIME', { ...d, target: v });
    return tg.view(chat, mid,
      '🕒 When should it be published?\n\nTap an option, or type a UTC time like 2026-10-05 14:30',
      ik([
        [btn('🚀 Now', 'np:w:0'), btn('+1 hour', 'np:w:3600')],
        [btn('+6 hours', 'np:w:21600'), btn('+24 hours', 'np:w:86400')],
        [btn('❌ Cancel', 'np:x')],
      ]));
  }
  if (a === 'w') {
    const sec = Number(v);
    if (![0, 3600, 21600, 86400].includes(sec)) return;
    if (u.state !== 'NP_TIME' || !d.target) return expired(tg, chat, mid);
    return schedulePost(env, tg, u, chat, mid, d, Date.now() + sec * 1000);
  }
}

async function onPostInput(env, tg, u, m, d) {
  const chat = m.chat.id;
  if (u.state === 'NP_CONTENT') {
    const targets = await all(env.DB, 'SELECT id, title FROM targets ORDER BY title');
    if (!targets.length) {
      await setState(env.DB, u.tg_id, 'IDLE');
      return tg.send(chat, '📣 No channels yet. Add one first.', ik([[btn('➕ Add channel or group', 'ad:ca')]]));
    }
    await setState(env.DB, u.tg_id, 'NP_TARGET', { from_chat_id: chat, message_id: m.message_id });
    const rows = targets.map((x) => [btn('📣 ' + clip(x.title, 40), 'np:t:' + x.id)]);
    if (targets.length > 1) rows.push([btn(`📣 All (${targets.length})`, 'np:t:all')]);
    rows.push([btn('❌ Cancel', 'np:x')]);
    return tg.send(chat, '✅ Content saved.\nWhere should it be published?', ik(rows));
  }
  if (u.state === 'NP_TIME') {
    const when = parseUtc(m.text);
    if (when == null) return tg.send(chat, '⚠️ Use the format YYYY-MM-DD HH:MM (UTC), for example 2026-10-05 14:30. Or tap a button above.', cancelKb('np:x'));
    if (when <= Date.now()) return tg.send(chat, '⚠️ That time is in the past. Send a future time.', cancelKb('np:x'));
    return schedulePost(env, tg, u, chat, null, d, when);
  }
  return tg.send(chat, 'Please use the buttons above, or tap Cancel.', cancelKb('np:x'));
}

async function schedulePost(env, tg, u, chat, mid, d, when) {
  const targets = d.target === 'all'
    ? await all(env.DB, 'SELECT id FROM targets')
    : await all(env.DB, 'SELECT id FROM targets WHERE id = ?1', Number(d.target));
  if (!targets.length) {
    await setState(env.DB, u.tg_id, 'IDLE');
    return tg.view(chat, mid, '⚠️ No target found.', ik([panelRow]));
  }
  const ids = [];
  const now = Date.now();
  for (const x of targets) {
    const r = await run(env.DB,
      `INSERT INTO post_queue (target_id, from_chat_id, message_id, scheduled_for, status, created_at)
       VALUES (?1, ?2, ?3, ?4, 'pending', ?5)`, x.id, d.from_chat_id, d.message_id, when, now);
    ids.push(r.meta.last_row_id);
  }
  await setState(env.DB, u.tg_id, 'IDLE');
  const after = ik([[btn('✍️ Another post', 'np:start'), btn('🗓 Scheduled', 'ad:q')], panelRow]);
  if (when > now + 1000) {
    return tg.view(chat, mid, `✅ Scheduled ${ids.length} post(s) for ${fmt(when)}.`, after);
  }
  const res = (await runQueue(env)).filter((r) => ids.includes(r.id));
  const okN = res.filter((r) => r.ok).length;
  let text = `📣 Published to ${okN} of ${ids.length}.`;
  const bad = res.filter((r) => !r.ok).slice(0, 3).map((r) => `• ${r.title}: ${r.error}`);
  if (bad.length) text += '\n\n⚠️ Problems:\n' + bad.join('\n');
  if (res.length < ids.length) text += `\n⏳ ${ids.length - res.length} more will go out within a minute.`;
  return tg.view(chat, mid, text, after);
}

// Cron + "Now": claim each due row atomically, copy the original message, record the result.
export async function runQueue(env) {
  const tg = makeTg(env.BOT_TOKEN);
  const rows = await all(env.DB,
    `SELECT q.id, q.from_chat_id, q.message_id, t.tg_id AS chat, t.title
     FROM post_queue q JOIN targets t ON t.id = q.target_id
     WHERE q.status = 'pending' AND q.scheduled_for <= ?1
     ORDER BY q.scheduled_for LIMIT 25`, Date.now());
  const out = [];
  for (const r of rows) {
    const claim = await run(env.DB, "UPDATE post_queue SET status = 'sending' WHERE id = ?1 AND status = 'pending'", r.id);
    if (claim.meta.changes !== 1) continue;
    const res = await tg.copy(r.chat, r.from_chat_id, r.message_id);
    if (res.ok) {
      await run(env.DB, "UPDATE post_queue SET status = 'sent', error = NULL WHERE id = ?1", r.id);
      out.push({ id: r.id, ok: true, title: r.title });
    } else {
      const err = String(res.description || 'unknown error').slice(0, 200);
      await run(env.DB, "UPDATE post_queue SET status = 'failed', error = ?2 WHERE id = ?1", r.id, err);
      out.push({ id: r.id, ok: false, error: err, title: r.title });
    }
  }
  return out;
}

async function queueScreen(env, tg, chat, mid) {
  const rows = await all(env.DB,
    `SELECT q.id, q.scheduled_for, t.title FROM post_queue q
     JOIN targets t ON t.id = q.target_id
     WHERE q.status = 'pending' ORDER BY q.scheduled_for LIMIT 10`);
  const text = '🗓 Scheduled posts\n\n' +
    (rows.length ? rows.map((r) => `#${r.id} → ${clip(r.title, 30)} · ${fmt(r.scheduled_for)}`).join('\n') : 'Nothing is scheduled.');
  const kb = [];
  for (let i = 0; i < rows.length; i += 2) {
    kb.push(rows.slice(i, i + 2).map((r) => btn(`❌ Cancel #${r.id}`, 'ad:qx:' + r.id)));
  }
  kb.push([btn('✍️ New post', 'np:start')]);
  kb.push([btn('⬅️ Back', 'ad:home')]);
  return tg.view(chat, mid, text, ik(kb));
}

// ---------- admin replies in the admin group -> customer ----------
export async function relayToUser(env, tg, m) {
  const s = await one(env.DB, 'SELECT user_id FROM support_sessions WHERE admin_msg_id = ?1', m.reply_to_message.message_id);
  if (!s) return;
  const r = await tg.copy(s.user_id, m.chat.id, m.message_id);
  if (!r.ok) {
    return tg.send(m.chat.id, `⚠️ Could not deliver: ${r.description || 'unknown error'}`,
      { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } });
  }
  await tg.react(m.chat.id, m.message_id, '👍');
}

// ---------- optional command shortcuts ----------
export async function onAdminCommand(env, tg, u, m, c, inGroup) {
  const chat = m.chat.id;
  const priv = !inGroup;
  switch (c.cmd) {
    case 'help': case 'commands':
      await helpScreen(env, tg, chat, null, priv); return true;
    case 'panel': case 'admin':
      if (priv) await sendPanel(env, tg, chat, null);
      else await helpScreen(env, tg, chat, null, false);
      return true;
    case 'stats':
      await statsScreen(env, tg, chat, null, priv); return true;
    case 'newpost':
      if (!priv) await tg.send(chat, 'Open the bot in a private chat to create posts.');
      else await startPost(env, tg, u, chat, null);
      return true;
    case 'schedule':
      if (!priv) await tg.send(chat, 'Open the bot in a private chat to see scheduled posts.');
      else await queueScreen(env, tg, chat, null);
      return true;
    case 'ban': case 'unban': {
      let id = null;
      if (m.reply_to_message) {
        const s = await one(env.DB, 'SELECT user_id FROM support_sessions WHERE admin_msg_id = ?1', m.reply_to_message.message_id);
        if (s) id = s.user_id;
      }
      if (!id && /^\d{5,}$/.test(c.arg)) id = Number(c.arg);
      if (!id) {
        await tg.send(chat, `Reply to a ticket with /${c.cmd}, or send /${c.cmd} <id>.\nTip: the 🚫 Ban button under each ticket is faster.`);
        return true;
      }
      await tg.send(chat, await banUser(env, id, c.cmd === 'ban'));
      return true;
    }
  }
  return false;
}

// ---------- panel callbacks ----------
export async function onAdminCallback(env, tg, u, cq) {
  const chat = cq.message.chat.id;
  const mid = cq.message.message_id;
  const [, a, ...p] = cq.data.split(':');
  if (a === 'bn') return toggleBan(env, tg, cq, Number(p[0]));
  if (cq.message.chat.type !== 'private') return;
  // Tapping any panel button abandons a half-finished wizard (except the broadcast confirmation).
  if (a !== 'bcgo' && /^(AD_|NP_)/.test(u.state || '')) {
    await setState(env.DB, u.tg_id, 'IDLE');
    u.state = 'IDLE';
    u.state_data = null;
  }
  const ask = async (data, text, cancelTo) => {
    await setState(env.DB, u.tg_id, 'AD_IN', { ...data, back: cancelTo });
    return tg.view(chat, mid, text, cancelKb(cancelTo));
  };
  const k = p[0];
  switch (a) {
    case 'home': return sendPanel(env, tg, chat, mid);
    case 'help': return helpScreen(env, tg, chat, mid, true);
    case 's': return statsScreen(env, tg, chat, mid, true);
    case 'pv':
      await sendMain(env, tg, u, chat, false);
      return tg.send(chat, '👆 This is what customers see.', ik([panelRow]));

    // --- menu / topic editor ---
    case 'tr': return treeList(env, tg, chat, mid, k, p[1]);
    case 'it': return itemScreen(env, tg, chat, mid, k, p[1]);
    case 'add': {
      const c = K[k];
      if (!c) return;
      const rows = c.types.map(([ty, lab]) => [btn(lab, `ad:ty:${k}:${p[1]}:${ty}`)]);
      rows.push([btn('⬅️ Back', `ad:tr:${k}:${p[1]}`)]);
      return tg.view(chat, mid, '➕ Add item\n\nChoose its type:', ik(rows));
    }
    case 'ty': {
      const c = K[k];
      if (!c || !c.types.some(([x]) => x === p[2])) return;
      return ask({ w: 'add', k, parent: Number(p[1]) || 0, type: p[2], step: 'label' },
        `Send the ${c.labName} (max ${MAXLAB} characters).`, `ad:tr:${k}:${p[1]}`);
    }
    case 'ed': {
      const c = K[k];
      const it = c && await getItem(env.DB, c.table, p[2]);
      if (!it) return;
      const text = p[1] === 'l' ? `Send the new ${c.labName} (max ${MAXLAB} characters).` : c.needVal[it[c.typ]];
      if (!text) return;
      return ask({ w: 'edit', k, f: p[1], id: it.id }, text, `ad:it:${k}:${it.id}`);
    }
    case 'mv':
      if (!K[k]) return;
      await moveItem(env, k, p[1], p[2]);
      return itemScreen(env, tg, chat, mid, k, p[1]);
    case 'rm': {
      const c = K[k];
      const it = c && await getItem(env.DB, c.table, p[1]);
      if (!it) return;
      return tg.view(chat, mid, `🗑 Delete "${clip(it[c.lab], 40)}"?\nEverything inside it is deleted too.`,
        ik([[btn('✅ Yes, delete', `ad:rmy:${k}:${it.id}`), btn('❌ No', `ad:it:${k}:${it.id}`)]]));
    }
    case 'rmy': {
      const c = K[k];
      const it = c && await getItem(env.DB, c.table, p[1]);
      if (!it) return;
      await delTree(env.DB, c.table, it.id);
      return treeList(env, tg, chat, mid, k, it.parent_id || 0);
    }
    case 'imp': {
      const c = K[k];
      if (!c) return;
      return ask({ w: 'imp', k, parent: Number(p[1]) || 0 },
        `📥 Import JSON\n\nPaste a JSON list. New items are added at the end. Example:\n\n${c.example}`, `ad:tr:${k}:${p[1]}`);
    }

    // --- welcome / mini app ---
    case 'w': {
      const w = (await getSetting(env.DB, 'welcome')) || '(empty)';
      return tg.view(chat, mid, `👋 Welcome text\n\n${clip(w, 1500)}`,
        ik([[btn('✏️ Change text', 'ad:wl')], [btn('⬅️ Back', 'ad:home')]]));
    }
    case 'wl': return ask({ w: 'welcome' }, 'Send the new welcome text.', 'ad:w');
    case 'ma': {
      const url = await getSetting(env.DB, 'miniapp');
      return tg.view(chat, mid, `📱 Mini App\n\nCurrent: ${url || 'off'}\n\nWhen set, /menu opens it for customers.`,
        ik([[btn('✏️ Set link', 'ad:mw'), btn('🚫 Turn off', 'ad:mwo')], [btn('⬅️ Back', 'ad:home')]]));
    }
    case 'mw': return ask({ w: 'miniapp' }, 'Send the Mini App link (https://...).', 'ad:ma');
    case 'mwo':
      await setSetting(env.DB, 'miniapp', '');
      return tg.view(chat, mid, '📱 Mini App turned off.', ik([[btn('⬅️ Back', 'ad:ma')]]));

    // --- scheduled posts ---
    case 'q': return queueScreen(env, tg, chat, mid);
    case 'qx':
      await run(env.DB, "UPDATE post_queue SET status = 'cancelled' WHERE id = ?1 AND status = 'pending'", Number(k));
      return queueScreen(env, tg, chat, mid);

    // --- channels ---
    case 'c': return channelsScreen(env, tg, chat, mid);
    case 'ca':
      return ask({ w: 'channel' },
        '📣 Add a channel or group\n\n1. Add this bot as an admin there (channels: with permission to post).\n2. Send the @username, the numeric ID, or forward any message from it.',
        'ad:c');
    case 'cd':
      await run(env.DB, "UPDATE post_queue SET status = 'cancelled' WHERE target_id = ?1 AND status = 'pending'", Number(k));
      await run(env.DB, 'DELETE FROM targets WHERE id = ?1', Number(k));
      return channelsScreen(env, tg, chat, mid);

    // --- team (owner only) ---
    case 'a': return teamScreen(env, tg, u, chat, mid);
    case 'aa':
      if (!isOwner(u)) return;
      return ask({ w: 'admin' },
        '👥 Add an admin\n\nForward any message from that person, or send their numeric Telegram ID.\nThey must have started this bot.', 'ad:a');
    case 'ar': {
      if (!isOwner(u)) return;
      const id = Number(k);
      await run(env.DB, "UPDATE users SET role = 'user' WHERE tg_id = ?1 AND role = 'admin'", id);
      await syncCommands(env, tg, id, false);
      return teamScreen(env, tg, u, chat, mid);
    }

    // --- bans ---
    case 'b': return banScreen(env, tg, chat, mid);
    case 'ba':
      return ask({ w: 'ban' }, '🚫 Ban a user\n\nForward one of their messages (or a ticket header), or send their numeric ID.', 'ad:b');
    case 'ub':
      await banUser(env, Number(k), false);
      return banScreen(env, tg, chat, mid);

    // --- broadcast ---
    case 'bc': {
      const n = await one(env.DB, 'SELECT COUNT(*) AS n FROM users WHERE banned = 0 AND tg_id != ?1', u.tg_id);
      return ask({ w: 'bc' }, `📢 Broadcast\n\nSend the message to deliver to ${n.n} users (text, photo, video... anything).`, 'ad:home');
    }
    case 'bcgo': {
      if (u.state !== 'AD_BC') return tg.view(chat, mid, '⌛ Nothing to send.', ik([panelRow]));
      const d = parse(u.state_data);
      await setState(env.DB, u.tg_id, 'IDLE');
      await tg.view(chat, mid, '📢 Sending… please wait.');
      const users = await all(env.DB, 'SELECT tg_id FROM users WHERE banned = 0 AND tg_id != ?1', u.tg_id);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let ok = 0, fail = 0, note = '';
      try {
        for (const x of users) {
          const r = await tg.copy(x.tg_id, d.from_chat_id, d.message_id);
          if (r.ok) ok++; else fail++;
          if (r.error_code === 429) await sleep(((r.parameters && r.parameters.retry_after) || 1) * 1000);
          await sleep(50);
        }
      } catch (e) {
        note = '\n⚠️ Stopped early (platform limit). Send again later for the rest.';
      }
      return tg.view(chat, mid, `📢 Done.\n✅ Delivered: ${ok}\n❌ Failed: ${fail}${note}`, ik([panelRow]));
    }
  }
}

// ---------- wizard text input (private chat only) ----------
export async function onWizardInput(env, tg, u, m) {
  const chat = m.chat.id;
  const d = parse(u.state_data);
  if (u.state.startsWith('NP_')) return onPostInput(env, tg, u, m, d);
  if (u.state === 'AD_BC') return tg.send(chat, 'Use the buttons above to send or cancel.');

  const text = (m.text || '').trim();
  const retry = (msg) => tg.send(chat, msg, cancelKb(d.back || 'ad:home'));
  const done = () => setState(env.DB, u.tg_id, 'IDLE');

  switch (d.w) {
    case 'add': {
      const c = K[d.k];
      if (!text) return retry('Please send text.');
      if (d.step === 'label') {
        if (text.length > MAXLAB) return retry(`⚠️ Too long (${text.length}/${MAXLAB}). Send something shorter.`);
        const need = c.needVal[d.type];
        if (need) {
          await setState(env.DB, u.tg_id, 'AD_IN', { ...d, step: 'value', label: text });
          return tg.send(chat, need, cancelKb(d.back));
        }
        return finishAdd(env, tg, u, chat, d, text, null);
      }
      const err = checkVal(d.type, text);
      if (err) return retry(err);
      return finishAdd(env, tg, u, chat, d, d.label, text);
    }
    case 'edit': {
      const c = K[d.k];
      const it = await getItem(env.DB, c.table, d.id);
      if (!it) { await done(); return sendPanel(env, tg, chat, null); }
      if (!text) return retry('Please send text.');
      if (d.f === 'l') {
        if (text.length > MAXLAB) return retry(`⚠️ Too long (${text.length}/${MAXLAB}).`);
        await run(env.DB, `UPDATE ${c.table} SET ${c.lab} = ?1 WHERE id = ?2`, text, it.id);
      } else {
        const err = checkVal(it[c.typ], text);
        if (err) return retry(err);
        await run(env.DB, `UPDATE ${c.table} SET ${c.val} = ?1 WHERE id = ?2`, text, it.id);
      }
      await done();
      await tg.send(chat, '✅ Updated.');
      return itemScreen(env, tg, chat, null, d.k, it.id);
    }
    case 'welcome': {
      if (!text) return retry('Please send text.');
      if (text.length > 3500) return retry('⚠️ Too long (max 3500 characters).');
      await setSetting(env.DB, 'welcome', text);
      await done();
      return tg.send(chat, '✅ Welcome text saved. Customers see it after /start.', ik([[btn('👁 Preview', 'ad:pv')], panelRow]));
    }
    case 'miniapp': {
      if (text.toLowerCase() === 'off') {
        await setSetting(env.DB, 'miniapp', '');
        await done();
        return tg.send(chat, '📱 Mini App turned off.', ik([panelRow]));
      }
      if (!/^https:\/\/\S+$/i.test(text)) return retry('⚠️ Send an https:// link, or "off".');
      await setSetting(env.DB, 'miniapp', text);
      await done();
      return tg.send(chat, '✅ Mini App link saved.', ik([panelRow]));
    }
    case 'channel': return addChannel(env, tg, u, m, text, retry, done);
    case 'admin': {
      if (!isOwner(u)) { await done(); return; }
      const id = userIdFrom(m);
      if (!id) return retry("⚠️ I couldn't read an ID. Forward a message from them or send the number. (If they hide their account, ask them for their ID.)");
      await run(env.DB,
        `INSERT INTO users (tg_id, role) VALUES (?1, 'admin')
         ON CONFLICT(tg_id) DO UPDATE SET role = CASE WHEN users.role = 'owner' THEN 'owner' ELSE 'admin' END, banned = 0`, id);
      await syncCommands(env, tg, id, true);
      await done();
      return tg.send(chat, `✅ ${id} is now an admin.`, ik([[btn('👥 Team', 'ad:a')], panelRow]));
    }
    case 'ban': {
      const id = userIdFrom(m);
      if (!id) return retry("⚠️ I couldn't read an ID. Forward one of their messages, or send the number.");
      const msg = await banUser(env, id, true);
      await done();
      return tg.send(chat, msg, ik([[btn('🚫 Banned list', 'ad:b')], panelRow]));
    }
    case 'bc': {
      const n = await one(env.DB, 'SELECT COUNT(*) AS n FROM users WHERE banned = 0 AND tg_id != ?1', u.tg_id);
      await setState(env.DB, u.tg_id, 'AD_BC', { from_chat_id: chat, message_id: m.message_id });
      return tg.send(chat, `📢 Ready to send the message above to ${n.n} users.\nSend it now?`,
        ik([[btn('✅ Send now', 'ad:bcgo'), btn('❌ Cancel', 'ad:home')]]));
    }
    case 'imp': {
      if (!text) return retry('Please send the JSON as text.');
      let data;
      try {
        data = JSON.parse(text.replace(/```(?:json)?/gi, '').replace(/[“”]/g, '"'));
      } catch (e) {
        return retry('⚠️ That is not valid JSON: ' + String(e.message).slice(0, 100));
      }
      if (data && !Array.isArray(data) && typeof data === 'object') data = [data];
      const counter = { n: 0 };
      const err = checkNodes(d.k, data, 0, counter);
      if (err) return retry('⚠️ ' + err);
      await insertNodes(env.DB, d.k, data, d.parent);
      await done();
      await tg.send(chat, `✅ Imported ${counter.n} item(s).`);
      return treeList(env, tg, chat, null, d.k, d.parent);
    }
  }
  await done();
  return sendPanel(env, tg, chat, null);
}

async function finishAdd(env, tg, u, chat, d, label, val) {
  const c = K[d.k];
  const pos = await nextPos(env.DB, c.table, d.parent);
  await run(env.DB,
    `INSERT INTO ${c.table} (parent_id, ${c.lab}, ${c.typ}, ${c.val}, position) VALUES (?1, ?2, ?3, ?4, ?5)`,
    d.parent || null, label, d.type, val, pos);
  await setState(env.DB, u.tg_id, 'IDLE');
  await tg.send(chat, `✅ Added: ${label}`);
  return treeList(env, tg, chat, null, d.k, d.parent);
}

async function addChannel(env, tg, u, m, text, retry, done) {
  const fo = m.forward_origin;
  let ref = (m.forward_from_chat && m.forward_from_chat.id) ?? (fo && fo.chat && fo.chat.id) ?? (fo && fo.sender_chat && fo.sender_chat.id) ?? null;
  if (ref == null) {
    const s = text.replace(/^https?:\/\/t\.me\//i, '');
    if (/^-?\d{5,}$/.test(s)) ref = Number(s);
    else if (/^@?[A-Za-z][A-Za-z0-9_]{4,}$/.test(s)) ref = '@' + s.replace(/^@/, '');
  }
  if (ref == null) return retry('⚠️ Send an @username, a numeric ID, or forward a message from the channel.');
  const r = await tg.call('getChat', { chat_id: ref });
  if (!r.ok) return retry(`⚠️ I can't see that chat (${r.description || 'unknown error'}). Add the bot as an admin there, then try again.`);
  const ch = r.result;
  const type = ch.type === 'channel' ? 'channel' : (ch.type === 'group' || ch.type === 'supergroup') ? 'group' : 'page';
  const botId = Number(String(env.BOT_TOKEN).split(':')[0]);
  const mem = await tg.call('getChatMember', { chat_id: ch.id, user_id: botId });
  if (type === 'channel' && mem.ok) {
    const st = mem.result.status;
    if (!(st === 'creator' || (st === 'administrator' && mem.result.can_post_messages !== false))) {
      return retry('⚠️ Make the bot an admin of that channel with permission to post messages, then try again.');
    }
  }
  await run(env.DB,
    'INSERT INTO targets (tg_id, title, type) VALUES (?1, ?2, ?3) ON CONFLICT(tg_id) DO UPDATE SET title = excluded.title, type = excluded.type',
    ch.id, ch.title || ch.username || String(ch.id), type);
  await done();
  return tg.send(m.chat.id, `✅ Added: ${ch.title || ch.username}`, ik([[btn('✍️ New post', 'np:start'), btn('📣 Channels', 'ad:c')], panelRow]));
}
