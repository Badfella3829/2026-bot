# 🎬 𝗥𝗼𝘀𝗲 𝗠𝗼𝘃𝗶𝗲 𝗕𝗼𝘁

A production-ready Telegram bot for movie downloads with GPlinks verification, credit system, premium membership, and admin controls.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## ✨ 𝗙𝗲𝗮𝘁𝘂𝗿𝗲𝘀

| Feature | Description |
|---------|-------------|
| 🔍 **Smart Search** | Fuzzy movie search - even misspelled names work |
| 💰 **Credit System** | 2 credits per 12h verification, 1 credit per movie |
| 👑 **Premium Access** | Instant access without verification |
| 👥 **Referral Program** | Earn 1 credit per referral |
| 📢 **Force Subscribe** | Require channel joins before access |
| 🚫 **Ban Management** | Ban/unban users |
| 📊 **Analytics** | User stats and bot statistics |
| 🌐 **Group Support** | Works in groups with @mention or inline mode |

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 📱 𝗨𝘀𝗲𝗿 𝗖𝗼𝗺𝗺𝗮𝗻𝗱𝘀

| Command | Description |
|---------|-------------|
| `/start` | Main menu with inline keyboard |
| `/search <name>` | Search movies |
| `/credits` | Check credit balance |
| `/earncredits` | Earn credits via verification |
| `/library` | View unlocked movies |
| `/profile` | View user stats |
| `/refer` | Get referral link |
| `/request <movie>` | Request a movie |
| `/myrequests` | View your requests |
| `/help` | Help & support |

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 🔧 𝗔𝗱𝗺𝗶𝗻 𝗖𝗼𝗺𝗺𝗮𝗻𝗱𝘀

| Command | Description |
|---------|-------------|
| `/addfiles` | Start adding a movie |
| `/end` | Save movie |
| `/list` | List all movies |
| `/delete <movie>` | Delete movie |
| `/stats` | Bot statistics |
| `/requests` | View pending requests |
| `/approvereq <id>` | Approve request |
| `/rejectreq <id>` | Reject request |
| `/ban <user_id>` | Ban user |
| `/unban <user_id>` | Unban user |
| `/banned` | List banned users |
| `/broadcast` | Send message to all users |
| `/premium <id> <days>` | Grant premium |
| `/rmpremium <id>` | Remove premium |
| `/addadmin <id>` | Add admin |
| `/admins` | List admins |
| `/forsub <url>` | Add force subscribe channel |
| `/unforsub <url>` | Remove force subscribe |
| `/addtokens <token>` | Add GPlinks token |
| `/showtokens` | Show tokens |
| `/howto <text>` | Set instructions |
| `/myswitch` | Toggle bot on/off |

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## ⚙️ 𝗘𝗻𝘃𝗶𝗿𝗼𝗻𝗺𝗲𝗻𝘁 𝗩𝗮𝗿𝗶𝗮𝗯𝗹𝗲𝘀

| Variable | Description | Required |
|----------|-------------|----------|
| `BOT_TOKEN` | Telegram Bot Token from @BotFather | ✅ Yes |
| `ADMIN_IDS` | Comma-separated admin Telegram IDs | ✅ Yes |
| `DATABASE_URL` | PostgreSQL connection string | ✅ Yes |
| `WEBHOOK_DOMAIN` | Your deployed app URL | 🔄 Production |
| `NODE_ENV` | Set to `production` for deployment | 🔄 Production |
| `PORT` | Port for webhook server (default: 5000) | 🔄 Auto |

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 🚀 𝗗𝗲𝗽𝗹𝗼𝘆𝗺𝗲𝗻𝘁

### Replit (Recommended)

1. Set environment variables in Secrets
2. Click **"Publish"** to deploy
3. Use **Reserved VM** deployment (not Autoscale) for 24/7 uptime
4. Bot runs automatically via webhooks

### Heroku / Render / Railway

1. **Create App**
```bash
heroku create your-movie-bot
```

2. **Add PostgreSQL**
```bash
heroku addons:create heroku-postgresql:essential-0
```

3. **Set Environment Variables**
```bash
heroku config:set BOT_TOKEN=your_telegram_bot_token
heroku config:set ADMIN_IDS=123456789,987654321
heroku config:set WEBHOOK_DOMAIN=https://your-movie-bot.herokuapp.com
heroku config:set NODE_ENV=production
```

4. **Deploy**
```bash
git push heroku main
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 💻 𝗟𝗼𝗰𝗮𝗹 𝗗𝗲𝘃𝗲𝗹𝗼𝗽𝗺𝗲𝗻𝘁

```bash
# 1. Set environment variables
export BOT_TOKEN=your_bot_token
export ADMIN_IDS=your_telegram_id
export DATABASE_URL=postgresql://...

# 2. Install dependencies
npm install

# 3. Push database schema
npm run db:push

# 4. Start the bot
npm run dev
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 💰 𝗖𝗿𝗲𝗱𝗶𝘁 𝗦𝘆𝘀𝘁𝗲𝗺

| Action | Credits |
|--------|---------|
| GPlinks verification | +2 credits |
| Movie download | -1 credit |
| Referral bonus | +1 credit per friend |
| Premium users | Unlimited (no credits needed) |
| Cooldown | 12 hours between earning |

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 🛠️ 𝗧𝗲𝗰𝗵 𝗦𝘁𝗮𝗰𝗸

| Technology | Purpose |
|------------|---------|
| **Node.js** | Runtime |
| **grammY** | Telegram Bot Framework |
| **PostgreSQL** | Database |
| **Drizzle ORM** | Database queries |
| **Fuse.js** | Fuzzy search |
| **TypeScript** | Type safety |

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 📁 𝗣𝗿𝗼𝗷𝗲𝗰𝘁 𝗦𝘁𝗿𝘂𝗰𝘁𝘂𝗿𝗲

```
bot/
├── index.ts      # Main bot code
├── schema.ts     # Database schema
├── db.ts         # Database connection
└── README.md     # This file

drizzle.config.ts # Database config
package.json      # Dependencies
tsconfig.json     # TypeScript config
Procfile          # Heroku deployment
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 📋 𝗦𝗲𝘁𝘂𝗽 𝗖𝗵𝗲𝗰𝗸𝗹𝗶𝘀𝘁

- [ ] Create bot with @BotFather
- [ ] Enable inline mode in BotFather (placeholder: "🎬 Search movies...")
- [ ] Set `BOT_TOKEN` environment variable
- [ ] Set `ADMIN_IDS` environment variable
- [ ] Add GPlinks token via `/addtokens <token>`
- [ ] Add force subscribe channels via `/forsub <url>` (optional)
- [ ] Test with `/start` command

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 📜 𝗦𝗰𝗿𝗶𝗽𝘁𝘀

| Script | Description |
|--------|-------------|
| `npm run dev` | Development mode (polling) |
| `npm start` | Production mode (webhooks) |
| `npm run db:push` | Push database schema |

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 🔒 𝗦𝗲𝗰𝘂𝗿𝗶𝘁𝘆

- All sensitive data stored in environment variables
- GPlinks verification for credit earning
- Ban system to block abusive users
- Force subscribe to protect content
- Premium membership for trusted users

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Made with ❤️ for movie enthusiasts**
