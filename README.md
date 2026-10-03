# ControllerBot v1.1

Serverless Telegram bot (Cloudflare Workers + D1). Customers get a menu, help center and live support.
Admins manage **everything with inline buttons** from the `⚙️ Admin panel`. Commands are optional shortcuts, listed only in `/help`.

## What you need
- A Telegram account, a bot token from @BotFather
- Your numeric Telegram ID (ask @userinfobot) -> `OWNER_ID`
- A private Telegram group with the bot added; its ID (starts with `-100`) -> `ADMIN_CHAT_ID`
- A free Cloudflare account, Node.js 18+ on a computer

## Deploy
```bash
npm install
npx wrangler login
npx wrangler d1 create controller_bot_db        # copy database_id into wrangler.toml
# edit wrangler.toml: OWNER_ID, ADMIN_CHAT_ID, database_id
npm run db:init                                  # creates tables + starter content
npx wrangler secret put BOT_TOKEN
npx wrangler secret put SECRET                   # letters, numbers, _ and - only
npm run deploy
```
Then open once in a browser: `https://<your-worker>.workers.dev/setup?key=<SECRET>` (registers the webhook and "/" menus; `ok: true` expected).

## Use it (all on your phone)
1. Send `/start` to the bot. As owner you get an **Open admin panel** button.
2. **Main menu / Help center**: tap items to edit, move ⬆️⬇️, delete, or **➕ Add** (pick a type, answer the prompts). **📥 Import JSON** adds many items at once.
3. **Channels**: add the bot as admin of your channel, then `📣 Channels > Add` (username, ID, or forward a message).
4. **New post**: send content, pick a channel, pick Now / +1h / +6h / +24h or type a UTC time.
5. **Live support**: customer messages arrive in the admin group. Reply to a ticket to answer. Tap **🚫 Ban** under a ticket to block.
6. **Team** (owner only): add admins by forwarding their message or sending their ID.

Optional shortcuts (also shown in `/help`): `/panel /newpost /schedule /stats /ban /unban /cancel`.

## JSON import format
Menu: `[{"text":"Links","type":"sub","children":[{"text":"Site","type":"url","value":"https://example.com"}]}]` (types: text, url, topics, live, sub)
Help: `[{"title":"Orders","type":"category","children":[{"title":"Track","type":"answer","value":"..."}]}]` (types: category, answer, link, live)

## Notes
- Times are UTC. Menu content is single-language; built-in UI strings are English/Arabic/French.
- Free-plan Workers limit large broadcasts; the bot stops cleanly and reports delivered count.
- Local dev: copy `.dev.vars.example` to `.dev.vars`, run `npm run db:init:local` and `npm run dev`.
