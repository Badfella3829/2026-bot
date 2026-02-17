import { Bot, Context, session, SessionFlavor, GrammyError, HttpError, InlineKeyboard } from "grammy";
import type { InlineQueryResultArticle } from "grammy/types";
import { conversations, createConversation, ConversationFlavor } from "@grammyjs/conversations";
import { Menu } from "@grammyjs/menu";
import Fuse from "fuse.js";
import puppeteer from "puppeteer";
import { db } from "./db";
import {
  users, movies, movieAssets, shortenerTokens, instructions, forceSubscribeRules,
  creditTransactions, settings, posts, movieAccess, movieVerifications, creditVerifications,
  referrals, movieRequests
} from "./schema";
import crypto from "crypto";
import { eq, desc, sql, and } from "drizzle-orm";
import { searchTMDB, getTMDBDetails } from "./tmdb";
import { downloadAndUpload } from "./uploader";
import { getStreamingLinks } from "./streaming";

interface FileAsset {
  type: 'document' | 'video' | 'photo' | 'audio' | 'animation' | 'voice' | 'sticker';
  fileId: string;
  fileUniqueId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  caption?: string;
}

interface SessionData {
  userId?: string;
  pendingMovie?: {
    fuzzyKey: string;
    displayTitle: string;
    links: string[];
    files: FileAsset[];
  };
  broadcastMode?: boolean;
}

type MyContext = Context & SessionFlavor<SessionData> & ConversationFlavor<Context>;

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map((id: string) => parseInt(id.trim())).filter(Boolean);
const ACCESS_VALIDITY_HOURS = 12; // Movie access expires after 12 hours

// Helper to escape Markdown special characters
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

// Helper to escape HTML special characters
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Cached bot info - populated at startup
let cachedBotUsername: string = "";
const VERIFICATION_DOMAIN = process.env.REPLIT_DEV_DOMAIN || process.env.WEBHOOK_DOMAIN || process.env.REPLIT_DOMAINS?.split(",")[0] || "";
// GPlinks API integration - uses token from database
async function generateShortLink(destinationUrl: string): Promise<string | null> {
  // Get active API token from database
  const activeToken = await db.select().from(shortenerTokens).where(eq(shortenerTokens.isActive, true)).limit(1);
  const apiToken = activeToken.length > 0 ? activeToken[0].tokenValue : null;

  if (!apiToken) return null;

  try {
    const encodedUrl = encodeURIComponent(destinationUrl);
    const apiUrl = `https://api.gplinks.com/api?api=${apiToken}&url=${encodedUrl}&format=text`;
    const response = await fetch(apiUrl);

    if (response.ok) {
      const shortUrl = await response.text();
      return shortUrl.trim() || null;
    }
    return null;
  } catch (error) {
    console.error("GPlinks API error:", error);
    return null;
  }
}

// Automated GP Links verification using Puppeteer
async function verifyGPLink(shortUrl: string): Promise<string | null> {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();

    // Set user agent to avoid detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    // Navigate to the GP Link
    await page.goto(shortUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for potential timer or loading
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Look for common GP Links elements and interactions
    try {
      // Check for timer countdown
      const timerExists = await page.$('.timer, #timer, .countdown, [data-timer]');
      if (timerExists) {
        console.log("Timer detected, waiting...");
        // Wait for timer to complete (usually 5-15 seconds)
        await new Promise(resolve => setTimeout(resolve, 15000));
      }

      // Look for "Continue" or "Get Link" buttons using locator instead of deprecated $x
      const continueButton = await page.$('button');
      if (continueButton) {
        const buttonText = await page.evaluate(el => el?.textContent || '', continueButton);
        if (buttonText.includes('Continue') || buttonText.includes('Get Link') || buttonText.includes('Proceed')) {
          await continueButton.click();
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      // Check for captcha (basic handling - may need 2captcha service for complex ones)
      const captchaExists = await page.$('.captcha, #captcha, [class*="captcha"]');
      if (captchaExists) {
        console.log("Captcha detected - manual intervention may be needed");
        // For now, we'll skip if captcha is present
        return null;
      }

      // Try to find the final redirect URL
      const finalUrl = page.url();
      if (finalUrl !== shortUrl && !finalUrl.includes('gplinks')) {
        return finalUrl;
      }

      // Alternative: look for redirect links
      const links = await page.$$eval('a[href]', (anchors: HTMLAnchorElement[]) => anchors.map(a => a.href));
      const redirectLink = links.find((link: string) => !link.includes('gplinks') && link.startsWith('http'));
      if (redirectLink) {
        return redirectLink;
      }

    } catch (error) {
      console.error("Error during verification:", error);
    }

    return null;
  } catch (error) {
    console.error("Puppeteer error:", error);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function isAccessValid(unlockedAt: Date): { valid: boolean; hoursRemaining: number; minutesRemaining: number } {
  const now = new Date();
  const hoursSinceUnlock = (now.getTime() - unlockedAt.getTime()) / (1000 * 60 * 60);
  const totalMinutesRemaining = Math.max(0, (ACCESS_VALIDITY_HOURS - hoursSinceUnlock) * 60);
  const hoursRemaining = Math.floor(totalMinutesRemaining / 60);
  const minutesRemaining = Math.floor(totalMinutesRemaining % 60);
  return { valid: hoursSinceUnlock < ACCESS_VALIDITY_HOURS, hoursRemaining, minutesRemaining };
}

// Bot is optional - web application can run without it
let bot: Bot<MyContext> | null = null;

const PORT = process.env.PORT || 3000;

async function getOrCreateUser(telegramId: number, displayName: string): Promise<{ user: typeof users.$inferSelect, isNew: boolean }> {
  const existing = await db.select().from(users).where(eq(users.username, telegramId.toString()));
  if (existing.length > 0) {
    // Update display name if it was a placeholder
    if (existing[0].displayName && existing[0].displayName.startsWith("Admin_")) {
      await db.update(users).set({ displayName }).where(eq(users.id, existing[0].id));
      existing[0].displayName = displayName;
    }
    return { user: existing[0], isNew: false };
  }

  const result = await db.insert(users).values({
    username: telegramId.toString(),
    displayName: displayName,
    role: ADMIN_IDS.includes(telegramId) ? "admin" : "user",
  }).returning();
  return { user: result[0], isNew: true };
}

async function isAdmin(telegramId: number): Promise<boolean> {
  if (ADMIN_IDS.includes(telegramId)) return true;
  const user = await db.select().from(users).where(eq(users.username, telegramId.toString()));
  return user.length > 0 && user[0].role === "admin";
}

async function getBotStatus(): Promise<boolean> {
  const result = await db.select().from(settings).where(eq(settings.key, "bot_active"));
  return result.length === 0 || result[0].value !== "false";
}

// Check if user has joined all force subscribe channels
async function checkForceSubscribe(bot: Bot<MyContext>, userId: number): Promise<{ allJoined: boolean; channels: Array<{ id: string; url: string; joined: boolean }> }> {
  const rules = await db.select().from(forceSubscribeRules).where(eq(forceSubscribeRules.isActive, true));

  if (rules.length === 0) {
    return { allJoined: true, channels: [] };
  }

  const channels: Array<{ id: string; url: string; joined: boolean }> = [];

  for (const rule of rules) {
    let channelId = rule.channelUrl;
    // Extract channel ID from URL or use as-is
    if (channelId.includes("t.me/")) {
      channelId = "@" + channelId.split("t.me/")[1].split("/")[0].replace("+", "");
    }

    let joined = false;
    try {
      const member = await bot.api.getChatMember(channelId, userId);
      joined = ["member", "administrator", "creator"].includes(member.status);
    } catch (error) {
      // Can't check - assume not joined
      joined = false;
    }

    channels.push({ id: channelId, url: rule.channelUrl, joined });
  }

  const allJoined = channels.every(c => c.joined);
  return { allJoined, channels };
}

// Get main menu keyboard - beautifully organized with all features
function getMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎬 Search Movie 🔍", "searchmovie").row()
    .text("📚 My Library", "library").text("💳 My Credits", "credits").row()
    .text("🎁 Earn Credits", "earncredits").text("👑 Premium", "premium_info").row()
    .text("🔔 Join Channel", "activate").text("📖 How To Use", "howtoactivate").row()
    .text("❓ Help & Support", "help").row();
}

// Premium promotion message - shown after each command
function getPremiumPromoMessage(isPremium: boolean = false): string {
  if (isPremium) {
    return `\n\n👑 Premium Member | Instant access enabled!`;
  }
  return `\n\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n👑 *Premium Membership*\n✨ Instant movie access\n✨ Unlimited downloads\n✨ Priority support\n🔥 Contact admin for premium!`;
}

function getPremiumPromoMessagePlain(isPremium: boolean = false): string {
  if (isPremium) {
    return `\n\n👑 Premium Member | Instant access enabled!`;
  }
  return `\n\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n👑 Premium Membership\n✨ Instant movie access\n✨ Unlimited downloads\n✨ Priority support\n🔥 Contact admin for premium!`;
}


async function searchMoviesDb(query: string) {
  const allMovies = await db.select().from(movies).where(eq(movies.status, "published"));

  if (!query || query.trim() === "") {
    return allMovies.slice(0, 4);
  }

  const fuse = new Fuse(allMovies, {
    keys: ["fuzzyKey", "displayTitle"],
    threshold: 0.25,
    includeScore: true,
  });

  const results = fuse.search(query);
  return results.slice(0, 4).map(r => r.item);
}

async function canEarnCredits(userId: string): Promise<{ canEarn: boolean; hoursRemaining?: number; minutesRemaining?: number }> {
  const user = await db.select().from(users).where(eq(users.id, userId));
  if (user.length === 0) return { canEarn: false };

  const now = new Date();
  const lastReset = user[0].lastCreditReset;
  const msSinceReset = lastReset ? (now.getTime() - lastReset.getTime()) : (13 * 60 * 60 * 1000);
  const hoursSinceReset = msSinceReset / (1000 * 60 * 60);

  if (hoursSinceReset >= 12) {
    await db.update(users).set({ credits: 0, lastCreditReset: new Date() }).where(eq(users.id, userId));
    return { canEarn: true };
  }

  if (user[0].credits >= 2) {
    const remainingMs = (12 * 60 * 60 * 1000) - msSinceReset;
    const hoursRemaining = Math.floor(remainingMs / (1000 * 60 * 60));
    const minutesRemaining = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
    return { canEarn: false, hoursRemaining, minutesRemaining };
  }

  return { canEarn: true };
}

async function earnCredits(userId: string): Promise<number> {
  const user = await db.select().from(users).where(eq(users.id, userId));
  const now = new Date();
  const newCredits = (user[0]?.credits || 0) + 2;

  await db.insert(creditTransactions).values({ userId, amount: 2, reason: "shortener_visit" });
  await db.update(users).set({
    credits: newCredits,
    lastCreditReset: user[0]?.lastCreditReset ? user[0].lastCreditReset : now
  }).where(eq(users.id, userId));
  return newCredits;
}

async function spendCredit(userId: string): Promise<{ success: boolean; credits: number }> {
  const user = await db.select().from(users).where(eq(users.id, userId));
  if (user.length === 0 || user[0].credits < 1) {
    return { success: false, credits: user[0]?.credits || 0 };
  }

  await db.insert(creditTransactions).values({ userId, amount: -1, reason: "link_access" });
  const newCredits = user[0].credits - 1;
  await db.update(users).set({ credits: newCredits }).where(eq(users.id, userId));
  return { success: true, credits: newCredits };
}

// Initialize bot if token is provided
console.log("Checking BOT_TOKEN: ", BOT_TOKEN ? "Present" : "Missing");
if (!BOT_TOKEN) {
  console.warn("BOT_TOKEN not provided - Telegram bot will not start. Web application will run normally.");
} else {
  console.log("Initializing Bot instance...");
  bot = new Bot<MyContext>(BOT_TOKEN);
  console.log("Bot instance initialized.");

  bot.use(session({
    initial: (): SessionData => ({})
  }));

  bot.use(conversations());

  // Global ban check and force subscribe middleware
  bot.use(async (ctx, next) => {
    // Skip for admins
    if (ctx.from && await isAdmin(ctx.from.id)) {
      return next();
    }

    // Check if user is banned
    if (ctx.from) {
      const existingUser = await db.select().from(users).where(eq(users.username, ctx.from.id.toString()));
      if (existingUser.length > 0 && existingUser[0].status === "banned") {
        return ctx.reply("🚫 𝗬𝗼𝘂 𝗮𝗿𝗲 𝗯𝗮𝗻𝗻𝗲𝗱 𝗳𝗿𝗼𝗺 𝘂𝘀𝗶𝗻𝗴 𝘁𝗵𝗶𝘀 𝗯𝗼𝘁\n\n📩 Contact admin for help.");
      }
    }

    // Skip for callback queries that are for verification
    if (ctx.callbackQuery?.data === "verifyjoin") {
      return next();
    }

    // Skip for /start command (it handles its own check with proper UI)
    if (ctx.message?.text?.startsWith("/start")) {
      return next();
    }

    // Check force subscribe for all other interactions
    if (ctx.from) {
      const { allJoined, channels } = await checkForceSubscribe(bot!, ctx.from.id);

      if (!allJoined && channels.length > 0) {
        const keyboard = new InlineKeyboard();
        let channelNum = 1;
        for (const channel of channels) {
          if (!channel.joined) {
            const channelUrl = channel.url.startsWith("http") ? channel.url : `https://t.me/${channel.id.replace("@", "")}`;
            keyboard.url(`📢 Join Channel ${channelNum}`, channelUrl).row();
            channelNum++;
          }
        }
        keyboard.text("✅ Verify Join", "verifyjoin").row();

        await ctx.reply(`❌ 𝗝𝗼𝗶𝗻 𝗖𝗵𝗮𝗻𝗻𝗲𝗹𝘀 𝗙𝗶𝗿𝘀𝘁!\n\n📢 Join the channels below\n✅ After joining, tap "Verify Join"`, { reply_markup: keyboard });
        return; // Don't proceed
      }
    }

    return next();
  });

  bot.command("start", async (ctx) => {
    const botActive = await getBotStatus();
    if (!botActive) {
      return ctx.reply("⚠️ 𝗕𝗼𝘁 𝗶𝘀 𝗰𝘂𝗿𝗿𝗲𝗻𝘁𝗹𝘆 𝗼𝗳𝗳𝗹𝗶𝗻𝗲\n\n🔄 Please try again later.");
    }

    const firstName = ctx.from?.first_name || "User";
    const { user, isNew } = await getOrCreateUser(ctx.from!.id, firstName);

    // Ban check is now handled by global middleware, no need to check again here

    // Check if user came from shortener verification (legacy - now handled via web /verify endpoint)
    const startParam = ctx.message?.text?.split(" ")[1];

    // Movie deep link - show movie details directly
    if (startParam && startParam.startsWith("movie_")) {
      const movieIdPrefix = startParam.replace("movie_", "");
      const allMovies = await db.select().from(movies).where(eq(movies.status, "published"));
      const movie = allMovies.find(m => m.id.startsWith(movieIdPrefix));

      if (!movie) {
        return ctx.reply(getNotFoundMessage());
      }

      // Get assets count
      const assets = await db.select().from(movieAssets).where(eq(movieAssets.movieId, movie.id));
      const fileTypes = ['document', 'video', 'photo', 'audio', 'animation', 'voice', 'sticker'];
      const fileCount = assets.filter(a => fileTypes.includes(a.assetType)).length;
      const linkCount = assets.filter(a => a.assetType === 'link').length || movie.links.length;

      const userRecord = await db.select().from(users).where(eq(users.id, user.id));
      const credits = userRecord[0]?.credits || 0;
      const isPremium = userRecord[0]?.isPremium || false;

      let message = `🎬 ${movie.displayTitle}\n\n`;
      if (fileCount > 0) message += `📁 Files: ${fileCount}\n`;
      if (linkCount > 0) message += `🔗 Links: ${linkCount}\n`;
      message += `\n💳 Your credits: ${credits}\n\n`;

      if (isPremium) {
        message += `👑 Premium Member - Instant access!\n`;
        message += `📥 Download: /getlink_${movieIdPrefix}`;
      } else if (credits >= 1) {
        message += `📥 Download: /getlink_${movieIdPrefix}\n`;
        message += `(1 credit required)`;
      } else {
        message += "❌ No credits available!\n";
        message += "🎁 Use /earnCredits to earn credits.";
      }

      return ctx.reply(message);
    }

    // Credit verification flow - deprecated, now handled via web verification
    if (startParam && startParam.startsWith("verified_")) {
      // This path is deprecated - credits are earned only through proper GPlinks web verification
      return ctx.reply(`❌ 𝗗𝗶𝗿𝗲𝗰𝘁 𝗖𝗹𝗮𝗶𝗺 𝗗𝗶𝘀𝗮𝗯𝗹𝗲𝗱!\n\n📋 Use "💰 Earn Credits" from menu to earn credits.`);
    }

    // Referral handling - only for NEW users who just joined
    if (startParam && startParam.startsWith("ref_") && isNew) {
      const referrerTelegramId = startParam.replace("ref_", "");

      // Don't allow self-referral
      if (referrerTelegramId !== ctx.from!.id.toString()) {
        // Find referrer by their telegram ID (stored in username field)
        const referrer = await db.select().from(users).where(eq(users.username, referrerTelegramId));

        if (referrer.length > 0) {
          // Create referral record (unique constraint on referredId prevents duplicates)
          try {
            await db.insert(referrals).values({
              referrerId: referrer[0].id,
              referredId: user.id,
              creditsAwarded: 1
            });

            // Award credit to referrer
            await db.update(users).set({ credits: sql`${users.credits} + 1` }).where(eq(users.id, referrer[0].id));

            // Notify referrer (safely handle if message fails)
            try {
              const referrerTgId = parseInt(referrer[0].username);
              if (!isNaN(referrerTgId)) {
                await bot!.api.sendMessage(referrerTgId, `🎉 New Referral!\n\n${firstName.replace(/_/g, " ")} joined via your link!\n+1 credit added to your account!`);
              }
            } catch (e) {
              // Silently fail if notification fails
            }
          } catch (e) {
            // Unique constraint violation - user was already referred (race condition protection)
          }
        }
      }
    }

    // Check force subscribe
    const { allJoined, channels } = await checkForceSubscribe(bot!, ctx.from!.id);

    if (!allJoined && channels.length > 0) {
      let message = `❌ 𝗦𝘁𝗶𝗹𝗹 𝗡𝗼𝘁 𝗝𝗼𝗶𝗻𝗲𝗱!\n\n📢 Join the channels below\n✅ After joining, tap "Verify Join"\n\n`;

      const keyboard = new InlineKeyboard();
      let channelNum = 1;
      for (const channel of channels) {
        if (!channel.joined) {
          const channelUrl = channel.url.startsWith("http") ? channel.url : `https://t.me/${channel.id.replace("@", "")}`;
          keyboard.url(`📢 Join Channel ${channelNum}`, channelUrl).row();
          channelNum++;
        }
      }
      keyboard.text("✅ Verify Join", "verifyjoin").row();

      const notJoined = channels.filter(c => !c.joined);
      if (notJoined.length > 0) {
        await ctx.reply(message, { parse_mode: "Markdown", reply_markup: keyboard });
        return;
      }
    }

    // Show verification success if coming from verify
    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const credits = userRecord[0]?.credits || 0;
    const isPremium = userRecord[0]?.isPremium || false;

    const safeName = firstName.replace(/_/g, " ");
    let welcomeMessage = `🌹 Welcome ${safeName}!\n\n`;
    if (isPremium) {
      welcomeMessage += `👑 Premium Member\n\n`;
    }
    welcomeMessage += `I'm Rose Bot. Tap the button below or type movie name to search.\n\n`;
    welcomeMessage += `✨ Smart search - even misspelled names work!\n\n`;
    welcomeMessage += `💳 Credits: ${credits}`;
    welcomeMessage += getPremiumPromoMessagePlain(isPremium);

    await ctx.reply(welcomeMessage, { reply_markup: getMainMenuKeyboard() });
  });

  bot.command("search", async (ctx) => {
    const botActive = await getBotStatus();
    if (!botActive) {
      return ctx.reply("⚠️ 𝗕𝗼𝘁 𝗶𝘀 𝗰𝘂𝗿𝗿𝗲𝗻𝘁𝗹𝘆 𝗼𝗳𝗳𝗹𝗶𝗻𝗲\n\n🔄 Please try again later.");
    }

    const query = ctx.message?.text?.replace("/search", "").trim();
    if (!query) {
      return ctx.reply("🔍 𝗠𝗼𝘃𝗶𝗲 𝗦𝗲𝗮𝗿𝗰𝗵\n\n📝 Example: /search Dangal");
    }

    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);
    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const isPremium = userRecord[0]?.isPremium || false;
    const results = await searchMoviesDb(query);

    if (results.length === 0) {
      let message = getNotFoundMessage();
      message += getPremiumPromoMessage(isPremium);
      return ctx.reply(message, { parse_mode: "Markdown" });
    }

    const botUsername = cachedBotUsername || ctx.me.username;
    let message = ``;

    results.forEach((movie: typeof movies.$inferSelect, index: number) => {
      const movieCode = movie.id.slice(0, 8);
      const safeTitle = escapeHtml(movie.displayTitle);
      message += `<b>Title:</b> ${safeTitle}\n`;
      message += `👉👉 <a href="https://t.me/${botUsername}?start=movie_${movieCode}">Download now</a> 👈👈\n\n`;
    });

    message += `⚠️ Movie not found? Use /request to request it.`;

    await ctx.reply(message, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });

  bot.hears(/^\/get_(.+)$/, async (ctx) => {
    const movieIdPrefix = ctx.match[1];
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);

    const allMovies = await db.select().from(movies).where(eq(movies.status, "published"));
    const movie = allMovies.find(m => m.id.startsWith(movieIdPrefix));

    if (!movie) {
      return ctx.reply(getNotFoundMessage());
    }

    // Get assets count (all file types)
    const assets = await db.select().from(movieAssets).where(eq(movieAssets.movieId, movie.id));
    const fileTypes = ['document', 'video', 'photo', 'audio', 'animation', 'voice', 'sticker'];
    const fileCount = assets.filter(a => fileTypes.includes(a.assetType)).length;
    const linkCount = assets.filter(a => a.assetType === 'link').length || movie.links.length;
    const totalAssets = fileCount + linkCount;

    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const credits = userRecord[0]?.credits || 0;
    const isPremium = userRecord[0]?.isPremium || false;

    let message = `🎬 *${escapeMarkdown(movie.displayTitle)}*\n\n`;
    if (fileCount > 0) message += `📁 Files: ${fileCount}\n`;
    if (linkCount > 0) message += `🔗 Links: ${linkCount}\n`;
    message += `\n💳 Your credits: ${credits}\n\n`;

    if (isPremium) {
      message += `👑 *Premium Member* | Instant access!\n`;
      message += `📥 Download: /getlink_${movieIdPrefix}`;
    } else if (totalAssets === 0) {
      message += "❌ No content available.";
    } else if (credits >= 1) {
      message += `📥 Download: /getlink_${movieIdPrefix}\n`;
      message += `(1 credit lagega)`;
    } else {
      message += "❌ Credits nahi hain!\n";
      message += "🎁 /earnCredits se credits kamao.";
    }

    message += getPremiumPromoMessage(isPremium);

    await ctx.reply(message, { parse_mode: "Markdown" });
  });

  // Professional "not found" message
  const getNotFoundMessage = () => {
    return `❌ 𝘊ᴏᴜʟᴅɴ'ᴛ 𝘍ɪɴᴅ 𝘈ɴʏ 𝘔ᴏᴠɪᴇ 𝘐ɴ 𝘛ʜᴀᴛ 𝘕ᴀᴍᴇ

📝 𝘗𝘓𝘌𝘈𝘚𝘌 𝘌𝘕𝘛𝘌𝘙 𝘊𝘖𝘙𝘙𝘌𝘊𝘛 𝘚𝘗𝘌𝘓𝘓𝘐𝘕𝘎 𝘍𝘙𝘖𝘔 𝘎𝘖𝘖𝘎𝘓𝘌

💡 Tips:
• Check spelling from Google/IMDB
• Try searching in English
• Use /request to request missing movies`;
  };

  // Copyright warning for files
  const getCopyrightWarning = () => {
    return `\n\n⚠️ 𝗧𝗵𝗶𝘀 𝗳𝗶𝗹𝗲 𝘄𝗶𝗹𝗹 𝗯𝗲 𝗱𝗲𝗹𝗲𝘁𝗲𝗱 𝗮𝗳𝘁𝗲𝗿 𝟮𝟰 𝗵𝗼𝘂𝗿𝘀
📌 Due to copyright issues

💾 𝗦𝗮𝘃𝗲 𝗶𝘁 𝗻𝗼𝘄:
• Forward to Saved Messages
• Download to your device`;
  };

  // Helper function to send movie content to user
  const sendMovieContent = async (ctx: MyContext, movie: typeof movies.$inferSelect, isAdminPreview: boolean, accessValidity: { valid: boolean; hoursRemaining: number; minutesRemaining: number }) => {
    const assets = await db.select().from(movieAssets)
      .where(eq(movieAssets.movieId, movie.id))
      .orderBy(movieAssets.orderIndex);

    const fileTypes = ['document', 'video', 'photo', 'audio', 'animation', 'voice', 'sticker'];
    const fileAssets = assets.filter(a => fileTypes.includes(a.assetType));
    const linkAssets = assets.filter(a => a.assetType === 'link');

    const timeLeft = accessValidity.hoursRemaining > 0
      ? `${accessValidity.hoursRemaining}h ${accessValidity.minutesRemaining}m`
      : `${accessValidity.minutesRemaining}m`;

    const botUsername = cachedBotUsername || ctx.me.username;

    let headerMsg = `🎬 <b>${escapeHtml(movie.displayTitle)}</b>\n\n`;
    if (isAdminPreview) {
      headerMsg += `👑 <i>Admin Preview | No Verification Required</i>`;
    } else {
      headerMsg += `✅ <b>Verified!</b> Access valid for <code>${timeLeft}</code>`;
    }

    await ctx.reply(headerMsg, { parse_mode: "HTML" });

    // Send files with copyright warning
    const copyrightCaption = getCopyrightWarning();

    for (const asset of fileAssets) {
      if (!asset.telegramFileId) continue;
      try {
        const caption = (asset.caption || movie.displayTitle) + copyrightCaption;

        switch (asset.assetType) {
          case 'video':
            await ctx.replyWithVideo(asset.telegramFileId, { caption });
            break;
          case 'document':
            await ctx.replyWithDocument(asset.telegramFileId, { caption });
            break;
          case 'photo':
            await ctx.replyWithPhoto(asset.telegramFileId, { caption });
            break;
          case 'audio':
            await ctx.replyWithAudio(asset.telegramFileId, { caption });
            break;
          case 'animation':
            await ctx.replyWithAnimation(asset.telegramFileId, { caption });
            break;
          case 'voice':
            await ctx.replyWithVoice(asset.telegramFileId, { caption });
            break;
          case 'sticker':
            await ctx.replyWithSticker(asset.telegramFileId);
            break;
        }
      } catch (err) {
        console.error("Error sending file:", err);
      }
    }

    // Send links
    if (linkAssets.length > 0) {
      let linkMsg = "🔗 <b>Download Links:</b>\n\n";
      linkAssets.forEach((asset, i) => {
        linkMsg += `${i + 1}. ${asset.url}\n`;
      });
      linkMsg += `\n💾 <i>Save these links - they may expire!</i>`;
      await ctx.reply(linkMsg, { parse_mode: "HTML" });
    } else if (movie.links.length > 0) {
      let linkMsg = "🔗 <b>Download Links:</b>\n\n";
      movie.links.forEach((link: string, i: number) => {
        linkMsg += `${i + 1}. ${link}\n`;
      });
      linkMsg += `\n💾 <i>Save these links - they may expire!</i>`;
      await ctx.reply(linkMsg, { parse_mode: "HTML" });
    }
  }

  // ============================================
  // TMDB INTEGRATION & AUTO UPLOADER COMMANDS
  // ============================================

  bot.command("find", async (ctx) => {
    const query = ctx.message?.text?.replace("/find", "").trim();
    if (!query) return ctx.reply("📝 Usage: /find <movie_name>");

    if (process.env.TMDB_API_KEY === undefined) {
      return ctx.reply("⚠️ TMDB_API_KEY is not set in environment variables.");
    }

    const results = await searchTMDB(query);

    if (results.length === 0) {
      return ctx.reply("❌ No results found on TMDB.");
    }

    // Show top 5 results
    for (const item of results.slice(0, 5)) {
      const year = item.release_date ? item.release_date.split('-')[0] : 'N/A';
      const type = item.media_type === 'tv' ? '📺 TV Show' : '🎬 Movie';
      let msg = `${type}\n<b>${escapeHtml(item.title || item.original_title)}</b> (${year})\n`;
      msg += `⭐ Rating: ${item.vote_average.toFixed(1)}\n`;
      msg += `📝 ${escapeHtml(item.overview.substring(0, 100))}...`;

      const keyboard = new InlineKeyboard()
        .text("➕ Add to DB", `tmdb_add_${item.id}_${item.media_type}`).row();

      // Add streaming buttons for immediate watching
      const streamLinks = getStreamingLinks(item.id, item.media_type as 'movie' | 'tv');
      streamLinks.slice(0, 2).forEach(link => {
        keyboard.url(link.name, link.url);
      });

      if (item.poster_path) {
        await ctx.replyWithPhoto(`https://image.tmdb.org/t/p/w500${item.poster_path}`, {
          caption: msg,
          parse_mode: "HTML",
          reply_markup: keyboard
        });
      } else {
        await ctx.reply(msg, {
          parse_mode: "HTML",
          reply_markup: keyboard
        });
      }
    }
  });

  bot.callbackQuery(/^tmdb_add_(\d+)_(movie|tv)$/, async (ctx) => {
    if (!ctx.match) return;
    const [_, idStr, type] = ctx.match;
    const id = parseInt(idStr);

    // Check if user is admin
    if (!await isAdmin(ctx.from.id)) {
      return ctx.answerCallbackQuery({ text: "⚠️ Admin only!", show_alert: true });
    }

    await ctx.answerCallbackQuery({ text: "🔄 Fetching details..." });

    const details = await getTMDBDetails(id, type as 'movie' | 'tv');
    if (!details) {
      return ctx.reply("❌ Failed to fetch details from TMDB.");
    }

    const title = details.title || details.original_title;
    const fuzzyKey = title.toLowerCase().replace(/[^a-z0-9]/g, "");

    // Check if already exists
    const existing = await db.select().from(movies).where(eq(movies.fuzzyKey, fuzzyKey));
    if (existing.length > 0) {
      return ctx.reply(`⚠️ Movie "${title}" already exists in DB!`);
    }

    try {
      const [newMovie] = await db.insert(movies).values({
        displayTitle: title,
        fuzzyKey: fuzzyKey,
        status: "published" // Auto-publish or keep as draft
      }).returning();

      // Optionally add poster as asset
      if (details.poster_path) {
        await db.insert(movieAssets).values({
          movieId: newMovie.id,
          assetType: 'link', // Store poster URL as link for now
          url: `https://image.tmdb.org/t/p/original${details.poster_path}`,
          caption: "Poster",
          orderIndex: -1
        });
      }

      // Add streaming links automatically
      const streamLinks = getStreamingLinks(id, type as 'movie' | 'tv');
      for (const link of streamLinks) {
        await db.insert(movieAssets).values({
          movieId: newMovie.id,
          assetType: 'link',
          url: link.url,
          caption: link.name,
          orderIndex: 0
        });
      }

      await ctx.reply(`✅ Added <b>${escapeHtml(title)}</b> to Database!\n🆔 ${newMovie.id}\n\nAdded ${streamLinks.length} streaming links automatically.`, { parse_mode: "HTML" });

    } catch (e) {
      console.error("DB Error:", e);
      await ctx.reply("❌ Database error.");
    }
  });

  bot.command("upload", async (ctx) => {
    // Check admin
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("❌ Admin only command.");
    }

    const url = ctx.message?.text?.replace("/upload", "").trim();
    if (!url || !url.startsWith("http")) {
      return ctx.reply("📝 Usage: /upload <direct_url>\n\nNote: File must be < 50MB for standard bot uploads.");
    }

    await downloadAndUpload(bot!, ctx.chat.id, url, ctx.message?.message_id);
  });

  bot.hears(/^\/getlink_(.+)$/, async (ctx) => {
    const movieIdPrefix = ctx.match[1];
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);
    const userIsAdmin = await isAdmin(ctx.from!.id);

    // Find movie by ID prefix
    const allMovies = await db.select().from(movies);
    const movie = allMovies.find(m => m.id.startsWith(movieIdPrefix));

    if (!movie) {
      return ctx.reply(getNotFoundMessage());
    }

    // Check if user already has valid access (within 12h)
    const existingAccess = await db.select().from(movieAccess)
      .where(and(eq(movieAccess.userId, user.id), eq(movieAccess.movieId, movie.id)));

    const hasAccess = existingAccess.length > 0;
    const accessValidity = hasAccess && existingAccess[0].unlockedAt
      ? isAccessValid(existingAccess[0].unlockedAt)
      : { valid: false, hoursRemaining: 0, minutesRemaining: 0 };

    // Check if movie is published (unless admin or user has valid access)
    if (!userIsAdmin && !accessValidity.valid && movie.status !== "published") {
      return ctx.reply("❌ 𝗠𝗼𝘃𝗶𝗲 𝗡𝗼𝘁 𝗔𝘃𝗮𝗶𝗹𝗮𝗯𝗹𝗲\n\nThis movie is not available yet.");
    }

    // Get movie assets to check if content exists
    const assets = await db.select().from(movieAssets)
      .where(eq(movieAssets.movieId, movie.id));

    const fileTypes = ['document', 'video', 'photo', 'audio', 'animation', 'voice', 'sticker'];
    const hasFiles = assets.some(a => fileTypes.includes(a.assetType));
    const hasLinks = assets.some(a => a.assetType === 'link') || movie.links.length > 0;

    if (!hasFiles && !hasLinks) {
      return ctx.reply(`❌ 𝗡𝗼 𝗖𝗼𝗻𝘁𝗲𝗻𝘁 𝗔𝘃𝗮𝗶𝗹𝗮𝗯𝗹𝗲\n\nNo files or links available for this movie yet.`);
    }

    // ADMIN: Always get instant access without verification
    if (userIsAdmin) {
      return sendMovieContent(ctx, movie, true, { valid: true, hoursRemaining: 12, minutesRemaining: 0 });
    }

    // PREMIUM USER: Instant access without verification
    if (await isPremiumUser(user.id)) {
      // Grant or renew access for premium user
      if (!accessValidity.valid) {
        if (hasAccess && existingAccess.length > 0) {
          await db.update(movieAccess).set({ unlockedAt: new Date() })
            .where(and(eq(movieAccess.userId, user.id), eq(movieAccess.movieId, movie.id)));
        } else {
          await db.insert(movieAccess).values({ userId: user.id, movieId: movie.id });
        }
      }
      await ctx.reply("👑 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗔𝗰𝗰𝗲𝘀𝘀!\n\n✨ No verification needed for premium users!", { parse_mode: "Markdown" });
      return sendMovieContent(ctx, movie, false, { valid: true, hoursRemaining: 12, minutesRemaining: 0 });
    }

    // USER WITH VALID ACCESS: Deliver content directly (re-download)
    if (accessValidity.valid) {
      return sendMovieContent(ctx, movie, false, accessValidity);
    }

    // USER NEEDS VERIFICATION: Generate GPlinks verification URL
    const verificationToken = crypto.randomBytes(16).toString('hex');

    // Store pending verification in database
    await db.insert(movieVerifications).values({
      userId: user.id,
      movieId: movie.id,
      token: verificationToken,
      status: 'pending'
    });

    // Generate GPlinks short URL pointing to our web verification endpoint
    const verificationUrl = `https://${VERIFICATION_DOMAIN}/verify?token=${verificationToken}`;
    const shortUrl = await generateShortLink(verificationUrl);

    if (!shortUrl) {
      return ctx.reply(`❌ 𝗩𝗲𝗿𝗶𝗳𝗶𝗰𝗮𝘁𝗶𝗼𝗻 𝗟𝗶𝗻𝗸 𝗘𝗿𝗿𝗼𝗿\n\n📩 Please contact admin for help.`);
    }

    // Show verification message with buttons
    const safeTitle = movie.displayTitle.replace(/_/g, " ");
    const expiredMsg = hasAccess ? `⏰ Access expired!\n\n` : "";
    const message = `${expiredMsg}🎬 ${safeTitle}\n\n` +
      `📋 Complete verification to access this movie:\n\n` +
      `1️⃣ Click "Verify Now" button\n` +
      `2️⃣ Complete the page that opens\n` +
      `3️⃣ After "Success" message, come back\n` +
      `4️⃣ Tap "Check Verification" to get movie\n\n` +
      `⏳ Link valid for 1 hour\n` +
      `🔓 Access valid for 12 hours after verification`;

    const keyboard = new InlineKeyboard()
      .url("🔗 Verify Now", shortUrl)
      .row()
      .text("✅ Check Verification", `checkverify_${verificationToken}`)
      .row()
      .text("⬅️ Back to Menu", "backtomenu");

    return ctx.reply(message, { reply_markup: keyboard });
  });

  // Check verification callback handler
  bot.callbackQuery(/^checkverify_(.+)$/, async (ctx) => {
    const token = ctx.match[1];
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);

    // Find the verification record
    const [verification] = await db.select().from(movieVerifications).where(eq(movieVerifications.token, token));

    if (!verification) {
      return ctx.answerCallbackQuery({ text: "❌ Link expired! Fresh link lo.", show_alert: true });
    }

    if (verification.userId !== user.id) {
      return ctx.answerCallbackQuery({ text: "❌ This link is not yours!", show_alert: true });
    }

    // Check if token is expired (1 hour limit)
    const createdAt = new Date(verification.createdAt);
    const now = new Date();
    const hoursPassed = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);

    if (hoursPassed > 1) {
      await db.update(movieVerifications).set({ status: "expired" }).where(eq(movieVerifications.token, token));
      return ctx.answerCallbackQuery({ text: "⏰ Link expired (1 hour limit)! Get new link.", show_alert: true });
    }

    if (verification.status === "pending") {
      return ctx.answerCallbackQuery({ text: "❌ Complete verification first! Click link and complete page.", show_alert: true });
    }

    if (verification.status === "expired") {
      return ctx.answerCallbackQuery({ text: "⏰ Link expired! Get new link.", show_alert: true });
    }

    if (verification.status === "used") {
      return ctx.answerCallbackQuery({ text: "✅ Already used! Movie already received.", show_alert: true });
    }

    // Verification successful! Grant access
    if (verification.status === "verified") {
      const movie = await db.select().from(movies).where(eq(movies.id, verification.movieId));

      if (movie.length === 0) {
        return ctx.answerCallbackQuery({ text: "❌ Movie not found! Check spelling.", show_alert: true });
      }

      // Grant or renew access
      const existingAccess = await db.select().from(movieAccess)
        .where(and(eq(movieAccess.userId, user.id), eq(movieAccess.movieId, movie[0].id)));

      if (existingAccess.length > 0) {
        await db.update(movieAccess).set({ unlockedAt: new Date() })
          .where(and(eq(movieAccess.userId, user.id), eq(movieAccess.movieId, movie[0].id)));
      } else {
        await db.insert(movieAccess).values({ userId: user.id, movieId: movie[0].id });
      }

      // Mark verification as used
      await db.update(movieVerifications).set({ status: "used" }).where(eq(movieVerifications.token, token));

      await ctx.answerCallbackQuery({ text: "✅ Verification successful! Sending movie..." });

      // Send movie content
      return sendMovieContent(ctx, movie[0], false, { valid: true, hoursRemaining: 12, minutesRemaining: 0 });
    }
  });

  const earnCreditsHandler = async (ctx: MyContext) => {
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);
    const { canEarn, hoursRemaining, minutesRemaining } = await canEarnCredits(user.id);

    if (!canEarn) {
      let message = `⏰ *Token still active!*\n\n`;
      message += `Wait time: ${hoursRemaining || 0}h ${minutesRemaining || 0}m\n\n`;
      message += `Token resets every 12 hours.`;
      return ctx.reply(message, { parse_mode: "Markdown" });
    }

    // Generate credit verification token
    const verificationToken = crypto.randomBytes(16).toString('hex');

    // Store pending credit verification
    await db.insert(creditVerifications).values({
      userId: user.id,
      token: verificationToken,
      status: 'pending',
      creditsAmount: 2
    });

    // Generate GPlinks short URL pointing to credit verification endpoint
    const verificationUrl = `https://${VERIFICATION_DOMAIN}/verify-credits?token=${verificationToken}`;
    const shortUrl = await generateShortLink(verificationUrl);

    if (!shortUrl) {
      return ctx.reply(`❌ 𝗩𝗲𝗿𝗶𝗳𝗶𝗰𝗮𝘁𝗶𝗼𝗻 𝗟𝗶𝗻𝗸 𝗙𝗮𝗶𝗹𝗲𝗱\n\n📩 Please contact admin for help.`);
    }

    const message = `💰 *Earn Credits*\n\n` +
      `📋 *Complete verification to earn credits:*\n\n` +
      `1️⃣ Click *"Verify Now"* button\n` +
      `2️⃣ Complete the page that opens\n` +
      `3️⃣ After "Success" message, come back\n` +
      `4️⃣ Tap *"Check Verification"* to claim credits\n\n` +
      `⏳ Link valid for 1 hour\n` +
      `🎁 +2 Credits after verification`;

    const keyboard = new InlineKeyboard()
      .url("🔗 Verify Now", shortUrl)
      .row()
      .text("✅ Check Verification", `checkcredit_${verificationToken}`)
      .row()
      .text("⬅️ Back to Menu", "backtomenu");

    return ctx.reply(message, { parse_mode: "Markdown", reply_markup: keyboard });
  };
  bot.command("earnCredits", earnCreditsHandler);
  bot.command("earncredits", earnCreditsHandler);

  // Check credit verification callback handler
  bot.callbackQuery(/^checkcredit_(.+)$/, async (ctx) => {
    const token = ctx.match[1];
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);

    const [verification] = await db.select().from(creditVerifications).where(eq(creditVerifications.token, token));

    if (!verification) {
      return ctx.answerCallbackQuery({ text: "❌ Link expired! Fresh link lo.", show_alert: true });
    }

    if (verification.userId !== user.id) {
      return ctx.answerCallbackQuery({ text: "❌ This link is not yours!", show_alert: true });
    }

    // Check 1 hour expiry
    const createdAt = new Date(verification.createdAt);
    const hoursPassed = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);

    if (hoursPassed > 1) {
      await db.update(creditVerifications).set({ status: "expired" }).where(eq(creditVerifications.token, token));
      return ctx.answerCallbackQuery({ text: "⏰ Link expired (1 hour limit)! Get new link.", show_alert: true });
    }

    if (verification.status === "pending") {
      return ctx.answerCallbackQuery({ text: "❌ Complete verification first! Click link and complete page.", show_alert: true });
    }

    if (verification.status === "expired") {
      return ctx.answerCallbackQuery({ text: "⏰ Link expired! Get new link.", show_alert: true });
    }

    if (verification.status === "used") {
      return ctx.answerCallbackQuery({ text: "✅ Already claimed! Credits already received.", show_alert: true });
    }

    // Verification successful! Award credits
    if (verification.status === "verified") {
      const newCredits = await earnCredits(user.id);

      // Mark as used
      await db.update(creditVerifications).set({ status: "used" }).where(eq(creditVerifications.token, token));

      await ctx.answerCallbackQuery({ text: `🎉 +2 Credits added! Total: ${newCredits}` });

      return ctx.editMessageText(`🎉 *Verification Successful!*\n\n+2 Credits added!\n\n💳 Total Credits: ${newCredits}`, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("⬅️ Back to Menu", "backtomenu")
      });
    }
  });

  // Premium check helper
  const isPremiumUser = async (userId: string): Promise<boolean> => {
    const userRecord = await db.select().from(users).where(eq(users.id, userId));
    if (userRecord.length === 0) return false;
    const user = userRecord[0];
    if (!user.isPremium) return false;
    if (user.premiumExpiresAt && new Date(user.premiumExpiresAt) < new Date()) return false;
    return true;
  };

  // Admin command to grant premium
  bot.command("premium", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const args = ctx.message?.text?.split(" ").slice(1) || [];
    if (args.length < 2) {
      return ctx.reply("👑 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗖𝗼𝗺𝗺𝗮𝗻𝗱\n\n📝 Usage: /premium <telegram_id> <days>\n\n📌 Example: /premium 123456789 30");
    }

    const telegramId = args[0];
    const days = parseInt(args[1]);

    if (isNaN(days) || days <= 0) {
      return ctx.reply("❌ 𝗜𝗻𝘃𝗮𝗹𝗶𝗱 𝗗𝗮𝘆𝘀\n\nPlease use a positive number.");
    }

    // Find user by telegram ID (stored as username)
    const userRecord = await db.select().from(users).where(eq(users.username, telegramId));

    if (userRecord.length === 0) {
      return ctx.reply("❌ 𝗨𝘀𝗲𝗿 𝗡𝗼𝘁 𝗙𝗼𝘂𝗻𝗱\n\nUser must have used the bot first.");
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    await db.update(users).set({
      isPremium: true,
      premiumExpiresAt: expiresAt
    }).where(eq(users.id, userRecord[0].id));

    // Send notification to the user
    try {
      const userTelegramId = parseInt(telegramId);
      const botUsername = cachedBotUsername || ctx.me.username;
      const userNotification =
        `🎉 <b>Congratulations!</b> 🎉\n\n` +
        `👑 You have been upgraded to <b>PREMIUM</b> membership!\n\n` +
        `✨ <b>Your Benefits:</b>\n` +
        `• Instant movie access - No verification needed\n` +
        `• Unlimited downloads\n` +
        `• Priority support\n` +
        `• Ad-free experience\n\n` +
        `📅 <b>Valid for:</b> ${days} days\n` +
        `⏳ <b>Expires:</b> ${expiresAt.toLocaleDateString()}\n\n` +
        `🎬 Start enjoying premium movies now!\n` +
        `👉 @${botUsername}`;

      await bot!.api.sendMessage(userTelegramId, userNotification, { parse_mode: "HTML" });
    } catch (e) {
      console.log("Could not send premium notification to user:", e);
    }

    await ctx.reply(`✅ 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗚𝗿𝗮𝗻𝘁𝗲𝗱!\n\n👤 User: ${escapeHtml(userRecord[0].displayName || 'Unknown')}\n🆔 ID: <code>${telegramId}</code>\n📅 Duration: ${days} days\n⏳ Expires: ${expiresAt.toLocaleDateString()}\n\n📨 User has been notified!`, { parse_mode: "HTML" });
  });

  // Admin command to remove premium
  bot.command("rmpremium", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const args = ctx.message?.text?.split(" ").slice(1) || [];
    if (args.length < 1) {
      return ctx.reply("👑 𝗥𝗲𝗺𝗼𝘃𝗲 𝗣𝗿𝗲𝗺𝗶𝘂𝗺\n\n📝 Usage: /rmpremium <telegram_id>");
    }

    const telegramId = args[0];
    const userRecord = await db.select().from(users).where(eq(users.username, telegramId));

    if (userRecord.length === 0) {
      return ctx.reply("❌ 𝗨𝘀𝗲𝗿 𝗡𝗼𝘁 𝗙𝗼𝘂𝗻𝗱\n\nUser must have used the bot first.");
    }

    await db.update(users).set({
      isPremium: false,
      premiumExpiresAt: null
    }).where(eq(users.id, userRecord[0].id));

    // Send notification to the user
    try {
      const userTelegramId = parseInt(telegramId);
      const botUsername = cachedBotUsername || ctx.me.username;
      const userNotification =
        `📢 <b>Premium Membership Update</b>\n\n` +
        `Your premium membership has been removed.\n\n` +
        `😊 Don't worry! You can still:\n` +
        `• Earn 2 free credits daily via verification\n` +
        `• Get 1 credit per referral\n` +
        `• Request movies\n\n` +
        `💎 Want premium back? Contact admin!\n\n` +
        `🎬 Continue using: @${botUsername}`;

      await bot!.api.sendMessage(userTelegramId, userNotification, { parse_mode: "HTML" });
    } catch (e) {
      console.log("Could not send premium removal notification to user:", e);
    }

    await ctx.reply(`✅ 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗥𝗲𝗺𝗼𝘃𝗲𝗱!\n\n👤 User: ${escapeHtml(userRecord[0].displayName || 'Unknown')}\n🆔 ID: <code>${telegramId}</code>\n\n📨 User has been notified!`, { parse_mode: "HTML" });
  });

  bot.command("credits", async (ctx) => {
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);
    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const credits = userRecord[0]?.credits || 0;
    const isPremium = userRecord[0]?.isPremium || false;

    let message = `💳 *Your Credits*\n\n`;
    message += `💰 Balance: *${credits} credits*\n\n`;
    message += `📋 *Credit System:*\n`;
    message += `• 1 credit = 1 movie access\n`;
    message += `• Access valid for 12 hours\n`;
    message += `• Earn 2 credits/12 hours\n\n`;
    message += `🎁 Use /earnCredits to earn more!`;
    message += getPremiumPromoMessage(isPremium);

    await ctx.reply(message, { parse_mode: "Markdown" });
  });

  bot.command("library", async (ctx) => {
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);
    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const isPremium = userRecord[0]?.isPremium || false;

    // Get all unlocked movies for this user
    const accessRecords = await db.select().from(movieAccess).where(eq(movieAccess.userId, user.id));

    if (accessRecords.length === 0) {
      let message = `📚 *My Library*\n\n`;
      message += `Your library is empty.\n\n`;
      message += `🔍 Use /search to find movies!`;
      message += getPremiumPromoMessage(isPremium);
      return ctx.reply(message, { parse_mode: "Markdown" });
    }

    // Get movie details
    const movieIds = accessRecords.map(a => a.movieId);
    const allMovies = await db.select().from(movies);
    const unlockedMovies = allMovies.filter(m => movieIds.includes(m.id)).slice(0, 10);

    // Create access map for expiry check
    const accessMap = new Map(accessRecords.map(a => [a.movieId, a.unlockedAt]));

    let message = `📚 *My Library*\n\n`;

    unlockedMovies.forEach((movie) => {
      const unlockedAt = accessMap.get(movie.id);
      const validity = unlockedAt ? isAccessValid(unlockedAt) : { valid: false, hoursRemaining: 0, minutesRemaining: 0 };

      if (validity.valid) {
        const timeLeft = validity.hoursRemaining > 0
          ? `${validity.hoursRemaining}h ${validity.minutesRemaining}m`
          : `${validity.minutesRemaining}m`;
        message += `🎬 *${escapeMarkdown(movie.displayTitle)}*\n   ✅ ${timeLeft} left\n   /getlink_${movie.id.slice(0, 8)}\n\n`;
      } else {
        message += `🎬 *${escapeMarkdown(movie.displayTitle)}*\n   ❌ Expired\n   /getlink_${movie.id.slice(0, 8)}\n\n`;
      }
    });

    message += getPremiumPromoMessage(isPremium);

    await ctx.reply(message, { parse_mode: "Markdown" });
  });

  bot.command("help", async (ctx) => {
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);
    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const isPremium = userRecord[0]?.isPremium || false;

    let message = `❓ 𝗛𝗲𝗹𝗽 & 𝗦𝘂𝗽𝗽𝗼𝗿𝘁\n\n`;
    message += `🎬 *How to Download Movies:*\n`;
    message += `1️⃣ /search <name> - Search movie\n`;
    message += `2️⃣ Select from results\n`;
    message += `3️⃣ Tap "Get Link"\n`;
    message += `4️⃣ Complete verification\n`;
    message += `5️⃣ Enjoy your movie!\n\n`;
    message += `💰 *Credits:*\n`;
    message += `• Each movie = 1 credit\n`;
    message += `• Access = 12 hours valid\n`;
    message += `• Earn = 2 credits/12h\n\n`;
    message += `📚 *Commands:*\n`;
    message += `/start - Main menu\n`;
    message += `/search <name> - Search movie\n`;
    message += `/earnCredits - Earn credits\n`;
    message += `/credits - Check balance\n`;
    message += `/library - Your movies`;
    message += getPremiumPromoMessage(isPremium);

    await ctx.reply(message, { parse_mode: "Markdown" });
  });

  // ==================== NEW FEATURES ====================

  // 1. /profile - User stats
  bot.command("profile", async (ctx) => {
    const firstName = ctx.from?.first_name || "User";
    const { user } = await getOrCreateUser(ctx.from!.id, firstName);
    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const userData = userRecord[0];

    // Count downloads (movie access)
    const downloads = await db.select({ count: sql<number>`count(*)` }).from(movieAccess).where(eq(movieAccess.userId, user.id));
    const downloadCount = downloads[0]?.count || 0;

    // Count referrals
    const refs = await db.select({ count: sql<number>`count(*)` }).from(referrals).where(eq(referrals.referrerId, user.id));
    const referralCount = refs[0]?.count || 0;

    const joinDate = userData?.createdAt ? new Date(userData.createdAt).toLocaleDateString('en-IN') : 'Unknown';
    const safeName = firstName.replace(/_/g, " ");

    let message = `👤 ${safeName} ka Profile\n\n`;
    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `🆔 Telegram ID: ${ctx.from!.id}\n`;
    message += `📅 Join Date: ${joinDate}\n`;
    message += `💳 Credits: ${userData?.credits || 0}\n`;
    message += `🎬 Downloads: ${downloadCount}\n`;
    message += `👥 Referrals: ${referralCount}\n`;
    message += `👑 Premium: ${userData?.isPremium ? 'Yes' : 'No'}\n`;
    message += `━━━━━━━━━━━━━━━━━━\n\n`;
    message += `🔗 Referral Link:\nt.me/${cachedBotUsername || ctx.me.username}?start=ref_${ctx.from!.id}`;
    message += getPremiumPromoMessagePlain(userData?.isPremium || false);

    await ctx.reply(message);
  });

  // 2. /refer - Referral system info
  bot.command("refer", async (ctx) => {
    const botUsername = cachedBotUsername || ctx.me.username;
    const refLink = `t.me/${botUsername}?start=ref_${ctx.from!.id}`;

    // Count referrals
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);
    const refs = await db.select({ count: sql<number>`count(*)` }).from(referrals).where(eq(referrals.referrerId, user.id));
    const referralCount = refs[0]?.count || 0;

    let message = `👥 𝗥𝗲𝗳𝗲𝗿𝗿𝗮𝗹 𝗣𝗿𝗼𝗴𝗿𝗮𝗺\n\n`;
    message += `🎁 Invite friends, earn 1 credit each!\n\n`;
    message += `📊 Your Stats:\n`;
    message += `• Total Referrals: ${referralCount}\n`;
    message += `• Credits Earned: ${referralCount} credits\n\n`;
    message += `🔗 Your Referral Link:\n${refLink}\n\n`;
    message += `📋 How it works:\n`;
    message += `1️⃣ Share link with friends\n`;
    message += `2️⃣ When they join, you earn 1 credit\n`;
    message += `3️⃣ Unlimited referrals allowed!`;

    await ctx.reply(message);
  });

  // 3. /request - Movie request
  bot.command("request", async (ctx) => {
    const movieName = ctx.message?.text?.replace("/request", "").trim();

    if (!movieName) {
      return ctx.reply("📝 𝗠𝗼𝘃𝗶𝗲 𝗥𝗲𝗾𝘂𝗲𝘀𝘁\n\n✍️ /request <movie name>\n\n📌 Example: /request Pushpa 2");
    }

    const firstName = ctx.from?.first_name || "User";
    const { user } = await getOrCreateUser(ctx.from!.id, firstName);

    // Check if already requested
    const existing = await db.select().from(movieRequests)
      .where(and(eq(movieRequests.userId, user.id), eq(movieRequests.movieName, movieName), eq(movieRequests.status, "pending")));

    if (existing.length > 0) {
      return ctx.reply(`⚠️ 𝗥𝗲𝗾𝘂𝗲𝘀𝘁 𝗔𝗹𝗿𝗲𝗮𝗱𝘆 𝗣𝗲𝗻𝗱𝗶𝗻𝗴\n\n"${movieName}" already has a pending request!\n\n⏳ Admin will review soon.`);
    }

    await db.insert(movieRequests).values({
      userId: user.id,
      movieName: movieName,
      status: "pending"
    });

    await ctx.reply(`✅ 𝗥𝗲𝗾𝘂𝗲𝘀𝘁 𝗦𝘂𝗯𝗺𝗶𝘁𝘁𝗲𝗱!\n\n🎬 Movie: ${movieName}\n📋 Status: Pending\n\n⏳ Admin will review soon!`);
  });

  // 4. /myrequests - View user's requests
  bot.command("myrequests", async (ctx) => {
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);
    const requests = await db.select().from(movieRequests).where(eq(movieRequests.userId, user.id)).orderBy(desc(movieRequests.createdAt)).limit(10);

    if (requests.length === 0) {
      return ctx.reply("📝 𝗡𝗼 𝗥𝗲𝗾𝘂𝗲𝘀𝘁𝘀 𝗬𝗲𝘁\n\nYou haven't made any movie requests yet.\n\n✍️ To request a movie:\n/request <movie name>");
    }

    let message = `📝 Your Movie Requests:\n\n`;
    requests.forEach((req, i) => {
      const status = req.status === "pending" ? "⏳ Pending" : req.status === "approved" ? "✅ Approved" : "❌ Rejected";
      message += `${i + 1}. ${req.movieName}\n   Status: ${status}\n\n`;
    });

    await ctx.reply(message);
  });

  // 5. Admin: /requests - View all pending requests
  bot.command("requests", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const pendingRequests = await db.select().from(movieRequests).where(eq(movieRequests.status, "pending")).orderBy(desc(movieRequests.createdAt)).limit(20);

    if (pendingRequests.length === 0) {
      return ctx.reply("✅ 𝗡𝗼 𝗣𝗲𝗻𝗱𝗶𝗻𝗴 𝗥𝗲𝗾𝘂𝗲𝘀𝘁𝘀\n\nAll requests have been processed!");
    }

    let message = `📝 Pending Movie Requests (${pendingRequests.length}):\n\n`;
    for (const req of pendingRequests) {
      const userRecord = await db.select().from(users).where(eq(users.id, req.userId));
      const userName = userRecord[0]?.displayName || "Unknown";
      message += `• ${req.movieName}\n  By: ${userName.replace(/_/g, " ")}\n  ID: ${req.id.slice(0, 8)}\n\n`;
    }
    message += `\nApprove: /approvereq <id>\nReject: /rejectreq <id>`;

    await ctx.reply(message);
  });

  // Admin: /approvereq - Approve request (requires full or unique ID prefix)
  bot.command("approvereq", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const reqId = ctx.message?.text?.replace("/approvereq", "").trim();
    if (!reqId || reqId.length < 8) {
      return ctx.reply("✅ 𝗔𝗽𝗽𝗿𝗼𝘃𝗲 𝗥𝗲𝗾𝘂𝗲𝘀𝘁\n\n📝 Usage: /approvereq <request_id>\n\n📌 Minimum 8 characters required");
    }

    const request = await db.select().from(movieRequests).where(sql`${movieRequests.id}::text LIKE ${reqId + '%'}`);
    if (request.length === 0) {
      return ctx.reply("❌ 𝗥𝗲𝗾𝘂𝗲𝘀𝘁 𝗡𝗼𝘁 𝗙𝗼𝘂𝗻𝗱");
    }
    if (request.length > 1) {
      return ctx.reply("⚠️ 𝗠𝘂𝗹𝘁𝗶𝗽𝗹𝗲 𝗠𝗮𝘁𝗰𝗵𝗲𝘀\n\nPlease use a longer ID prefix.");
    }

    await db.update(movieRequests).set({ status: "approved", resolvedAt: new Date() }).where(eq(movieRequests.id, request[0].id));
    await ctx.reply(`✅ 𝗥𝗲𝗾𝘂𝗲𝘀𝘁 𝗔𝗽𝗽𝗿𝗼𝘃𝗲𝗱!\n\n🎬 Movie: ${request[0].movieName}`);
  });

  // Admin: /rejectreq - Reject request (requires full or unique ID prefix)
  bot.command("rejectreq", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const reqId = ctx.message?.text?.replace("/rejectreq", "").trim();
    if (!reqId || reqId.length < 8) {
      return ctx.reply("❌ 𝗥𝗲𝗷𝗲𝗰𝘁 𝗥𝗲𝗾𝘂𝗲𝘀𝘁\n\n📝 Usage: /rejectreq <request_id>\n\n📌 Minimum 8 characters required");
    }

    const request = await db.select().from(movieRequests).where(sql`${movieRequests.id}::text LIKE ${reqId + '%'}`);
    if (request.length === 0) {
      return ctx.reply("❌ 𝗥𝗲𝗾𝘂𝗲𝘀𝘁 𝗡𝗼𝘁 𝗙𝗼𝘂𝗻𝗱");
    }
    if (request.length > 1) {
      return ctx.reply("⚠️ 𝗠𝘂𝗹𝘁𝗶𝗽𝗹𝗲 𝗠𝗮𝘁𝗰𝗵𝗲𝘀\n\nPlease use a longer ID prefix.");
    }

    await db.update(movieRequests).set({ status: "rejected", resolvedAt: new Date() }).where(eq(movieRequests.id, request[0].id));
    await ctx.reply(`❌ 𝗥𝗲𝗾𝘂𝗲𝘀𝘁 𝗥𝗲𝗷𝗲𝗰𝘁𝗲𝗱\n\n🎬 Movie: ${request[0].movieName}`);
  });

  // 6. Admin: /ban - Ban user
  bot.command("ban", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const userId = ctx.message?.text?.replace("/ban", "").trim();
    if (!userId) {
      return ctx.reply("🚫 𝗕𝗮𝗻 𝗨𝘀𝗲𝗿\n\n📝 Usage: /ban <telegram_id>");
    }

    const targetUser = await db.select().from(users).where(eq(users.username, userId));
    if (targetUser.length === 0) {
      return ctx.reply("❌ 𝗨𝘀𝗲𝗿 𝗡𝗼𝘁 𝗙𝗼𝘂𝗻𝗱");
    }

    await db.update(users).set({ status: "banned" }).where(eq(users.username, userId));
    await ctx.reply(`🚫 𝗨𝘀𝗲𝗿 𝗕𝗮𝗻𝗻𝗲𝗱!\n\n👤 ${targetUser[0].displayName}\n🆔 ${userId}`);
  });

  // Admin: /unban - Unban user
  bot.command("unban", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const userId = ctx.message?.text?.replace("/unban", "").trim();
    if (!userId) {
      return ctx.reply("✅ 𝗨𝗻𝗯𝗮𝗻 𝗨𝘀𝗲𝗿\n\n📝 Usage: /unban <telegram_id>");
    }

    const targetUser = await db.select().from(users).where(eq(users.username, userId));
    if (targetUser.length === 0) {
      return ctx.reply("❌ 𝗨𝘀𝗲𝗿 𝗡𝗼𝘁 𝗙𝗼𝘂𝗻𝗱");
    }

    await db.update(users).set({ status: "active" }).where(eq(users.username, userId));
    await ctx.reply(`✅ 𝗨𝘀𝗲𝗿 𝗨𝗻𝗯𝗮𝗻𝗻𝗲𝗱!\n\n👤 ${targetUser[0].displayName}\n🆔 ${userId}`);
  });

  // Admin: /banned - List banned users
  bot.command("banned", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const bannedUsers = await db.select().from(users).where(eq(users.status, "banned"));

    if (bannedUsers.length === 0) {
      return ctx.reply("✅ No banned users!");
    }

    let message = `🚫 Banned Users (${bannedUsers.length}):\n\n`;
    bannedUsers.forEach((u, i) => {
      message += `${i + 1}. ${u.displayName.replace(/_/g, " ")} (ID: ${u.username})\n`;
    });
    message += `\nUnban: /unban <telegram_id>`;

    await ctx.reply(message);
  });

  // 7. Admin: /stats - Bot statistics
  bot.command("stats", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const totalUsers = await db.select({ count: sql<number>`count(*)` }).from(users);
    const premiumUsers = await db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.isPremium, true));
    const bannedUsers = await db.select({ count: sql<number>`count(*)` }).from(users).where(eq(users.status, "banned"));
    const totalMovies = await db.select({ count: sql<number>`count(*)` }).from(movies).where(eq(movies.status, "published"));
    const totalDownloads = await db.select({ count: sql<number>`count(*)` }).from(movieAccess);
    const totalReferrals = await db.select({ count: sql<number>`count(*)` }).from(referrals);
    const pendingRequests = await db.select({ count: sql<number>`count(*)` }).from(movieRequests).where(eq(movieRequests.status, "pending"));

    let message = `📊 Bot Statistics\n\n`;
    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `👥 Total Users: ${totalUsers[0]?.count || 0}\n`;
    message += `👑 Premium Users: ${premiumUsers[0]?.count || 0}\n`;
    message += `🚫 Banned Users: ${bannedUsers[0]?.count || 0}\n`;
    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `🎬 Total Movies: ${totalMovies[0]?.count || 0}\n`;
    message += `📥 Total Downloads: ${totalDownloads[0]?.count || 0}\n`;
    message += `👥 Total Referrals: ${totalReferrals[0]?.count || 0}\n`;
    message += `📝 Pending Requests: ${pendingRequests[0]?.count || 0}\n`;
    message += `━━━━━━━━━━━━━━━━━━`;

    await ctx.reply(message);
  });

  // ==================== END NEW FEATURES ====================

  bot.command("addfiles", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    ctx.session.pendingMovie = { fuzzyKey: "", displayTitle: "", links: [], files: [] };
    await ctx.reply("🎬 Add New Movie\n\nFuzzy Search Keyword bhejo (search ke liye):\n\n(Cancel karne ke liye /canceladd bhejo)");
  });

  bot.command("canceladd", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    if (ctx.session.pendingMovie) {
      ctx.session.pendingMovie = undefined;
      await ctx.reply("❌ Movie adding cancelled.");
    } else {
      await ctx.reply("No pending movie to cancel.");
    }
  });

  bot.command("end", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    if (!ctx.session.pendingMovie || !ctx.session.pendingMovie.fuzzyKey) {
      return ctx.reply("No pending movie. Use /addfiles first.");
    }

    const movie = ctx.session.pendingMovie;

    // Insert movie
    const insertedMovie = await db.insert(movies).values({
      fuzzyKey: movie.fuzzyKey,
      displayTitle: movie.displayTitle,
      links: movie.links,
      status: "published"
    }).returning();

    const movieId = insertedMovie[0].id;

    // Insert file assets
    let orderIndex = 0;
    for (const file of movie.files) {
      await db.insert(movieAssets).values({
        movieId,
        assetType: file.type,
        telegramFileId: file.fileId,
        telegramFileUniqueId: file.fileUniqueId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        caption: file.caption,
        orderIndex: orderIndex++,
      });
    }

    // Insert links as assets too
    for (const link of movie.links) {
      await db.insert(movieAssets).values({
        movieId,
        assetType: 'link',
        url: link,
        orderIndex: orderIndex++,
      });
    }

    ctx.session.pendingMovie = undefined;
    const totalAssets = movie.files.length + movie.links.length;
    const movieIdPrefix = movieId.slice(0, 8);
    await ctx.reply(`✅ 𝗠𝗼𝘃𝗶𝗲 𝗦𝗮𝘃𝗲𝗱!\n\n🎬 ${movie.displayTitle}\n📁 ${movie.files.length} files\n🔗 ${movie.links.length} links\n\n👇 Preview:\n/get_${movieIdPrefix}\n\n⚠️ Users need verification to access.`);
  });

  bot.command("list", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const allMovies = await db.select().from(movies);

    if (allMovies.length === 0) {
      return ctx.reply("📽️ No movies added yet.\n\nUse /addfiles to add movies.");
    }

    let message = `📽️ <b>Total Movies: ${allMovies.length}</b>\n\n`;

    allMovies.slice(0, 20).forEach((movie: typeof movies.$inferSelect, index: number) => {
      const movieIdPrefix = movie.id.slice(0, 8);
      const safeTitle = escapeHtml(movie.displayTitle);
      const statusIcon = movie.status === 'published' ? '✅' : '⏳';
      message += `${index + 1}. ${statusIcon} ${safeTitle}\n   <code>/getlink_${movieIdPrefix}</code>\n\n`;
    });

    if (allMovies.length > 20) {
      message += `\n... and ${allMovies.length - 20} more`;
    }

    await ctx.reply(message, { parse_mode: "HTML" });
  });

  bot.command("reset", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const targetUserId = ctx.message?.text?.replace("/reset", "").trim();
    if (!targetUserId) {
      return ctx.reply("Usage: /reset <telegram_id>");
    }

    const user = await db.select().from(users).where(eq(users.username, targetUserId));
    if (user.length === 0) {
      return ctx.reply("❌ 𝗨𝘀𝗲𝗿 𝗡𝗼𝘁 𝗙𝗼𝘂𝗻𝗱");
    }

    await db.update(users).set({ credits: 0, lastCreditReset: new Date() }).where(eq(users.id, user[0].id));
    await ctx.reply(`✅ 𝗖𝗿𝗲𝗱𝗶𝘁𝘀 𝗥𝗲𝘀𝗲𝘁!\n\n👤 ${user[0].displayName}`);
  });

  bot.command("addtokens", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const token = ctx.message?.text?.replace("/addtokens", "").trim();
    if (!token) {
      return ctx.reply("🔗 𝗔𝗱𝗱 𝗧𝗼𝗸𝗲𝗻\n\n📝 Usage: /addtokens <api_token>");
    }

    await db.update(shortenerTokens).set({ isActive: false });
    await db.insert(shortenerTokens).values({ tokenValue: token, isActive: true });
    await ctx.reply("✅ 𝗧𝗼𝗸𝗲𝗻 𝗔𝗱𝗱𝗲𝗱!\n\nGPlinks token activated successfully.");
  });

  bot.command("showtokens", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const tokens = await db.select().from(shortenerTokens);
    let message = `🔑 *Tokens (${tokens.length}):*\n\n`;

    tokens.forEach((token: typeof shortenerTokens.$inferSelect, index: number) => {
      message += `${index + 1}. ${token.tokenValue.slice(0, 30)}... ${token.isActive ? "✅" : "❌"}\n`;
    });

    await ctx.reply(message, { parse_mode: "Markdown" });
  });

  bot.command("howto", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const text = ctx.message?.text?.replace("/howto", "").trim();
    if (!text) {
      return ctx.reply("📖 𝗦𝗲𝘁 𝗜𝗻𝘀𝘁𝗿𝘂𝗰𝘁𝗶𝗼𝗻𝘀\n\n📝 Usage: /howto <instructions text>");
    }

    await db.update(instructions).set({ isActive: false });
    await db.insert(instructions).values({ body: text, isActive: true });
    await ctx.reply("✅ 𝗜𝗻𝘀𝘁𝗿𝘂𝗰𝘁𝗶𝗼𝗻𝘀 𝗨𝗽𝗱𝗮𝘁𝗲𝗱!");
  });

  bot.command("myswitch", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const currentStatus = await getBotStatus();
    const newStatus = !currentStatus;

    const existing = await db.select().from(settings).where(eq(settings.key, "bot_active"));
    if (existing.length > 0) {
      await db.update(settings).set({ value: newStatus ? "true" : "false" }).where(eq(settings.key, "bot_active"));
    } else {
      await db.insert(settings).values({ key: "bot_active", value: newStatus ? "true" : "false" });
    }

    await ctx.reply(`🔄 𝗕𝗼𝘁 𝗦𝘁𝗮𝘁𝘂𝘀 𝗖𝗵𝗮𝗻𝗴𝗲𝗱\n\n${newStatus ? "✅ Bot is now ACTIVE" : "❌ Bot is now STOPPED"}`);
  });

  const escapeMarkdown = (text: string): string => {
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
  };

  bot.command("admins", async (ctx) => {
    const callerTelegramId = ctx.from!.id;

    // Only owner (ADMIN_IDS) can use this command
    if (!ADMIN_IDS.includes(callerTelegramId)) {
      return ctx.reply("🔒 𝗢𝘄𝗻𝗲𝗿 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const admins = await db.select().from(users).where(eq(users.role, "admin"));
    let message = `👑 *Admins (${admins.length}):*\n\n`;
    admins.forEach((admin: typeof users.$inferSelect, index: number) => {
      const name = admin.displayName || "Unknown";
      message += `${index + 1}. *${name}* (ID: \`${admin.username}\`)\n`;
    });
    message += `\n*Root Admins:* \`${ADMIN_IDS.join(", ")}\``;
    message += `\n\nTo add admin: /addadmin <telegram_id>`;
    return ctx.reply(message, { parse_mode: "Markdown" });
  });

  // Alias for /admins
  bot.command("admin", async (ctx) => {
    const callerTelegramId = ctx.from!.id;

    if (!ADMIN_IDS.includes(callerTelegramId)) {
      return ctx.reply("🔒 𝗢𝘄𝗻𝗲𝗿 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const admins = await db.select().from(users).where(eq(users.role, "admin"));
    let message = `👑 Admins (${admins.length}):\n\n`;
    admins.forEach((admin: typeof users.$inferSelect, index: number) => {
      const name = (admin.displayName || "Unknown").replace(/_/g, " ");
      message += `${index + 1}. ${name} (ID: ${admin.username})\n`;
    });
    message += `\nRoot Admins: ${ADMIN_IDS.join(", ")}`;
    message += `\n\nTo add admin: /addadmin <telegram_id>`;
    return ctx.reply(message);
  });

  bot.command("addadmin", async (ctx) => {
    const callerTelegramId = ctx.from!.id;

    // Only owner (ADMIN_IDS) can add admins
    if (!ADMIN_IDS.includes(callerTelegramId)) {
      return ctx.reply("🔒 𝗢𝘄𝗻𝗲𝗿 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const text = ctx.message?.text?.replace("/addadmin", "").trim();
    if (!text) {
      return ctx.reply("👑 𝗔𝗱𝗱 𝗔𝗱𝗺𝗶𝗻\n\n📝 Usage: /addadmin <telegram_id>\n\n📌 Example: /addadmin 123456789");
    }

    const targetTelegramId = parseInt(text);
    if (isNaN(targetTelegramId)) {
      return ctx.reply("❌ 𝗜𝗻𝘃𝗮𝗹𝗶𝗱 𝗜𝗗\n\nPlease provide a valid Telegram ID (numbers only).");
    }

    if (targetTelegramId === callerTelegramId) {
      return ctx.reply("❌ 𝗦𝗲𝗹𝗳 𝗣𝗿𝗼𝗺𝗼𝘁𝗶𝗼𝗻 𝗡𝗼𝘁 𝗔𝗹𝗹𝗼𝘄𝗲𝗱");
    }

    const user = await db.select().from(users).where(eq(users.username, text));

    if (user.length === 0) {
      // User not in database, create new admin user
      await db.insert(users).values({
        username: text,
        displayName: `Admin_${text}`,
        role: "admin",
      });
      return ctx.reply(`✅ 𝗔𝗱𝗺𝗶𝗻 𝗔𝗱𝗱𝗲𝗱!\n\n🆔 ${text}\n\n📌 Will become admin when they use /start`);
    }

    if (user[0].role === "admin") {
      return ctx.reply(`⚠️ 𝗔𝗹𝗿𝗲𝗮𝗱𝘆 𝗔𝗱𝗺𝗶𝗻\n\n👤 ${user[0].displayName}`);
    }

    await db.update(users).set({ role: "admin" }).where(eq(users.id, user[0].id));
    await ctx.reply(`✅ 𝗔𝗱𝗺𝗶𝗻 𝗔𝗱𝗱𝗲𝗱!\n\n👤 ${user[0].displayName}`);
  });

  bot.command("forsub", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const channelUrl = ctx.message?.text?.replace("/forsub", "").trim();
    if (!channelUrl) {
      const rules = await db.select().from(forceSubscribeRules).where(eq(forceSubscribeRules.isActive, true));
      let message = `📢 <b>Force Subscribe Channels:</b>\n\n`;
      if (rules.length === 0) {
        message += `No channels added yet.\n\n`;
      } else {
        rules.forEach((rule, index) => {
          message += `${index + 1}. <code>${escapeHtml(rule.channelUrl)}</code>\n`;
        });
        message += `\n`;
      }
      message += `<b>Add channel:</b>\n`;
      message += `Public: <code>/forsub @channelname</code>\n`;
      message += `Private: <code>/forsub -100xxxx https://t.me/+invitelink</code>\n\n`;
      message += `<b>Remove:</b>\n`;
      message += `• <code>/unforsub @channelname</code>\n`;
      message += `• <code>/unforsub -100xxxx</code>\n`;
      message += `• <code>/unforsub</code> (show list)`;
      return ctx.reply(message, { parse_mode: "HTML" });
    }

    await db.insert(forceSubscribeRules).values({ channelUrl, isActive: true });
    await ctx.reply(`✅ Force subscribe channel added!\n\nChannel ID: <code>${escapeHtml(channelUrl)}</code>`, { parse_mode: "HTML" });
  });

  bot.command("unforsub", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const input = ctx.message?.text?.replace("/unforsub", "").trim();

    // Get all active channels
    const activeChannels = await db.select().from(forceSubscribeRules).where(eq(forceSubscribeRules.isActive, true));

    if (!input) {
      if (activeChannels.length === 0) {
        return ctx.reply("📢 𝗡𝗼 𝗙𝗼𝗿𝗰𝗲 𝗦𝘂𝗯𝘀𝗰𝗿𝗶𝗯𝗲 𝗖𝗵𝗮𝗻𝗻𝗲𝗹𝘀\n\nNo channels to remove.");
      }

      let message = `📢 𝗙𝗼𝗿𝗰𝗲 𝗦𝘂𝗯𝘀𝗰𝗿𝗶𝗯𝗲 𝗖𝗵𝗮𝗻𝗻𝗲𝗹𝘀:\n\n`;
      activeChannels.forEach((ch, i) => {
        message += `${i + 1}. <code>${escapeHtml(ch.channelUrl)}</code>\n`;
      });
      message += `\n<b>Remove:</b>\n`;
      message += `• <code>/unforsub @channelname</code>\n`;
      message += `• <code>/unforsub -100xxxx</code>\n`;
      message += `• <code>/unforsub https://t.me/+invitelink</code>`;
      return ctx.reply(message, { parse_mode: "HTML" });
    }

    // Find matching channel - support @username, -100xxx ID, or invite link
    let foundChannel = null;

    for (const ch of activeChannels) {
      const stored = ch.channelUrl.toLowerCase();
      const search = input.toLowerCase();

      // Exact match
      if (stored === search) {
        foundChannel = ch;
        break;
      }

      // @username match (stored might be @channel or just channel)
      if (search.startsWith("@")) {
        const searchName = search.substring(1);
        if (stored === search || stored === searchName || stored === `@${searchName}`) {
          foundChannel = ch;
          break;
        }
      }

      // ID match (-100xxxx)
      if (search.startsWith("-100") && stored.includes(search)) {
        foundChannel = ch;
        break;
      }

      // Partial match for invite links
      if (stored.includes(search) || search.includes(stored)) {
        foundChannel = ch;
        break;
      }
    }

    if (!foundChannel) {
      let message = `❌ 𝗖𝗵𝗮𝗻𝗻𝗲𝗹 𝗡𝗼𝘁 𝗙𝗼𝘂𝗻𝗱\n\n`;
      message += `Active channels:\n`;
      activeChannels.forEach((ch, i) => {
        message += `${i + 1}. <code>${escapeHtml(ch.channelUrl)}</code>\n`;
      });
      return ctx.reply(message, { parse_mode: "HTML" });
    }

    await db.update(forceSubscribeRules).set({ isActive: false }).where(eq(forceSubscribeRules.id, foundChannel.id));
    await ctx.reply(`✅ 𝗖𝗵𝗮𝗻𝗻𝗲𝗹 𝗥𝗲𝗺𝗼𝘃𝗲𝗱\n\n<code>${escapeHtml(foundChannel.channelUrl)}</code> removed from force subscribe!`, { parse_mode: "HTML" });
  });

  bot.command("delete", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    let movieName = ctx.message?.text?.replace("/delete", "").trim();
    if (!movieName) {
      return ctx.reply("Usage: /delete <movie_name>");
    }

    // Remove angle brackets if present (e.g., /delete <Cult> -> Cult)
    movieName = movieName.replace(/^<|>$/g, "").trim();

    const allMovies = await db.select().from(movies);
    const fuse = new Fuse(allMovies, { keys: ["displayTitle", "fuzzyKey"], threshold: 0.25 });
    const results = fuse.search(movieName);

    if (results.length === 0) {
      return ctx.reply(getNotFoundMessage());
    }

    const movie = results[0].item as typeof movies.$inferSelect;

    // Delete related records first (foreign key constraints)
    await db.delete(movieAssets).where(eq(movieAssets.movieId, movie.id));
    await db.delete(movieAccess).where(eq(movieAccess.movieId, movie.id));
    await db.delete(movieVerifications).where(eq(movieVerifications.movieId, movie.id));

    // Now delete the movie
    await db.delete(movies).where(eq(movies.id, movie.id));
    await ctx.reply(`✅ 𝗠𝗼𝘃𝗶𝗲 𝗗𝗲𝗹𝗲𝘁𝗲𝗱!\n\n🎬 ${movie.displayTitle}`);
  });

  bot.command("addpost", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    const text = ctx.message?.text?.replace("/addpost", "").trim();
    if (!text) {
      return ctx.reply("Usage: /addpost <title> | <body>");
    }

    const parts = text.split("|").map(p => p.trim());
    const title = parts[0] || "Announcement";
    const body = parts[1] || text;

    await db.insert(posts).values({ title, body });
    await ctx.reply(`✅ 𝗣𝗼𝘀𝘁 𝗖𝗿𝗲𝗮𝘁𝗲𝗱!\n\n📝 ${title}`);
  });

  // ======= BROADCAST COMMANDS =======
  bot.command("broadcast", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    ctx.session.broadcastMode = true;
    await ctx.reply(`📢 𝗕𝗿𝗼𝗮𝗱𝗰𝗮𝘀𝘁 𝗠𝗼𝗱𝗲 𝗢𝗡\n\nAny message you send (text, photo, video, document, audio, etc.) will be forwarded to all users.\n\nSend /cancelbroadcast to cancel.`, { parse_mode: "Markdown" });
  });

  bot.command("cancelbroadcast", async (ctx) => {
    if (!await isAdmin(ctx.from!.id)) {
      return ctx.reply("🔒 𝗔𝗱𝗺𝗶𝗻 𝗢𝗻𝗹𝘆 𝗖𝗼𝗺𝗺𝗮𝗻𝗱");
    }

    ctx.session.broadcastMode = false;
    await ctx.reply("❌ Broadcast mode OFF");
  });

  // ======= CALLBACK QUERY HANDLERS =======
  bot.callbackQuery("verifyjoin", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { allJoined, channels } = await checkForceSubscribe(bot!, ctx.from!.id);

    if (!allJoined) {
      let message = `❌ 𝗦𝘁𝗶𝗹𝗹 𝗡𝗼𝘁 𝗝𝗼𝗶𝗻𝗲𝗱!\n\n📢 Join the channels below\n✅ After joining, tap "Verify Join"\n\n`;
      message += `⚠️ Some channels couldn't be verified. Join them and try again.`;

      const keyboard = new InlineKeyboard();
      let channelNum = 1;
      for (const channel of channels) {
        if (!channel.joined) {
          const channelUrl = channel.url.startsWith("http") ? channel.url : `https://t.me/${channel.id.replace("@", "")}`;
          keyboard.url(`📢 Join Channel ${channelNum}`, channelUrl).row();
          channelNum++;
        }
      }
      keyboard.text("✅ Verify Join", "verifyjoin").row();

      await ctx.editMessageText(message, { parse_mode: "Markdown", reply_markup: keyboard });
    } else {
      const firstName = ctx.from?.first_name || "User";
      const { user } = await getOrCreateUser(ctx.from!.id, firstName);
      const userRecord = await db.select().from(users).where(eq(users.id, user.id));
      const credits = userRecord[0]?.credits || 0;

      const safeName = firstName.replace(/_/g, " ");
      await ctx.editMessageText(`✅ 𝗩𝗲𝗿𝗶𝗳𝗶𝗰𝗮𝘁𝗶𝗼𝗻 𝗦𝘂𝗰𝗰𝗲𝘀𝘀𝗳𝘂𝗹!\n\n🎉 Welcome ${safeName}!\n\nYou can now use the bot. Start searching movies!`);

      const welcomeMessage = `😊 Activate Your Account Today! 😊\n\n🎉 Enjoy 2 FREE movie downloads every day! 🎬✨\n\nSimply activate your account daily and get seamless access to your favorite movies, absolutely FREE! 🚀\n\n👇 Tap below to activate now and start watching! 🎥🍿`;

      await ctx.reply(welcomeMessage, { reply_markup: getMainMenuKeyboard() });
    }
  });

  bot.callbackQuery("activate", async (ctx) => {
    await ctx.answerCallbackQuery();
    const firstName = ctx.from?.first_name || "User";
    const { user } = await getOrCreateUser(ctx.from!.id, firstName);
    const { canEarn, hoursRemaining, minutesRemaining } = await canEarnCredits(user.id);

    if (!canEarn) {
      const backKeyboard = new InlineKeyboard().text("⬅️ Back to Menu", "backtomenu");
      return ctx.editMessageText(`⏰ 𝗧𝗼𝗸𝗲𝗻 𝗔𝗹𝗿𝗲𝗮𝗱𝘆 𝗔𝗰𝘁𝗶𝘃𝗲!\n\nYou already have 2 credits!\n\nNext activation: ${hoursRemaining}h ${minutesRemaining}m\n\nStart searching movies now!`, { parse_mode: "Markdown", reply_markup: backKeyboard });
    }

    // Generate GPlinks short URL
    const botUsername = cachedBotUsername || ctx.me.username;
    const verificationUrl = `https://t.me/${botUsername}?start=verified_${user.id}`;
    const shortUrl = await generateShortLink(verificationUrl);

    if (shortUrl) {
      const keyboard = new InlineKeyboard()
        .url("😊 Activate 😊", shortUrl).row()
        .text("⬅️ Back to Menu", "backtomenu");

      await ctx.editMessageText(`😊 *Activate Your Account Today!* 😊\n\n🎉 Enjoy *2 FREE* movie downloads every day! 🎬✨\n\nSimply activate your account daily and get seamless access to your favorite movies—absolutely *FREE!* 🚀\n\n👇 Tap below to activate now and start watching! 🎥🍿`, { parse_mode: "Markdown", reply_markup: keyboard });
    } else {
      const backKeyboard = new InlineKeyboard().text("⬅️ Back to Menu", "backtomenu");
      await ctx.editMessageText(`❌ 𝗟𝗶𝗻𝗸 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗶𝗼𝗻 𝗙𝗮𝗶𝗹𝗲𝗱\n\nPlease contact admin or try again later.`, { parse_mode: "Markdown", reply_markup: backKeyboard });
    }
  });

  bot.callbackQuery("backtomenu", async (ctx) => {
    await ctx.answerCallbackQuery();
    const firstName = ctx.from?.first_name || "User";
    const { user } = await getOrCreateUser(ctx.from!.id, firstName);
    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const credits = userRecord[0]?.credits || 0;
    const isPremium = userRecord[0]?.isPremium || false;

    let welcomeMessage = `🌹 *Welcome ${firstName}!*\n\n`;
    if (isPremium) {
      welcomeMessage += `👑 *Premium Member*\n\n`;
    }
    welcomeMessage += `Main *Rose Bot* hoon. Movie search karne ke liye neeche button dabao ya movie ka naam likho.\n\n`;
    welcomeMessage += `✨ Fuzzy search hai, thoda galat bhi likha to mil jayegi!\n\n`;
    welcomeMessage += `💳 Credits: ${credits}`;

    await ctx.editMessageText(welcomeMessage, { parse_mode: "Markdown", reply_markup: getMainMenuKeyboard() });
  });

  // Premium info callback
  bot.callbackQuery("premium_info", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);
    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const isPremium = userRecord[0]?.isPremium || false;
    const expiresAt = userRecord[0]?.premiumExpiresAt;

    let message = `👑 *Premium Membership*\n\n`;

    if (isPremium && expiresAt) {
      const daysLeft = Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      message += `✅ *Status:* Active\n`;
      message += `📅 *Expires:* ${daysLeft} days left\n\n`;
      message += `🎁 *Your Benefits:*\n`;
      message += `✨ Instant movie access, No verification!\n`;
      message += `✨ Unlimited downloads\n`;
      message += `✨ No credit required\n`;
      message += `✨ Priority support`;
    } else {
      message += `❌ *Status:* Not Active\n\n`;
      message += `🎁 *Premium Benefits:*\n`;
      message += `✨ Instant movie access, No verification!\n`;
      message += `✨ Unlimited downloads\n`;
      message += `✨ No credit required\n`;
      message += `✨ Priority support\n\n`;
      message += `💰 *Price:* Contact admin for pricing`;
    }

    const keyboard = new InlineKeyboard()
      .text("📞 Contact Admin", "contact_admin")
      .row()
      .text("⬅️ Back to Menu", "backtomenu");

    await ctx.editMessageText(message, { parse_mode: "Markdown", reply_markup: keyboard });
  });

  // Contact admin callback
  bot.callbackQuery("contact_admin", async (ctx) => {
    await ctx.answerCallbackQuery();
    const message = `📞 *Contact Admin*\n\n` +
      `DM admin for Premium membership.\n\n` +
      `Admin will share payment details and pricing.`;

    const keyboard = new InlineKeyboard()
      .text("⬅️ Back to Menu", "backtomenu");

    await ctx.editMessageText(message, { parse_mode: "Markdown", reply_markup: keyboard });
  });

  bot.callbackQuery("howtoactivate", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);
    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const isPremium = userRecord[0]?.isPremium || false;

    const instructionRecords = await db.select().from(instructions).where(eq(instructions.isActive, true)).limit(1);

    let text = `📖 𝗛𝗼𝘄 𝗧𝗼 𝗨𝘀𝗲\n\n`;
    text += `🔍 *Step 1:* Search movie\n`;
    text += `📥 *Step 2:* Tap "Get Link"\n`;
    text += `✅ *Step 3:* Complete verification\n`;
    text += `🎬 *Step 4:* Enjoy your movie!\n\n`;

    if (instructionRecords.length > 0) {
      text += `📋 *Instructions:*\n${instructionRecords[0].body}`;
    }

    text += getPremiumPromoMessage(isPremium);

    const keyboard = new InlineKeyboard().text("⬅️ Back to Menu", "backtomenu");
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
  });

  bot.callbackQuery("searchmovie", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);
    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const isPremium = userRecord[0]?.isPremium || false;

    let message = `🔍 𝗠𝗼𝘃𝗶𝗲 𝗦𝗲𝗮𝗿𝗰𝗵\n\n`;
    message += `Just type the movie name and send!\n\n`;
    message += `📝 Example: Dangal, KGF, Pushpa\n\n`;
    message += `✨ Smart search - even misspelled names work!`;
    message += getPremiumPromoMessage(isPremium);

    await ctx.editMessageText(message, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Back to Menu", "backtomenu") });
  });

  bot.callbackQuery("library", async (ctx) => {
    await ctx.answerCallbackQuery();
    const firstName = ctx.from?.first_name || "User";
    const { user } = await getOrCreateUser(ctx.from!.id, firstName);
    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const isPremium = userRecord[0]?.isPremium || false;

    const accessList = await db.select().from(movieAccess)
      .where(eq(movieAccess.userId, user.id))
      .orderBy(desc(movieAccess.unlockedAt));

    if (accessList.length === 0) {
      let message = `📚 𝗠𝘆 𝗟𝗶𝗯𝗿𝗮𝗿𝘆\n\n`;
      message += `No movies unlocked yet.\n\n`;
      message += `🔍 Search and unlock movies!`;
      message += getPremiumPromoMessage(isPremium);
      return ctx.editMessageText(message, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔍 Search Movie", "searchmovie").row().text("⬅️ Back to Menu", "backtomenu") });
    }

    let message = `📚 *My Library*\n\n`;

    for (const access of accessList.slice(0, 10)) {
      const movieResult = await db.select().from(movies).where(eq(movies.id, access.movieId));
      if (movieResult.length > 0) {
        const movie = movieResult[0];
        const validity = isAccessValid(access.unlockedAt);
        const status = validity.valid ? `✅ ${validity.hoursRemaining}h ${validity.minutesRemaining}m` : "❌ Expired";
        message += `🎬 *${escapeMarkdown(movie.displayTitle)}*\n`;
        message += `   ${status}\n`;
        message += `   /get_${movie.id.slice(0, 8)}\n\n`;
      }
    }

    message += getPremiumPromoMessage(isPremium);

    await ctx.editMessageText(message, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Back to Menu", "backtomenu") });
  });

  bot.callbackQuery("credits", async (ctx) => {
    await ctx.answerCallbackQuery();
    const firstName = ctx.from?.first_name || "User";
    const { user } = await getOrCreateUser(ctx.from!.id, firstName);
    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const credits = userRecord[0]?.credits || 0;
    const isPremium = userRecord[0]?.isPremium || false;

    let message = `💳 *Your Credits*\n\n`;
    message += `💰 Balance: *${credits} credits*\n\n`;
    message += `📋 *Credit System:*\n`;
    message += `• 1 credit = 1 movie access\n`;
    message += `• Access valid for 12 hours\n`;
    message += `• Earn 2 credits every 12 hours\n`;

    if (isPremium) {
      message += `\n👑 *Premium Status:* Active\n`;
      message += `✨ Unlimited access, No credits needed!`;
    } else {
      message += getPremiumPromoMessage(false);
    }

    const keyboard = new InlineKeyboard()
      .text("🎁 Earn Credits", "earncredits").row()
      .text("👑 Get Premium", "premium_info").row()
      .text("⬅️ Back to Menu", "backtomenu");

    await ctx.editMessageText(message, { parse_mode: "Markdown", reply_markup: keyboard });
  });

  bot.callbackQuery("earncredits", async (ctx) => {
    await ctx.answerCallbackQuery();
    const firstName = ctx.from?.first_name || "User";
    const { user } = await getOrCreateUser(ctx.from!.id, firstName);
    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const isPremium = userRecord[0]?.isPremium || false;
    const { canEarn, hoursRemaining, minutesRemaining } = await canEarnCredits(user.id);

    if (isPremium) {
      let message = `👑 𝗣𝗿𝗲𝗺𝗶𝘂𝗺 𝗠𝗲𝗺𝗯𝗲𝗿\n\n`;
      message += `You don't need credits!\n\n`;
      message += `✨ Premium members get instant access.`;
      const keyboard = new InlineKeyboard().text("⬅️ Back to Menu", "backtomenu");
      return ctx.editMessageText(message, { parse_mode: "Markdown", reply_markup: keyboard });
    }

    if (!canEarn) {
      let message = `⏰ 𝗖𝗼𝗼𝗹𝗱𝗼𝘄𝗻 𝗔𝗰𝘁𝗶𝘃𝗲\n\n`;
      message += `You recently earned credits.\n\n`;
      message += `⏳ Next earn: *${hoursRemaining}h ${minutesRemaining}m*`;
      message += getPremiumPromoMessage(false);
      const keyboard = new InlineKeyboard()
        .text("👑 Get Premium", "premium_info").row()
        .text("⬅️ Back to Menu", "backtomenu");
      return ctx.editMessageText(message, { parse_mode: "Markdown", reply_markup: keyboard });
    }

    // Generate credit verification token (using new web verification flow)
    const verificationToken = crypto.randomBytes(16).toString('hex');

    await db.insert(creditVerifications).values({
      userId: user.id,
      token: verificationToken,
      status: 'pending',
      creditsAmount: 2
    });

    const verificationUrl = `https://${VERIFICATION_DOMAIN}/verify-credits?token=${verificationToken}`;
    const shortUrl = await generateShortLink(verificationUrl);

    if (shortUrl) {
      let message = `🎁 𝗘𝗮𝗿𝗻 𝗖𝗿𝗲𝗱𝗶𝘁𝘀\n\n`;
      message += `📋 *Steps:*\n`;
      message += `1️⃣ Tap "Verify Now"\n`;
      message += `2️⃣ Complete the page\n`;
      message += `3️⃣ Come back and tap "Check Verification"\n\n`;
      message += `⏳ Link valid for 1 hour\n`;
      message += `🎁 +2 Credits after verification!`;

      const keyboard = new InlineKeyboard()
        .url("🔗 Verify Now", shortUrl).row()
        .text("✅ Check Verification", `checkcredit_${verificationToken}`).row()
        .text("⬅️ Back to Menu", "backtomenu");

      await ctx.editMessageText(message, { parse_mode: "Markdown", reply_markup: keyboard });
    } else {
      let message = `❌ 𝗟𝗶𝗻𝗸 𝗚𝗲𝗻𝗲𝗿𝗮𝘁𝗶𝗼𝗻 𝗙𝗮𝗶𝗹𝗲𝗱\n\nPlease contact admin.`;
      const keyboard = new InlineKeyboard().text("⬅️ Back to Menu", "backtomenu");
      await ctx.editMessageText(message, { parse_mode: "Markdown", reply_markup: keyboard });
    }
  });

  bot.callbackQuery("help", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);
    const userRecord = await db.select().from(users).where(eq(users.id, user.id));
    const isPremium = userRecord[0]?.isPremium || false;

    let message = `❓ 𝗛𝗲𝗹𝗽 & 𝗦𝘂𝗽𝗽𝗼𝗿𝘁\n\n`;
    message += `🎬 *How to Download:*\n`;
    message += `1️⃣ Search movie\n`;
    message += `2️⃣ Tap "Get Link" button\n`;
    message += `3️⃣ Complete verification\n`;
    message += `4️⃣ Tap "Check Verification"\n`;
    message += `5️⃣ Get your movie files!\n\n`;
    message += `💰 *Credits:*\n`;
    message += `• Each movie = 1 credit\n`;
    message += `• Access = 12 hours\n`;
    message += `• Earn = 2 credits/12h\n\n`;
    message += `📚 *Commands:*\n`;
    message += `/start - Main menu\n`;
    message += `/search <name> - Search movie\n`;
    message += `/earncredits - Earn free credits\n`;
    message += `/credits - Check balance\n`;
    message += `/library - Your movies`;
    message += getPremiumPromoMessage(isPremium);

    await ctx.editMessageText(message, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⬅️ Back to Menu", "backtomenu") });
  });

  // Helper function to broadcast message to all users
  const broadcastMessage = async (ctx: MyContext, messageType: string): Promise<void> => {
    if (!ctx.session.broadcastMode || !await isAdmin(ctx.from!.id)) return;

    const allUsers = await db.select().from(users);
    let successCount = 0;
    let failCount = 0;

    for (const user of allUsers) {
      const telegramId = parseInt(user.username);
      if (isNaN(telegramId) || telegramId === ctx.from!.id) continue;

      try {
        await ctx.api.copyMessage(telegramId, ctx.chat!.id, ctx.message!.message_id);
        successCount++;
      } catch (error) {
        failCount++;
      }
      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    ctx.session.broadcastMode = false;
    await ctx.reply(`📢 *Broadcast Complete!*\n\n✅ Sent: ${successCount}\n❌ Failed: ${failCount}`, { parse_mode: "Markdown" });
  }

  // Helper function to add file to pending movie
  const addFileToPending = (ctx: MyContext, type: FileAsset['type'], fileId: string, fileUniqueId: string, fileName?: string, mimeType?: string, fileSize?: number) => {
    if (!ctx.session.pendingMovie || !ctx.session.pendingMovie.displayTitle) return false;
    ctx.session.pendingMovie.files.push({
      type,
      fileId,
      fileUniqueId,
      fileName,
      mimeType,
      fileSize,
      caption: ctx.message?.caption,
    });
    return true;
  }

  // Group welcome message when bot is added to a group
  bot.on("my_chat_member", async (ctx) => {
    const update = ctx.myChatMember;
    const chat = update.chat;

    // Only handle group/supergroup
    if (chat.type !== "group" && chat.type !== "supergroup") return;

    // Check if bot was added (status changed to member or administrator)
    const oldStatus = update.old_chat_member.status;
    const newStatus = update.new_chat_member.status;

    if ((oldStatus === "left" || oldStatus === "kicked") && (newStatus === "member" || newStatus === "administrator")) {
      // Bot was added to group - send welcome message
      const botUsername = cachedBotUsername || ctx.me.username;

      const welcomeMsg = `🌹 *Welcome to Rose Bot!*\n\n` +
        `Main ek movie search bot hoon.\n\n` +
        `🎬 *Features:*\n` +
        `✨ Fuzzy movie search\n` +
        `✨ Credit based system\n` +
        `✨ Premium membership\n` +
        `✨ Daily free credits\n\n` +
        `📋 *How to use:*\n` +
        `1️⃣ DM me @${botUsername}\n` +
        `2️⃣ Tap /start\n` +
        `3️⃣ Search movie\n` +
        `4️⃣ Complete verification\n` +
        `5️⃣ Enjoy your movie!\n\n` +
        `👑 Premium members get instant access!\n\n` +
        `🔗 Start: @${botUsername}`;

      try {
        await ctx.reply(welcomeMsg, { parse_mode: "Markdown" });
      } catch (e) {
        console.log("Could not send group welcome message:", e);
      }
    }
  });

  // Handle new members in group (optional welcome)
  bot.on("message:new_chat_members", async (ctx) => {
    // Only in groups
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;

    const newMembers = ctx.message.new_chat_members;

    // Check if the bot itself was added
    const botWasAdded = newMembers.some(m => m.id === ctx.me.id);
    if (botWasAdded) {
      // Already handled by my_chat_member
      return;
    }

    // Welcome new users to the group with bot info (optional - can comment out if too spammy)
    // for (const member of newMembers) {
    //   if (!member.is_bot) {
    //     await ctx.reply(`Welcome ${member.first_name}! 🎬 Movie download ke liye @${botInfo.username} use karo.`);
    //   }
    // }
  });

  // Handle document uploads
  bot.on("message:document", async (ctx) => {
    // Check broadcast mode
    if (ctx.session.broadcastMode) {
      return broadcastMessage(ctx, 'document');
    }

    const doc = ctx.message.document;
    if (addFileToPending(ctx, 'document', doc.file_id, doc.file_unique_id, doc.file_name, doc.mime_type, doc.file_size)) {
      const total = ctx.session.pendingMovie!.files.length + ctx.session.pendingMovie!.links.length;
      await ctx.reply(`📁 𝗗𝗼𝗰𝘂𝗺𝗲𝗻𝘁 𝗔𝗱𝗱𝗲𝗱!\n\n📊 Total: ${total}\n\n➕ Send more or /end to save`);
    }
  });

  // Handle video uploads
  bot.on("message:video", async (ctx) => {
    // Check broadcast mode
    if (ctx.session.broadcastMode) {
      return broadcastMessage(ctx, 'video');
    }

    const video = ctx.message.video;
    if (addFileToPending(ctx, 'video', video.file_id, video.file_unique_id, video.file_name, video.mime_type, video.file_size)) {
      const total = ctx.session.pendingMovie!.files.length + ctx.session.pendingMovie!.links.length;
      await ctx.reply(`🎬 𝗩𝗶𝗱𝗲𝗼 𝗔𝗱𝗱𝗲𝗱!\n\n📊 Total: ${total}\n\n➕ Send more or /end to save`);
    }
  });

  // Handle photo uploads
  bot.on("message:photo", async (ctx) => {
    // Check broadcast mode
    if (ctx.session.broadcastMode) {
      return broadcastMessage(ctx, 'photo');
    }

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1]; // Get highest resolution
    if (addFileToPending(ctx, 'photo', photo.file_id, photo.file_unique_id, undefined, undefined, photo.file_size)) {
      const total = ctx.session.pendingMovie!.files.length + ctx.session.pendingMovie!.links.length;
      await ctx.reply(`📷 𝗣𝗵𝗼𝘁𝗼 𝗔𝗱𝗱𝗲𝗱!\n\n📊 Total: ${total}\n\n➕ Send more or /end to save`);
    }
  });

  // Handle audio uploads
  bot.on("message:audio", async (ctx) => {
    // Check broadcast mode
    if (ctx.session.broadcastMode) {
      return broadcastMessage(ctx, 'audio');
    }

    const audio = ctx.message.audio;
    if (addFileToPending(ctx, 'audio', audio.file_id, audio.file_unique_id, audio.file_name, audio.mime_type, audio.file_size)) {
      const total = ctx.session.pendingMovie!.files.length + ctx.session.pendingMovie!.links.length;
      await ctx.reply(`🎵 𝗔𝘂𝗱𝗶𝗼 𝗔𝗱𝗱𝗲𝗱!\n\n📊 Total: ${total}\n\n➕ Send more or /end to save`);
    }
  });

  // Handle animation/GIF uploads
  bot.on("message:animation", async (ctx) => {
    // Check broadcast mode
    if (ctx.session.broadcastMode) {
      return broadcastMessage(ctx, 'animation');
    }

    const anim = ctx.message.animation;
    if (addFileToPending(ctx, 'animation', anim.file_id, anim.file_unique_id, anim.file_name, anim.mime_type, anim.file_size)) {
      const total = ctx.session.pendingMovie!.files.length + ctx.session.pendingMovie!.links.length;
      await ctx.reply(`🎞️ 𝗚𝗜𝗙 𝗔𝗱𝗱𝗲𝗱!\n\n📊 Total: ${total}\n\n➕ Send more or /end to save`);
    }
  });

  // Handle voice messages
  bot.on("message:voice", async (ctx) => {
    // Check broadcast mode
    if (ctx.session.broadcastMode) {
      return broadcastMessage(ctx, 'voice');
    }

    const voice = ctx.message.voice;
    if (addFileToPending(ctx, 'voice', voice.file_id, voice.file_unique_id, undefined, voice.mime_type, voice.file_size)) {
      const total = ctx.session.pendingMovie!.files.length + ctx.session.pendingMovie!.links.length;
      await ctx.reply(`🎤 𝗩𝗼𝗶𝗰𝗲 𝗔𝗱𝗱𝗲𝗱!\n\n📊 Total: ${total}\n\n➕ Send more or /end to save`);
    }
  });

  // Handle sticker
  bot.on("message:sticker", async (ctx) => {
    // Check broadcast mode
    if (ctx.session.broadcastMode) {
      return broadcastMessage(ctx, 'sticker');
    }

    const sticker = ctx.message.sticker;
    if (addFileToPending(ctx, 'sticker', sticker.file_id, sticker.file_unique_id, undefined, undefined, sticker.file_size)) {
      const total = ctx.session.pendingMovie!.files.length + ctx.session.pendingMovie!.links.length;
      await ctx.reply(`🎨 𝗦𝘁𝗶𝗰𝗸𝗲𝗿 𝗔𝗱𝗱𝗲𝗱!\n\n📊 Total: ${total}\n\n➕ Send more or /end to save`);
    }
  });

  bot.on("message:text", async (ctx) => {
    // Check broadcast mode
    if (ctx.session.broadcastMode) {
      return broadcastMessage(ctx, 'text');
    }

    if (ctx.session.pendingMovie) {
      const text = ctx.message.text;

      if (!ctx.session.pendingMovie.fuzzyKey) {
        ctx.session.pendingMovie.fuzzyKey = text;
        await ctx.reply("Ab Display Title bhejo (jo users ko dikhega):");
      } else if (!ctx.session.pendingMovie.displayTitle) {
        ctx.session.pendingMovie.displayTitle = text;
        await ctx.reply("Ab files ya links bhejo:\n\n📁 Koi bhi file bhejo - Photo, Video, Document, Audio, GIF, Voice, Sticker\n🔗 Ya text links bhejo (comma/newline se alag)\n\nJab done ho, /end bhejo.");
      } else {
        const links = text.split(/[\n,]/).map((l: string) => l.trim()).filter(Boolean);
        ctx.session.pendingMovie.links.push(...links);
        const total = ctx.session.pendingMovie.files.length + ctx.session.pendingMovie.links.length;
        await ctx.reply(`🔗 𝗟𝗶𝗻𝗸𝘀 𝗔𝗱𝗱𝗲𝗱!\n\n📊 ${links.length} links, Total: ${total}\n\n➕ Send more or /end to save`);
      }
      return;
    }

    const botActive = await getBotStatus();
    if (!botActive) {
      return ctx.reply("Bot is currently offline.");
    }

    const botUsername = cachedBotUsername || ctx.me.username;
    const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
    let searchQuery = ctx.message.text;

    // In groups, handle search based on mention or privacy mode
    if (isGroup) {
      const mentionRegex = new RegExp(`@${botUsername}\\s*(.*)`, 'i');
      const match = ctx.message.text.match(mentionRegex);

      if (match) {
        // Bot was mentioned, extract search query
        searchQuery = match[1].trim();
        if (!searchQuery) {
          // Just mentioned bot without query
          return ctx.reply(
            `🎬 𝗥𝗼𝘀𝗲 𝗠𝗼𝘃𝗶𝗲 𝗕𝗼𝘁\n\n` +
            `📝 To search movies:\n\n` +
            `1️⃣ Inline: @${botUsername} movie name\n` +
            `2️⃣ Mention: @${botUsername} movie name\n` +
            `3️⃣ DM: Send DM to bot\n\n` +
            `👉 𝗜𝗻𝗹𝗶𝗻𝗲 𝗺𝗼𝗱𝗲 𝗶𝘀 𝗯𝗲𝘀𝘁!`
          );
        }
      } else {
        // Bot not mentioned - check if it's a reply to bot's message
        const replyTo = ctx.message.reply_to_message;
        if (replyTo && replyTo.from?.id === ctx.me.id) {
          // Reply to bot's message, use full text as search
          searchQuery = ctx.message.text;
        } else {
          // Privacy mode off means bot receives all messages
          // Treat message as search query if it's not a command
          if (ctx.message.text.startsWith('/')) {
            return; // Don't process commands as search
          }
          // Use full message as search query (privacy mode is off)
          searchQuery = ctx.message.text;
        }
      }
    }

    const results = await searchMoviesDb(searchQuery);
    const { user } = await getOrCreateUser(ctx.from!.id, ctx.from!.first_name);

    if (results.length === 0) {
      const noResultMsg = getNotFoundMessage() + (isGroup ? `\n\n💡 𝗧𝗶𝗽: Use inline mode @${botUsername}` : "");
      return ctx.reply(noResultMsg);
    }

    let message = `🎬 𝗦𝗲𝗮𝗿𝗰𝗵 𝗥𝗲𝘀𝘂𝗹𝘁𝘀\n\n`;

    results.forEach((movie: any, index: number) => {
      const movieCode = movie.id.slice(0, 8);
      const safeTitle = escapeHtml(movie.displayTitle);
      message += `📽️ <b>${safeTitle}</b>\n`;
      message += `👉 <a href="https://t.me/${botUsername}?start=movie_${movieCode}">𝗗𝗼𝘄𝗻𝗹𝗼𝗮𝗱 𝗻𝗼𝘄</a>\n\n`;
    });

    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `⚠️ Movie not found? Use /request to request it`;

    if (isGroup) {
      message += `\n\n💡 𝗧𝗶𝗽: Use inline mode @${botUsername}`;
    }

    await ctx.reply(message, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });

  // Inline Query Handler - Search movies from any chat using @botname query
  bot.on("inline_query", async (ctx) => {
    const query = ctx.inlineQuery.query.trim();
    const botUsername = cachedBotUsername || ctx.me.username;

    if (query.length < 2) {
      // Show help message when query is too short
      const results: InlineQueryResultArticle[] = [{
        type: "article",
        id: "help",
        title: "🎬 Movie Search Bot",
        description: "Type movie name to search...",
        input_message_content: {
          message_text: `🎬 *Rose Movie Bot*\n\nUse: @${botUsername} <movie name>\n\nExample: @${botUsername} Avengers`,
          parse_mode: "Markdown"
        }
      }];
      return ctx.answerInlineQuery(results, { cache_time: 300 });
    }

    try {
      const movies = await searchMoviesDb(query);

      if (movies.length === 0) {
        const results: InlineQueryResultArticle[] = [{
          type: "article",
          id: "no_results",
          title: "❌ No movies found",
          description: `No results for "${query}"`,
          input_message_content: {
            message_text: `🔍 No movies found for: *${escapeMarkdown(query)}*\n\nTry different keywords!`,
            parse_mode: "Markdown"
          }
        }];
        return ctx.answerInlineQuery(results, { cache_time: 60 });
      }

      const results: InlineQueryResultArticle[] = movies.slice(0, 20).map((movie: any, index: number) => {
        const movieCode = movie.id.slice(0, 8);
        const safeTitle = escapeHtml(movie.displayTitle);
        return {
          type: "article" as const,
          id: movie.id,
          title: `🎬 ${movie.displayTitle}`,
          description: `Tap to get download link`,
          input_message_content: {
            message_text: `🎬 <b>${safeTitle}</b>\n\n👉👉 <a href="https://t.me/${botUsername}?start=movie_${movieCode}">Download now</a> 👈👈`,
            parse_mode: "HTML" as const
          },
          reply_markup: {
            inline_keyboard: [[
              { text: "🎬 Download Now", url: `https://t.me/${botUsername}?start=movie_${movieCode}` }
            ]]
          }
        };
      });

      await ctx.answerInlineQuery(results, { cache_time: 60 });
    } catch (error) {
      console.error("Inline query error:", error);
      const results: InlineQueryResultArticle[] = [{
        type: "article",
        id: "error",
        title: "⚠️ Error",
        description: "Please try again",
        input_message_content: {
          message_text: "❌ An error occurred. Please try again.",
          parse_mode: "Markdown"
        }
      }];
      return ctx.answerInlineQuery(results, { cache_time: 10 });
    }
  });

  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    const e = err.error;
    if (e instanceof GrammyError) {
      console.error("Error in request:", e.description);
    } else if (e instanceof HttpError) {
      console.error("Could not contact Telegram:", e);
    } else {
      console.error("Unknown error:", e);
    }
  });

  // Prevent multiple bot instances
  let botStarted = false;

  const startBot = async () => {
    if (!bot) {
      console.log("Bot not initialized (BOT_TOKEN not provided), skipping bot startup");
      return;
    }

    if (botStarted) {
      console.log("Bot already started, skipping duplicate start");
      return;
    }

    botStarted = true;

    botStarted = true;
    console.log("Starting startBot()...");

    // Cache bot username at startup
    console.log("Calling getMe()...");
    const botInfo = await bot.api.getMe();
    console.log("getMe() success!");
    cachedBotUsername = botInfo.username || "";
    console.log(`Bot username cached: @${cachedBotUsername}`);


    // Production mode: Use polling (health server runs globally outside this block)
    if (process.env.NODE_ENV === "production") {
      try {
        await bot.api.deleteWebhook({ drop_pending_updates: true });
        console.log("Webhook deleted, starting polling mode in production...");
      } catch (e) {
        console.log("No webhook to delete, proceeding...");
      }

      await bot.api.setMyCommands([
        { command: "start", description: "🏠 Main Menu" },
        { command: "search", description: "🔍 Movie Search" },
        { command: "library", description: "📚 My Library" },
        { command: "credits", description: "💳 My Credits" },
        { command: "earncredits", description: "🎁 Earn Credits" },
        { command: "profile", description: "👤 My Profile" },
        { command: "refer", description: "👥 Referral Link" },
        { command: "request", description: "📝 Request Movie" },
        { command: "myrequests", description: "📋 My Requests" },
        { command: "help", description: "❓ Help" },
        // Admin commands
        { command: "stats", description: "📊 Bot Stats (Admin)" },
        { command: "requests", description: "📝 Pending Requests (Admin)" },
        { command: "ban", description: "🚫 Ban User (Admin)" },
        { command: "unban", description: "✅ Unban User (Admin)" },
        { command: "banned", description: "📋 Banned List (Admin)" },
        { command: "addfiles", description: "📁 Add Movie (Admin)" },
        { command: "end", description: "✅ Save Movie (Admin)" },
        { command: "list", description: "📋 List Movies (Admin)" },
        { command: "delete", description: "🗑️ Delete Movie (Admin)" },
        { command: "broadcast", description: "📢 Broadcast (Admin)" },
        { command: "cancelbroadcast", description: "❌ Cancel Broadcast (Admin)" },
        { command: "admin", description: "👑 Show Admins (Admin)" },
        { command: "addadmin", description: "➕ Add Admin (Admin)" },
        { command: "forsub", description: "📢 Force Subscribe (Admin)" },
        { command: "unforsub", description: "🔓 Remove Subscribe (Admin)" },
        { command: "premium", description: "👑 Give Premium (Admin)" },
        { command: "rmpremium", description: "❌ Remove Premium (Admin)" },
        { command: "myswitch", description: "🔄 Bot On/Off (Admin)" },
        { command: "reset", description: "🔄 Reset User (Admin)" },
        { command: "addtokens", description: "🔗 Add GPlinks Token (Admin)" },
        { command: "showtokens", description: "👁️ Show Tokens (Admin)" },
        { command: "howto", description: "📖 Set Instructions (Admin)" },
        { command: "addpost", description: "📝 Add Post (Admin)" },
      ]);
      console.log("Commands set!");

      console.log("Bot starting polling mode (production)...");
      bot.start({
        onStart: (botInfo) => {
          console.log(`Bot @${botInfo.username} started successfully in production polling mode!`);
        },
      });
    } else {
      // Development mode - use polling
      // CRITICAL: Delete any existing webhook to prevent 409 conflict
      try {
        await bot.api.deleteWebhook({ drop_pending_updates: true });
        console.log("Webhook deleted, starting polling mode...");
      } catch (e) {
        console.log("No webhook to delete, proceeding with polling...");
      }

      await bot.api.setMyCommands([
        { command: "start", description: "🏠 Main Menu" },
        { command: "search", description: "🔍 Movie Search" },
        { command: "library", description: "📚 My Library" },
        { command: "credits", description: "💳 My Credits" },
        { command: "earncredits", description: "🎁 Earn Credits" },
        { command: "profile", description: "👤 My Profile" },
        { command: "refer", description: "👥 Referral Link" },
        { command: "request", description: "📝 Request Movie" },
        { command: "myrequests", description: "📋 My Requests" },
        { command: "help", description: "❓ Help" },
        // Admin commands
        { command: "stats", description: "📊 Bot Stats (Admin)" },
        { command: "requests", description: "📝 Pending Requests (Admin)" },
        { command: "ban", description: "🚫 Ban User (Admin)" },
        { command: "unban", description: "✅ Unban User (Admin)" },
        { command: "banned", description: "📋 Banned List (Admin)" },
        { command: "addfiles", description: "📁 Add Movie (Admin)" },
        { command: "end", description: "✅ Save Movie (Admin)" },
        { command: "list", description: "📋 List Movies (Admin)" },
        { command: "delete", description: "🗑️ Delete Movie (Admin)" },
        { command: "broadcast", description: "📢 Broadcast (Admin)" },
        { command: "cancelbroadcast", description: "❌ Cancel Broadcast (Admin)" },
        { command: "admin", description: "👑 Show Admins (Admin)" },
        { command: "addadmin", description: "➕ Add Admin (Admin)" },
        { command: "forsub", description: "📢 Force Subscribe (Admin)" },
        { command: "unforsub", description: "🔓 Remove Subscribe (Admin)" },
        { command: "premium", description: "👑 Give Premium (Admin)" },
        { command: "rmpremium", description: "❌ Remove Premium (Admin)" },
        { command: "myswitch", description: "🔄 Bot On/Off (Admin)" },
        { command: "reset", description: "🔄 Reset User (Admin)" },
        { command: "addtokens", description: "🔗 Add GPlinks Token (Admin)" },
        { command: "showtokens", description: "👁️ Show Tokens (Admin)" },
        { command: "howto", description: "📖 Set Instructions (Admin)" },
        { command: "addpost", description: "📝 Add Post (Admin)" },
      ]);
      console.log("Commands set!");

      // Start bot polling
      console.log("Bot starting polling mode (development)...");
      bot.start({
        onStart: (botInfo) => {
          console.log(`Bot @${botInfo.username} started successfully in polling mode!`);
        },
      });
    }
  };

  startBot().catch(console.error);

} // End of BOT_TOKEN conditional

// Global health check server - runs regardless of bot status
// This ensures Cloud Run health checks pass even if bot initialization fails
import express from "express";
const healthApp = express();
const HEALTH_PORT = process.env.PORT || 5000;

healthApp.get("/", (req, res) => res.send("Bot is running!"));
healthApp.get("/health", (req, res) => res.json({ status: "ok", timestamp: Date.now() }));

healthApp.listen(HEALTH_PORT, () => {
  console.log(`Health check server running on port ${HEALTH_PORT}`);
});

// Keep process alive
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

export { bot };
