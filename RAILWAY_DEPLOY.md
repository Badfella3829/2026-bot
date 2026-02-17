
# Railway App Guide for Rose Bot

## Quick Deploy Steps

1. **Install Railway CLI** (Optional but faster):
   `npm i -g @railway/cli`
   `railway login`

2. **Deploy**:
   Run this in your terminal:
   `railway up`

3. **Configure Variables (in Railway Dashboard)**:
   Go to your project settings in Railway and add these variables:
   - `BOT_TOKEN`: `8436853122:AAE4qR6V_38izfAxHGHoualntbLQvRPunzw`
   - `TMDB_API_KEY`: `7bffed716d50c95ed1c4790cfab4866a`
   - `ADMIN_IDS`: `Your_Telegram_ID` (e.g., 123456789)
   - `NODE_ENV`: `production`

4. **Add Database**:
   - In Railway, click **"New"** -> **"Database"** -> **"PostgreSQL"**.
   - It will automatically link to your app as `DATABASE_URL`.
   - Your bot will auto-migrate the tables on start.

## Manual Git Deploy
1. Upload this code to GitHub.
2. Go to Railway -> New Project -> Deploy from GitHub repo.
3. Add the variables above.
4. Add a PostgreSQL database.

Your bot is ready for cloud deployment!
