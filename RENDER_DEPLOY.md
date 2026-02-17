
# Render Deployment Guide

1. **Push your code to GitHub/GitLab**:
   - Create a repository (e.g., `telegram-movie-bot`).
   - Push this entire project folder to it.

2. **Deploy on Render (Automatic)**:
   - Go to [render.com](https://render.com) and create an account.
   - Click **New** -> **Blueprints**.
   - Connect your GitHub repository.
   - Render will detect `render.yaml` and set up everything for you (Database + Web Service).

3. **Configure Environment Variables**:
   - During the setup (or in Settings -> Environment), add:
     - `BOT_TOKEN`: `8436853122:AAE4qR6V_38izfAxHGHoualntbLQvRPunzw`
     - `TMDB_API_KEY`: `7bffed716d50c95ed1c4790cfab4866a`
     - `ADMIN_IDS`: `123456789` (Your Telegram ID)

4. **Verify**:
   - Check the logs in the Render dashboard. The bot should start and print:
     `Bot @nnnnnnewtesting_bot started successfully in production polling mode!`

**Note**: Render's free tier spins down after inactivity (slow first request) and the free database expires after 30 days. For permanent usage, upgrade to a paid plan ($7/month usually).
