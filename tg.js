// src/tg.js - thin Telegram Bot API client + inline keyboard helpers.
// No parse_mode is ever sent (decision D-3): all text is plain, so
// underscores/asterisks in names or messages can never break a send.

export const PUBLIC_COMMANDS = [
  { command: 'start', description: 'Open the main menu' },
  { command: 'service', description: 'Help center' },
  { command: 'botlang', description: 'Change language' },
  { command: 'menu', description: 'Open the menu' },
  { command: 'cancel', description: 'Cancel the current action' },
];
// Admins see ONE extra command. Everything else lives in /help and the panel.
export const ADMIN_COMMANDS = [
  ...PUBLIC_COMMANDS,
  { command: 'help', description: 'Admin help and panel' },
];

export const btn = (text, data) => ({ text, callback_data: data });
export const link = (text, url) => ({ text, url });
export const ik = (rows) => ({ reply_markup: { inline_keyboard: rows } });

export function makeTg(token) {
  const clip = (s) => String(s ?? '').slice(0, 4096) || '…';

  async function call(method, params = {}) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
      const j = await res.json();
      if (!j.ok) console.log('tg', method, j.error_code, j.description);
      return j;
    } catch (e) {
      return { ok: false, description: String(e) };
    }
  }

  const api = {
    call,
    send: (chat, text, extra = {}) =>
      call('sendMessage', { chat_id: chat, text: clip(text), ...extra }),
    // Edit in place; "message is not modified" is ignored, other failures fall back to a new message.
    async edit(chat, id, text, extra = {}) {
      const r = await call('editMessageText', { chat_id: chat, message_id: id, text: clip(text), ...extra });
      if (!r.ok && !/not modified/i.test(r.description || '')) return api.send(chat, text, extra);
      return r;
    },
    view: (chat, mid, text, extra = {}) =>
      mid ? api.edit(chat, mid, text, extra) : api.send(chat, text, extra),
    answer: (id, text) =>
      call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }),
    copy: (to, from, mid, extra = {}) =>
      call('copyMessage', { chat_id: to, from_chat_id: from, message_id: mid, ...extra }),
    react: (chat, mid, emoji = '👍') =>
      call('setMessageReaction', { chat_id: chat, message_id: mid, reaction: [{ type: 'emoji', emoji }] }),
  };
  return api;
}
