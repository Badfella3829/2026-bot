
const { Bot } = require("grammy");

// Hardcoded token to eliminate env var issues
const token = "8436853122:AAHraW5xfnMz0171CczrDWKBAt-l5_1DQp4";

if (!token) {
    console.error("No token provided!");
    process.exit(1);
}

const bot = new Bot(token);

bot.command("start", (ctx) => ctx.reply("✅ Simple Bot is Online via Node.js!"));

bot.on("message", (ctx) => ctx.reply("You said: " + ctx.message.text));

console.log("Starting simple bot check...");

bot.start({
    onStart: (botInfo) => {
        console.log(`Simple Bot @${botInfo.username} started successfully!`);
    }
});
