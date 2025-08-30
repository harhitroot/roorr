const { Telegraf } = require("telegraf");
const { spawn, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const express = require("express");

// Bot token from environment
const BOT_TOKEN = process.env.BOT_TOKEN || "your_bot_token_here";
const REPO_URL = "https://github.com/adamfarreledu-cloud/java.git";
const REPO_DIR = "./java";

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// User session storage
const userSessions = new Map();

// Simple progress tracking
const progressTimers = new Map(); // userId -> intervalId
const PROGRESS_INTERVAL = 60000; // Send progress every 60 seconds (reduced frequency)
const errorCounts = new Map(); // Track error counts per user

// Rate limiting for Telegram API calls
const messageQueue = new Map(); // userId -> array of pending messages
const rateLimitDelay = 2000; // 2 seconds between messages (increased to prevent 429s)
const processingQueue = new Set(); // Track which users are being processed

// Bot states
const STATES = {
    IDLE: "idle",
    AWAITING_CONSENT: "awaiting_consent",
    AWAITING_API_ID: "awaiting_api_id",
    AWAITING_API_HASH: "awaiting_api_hash",
    AWAITING_PHONE: "awaiting_phone",
    AWAITING_OTP: "awaiting_otp",
    AWAITING_CHANNEL: "awaiting_channel",
    AWAITING_OPTION: "awaiting_option",
    AWAITING_DESTINATION: "awaiting_destination",
    PROCESSING: "processing",
};

// Progress tracking for web dashboard
let globalProgress = {
    status: "idle",
    task: "Waiting for user commands",
    completed: 0,
    total: 100,
    activeUsers: 0,
    lastUpdate: new Date().toISOString(),
};

// Clone repository on startup
async function cloneRepository() {
    return new Promise((resolve, reject) => {
        // Remove existing directory if it exists
        if (fs.existsSync(REPO_DIR)) {
            exec(`rm -rf ${REPO_DIR}`, (error) => {
                if (error) {
                    console.error("Error removing existing directory:", error);
                    // Don't fail on cleanup error, try to continue
                    console.warn("Continuing despite cleanup error...");
                }
                performClone();
            });
        } else {
            performClone();
        }

        function performClone() {
            // Add timeout and better error handling for cloud environments
            const cloneCommand = `timeout 60 git clone --depth 1 ${REPO_URL}`;
            exec(cloneCommand, { timeout: 65000 }, (error, stdout, stderr) => {
                if (error) {
                    console.error("Error cloning repository:", error);
                    console.error("STDERR:", stderr);
                    // Try fallback without timeout for Render compatibility
                    exec(
                        `git clone --depth 1 ${REPO_URL}`,
                        (fallbackError, fallbackStdout) => {
                            if (fallbackError) {
                                console.error(
                                    "Fallback clone also failed:",
                                    fallbackError,
                                );
                                reject(fallbackError);
                                return;
                            }
                            console.log(
                                "Repository cloned successfully (fallback)",
                            );
                            console.log(fallbackStdout);
                            resolve();
                        },
                    );
                    return;
                }
                console.log("Repository cloned successfully");
                console.log(stdout);
                resolve();
            });
        }
    });
}

// Get or create user session
function getUserSession(userId) {
    if (!userSessions.has(userId)) {
        userSessions.set(userId, {
            state: STATES.IDLE,
            process: null,
            phone: null,
            channel: null,
            option: null,
            destination: null,
            apiId: null,
            apiHash: null,
            progressMessageId: null,
        });
    }
    return userSessions.get(userId);
}

// Update global progress (called when bot processes tasks)
function updateProgress(status, task, completed = 0, total = 100) {
    globalProgress = {
        status,
        task,
        completed,
        total,
        activeUsers: userSessions.size,
        lastUpdate: new Date().toISOString(),
    };
    console.log(
        `📊 Progress Update: ${status} - ${task} (${completed}/${total})`,
    );
}

// Start simple progress timer
function startProgressTimer(ctx, userId) {
    // Clear any existing timer
    if (progressTimers.has(userId)) {
        clearInterval(progressTimers.get(userId));
    }

    // Initialize error counter for this user
    if (!errorCounts.has(userId)) {
        errorCounts.set(userId, { total: 0, fileExpired: 0, timeout: 0 });
    }

    // Send progress message every 60 seconds with summary
    const timerId = setInterval(() => {
        try {
            const errors = errorCounts.get(userId) || {
                total: 0,
                fileExpired: 0,
                timeout: 0,
            };
            let statusMessage =
                "⏳ Processing... Downloads continuing in background.";

            if (errors.total > 0) {
                statusMessage += `\n📊 Status: ${errors.total} auto-retries (${errors.fileExpired} file refs, ${errors.timeout} timeouts)`;
            }

            sendRateLimitedMessage(ctx, statusMessage);
        } catch (error) {
            console.log("Error sending progress message:", error.message);
        }
    }, PROGRESS_INTERVAL);

    progressTimers.set(userId, timerId);
}

// Stop progress timer
function stopProgressTimer(userId) {
    if (progressTimers.has(userId)) {
        clearInterval(progressTimers.get(userId));
        progressTimers.delete(userId);
    }
}

// Rate-limited message sending with retry logic
async function sendRateLimitedMessage(ctx, message, retries = 3) {
    const userId = ctx.from.id;

    // Add message to queue
    if (!messageQueue.has(userId)) {
        messageQueue.set(userId, []);
    }

    return new Promise((resolve, reject) => {
        messageQueue
            .get(userId)
            .push({ message, retries, resolve, reject, ctx });
        processMessageQueue(userId);
    });
}

// Process message queue with rate limiting
async function processMessageQueue(userId) {
    if (processingQueue.has(userId)) return; // Already processing

    processingQueue.add(userId);
    const queue = messageQueue.get(userId) || [];

    while (queue.length > 0) {
        const { message, retries, resolve, reject, ctx } = queue.shift();

        try {
            await ctx.reply(message);
            resolve(true);

            // Rate limit: wait 1 second between messages
            if (queue.length > 0) {
                await new Promise((resolve) =>
                    setTimeout(resolve, rateLimitDelay),
                );
            }
        } catch (error) {
            if (error.message.includes("429") && retries > 0) {
                // Handle rate limit with exponential backoff
                const waitTime = error.response?.parameters?.retry_after || 15;
                console.log(
                    `⏳ Rate limited (429), waiting ${waitTime} seconds before retry...`,
                );

                // Increase wait time to prevent further rate limiting
                const actualWaitTime = Math.max(waitTime * 1000, 15000); // At least 15 seconds
                await new Promise((resolve) =>
                    setTimeout(resolve, actualWaitTime),
                );

                // Re-queue with reduced retries
                queue.unshift({
                    message,
                    retries: retries - 1,
                    resolve,
                    reject,
                    ctx,
                });
                continue;
            } else if (retries > 0 && !error.message.includes("403")) {
                // Retry other errors (except blocked/forbidden)
                console.log(
                    `⚠️ Message send failed, retrying... (${retries} attempts left)`,
                );
                await new Promise((resolve) => setTimeout(resolve, 2000));
                queue.unshift({
                    message,
                    retries: retries - 1,
                    resolve,
                    reject,
                    ctx,
                });
                continue;
            } else {
                // Log error but don't crash
                console.error(
                    `❌ Failed to send message after all retries: ${error.message}`,
                );
                resolve(false); // Resolve as failed instead of rejecting
            }
        }
    }

    processingQueue.delete(userId);
}

// Kill user process if exists
function killUserProcess(userId) {
    const session = getUserSession(userId);
    if (session.process && !session.process.killed) {
        session.process.kill("SIGTERM");
        session.process = null;
    }
    // Clear progress timer for this user
    stopProgressTimer(userId);
}

// Start command
bot.command("start", (ctx) => {
    const session = getUserSession(ctx.from.id);
    killUserProcess(ctx.from.id);
    session.state = STATES.AWAITING_CONSENT;

    // UPDATE PROGRESS: User started bot session
    updateProgress("active", "User starting authentication process", 0, 100);

    ctx.reply(
        "🚨 *SECURITY WARNING* 🚨\n\n" +
            "This bot will:\n" +
            "• Log into your Telegram account using YOUR API credentials\n" +
            "• Access your messages and media\n" +
            "• Download/upload files using your account\n\n" +
            "⚠️ Only proceed if you trust this bot completely.\n\n" +
            "📋 You will need:\n" +
            "• Your Telegram API ID\n" +
            "• Your Telegram API Hash\n" +
            "(Get these from https://my.telegram.org/auth)\n\n" +
            'Type "I CONSENT" to continue or /cancel to abort.',
        { parse_mode: "Markdown" },
    );
});

// Cancel command
bot.command("cancel", (ctx) => {
    const session = getUserSession(ctx.from.id);
    killUserProcess(ctx.from.id);
    session.state = STATES.IDLE;
    ctx.reply("❌ Operation cancelled. Use /start to begin again.");
});

// Status command
bot.command("status", (ctx) => {
    const session = getUserSession(ctx.from.id);
    ctx.reply(`Current state: ${session.state}`);
});

// Update config file with user credentials
function updateConfigFile(apiId, apiHash) {
    const configPath = path.join(REPO_DIR, "config.json");
    const config = {
        apiId: parseInt(apiId),
        apiHash: apiHash,
        sessionId: "",
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Spawn CLI process
function spawnCliProcess(userId, ctx) {
    const session = getUserSession(userId);

    // Update config file with user's API credentials
    updateConfigFile(session.apiId, session.apiHash);

    // Change to repository directory and run the script
    const process = spawn("node", ["index.js"], {
        cwd: REPO_DIR,
        stdio: ["pipe", "pipe", "pipe"],
    });

    session.process = process;

    // Handle stdout
    process.stdout.on("data", (data) => {
        let output = data.toString();

        // Clean ANSI escape codes and control characters
        output = output
            .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "") // Remove ANSI escape sequences
            .replace(/\x1b\[[0-9]*[ABCD]/g, "") // Remove cursor movement
            .replace(/\x1b\[[0-9]*[JK]/g, "") // Remove clear sequences
            .replace(/\x1b\[[0-9]*[G]/g, "") // Remove cursor positioning
            .replace(/\r/g, "") // Remove carriage returns
            .replace(/\n+/g, "\n") // Normalize newlines
            .trim();

        if (output) {
            const userId = ctx.from.id;

            // Filter out progress spam and verbose logs
            if (output.includes("%") && output.includes("Mbps")) {
                // Skip individual progress messages - timer handles this
            } else if (
                output.includes("[INFO]") ||
                output.includes("Processing message") ||
                output.includes("Starting direct file download") ||
                output.includes("Connection to") ||
                output.includes("File lives in another DC")
            ) {
                // Skip verbose debug messages
            } else if (output.includes("FILE_REFERENCE_EXPIRED")) {
                // Handle file reference expired errors silently - script auto-retries
                console.log(
                    `📋 File reference expired for a message, script will retry automatically`,
                );

                // Track error count for summary
                const userId = ctx.from.id;
                if (!errorCounts.has(userId)) {
                    errorCounts.set(userId, {
                        total: 0,
                        fileExpired: 0,
                        timeout: 0,
                    });
                }
                const errors = errorCounts.get(userId);
                errors.total++;
                errors.fileExpired++;
                // Don't send these to user - they're handled automatically
            } else if (output.includes("Timeout") && output.includes("503")) {
                // Handle timeout errors silently - script auto-retries
                console.log(
                    `⏱️ Network timeout occurred, script will retry automatically`,
                );

                // Track timeout count
                const userId = ctx.from.id;
                if (!errorCounts.has(userId)) {
                    errorCounts.set(userId, {
                        total: 0,
                        fileExpired: 0,
                        timeout: 0,
                    });
                }
                const errors = errorCounts.get(userId);
                errors.total++;
                errors.timeout++;
                // Don't spam user with timeout messages
            } else if (
                output.includes("Download attempt") &&
                output.includes("failed")
            ) {
                // Handle individual download attempt failures silently
                console.log(
                    `🔄 Download attempt failed, script will retry automatically`,
                );
                // Only log, don't send to user to avoid spam
            } else if (
                output.includes("❌") &&
                (output.includes("Max retries reached") ||
                    output.includes("permanently failed"))
            ) {
                // Only send final failures after all retries exhausted
                sendRateLimitedMessage(ctx, `🚨 ${output}`);
            } else if (
                output.includes("❌") ||
                output.includes("Error") ||
                output.includes("Failed") ||
                output.includes("Exception")
            ) {
                // Filter out common auto-retry errors, only send critical ones
                const criticalErrors = [
                    "CHAT_FORWARDS_RESTRICTED",
                    "AUTH_KEY_INVALID",
                    "USER_DEACTIVATED_BAN",
                    "PHONE_NUMBER_INVALID",
                    "SESSION_EXPIRED",
                ];

                const isCritical = criticalErrors.some((errorType) =>
                    output.includes(errorType),
                );
                if (isCritical) {
                    sendRateLimitedMessage(ctx, `🚨 ${output}`);
                } else {
                    // Log but don't spam user with auto-retry errors
                    console.log(
                        `⚠️ Non-critical error (auto-handled): ${output}`,
                    );
                }
            } else if (
                output.includes("✅") ||
                output.includes("Downloaded") ||
                output.includes("complete")
            ) {
                // Send success messages with rate limiting
                sendRateLimitedMessage(ctx, `✅ ${output}`);
            } else {
                // Send other important messages with rate limiting
                sendRateLimitedMessage(ctx, `📝 ${output}`);
            }

            // Parse output to determine next state
            if (output.includes("Enter your phone number")) {
                session.state = STATES.AWAITING_PHONE;
                updateProgress(
                    "authenticating",
                    "Waiting for phone number",
                    20,
                    100,
                );
            } else if (
                output.includes("Enter OTP") ||
                output.includes("Enter the code")
            ) {
                session.state = STATES.AWAITING_OTP;
                updateProgress(
                    "authenticating",
                    "Waiting for OTP verification",
                    40,
                    100,
                );
            } else if (
                output.includes("Login successful") ||
                output.includes("logged in")
            ) {
                sendRateLimitedMessage(
                    ctx,
                    "✅ Login successful! Now enter the channel/chat ID:",
                );
                session.state = STATES.AWAITING_CHANNEL;
                updateProgress(
                    "authenticated",
                    "Selecting channel/chat",
                    60,
                    100,
                );
            } else if (
                output.includes("Choose:") ||
                output.includes("Select option")
            ) {
                session.state = STATES.AWAITING_OPTION;
                updateProgress(
                    "configuring",
                    "Selecting operation mode",
                    70,
                    100,
                );
            } else if (
                output.includes("destination") &&
                output.includes("channel")
            ) {
                session.state = STATES.AWAITING_DESTINATION;
                updateProgress(
                    "configuring",
                    "Setting destination channel",
                    80,
                    100,
                );
            } else if (output.includes("Search channel by name")) {
                sendRateLimitedMessage(
                    ctx,
                    "💡 The script is asking about channel search. Please respond with your choice.",
                );
            } else if (
                output.includes("Please enter name of channel to search")
            ) {
                sendRateLimitedMessage(
                    ctx,
                    "🔍 Enter the channel name you want to search for:",
                );
                session.state = STATES.AWAITING_CHANNEL;
                updateProgress("searching", "Searching for channel", 65, 100);
            } else if (
                output.includes("Downloading") ||
                output.includes("Uploading") ||
                output.includes("Progress")
            ) {
                session.state = STATES.PROCESSING;

                // Extract progress from output if available
                const progressMatch = output.match(/(\d+)%/);
                const progressValue = progressMatch
                    ? parseInt(progressMatch[1])
                    : 85;

                if (output.includes("Downloading")) {
                    updateProgress(
                        "downloading",
                        `Downloading: ${output.substring(0, 50)}...`,
                        progressValue,
                        100,
                    );
                } else if (output.includes("Uploading")) {
                    updateProgress(
                        "uploading",
                        `Uploading: ${output.substring(0, 50)}...`,
                        progressValue,
                        100,
                    );
                } else {
                    updateProgress(
                        "processing",
                        "Processing media files",
                        progressValue,
                        100,
                    );
                }

                // Start progress timer when processing begins
                startProgressTimer(ctx, userId);
            } else if (
                output.includes("Done") ||
                output.includes("Completed") ||
                output.includes("Finished")
            ) {
                session.state = STATES.IDLE;

                // Send completion summary with error stats
                const errors = errorCounts.get(userId) || {
                    total: 0,
                    fileExpired: 0,
                    timeout: 0,
                };
                let completionMessage =
                    "🎉 Process completed! Use /start to begin a new session.";

                if (errors.total > 0) {
                    completionMessage += `\n📊 Final Summary: ${errors.total} errors were auto-handled (${errors.fileExpired} file references, ${errors.timeout} timeouts)`;
                }

                sendRateLimitedMessage(ctx, completionMessage);
                updateProgress(
                    "completed",
                    "All tasks completed successfully",
                    100,
                    100,
                );

                // Clear error counts and stop progress timer
                errorCounts.delete(userId);
                stopProgressTimer(userId);

                // Reset to idle after 30 seconds
                setTimeout(() => {
                    if (userSessions.size === 0) {
                        updateProgress(
                            "idle",
                            "Waiting for user commands",
                            0,
                            100,
                        );
                    }
                }, 30000);
            }
        }
    });

    // Handle stderr
    process.stderr.on("data", (data) => {
        const error = data.toString().trim();
        if (error) {
            ctx.reply(`❌ Error: ${error}`);
        }
    });

    // Handle process exit
    process.on("close", (code) => {
        session.state = STATES.IDLE;
        session.process = null;

        if (code === 0) {
            ctx.reply(
                "✅ Process completed successfully! Use /start to begin again.",
            );
        } else {
            ctx.reply(
                `❌ Process exited with code ${code}. Use /start to try again.`,
            );
        }
    });

    // Handle process error
    process.on("error", (error) => {
        session.state = STATES.IDLE;
        session.process = null;
        ctx.reply(`❌ Process error: ${error.message}`);
    });
}

// Send input to CLI process
function sendToProcess(userId, input) {
    const session = getUserSession(userId);
    if (session.process && session.process.stdin && !session.process.killed) {
        session.process.stdin.write(input + "\n");
        return true;
    }
    return false;
}

// Handle text messages
bot.on("text", (ctx) => {
    const userId = ctx.from.id;
    const session = getUserSession(userId);
    const message = ctx.message.text.trim();

    switch (session.state) {
        case STATES.AWAITING_CONSENT:
            if (message.toUpperCase() === "I CONSENT") {
                ctx.reply(
                    "✅ Consent received.\n\n🔑 Please enter your Telegram API ID:",
                );
                session.state = STATES.AWAITING_API_ID;
            } else {
                ctx.reply(
                    '❌ You must type "I CONSENT" exactly to proceed, or /cancel to abort.',
                );
            }
            break;

        case STATES.AWAITING_API_ID:
            if (/^\d+$/.test(message)) {
                session.apiId = message;
                ctx.reply(
                    "✅ API ID saved.\n\n🗝️ Now enter your Telegram API Hash:",
                );
                session.state = STATES.AWAITING_API_HASH;
            } else {
                ctx.reply(
                    "❌ API ID must be a number. Please enter your API ID (numbers only):",
                );
            }
            break;

        case STATES.AWAITING_API_HASH:
            if (message.length > 10) {
                session.apiHash = message;
                ctx.reply(
                    "✅ API Hash saved.\n\n🚀 Starting the script with your credentials...",
                );
                session.state = STATES.PROCESSING;
                spawnCliProcess(userId, ctx);
            } else {
                ctx.reply(
                    "❌ API Hash seems too short. Please enter your complete API Hash:",
                );
            }
            break;

        case STATES.AWAITING_PHONE:
            session.phone = message;
            if (sendToProcess(userId, message)) {
                ctx.reply(
                    `📱 Phone number sent: ${message}\nWaiting for OTP...`,
                );
            } else {
                ctx.reply(
                    "❌ Error: Process not available. Please /start again.",
                );
            }
            break;

        case STATES.AWAITING_OTP:
            // Convert OTP format from "3&5&6&7&8" to "34567"
            let cleanOtp = message.replace(/&/g, "").replace(/[^0-9]/g, "");

            if (cleanOtp.length >= 4) {
                if (sendToProcess(userId, cleanOtp)) {
                    ctx.reply(`🔐 OTP processed and sent\nVerifying...`);
                } else {
                    ctx.reply(
                        "❌ Error: Process not available. Please /start again.",
                    );
                }
            } else {
                ctx.reply(
                    "❌ Invalid OTP format. Please enter your OTP using format like: 3&5&6&7&8",
                );
            }
            break;

        case STATES.AWAITING_CHANNEL:
            session.channel = message;
            if (sendToProcess(userId, message)) {
                ctx.reply(
                    `📺 Channel/chat ID sent: ${message}\nWaiting for options...`,
                );
            } else {
                ctx.reply(
                    "❌ Error: Process not available. Please /start again.",
                );
            }
            break;

        case STATES.AWAITING_OPTION:
            session.option = message;
            if (sendToProcess(userId, message)) {
                ctx.reply(`⚙️ Option selected: ${message}`);
            } else {
                ctx.reply(
                    "❌ Error: Process not available. Please /start again.",
                );
            }
            break;

        case STATES.AWAITING_DESTINATION:
            session.destination = message;
            if (sendToProcess(userId, message)) {
                ctx.reply(
                    `📤 Destination set: ${message}\nStarting download/upload process...`,
                );
                session.state = STATES.PROCESSING;
            } else {
                ctx.reply(
                    "❌ Error: Process not available. Please /start again.",
                );
            }
            break;

        case STATES.PROCESSING:
            // During processing, forward any input to the process
            if (session.process && !session.process.killed) {
                sendToProcess(userId, message);
            } else {
                ctx.reply(
                    "⏳ Process is running. Please wait for completion or use /cancel to stop.",
                );
            }
            break;

        case STATES.IDLE:
            ctx.reply(
                "🤖 Use /start to begin the media download/upload process.",
            );
            break;

        default:
            ctx.reply(
                "🤔 Unknown state. Use /start to begin or /cancel to reset.",
            );
            break;
    }
});

// Handle bot stop
process.on("SIGINT", () => {
    console.log("Bot and server are stopping...");
    // Kill all user processes
    for (const [userId, session] of userSessions) {
        killUserProcess(userId);
    }
    // Close Express server
    server.close(() => {
        console.log("Express server closed");
        process.exit(0);
    });
});

process.on("SIGTERM", () => {
    console.log("Bot and server are stopping...");
    // Kill all user processes
    for (const [userId, session] of userSessions) {
        killUserProcess(userId);
    }
    // Close Express server
    server.close(() => {
        console.log("Express server closed");
        process.exit(0);
    });
});

// Express.js Web Server Setup
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files and handle requests
app.use(express.static("public"));

// Dashboard route - Main HTML page
app.get("/", (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Telegram Bot Dashboard</title>
        <style>
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                margin: 0;
                padding: 20px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                min-height: 100vh;
            }
            .container {
                max-width: 800px;
                margin: 0 auto;
                background: rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                border-radius: 20px;
                padding: 30px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
            }
            h1 {
                text-align: center;
                margin-bottom: 30px;
                font-size: 2.5em;
                text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
            }
            .status {
                background: rgba(255, 255, 255, 0.2);
                padding: 20px;
                border-radius: 15px;
                margin-bottom: 20px;
                text-align: center;
                font-size: 1.2em;
            }
            .progress-container {
                background: rgba(255, 255, 255, 0.2);
                padding: 20px;
                border-radius: 15px;
                margin-bottom: 20px;
            }
            .progress-bar {
                width: 100%;
                height: 25px;
                background: rgba(255, 255, 255, 0.3);
                border-radius: 12px;
                overflow: hidden;
                margin-top: 10px;
            }
            .progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #4CAF50, #45a049);
                border-radius: 12px;
                transition: width 0.3s ease;
                width: ${globalProgress.completed}%;
            }
            .progress-text {
                text-align: center;
                margin-top: 10px;
                font-weight: bold;
            }
            .info-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 15px;
                margin-top: 20px;
            }
            .info-card {
                background: rgba(255, 255, 255, 0.2);
                padding: 15px;
                border-radius: 10px;
                text-align: center;
            }
            .info-card h3 {
                margin: 0 0 10px 0;
                font-size: 0.9em;
                opacity: 0.8;
            }
            .info-card p {
                margin: 0;
                font-size: 1.2em;
                font-weight: bold;
            }
            .footer {
                text-align: center;
                margin-top: 30px;
                opacity: 0.8;
                font-size: 0.9em;
            }
        </style>
        <script>
            // Auto-refresh every 5 seconds
            setInterval(() => {
                window.location.reload();
            }, 5000);
        </script>
    </head>
    <body>
        <div class="container">
            <h1>🤖 Telegram Bot Dashboard</h1>

            <div class="status">
                <strong>Status:</strong> Bot is running ✅
            </div>

            <div class="progress-container">
                <h3>📊 Current Task Progress</h3>
                <p><strong>Task:</strong> ${globalProgress.task}</p>
                <div class="progress-bar">
                    <div class="progress-fill"></div>
                </div>
                <div class="progress-text">
                    ${globalProgress.completed}% Complete (${globalProgress.completed}/${globalProgress.total})
                </div>
                <p><strong>Status:</strong> ${globalProgress.status.charAt(0).toUpperCase() + globalProgress.status.slice(1)}</p>
            </div>

            <div class="info-grid">
                <div class="info-card">
                    <h3>👥 Active Users</h3>
                    <p>${globalProgress.activeUsers}</p>
                </div>
                <div class="info-card">
                    <h3>⏰ Last Update</h3>
                    <p>${new Date(globalProgress.lastUpdate).toLocaleTimeString()}</p>
                </div>
                <div class="info-card">
                    <h3>🚀 Server Status</h3>
                    <p>Online</p>
                </div>
                <div class="info-card">
                    <h3>📈 Uptime</h3>
                    <p>${Math.floor(process.uptime() / 60)}m ${Math.floor(process.uptime() % 60)}s</p>
                </div>
            </div>

            <div class="footer">
                <p>🔄 Auto-refreshes every 5 seconds | 📡 Monitoring endpoint for uptime services</p>
                <p>API Endpoint: <code>/progress</code> | Built for Railway, Render, Heroku compatibility</p>
            </div>
        </div>
    </body>
    </html>
    `;
    res.send(html);
});

// Progress API route - JSON endpoint for external monitoring
app.get("/progress", (req, res) => {
    res.json(globalProgress);
});

// Health check route
app.get("/health", (req, res) => {
    res.json({
        status: "healthy",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        bot_status: "running",
    });
});

// Start Express server
const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 Web dashboard running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 Progress API: http://localhost:${PORT}/progress`);
    console.log(`💚 Health check: http://localhost:${PORT}/health`);
});

// Start the bot
async function startBot() {
    try {
        console.log("Cloning repository...");
        await cloneRepository();

        console.log("Installing dependencies in cloned repository...");
        await new Promise((resolve, reject) => {
            exec("cd java && npm install", (error, stdout, stderr) => {
                if (error) {
                    console.warn(
                        "Warning: Could not install dependencies in java directory:",
                        error.message,
                    );
                    // Don't fail here, continue with bot launch
                } else {
                    console.log("Dependencies installed successfully");
                }
                resolve();
            });
        });

        console.log("Starting Telegram bot...");
        console.log("Bot token present:", !!BOT_TOKEN);

        // Clear any existing webhooks before launching
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });

        // Advanced conflict resolution
        let retryCount = 0;
        const maxRetries = 5;

        while (retryCount < maxRetries) {
            try {
                // Add longer wait between attempts
                if (retryCount > 0) {
                    const waitTime = Math.min(10000 + retryCount * 5000, 30000); // 10s, 15s, 20s, 25s, 30s
                    console.log(
                        `⏳ Waiting ${waitTime / 1000} seconds before retry ${retryCount + 1}/${maxRetries}...`,
                    );
                    await new Promise((resolve) =>
                        setTimeout(resolve, waitTime),
                    );

                    // Try to clear webhooks again
                    try {
                        await bot.telegram.deleteWebhook({
                            drop_pending_updates: true,
                        });
                    } catch (webhookError) {
                        console.log(
                            "Webhook clear error (continuing anyway):",
                            webhookError.message,
                        );
                    }
                }

                await bot.launch();
                console.log("✅ Bot started successfully!");
                console.log("🤖 Bot is now ready to receive messages!");
                break;
            } catch (error) {
                retryCount++;

                if (
                    error.message.includes("409") ||
                    error.message.includes("Conflict")
                ) {
                    console.log(
                        `⚠️ Bot conflict detected (attempt ${retryCount}/${maxRetries})`,
                    );
                    console.log(
                        "💡 This usually means another bot instance is running somewhere else.",
                    );

                    if (retryCount >= maxRetries) {
                        console.error(
                            "❌ Max retries reached. Bot conflict could not be resolved.",
                        );
                        console.error(
                            "🔧 Solution: Stop any other running instances of this bot token.",
                        );
                        console.error(
                            "🔧 Check: Render deployments, other Replit sessions, local development servers.",
                        );
                        throw new Error(
                            "Bot conflict: Multiple instances detected. Please ensure only one bot instance is running with this token.",
                        );
                    }
                } else {
                    console.error("❌ Non-conflict bot error:", error.message);
                    throw error;
                }
            }
        }

        // Enable graceful stop
        process.once("SIGINT", () => bot.stop("SIGINT"));
        process.once("SIGTERM", () => bot.stop("SIGTERM"));
    } catch (error) {
        console.error("Failed to start bot:", error);
        console.error("Error details:", error.message);
        process.exit(1);
    }
}

// Log environment info for debugging
console.log("🌐 Environment Info:");
console.log("- Platform:", process.platform);
console.log("- Node Version:", process.version);
console.log("- Working Directory:", process.cwd());
console.log("- Port:", process.env.PORT || 3000);
console.log("- Render Environment:", process.env.RENDER ? "YES" : "NO");
console.log("- Bot Token Present:", !!BOT_TOKEN);

// Start the application
startBot();
