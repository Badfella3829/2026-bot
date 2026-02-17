# Telegram Movie Bot

## Overview

A production-ready Telegram movie bot with GPlinks verification, credit system, referral program, and admin controls.

## Bot Features

### User Commands
- `/start` - Main menu with inline keyboard
- `/search <name>` - Fuzzy movie search
- `/library` - View unlocked movies
- `/credits` - Check credit balance
- `/earncredits` - Earn credits via GPlinks verification
- `/profile` - View user stats
- `/refer` - Get referral link
- `/request <movie>` - Request a movie
- `/myrequests` - View your requests
- `/help` - Help & support

### Admin Commands
- `/addfiles` - Start adding a movie
- `/end` - Save movie
- `/list` - List all movies
- `/delete <movie>` - Delete movie
- `/stats` - Bot statistics
- `/requests` - View pending requests
- `/approvereq <id>` - Approve request
- `/rejectreq <id>` - Reject request
- `/ban <user_id>` - Ban user
- `/unban <user_id>` - Unban user
- `/banned` - List banned users
- `/broadcast` - Send message to all users
- `/admin` - Manage admins
- `/forsub` - Force subscribe settings

## Project Structure

```
bot/
  index.ts     # Main bot code
  schema.ts    # Database schema
  db.ts        # Database connection
  README.md    # Bot documentation
drizzle.config.ts  # Database config
package.json       # Dependencies
tsconfig.json      # TypeScript config
```

## Environment Variables

Required:
- `BOT_TOKEN` - Telegram Bot Token from @BotFather
- `DATABASE_URL` - PostgreSQL connection string
- `ADMIN_IDS` - Comma-separated admin Telegram IDs

Production only:
- `WEBHOOK_DOMAIN` - Your deployed app URL (e.g., https://your-app.replit.app)
- `NODE_ENV` - Set to "production"

## Deployment

### Replit
1. Set environment variables in Secrets
2. Click "Publish" to deploy
3. Bot runs 24/7 via webhooks

### Heroku/Render
1. Set environment variables
2. Deploy with `npm start`
3. Ensure PORT is set (default: 5000)

## Scripts

- `npm run dev` - Development mode (polling)
- `npm start` - Production mode (webhooks)
- `npm run db:push` - Push database schema

## Database

Uses PostgreSQL with Drizzle ORM. Tables:
- `users` - User accounts and credits
- `movies` - Movie content
- `movie_assets` - Movie files/links
- `referrals` - Referral tracking
- `movie_requests` - User requests
- `shortener_tokens` - GPlinks API tokens
- `force_subscribe_rules` - Channel subscriptions
