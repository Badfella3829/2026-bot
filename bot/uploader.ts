
import axios from 'axios';
import { Bot, InputFile } from 'grammy';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { constants } from 'fs';

// Helper to determine filename from URL or headers
const getFilename = (url: string, headers: any, defaultName = 'downloaded_file'): string => {
    // Try to get from Content-Disposition header
    const disposition = headers['content-disposition'];
    let filename = '';

    if (disposition && disposition.indexOf('attachment') !== -1) {
        const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
        const matches = filenameRegex.exec(disposition);
        if (matches != null && matches[1]) {
            filename = matches[1].replace(/['"]/g, '');
        }
    }

    if (!filename) {
        // Extract from URL path
        try {
            const urlPath = new URL(url).pathname;
            filename = path.basename(urlPath);
        } catch (e) {
            // Ignore URL parsing errors
        }
    }

    if (!filename || filename === '/') {
        filename = defaultName;
    }

    return filename;
};

// Stream download and upload - only for small files (< 50MB) 
// For larger files, it needs a Local Bot Server or specialized streaming logic beyond standard bot API
export async function downloadAndUpload(bot: Bot<any>, chatId: number, url: string, messageIdToReply?: number) {
    const statusMsg = await bot.api.sendMessage(chatId, `⬇️ Downloading...`, { reply_to_message_id: messageIdToReply });

    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });

        const totalLength = parseInt(response.headers['content-length'] || '0', 10);
        const filename = getFilename(url, response.headers);
        const MAX_SIZE = 50 * 1024 * 1024; // 50MB

        if (totalLength > MAX_SIZE) {
            await bot.api.editMessageText(chatId, statusMsg.message_id,
                `❌ File Too Large!\n\nStandard Telegram Bots limit uploads to 50MB.\nDetected Size: ${(totalLength / (1024 * 1024)).toFixed(2)}MB.\n\nTo bypass this, you need a Local Bot API Server.`);
            return;
        }

        // Prepare temporary file path
        const tempFilePath = path.join(process.cwd(), 'temp_downloads', filename);

        // Ensure directory exists
        const tempDir = path.dirname(tempFilePath);
        try {
            await fs.promises.access(tempDir, constants.F_OK);
        } catch {
            await fs.promises.mkdir(tempDir, { recursive: true });
        }

        // Save stream to file first (safer for retry logic and avoiding stream timeouts)
        const writer = fs.createWriteStream(tempFilePath);
        await pipeline(response.data, writer);

        // Upload to Telegram
        await bot.api.editMessageText(chatId, statusMsg.message_id, `⬆️ Uploading to Telegram...`);

        // Determine file type simply
        const ext = path.extname(filename).toLowerCase();
        let sentMessage;

        if (['.mp4', '.mkv', '.avi', '.mov'].includes(ext)) {
            sentMessage = await bot.api.sendVideo(chatId, new InputFile(tempFilePath), { caption: filename });
        } else if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
            sentMessage = await bot.api.sendPhoto(chatId, new InputFile(tempFilePath), { caption: filename });
        } else if (['.mp3', '.m4a', '.wav'].includes(ext)) {
            sentMessage = await bot.api.sendAudio(chatId, new InputFile(tempFilePath), { caption: filename });
        } else {
            sentMessage = await bot.api.sendDocument(chatId, new InputFile(tempFilePath), { caption: filename });
        }

        // Clean up
        await fs.promises.unlink(tempFilePath);
        await bot.api.deleteMessage(chatId, statusMsg.message_id);

        return sentMessage;

    } catch (error) {
        console.error('Download/Upload Error:', error);
        await bot.api.editMessageText(chatId, statusMsg.message_id, `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
