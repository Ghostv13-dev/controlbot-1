// src/index.js - Worker entry: webhook, /setup, cron, and the authoritative router (PRD 4.1).
import { makeTg, PUBLIC_COMMANDS, btn, ik } from './tg.js';
import { ensureUser, setState, isAdmin, all } from './db.js';
import { t, onStart, onUserCommand, onUserCallback, onButton, relayToAdmin } from './user.js';
import {
  sendPanel, onAdminCommand, onAdminCallback, onPostCallback,
  onWizardInput, relayToUser, runQueue, syncCommands,
} from './admin.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/webhook') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
      let update;
      try { update = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
      // Reply 200 immediately; do the work in the background so Telegram never retries.
      ctx.waitUntil(handle(update, env).catch((e) => console.error('update failed', e)));
      return new Response('ok');
    }
    if (url.pathname === '/setup' && request.method === 'GET') {
      if (url.searchParams.get('key') !== env.SECRET) return new Response('Forbidden', { status: 403 });
      return Response.json(await setup(env, url));
    }
    return new Response('ControllerBot is running.');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runQueue(env).catch((e) => console.error('cron failed', e)));
  },
};

async function setup(env, url) {
  const tg = makeTg(env.BOT_TOKEN);
  const webhook = await tg.call('setWebhook', {
    url: `${url.origin}/webhook`,
    secret_token: env.SECRET,
    allowed_updates: ['message', 'callback_query'],
  });
  const commands = await tg.call('setMyCommands', { commands: PUBLIC_COMMANDS });
  const ids = new Set([String(env.OWNER_ID)]);
  for (const r of await all(env.DB, "SELECT tg_id FROM users WHERE role IN ('owner','admin')")) ids.add(String(r.tg_id));
  const admins = {};
  for (const id of ids) admins[id] = (await syncCommands(env, tg, id, true)).ok;
  const group = (await syncCommands(env, tg, env.ADMIN_CHAT_ID, true)).ok;
  return { webhook, commands, admins, group };
}

async function handle(update, env) {
  const tg = makeTg(env.BOT_TOKEN);
  if (update.callback_query) return onCallback(env, tg, update.callback_query);
  if (update.message) return onMessage(env, tg, update.message);
}

function parseCmd(text) {
  if (!text || text[0] !== '/') return null;
  const m = text.match(/^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return m ? { cmd: m[1].toLowerCase(), arg: (m[2] || '').trim() } : null;
}

// ---------- callbacks ----------
async function onCallback(env, tg, cq) {
  if (!cq.message) return;
  const d = cq.data || '';
  const deferred = d.startsWith('ad:bn:'); // the ban toggle answers with a toast itself
  if (!deferred) await tg.answer(cq.id);
  const u = await ensureUser(env, cq.from);
  const adm = isAdmin(u);
  if (u.banned && !adm) return;
  if (d.startsWith('np:') || d.startsWith('ad:')) {
    if (!adm) { if (deferred) await tg.answer(cq.id); return; }
    return d.startsWith('np:') ? onPostCallback(env, tg, u, cq) : onAdminCallback(env, tg, u, cq);
  }
  return onUserCallback(env, tg, u, cq);
}

// ---------- messages ----------
async function onMessage(env, tg, m) {
  if (!m.from || m.from.is_bot) return;
  const isPrivate = m.chat.type === 'private';
  const inAdminGroup = String(m.chat.id) === String(env.ADMIN_CHAT_ID);
  if (!isPrivate && !inAdminGroup) return;

  let u = await ensureUser(env, m.from);
  const adm = isAdmin(u);
  if (u.banned && !adm) return;
  const c = parseCmd(m.text);

  // Admin group: only admins; commands, or replies to tickets.
  if (inAdminGroup) {
    if (!adm) return;
    if (c && (await onAdminCommand(env, tg, u, m, c, true))) return;
    if (!c && m.reply_to_message) await relayToUser(env, tg, m);
    return;
  }

  const chat = m.chat.id;
  // Any command abandons live mode or a wizard (D-8): nobody is ever trapped.
  if (c && u.state !== 'IDLE') {
    await setState(env.DB, u.tg_id, 'IDLE');
    u = { ...u, state: 'IDLE', state_data: null };
  }
  if (c) {
    if (c.cmd === 'cancel') return tg.send(chat, t(u, 'closed'));
    if (c.cmd === 'start') {
      if (c.arg === 'panel' && adm) return sendPanel(env, tg, chat, null);
      return onStart(env, tg, u, chat, c.arg);
    }
    if (c.cmd === 'service' || c.cmd === 'botlang' || c.cmd === 'menu') return onUserCommand(env, tg, u, m, c);
    if (adm && (await onAdminCommand(env, tg, u, m, c, false))) return;
  }

  // A demoted admin must not stay stuck inside a wizard.
  if (!adm && /^(AD_|NP_)/.test(u.state)) {
    await setState(env.DB, u.tg_id, 'IDLE');
    u = { ...u, state: 'IDLE', state_data: null };
  }
  if (adm && /^(AD_|NP_)/.test(u.state)) return onWizardInput(env, tg, u, m);
  if (u.state === 'LIVE') return relayToAdmin(env, tg, u, m);
  if (m.text && (await onButton(env, tg, u, m))) return;
  return tg.send(chat, t(u, 'hint'), ik([[btn(t(u, 'live'), 'l:on')]]));
}
