const fs = require('fs');
const path = require('path');
const TelegramBot = require("node-telegram-bot-api");

// ============================================================
// ⚙️ ADMIN CONFIGURATION
// ============================================================
const ADMIN_IDS = [6006322754];

// ============================================================
// 🤖 BOT CONFIGURATION
// ============================================================
const BOT_TOKENS = {
   // NOTIFICATION_BOT: "8375633677:AAHBu9F3h8nVg6nNwtW7Zijtb4o_i4zzHoo", // গ্রুপে ওটিপি পাঠানোর জন্য
   // USER_BOT: "8375633677:AAHBu9F3h8nVg6nNwtW7Zijtb4o_i4zzHoo",         // মেইন ইউজার বট

    //test bot
   NOTIFICATION_BOT: "7142079092:AAGHKZJ1K6BRQ7CckbNWeYyXmW05xGZ4FT8", // Bot 1
   USER_BOT: "7142079092:AAGHKZJ1K6BRQ7CckbNWeYyXmW05xGZ4FT8"      // Bot 2

};

const ALIF_API_BASE_URL = "https://alif-apiserver.vercel.app/nexo-pay";
const ALIF_API_KEY = "alif-api";

const ADMIN_INFO = {
    ADMIN_IDS: [6006322754],
    SUPPORT: "alifhosson",
    REQUIRED_JOIN: [
        { id: -1002245233356, url: "https://t.me/+VSMzR6gHsh4yMzFl" },
        { id: -1002978485719, url: "https://t.me/+Pslir1rUH1dmN2E1" },
        { id: -1002391889544, url: "https://t.me/+2XH40sg3Pj9iNGY1" }
    ]
};

const GROUP_LINKS = {
    //OTP_GROUP_ID: "-1002391889544",
    //OTP_GROUP_ID: "-1003228541421",
    WITHDRAW_GROUP_ID : "-1004306356999",
    OTP_GROUP_LINK: "https://t.me/+2XH40sg3Pj9iNGY1",
    PAY_GROUP_LINK: "https://t.me/+8hiNHsrn2jsxMzll",   // ← এখানে Pay Group লিংক দিন
    MAIN_CHANNEL_LINK: "https://youtube.com/@team_x4x",
    NUMBER_PANEL_LINK: "https://t.me/NEXOZONEBOT",
};



// ============================================================
// 🗄️ MONGODB CONFIGURATION
// ============================================================
const USER_DB_URI = "mongodb+srv://earbag436_db_user:alif123@user.dqgdxf6.mongodb.net/?appName=user&retryWrites=true&w=majority";    //1

const NUMBER_DB_URI = "mongodb+srv://peasonsee801_db_user:alif123@number.rdqe8gb.mongodb.net/?appName=number&retryWrites=true&w=majority";    //2

const USER_STATUS_DB = "mongodb+srv://y3od31uvk8_db_user:alif123@pamentinfo.ihxi1d4.mongodb.net/?appName=pamentinfo&retryWrites=true&w=majority"; //3


// ============================================================
// 🎨 LOGGING SYSTEM
// ============================================================
const colors = {
    reset: "\x1b[0m", bright: "\x1b[1m", green: "\x1b[32m",
    yellow: "\x1b[33m", cyan: "\x1b[36m", red: "\x1b[31m", blue: "\x1b[34m"
};

function log(source, msg, type = 'info') {
    let color = colors.green, icon = "🔹";
    if (type === 'error') { color = colors.red; icon = "❌"; }
    else if (type === 'sms') { color = colors.cyan; icon = "📩"; }
    else if (type === 'warn') { color = colors.yellow; icon = "⚠️"; }
    else if (type === 'success') { color = colors.green; icon = "✅"; }

    console.log(`${colors.bright}${color}${icon} [${source}]${colors.reset} ${msg}`);
}

// ============================================================
// 📢 ERROR REPORTING
// ============================================================
let adminBot = null;

async function initAdminBot() {
    try {
        adminBot = new TelegramBot(BOT_TOKENS.USER_BOT, { polling: false });
        log("SYSTEM", `Admin reporting enabled for ${ADMIN_IDS.length} admins`, "success");
    } catch (e) {
        console.error("Failed to init admin bot:", e.message);
    }
}

async function reportErrorToAdmin(source, errorMessage) {
    if (!adminBot || ADMIN_IDS.length === 0) return;
    const text = `❌ <b>ERROR ALERT</b>\n\n📍 <b>Source:</b> ${source}\n⚠️ <b>Error:</b>\n<pre>${String(errorMessage).substring(0, 3000)}</pre>`;

    for (const adminId of ADMIN_IDS) {
        try {
            await adminBot.sendMessage(adminId, text, { parse_mode: "HTML" });
        } catch (e) {
            // Ignore if admin blocked bot
        }
    }
}

// ============================================================
// 🚀 LOADERS
// ============================================================
function loadNumberBot() {
    const numberBotPath = path.join(__dirname, 'Number', 'number-bot.js');
    if (!fs.existsSync(numberBotPath)) {
        log("SYSTEM", "Number Bot file missing!", "error");
        return;
    }
    try {
        global.NUMBER_BOT_CONFIG = {
    BOT_TOKEN: BOT_TOKENS.USER_BOT,
    USER_DB_URI: USER_DB_URI,
    NUMBER_DB_URI: NUMBER_DB_URI,
    USER_STATUS_DB: USER_STATUS_DB,
    OTP_GROUP_URL: GROUP_LINKS.OTP_GROUP_LINK,
    PAY_GROUP_URL: GROUP_LINKS.PAY_GROUP_LINK,
    GROUP_LINKS: GROUP_LINKS,
    ADMIN_INFO: ADMIN_INFO,
    ALIF_API_BASE_URL: ALIF_API_BASE_URL,
    ALIF_API_KEY: ALIF_API_KEY,
    WITHDRAW_GROUP_ID: GROUP_LINKS.WITHDRAW_GROUP_ID
};
        require(numberBotPath);
        log("NUMBER-BOT", "Started Successfully!", "success");
    } catch (error) {
        reportErrorToAdmin("NUMBER BOT LOAD", error.message);
    }
}

function loadOtpWorkers() {
    const otpFolder = path.join(__dirname, 'otp');
    if (!fs.existsSync(otpFolder)) fs.mkdirSync(otpFolder, { recursive: true });

    const files = fs.readdirSync(otpFolder).filter(file => file.endsWith('.js'));
    if (files.length === 0) return log("SYSTEM", "No OTP workers found.", "warn");

    files.forEach(file => {
        const workerName = file.replace('.js', '').toUpperCase();
        try {
            log("SYSTEM", `Loading Worker: ${workerName}...`, "warn");
            const WorkerClass = require(path.join(otpFolder, file));
            const worker = new WorkerClass();

            worker.setConfig({
  BOT_TOKENS,
  GROUP_LINKS,
  NUMBER_DB_URI,
  USER_DB_URI,
  USER_STATUS_DB,              
  ADMIN_IDS: ADMIN_INFO.ADMIN_IDS
});

            worker.on('log', (msg) => log(workerName, msg, 'info'));
            worker.on('error', (msg) => {
                log(workerName, msg, 'error');
                // Optional: Reduce admin spam by uncommenting below only for critical errors
                // reportErrorToAdmin(workerName, msg); 
            });
            worker.on('sms', (msg) => log(workerName, msg, 'sms'));

            worker.start();
        } catch (error) {
            log(workerName, `Load Error: ${error.message}`, "error");
        }
    });
}

// ============================================================
// ⚠️ GLOBAL HANDLERS
// ============================================================
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught:', err.message);
    reportErrorToAdmin("SYSTEM CRASH", err.message);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('💥 Rejection:', reason);
    reportErrorToAdmin("UNHANDLED REJECTION", msg);
});

// ============================================================
// 🏁 START
// ============================================================
(async () => {
    console.log(`\n🤖 MULTI-BOT SYSTEM STARTING\n`);
    await initAdminBot();
    loadNumberBot();
    loadOtpWorkers();
})();
const fs = require('fs');
const path = require('path');
const TelegramBot = require("node-telegram-bot-api");

// ============================================================
// ⚙️ ADMIN CONFIGURATION
// ============================================================
const ADMIN_IDS = [6006322754];

// ============================================================
// 🤖 BOT CONFIGURATION
// ============================================================
const BOT_TOKENS = {
   // NOTIFICATION_BOT: "8375633677:AAHBu9F3h8nVg6nNwtW7Zijtb4o_i4zzHoo", // গ্রুপে ওটিপি পাঠানোর জন্য
   // USER_BOT: "8375633677:AAHBu9F3h8nVg6nNwtW7Zijtb4o_i4zzHoo",         // মেইন ইউজার বট

    //test bot
   NOTIFICATION_BOT: "7142079092:AAGHKZJ1K6BRQ7CckbNWeYyXmW05xGZ4FT8", // Bot 1
   USER_BOT: "7142079092:AAGHKZJ1K6BRQ7CckbNWeYyXmW05xGZ4FT8"      // Bot 2

};

const ALIF_API_BASE_URL = "https://alif-apiserver.vercel.app/nexo-pay";
const ALIF_API_KEY = "alif-api";

const ADMIN_INFO = {
    ADMIN_IDS: [6006322754],
    SUPPORT: "alifhosson",
    REQUIRED_JOIN: [
        { id: -1002245233356, url: "https://t.me/+VSMzR6gHsh4yMzFl" },
        { id: -1002978485719, url: "https://t.me/+Pslir1rUH1dmN2E1" },
        { id: -1002391889544, url: "https://t.me/+2XH40sg3Pj9iNGY1" }
    ]
};

const GROUP_LINKS = {
    //OTP_GROUP_ID: "-1002391889544",
    //OTP_GROUP_ID: "-1003228541421",
    WITHDRAW_GROUP_ID : "-1004306356999",
    OTP_GROUP_LINK: "https://t.me/+2XH40sg3Pj9iNGY1",
    PAY_GROUP_LINK: "https://t.me/+8hiNHsrn2jsxMzll",   // ← এখানে Pay Group লিংক দিন
    MAIN_CHANNEL_LINK: "https://youtube.com/@team_x4x",
    NUMBER_PANEL_LINK: "https://t.me/NEXOZONEBOT",
};



// ============================================================
// 🗄️ MONGODB CONFIGURATION
// ============================================================
const USER_DB_URI = "mongodb+srv://earbag436_db_user:alif123@user.dqgdxf6.mongodb.net/?appName=user&retryWrites=true&w=majority";    //1

const NUMBER_DB_URI = "mongodb+srv://peasonsee801_db_user:alif123@number.rdqe8gb.mongodb.net/?appName=number&retryWrites=true&w=majority";    //2

const USER_STATUS_DB = "mongodb+srv://y3od31uvk8_db_user:alif123@pamentinfo.ihxi1d4.mongodb.net/?appName=pamentinfo&retryWrites=true&w=majority"; //3


// ============================================================
// 🎨 LOGGING SYSTEM
// ============================================================
const colors = {
    reset: "\x1b[0m", bright: "\x1b[1m", green: "\x1b[32m",
    yellow: "\x1b[33m", cyan: "\x1b[36m", red: "\x1b[31m", blue: "\x1b[34m"
};

function log(source, msg, type = 'info') {
    let color = colors.green, icon = "🔹";
    if (type === 'error') { color = colors.red; icon = "❌"; }
    else if (type === 'sms') { color = colors.cyan; icon = "📩"; }
    else if (type === 'warn') { color = colors.yellow; icon = "⚠️"; }
    else if (type === 'success') { color = colors.green; icon = "✅"; }

    console.log(`${colors.bright}${color}${icon} [${source}]${colors.reset} ${msg}`);
}

// ============================================================
// 📢 ERROR REPORTING
// ============================================================
let adminBot = null;

async function initAdminBot() {
    try {
        adminBot = new TelegramBot(BOT_TOKENS.USER_BOT, { polling: false });
        log("SYSTEM", `Admin reporting enabled for ${ADMIN_IDS.length} admins`, "success");
    } catch (e) {
        console.error("Failed to init admin bot:", e.message);
    }
}

async function reportErrorToAdmin(source, errorMessage) {
    if (!adminBot || ADMIN_IDS.length === 0) return;
    const text = `❌ <b>ERROR ALERT</b>\n\n📍 <b>Source:</b> ${source}\n⚠️ <b>Error:</b>\n<pre>${String(errorMessage).substring(0, 3000)}</pre>`;

    for (const adminId of ADMIN_IDS) {
        try {
            await adminBot.sendMessage(adminId, text, { parse_mode: "HTML" });
        } catch (e) {
            // Ignore if admin blocked bot
        }
    }
}

// ============================================================
// 🚀 LOADERS
// ============================================================
function loadNumberBot() {
    const numberBotPath = path.join(__dirname, 'Number', 'number-bot.js');
    if (!fs.existsSync(numberBotPath)) {
        log("SYSTEM", "Number Bot file missing!", "error");
        return;
    }
    try {
        global.NUMBER_BOT_CONFIG = {
    BOT_TOKEN: BOT_TOKENS.USER_BOT,
    USER_DB_URI: USER_DB_URI,
    NUMBER_DB_URI: NUMBER_DB_URI,
    USER_STATUS_DB: USER_STATUS_DB,
    OTP_GROUP_URL: GROUP_LINKS.OTP_GROUP_LINK,
    PAY_GROUP_URL: GROUP_LINKS.PAY_GROUP_LINK,
    GROUP_LINKS: GROUP_LINKS,
    ADMIN_INFO: ADMIN_INFO,
    ALIF_API_BASE_URL: ALIF_API_BASE_URL,
    ALIF_API_KEY: ALIF_API_KEY,
    WITHDRAW_GROUP_ID: GROUP_LINKS.WITHDRAW_GROUP_ID
};
        require(numberBotPath);
        log("NUMBER-BOT", "Started Successfully!", "success");
    } catch (error) {
        reportErrorToAdmin("NUMBER BOT LOAD", error.message);
    }
}

function loadOtpWorkers() {
    const otpFolder = path.join(__dirname, 'otp');
    if (!fs.existsSync(otpFolder)) fs.mkdirSync(otpFolder, { recursive: true });

    const files = fs.readdirSync(otpFolder).filter(file => file.endsWith('.js'));
    if (files.length === 0) return log("SYSTEM", "No OTP workers found.", "warn");

    files.forEach(file => {
        const workerName = file.replace('.js', '').toUpperCase();
        try {
            log("SYSTEM", `Loading Worker: ${workerName}...`, "warn");
            const WorkerClass = require(path.join(otpFolder, file));
            const worker = new WorkerClass();

            worker.setConfig({
  BOT_TOKENS,
  GROUP_LINKS,
  NUMBER_DB_URI,
  USER_DB_URI,
  USER_STATUS_DB,              
  ADMIN_IDS: ADMIN_INFO.ADMIN_IDS
});

            worker.on('log', (msg) => log(workerName, msg, 'info'));
            worker.on('error', (msg) => {
                log(workerName, msg, 'error');
                // Optional: Reduce admin spam by uncommenting below only for critical errors
                // reportErrorToAdmin(workerName, msg); 
            });
            worker.on('sms', (msg) => log(workerName, msg, 'sms'));

            worker.start();
        } catch (error) {
            log(workerName, `Load Error: ${error.message}`, "error");
        }
    });
}

// ============================================================
// ⚠️ GLOBAL HANDLERS
// ============================================================
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught:', err.message);
    reportErrorToAdmin("SYSTEM CRASH", err.message);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('💥 Rejection:', reason);
    reportErrorToAdmin("UNHANDLED REJECTION", msg);
});

// ============================================================
// 🏁 START
// ============================================================
(async () => {
    console.log(`\n🤖 MULTI-BOT SYSTEM STARTING\n`);
    await initAdminBot();
    loadNumberBot();
    loadOtpWorkers();
})();
