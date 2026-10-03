// src/user.js - everything a customer sees: menus, help center, live support, language.
import { btn, link, ik } from './tg.js';
import { one, run, setState, getSetting, kids, getItem, isAdmin } from './db.js';

// Built-in UI strings (menu/topic/welcome content is whatever the admin typed).
const S = {
  en: {
    hint: "I didn't understand that. Use the menu below, or tap Live support to talk to our team.",
    live: '🎧 Live support',
    liveStart: "🎧 You're now connected to live support.\nSend your message (text, photo, voice, video or file) and our team will reply here.\n\nTap Cancel to leave.",
    cancel: '❌ Cancel',
    liveOff: '✅ Live support closed. Send /start any time to return to the menu.',
    unavailable: '⚠️ Support is unavailable right now. Please try again later.',
    back: '⬅️ Back',
    helpTitle: '📚 Help center\nChoose a topic:',
    noTopics: 'No help topics yet.',
    chooseLang: '🌐 Choose your language:',
    langSet: '✅ Language updated: English',
    closed: '✅ Cancelled.',
    openMenu: '📱 Open menu',
    miniappMsg: 'Tap below to open the menu:',
  },
  ar: {
    hint: 'لم أفهم رسالتك. استخدم القائمة أدناه أو اضغط «الدعم المباشر» للتحدث مع فريقنا.',
    live: '🎧 الدعم المباشر',
    liveStart: '🎧 أنت الآن متصل بالدعم المباشر.\nأرسل رسالتك (نص أو صورة أو رسالة صوتية أو فيديو أو ملف) وسيرد عليك فريقنا هنا.\n\nاضغط «إلغاء» للخروج.',
    cancel: '❌ إلغاء',
    liveOff: '✅ تم إغلاق الدعم المباشر. أرسل /start للعودة إلى القائمة.',
    unavailable: '⚠️ الدعم غير متاح حاليًا. يرجى المحاولة لاحقًا.',
    back: '⬅️ رجوع',
    helpTitle: '📚 مركز المساعدة\nاختر موضوعًا:',
    noTopics: 'لا توجد مواضيع مساعدة بعد.',
    chooseLang: '🌐 اختر لغتك:',
    langSet: '✅ تم تحديث اللغة: العربية',
    closed: '✅ تم الإلغاء.',
    openMenu: '📱 فتح القائمة',
    miniappMsg: 'اضغط بالأسفل لفتح القائمة:',
  },
  fr: {
    hint: "Je n'ai pas compris. Utilisez le menu ci-dessous ou touchez « Support en direct » pour parler à notre équipe.",
    live: '🎧 Support en direct',
    liveStart: 'Vous êtes connecté au support en direct. 🎧\nEnvoyez votre message (texte, photo, vocal, vidéo ou fichier) et notre équipe vous répondra ici.\n\nAppuyez sur Annuler pour quitter.',
    cancel: '❌ Annuler',
    liveOff: '✅ Support en direct fermé. Envoyez /start pour revenir au menu.',
    unavailable: '⚠️ Le support est indisponible pour le moment. Réessayez plus tard.',
    back: '⬅️ Retour',
    helpTitle: "📚 Centre d'aide\nChoisissez un sujet :",
    noTopics: "Aucun sujet d'aide pour le moment.",
    chooseLang: '🌐 Choisissez votre langue :',
    langSet: '✅ Langue mise à jour : Français',
    closed: '✅ Annulé.',
    openMenu: '📱 Ouvrir le menu',
    miniappMsg: 'Touchez ci-dessous pour ouvrir le menu :',
  },
};
export const t = (u, k) => (S[u?.lang] && S[u.lang][k]) || S.en[k];

// ---------- start / main keyboard ----------
async function mainKeyboard(env) {
  const items = await kids(env.DB, 'bot_menus', null);
  if (!items.length) return { remove_keyboard: true };
  const rows = [];
  for (let i = 0; i < items.length; i += 2) {
    rows.push(items.slice(i, i + 2).map((x) => ({ text: x.button_text })));
  }
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

export async function sendMain(env, tg, u, chat, showAdmin = true) {
  const welcome = (await getSetting(env.DB, 'welcome')) || '👋 Welcome!';
  await tg.send(chat, welcome, { reply_markup: await mainKeyboard(env) });
  if (showAdmin && isAdmin(u)) {
    await tg.send(chat, '⚙️ Admin tools', ik([[btn('⚙️ Open admin panel', 'ad:home')]]));
  }
}

export async function onStart(env, tg, u, chat, payload) {
  if (payload === 'live') return startLive(env, tg, u, chat);
  const m = /^([at])(\d+)$/.exec(payload || '');
  if (m) {
    const id = Number(m[2]);
    return m[1] === 'a' ? showAnswer(env, tg, u, chat, id, null) : showTopics(env, tg, u, chat, id, null);
  }
  return sendMain(env, tg, u, chat);
}

export async function onUserCommand(env, tg, u, m, c) {
  const chat = m.chat.id;
  if (c.cmd === 'service') return showTopics(env, tg, u, chat, 0, null);
  if (c.cmd === 'botlang') {
    return tg.send(chat, t(u, 'chooseLang'),
      ik([[btn('English', 'lang:en'), btn('العربية', 'lang:ar'), btn('Français', 'lang:fr')]]));
  }
  if (c.cmd === 'menu') {
    const url = await getSetting(env.DB, 'miniapp');
    if (url) {
      return tg.send(chat, t(u, 'miniappMsg'),
        { reply_markup: { inline_keyboard: [[{ text: t(u, 'openMenu'), web_app: { url } }]] } });
    }
    return sendMain(env, tg, u, chat);
  }
}

// ---------- reply-keyboard + inline menu actions ----------
export async function onButton(env, tg, u, m) {
  const item = await one(env.DB, 'SELECT * FROM bot_menus WHERE parent_id IS NULL AND button_text = ?1', m.text);
  if (!item) return false;
  await runMenuItem(env, tg, u, m.chat.id, item, null);
  return true;
}

async function runMenuItem(env, tg, u, chat, item, editId) {
  switch (item.action_type) {
    case 'text': return tg.send(chat, item.action_value || '…');
    case 'url': return tg.send(chat, item.button_text, ik([[link(item.button_text, item.action_value)]]));
    case 'topics': return showTopics(env, tg, u, chat, 0, null);
    case 'live': return startLive(env, tg, u, chat);
    case 'sub': return showSub(env, tg, u, chat, item, editId);
  }
}

async function showSub(env, tg, u, chat, item, editId) {
  const ch = await kids(env.DB, 'bot_menus', item.id);
  const rows = ch.map((c) => [c.action_type === 'url' ? link(c.button_text, c.action_value) : btn(c.button_text, 'bm:' + c.id)]);
  if (item.parent_id) rows.push([btn(t(u, 'back'), 'bm:' + item.parent_id)]);
  const text = ch.length ? item.button_text : item.button_text + '\n—';
  return tg.view(chat, editId, text, rows.length ? ik(rows) : {});
}

// ---------- help center ----------
export async function showTopics(env, tg, u, chat, parentId, msgId) {
  let parent = null;
  if (parentId) {
    parent = await getItem(env.DB, 'support_topics', parentId);
    if (!parent) parentId = 0;
  }
  const ch = await kids(env.DB, 'support_topics', parentId);
  const rows = ch.map((c) => {
    if (c.content_type === 'link') return [link(c.title, c.payload)];
    if (c.content_type === 'category') return [btn(c.title, 't:' + c.id)];
    if (c.content_type === 'answer') return [btn(c.title, 'a:' + c.id)];
    return [btn(c.title, 'l:on')]; // live
  });
  if (parent) rows.push([btn(t(u, 'back'), 't:' + (parent.parent_id || 0))]);
  let text = parent ? parent.title + (parent.payload ? '\n\n' + parent.payload : '') : t(u, 'helpTitle');
  if (!ch.length) text += '\n\n' + t(u, 'noTopics');
  return tg.view(chat, msgId, text, rows.length ? ik(rows) : {});
}

async function showAnswer(env, tg, u, chat, id, msgId) {
  const a = await getItem(env.DB, 'support_topics', id);
  if (!a) return;
  return tg.view(chat, msgId, a.title + '\n\n' + (a.payload || ''),
    ik([[btn(t(u, 'back'), 't:' + (a.parent_id || 0))]]));
}

// ---------- live support ----------
export async function startLive(env, tg, u, chat) {
  await setState(env.DB, u.tg_id, 'LIVE');
  return tg.send(chat, t(u, 'liveStart'), ik([[btn(t(u, 'cancel'), 'l:off')]]));
}

// Customer -> admin group: a header (name/@user/ID + Ban button) and a copy of the message.
export async function relayToAdmin(env, tg, u, m) {
  const adminChat = env.ADMIN_CHAT_ID;
  const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || 'User';
  const header = `👤 ${name}${u.username ? ' (@' + u.username + ')' : ''}\n🆔 ${u.tg_id}`;
  const h = await tg.send(adminChat, header, ik([[btn('🚫 Ban', 'ad:bn:' + u.tg_id)]]));
  if (!h.ok) return tg.send(m.chat.id, t(u, 'unavailable'));
  const hid = h.result.message_id;
  const c = await tg.copy(adminChat, m.chat.id, m.message_id,
    { reply_parameters: { message_id: hid, allow_sending_without_reply: true } });
  const now = Date.now();
  await run(env.DB, 'INSERT OR REPLACE INTO support_sessions (admin_msg_id, user_id, created_at) VALUES (?1, ?2, ?3)', hid, u.tg_id, now);
  if (!c.ok) return tg.send(m.chat.id, t(u, 'unavailable'));
  await run(env.DB, 'INSERT OR REPLACE INTO support_sessions (admin_msg_id, user_id, created_at) VALUES (?1, ?2, ?3)', c.result.message_id, u.tg_id, now);
  const r = await tg.react(m.chat.id, m.message_id, '👍');
  if (!r.ok) await tg.send(m.chat.id, '✅');
}

// ---------- callbacks ----------
export async function onUserCallback(env, tg, u, cq) {
  const d = cq.data || '';
  const chat = cq.message.chat.id;
  const mid = cq.message.message_id;
  if (d.startsWith('t:')) return showTopics(env, tg, u, chat, Number(d.slice(2)) || 0, mid);
  if (d.startsWith('a:')) return showAnswer(env, tg, u, chat, Number(d.slice(2)), mid);
  if (d.startsWith('bm:')) {
    const item = await getItem(env.DB, 'bot_menus', Number(d.slice(3)));
    if (item) await runMenuItem(env, tg, u, chat, item, mid);
    return;
  }
  if (d === 'l:on') return startLive(env, tg, u, chat);
  if (d === 'l:off') {
    await setState(env.DB, u.tg_id, 'IDLE');
    return tg.view(chat, mid, t(u, 'liveOff'));
  }
  if (d.startsWith('lang:')) {
    const lang = d.slice(5);
    if (!S[lang]) return;
    await run(env.DB, 'UPDATE users SET lang = ?1 WHERE tg_id = ?2', lang, u.tg_id);
    return tg.view(chat, mid, S[lang].langSet);
  }
}
