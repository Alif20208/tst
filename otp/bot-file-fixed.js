const _axiosLib = require("axios");
const axios = _axiosLib.default || _axiosLib;
const TelegramBot = require("node-telegram-bot-api");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const countryEmoji = require("country-emoji");
const mongoose = require("mongoose");
const EventEmitter = require("events");
//const fs = require("fs");
const path = require("path");

// ── API Config ────────────────────────────────────────────────────────────────
const CONFIG_JSON_URL = "https://alifhosson-json-api.vercel.app/data/sms-api-bot.js";
let   API_URL  = null;
const API_KEY  = "nexo0";
const POLL_MS  = 500;  // ✅ FIX: 800ms → 500ms — OTP দ্রুত detect করবে

const SERVICE_JSON_URL = "https://alifhosson-json-api.vercel.app/data/service.json";
const EMOJI_JSON_URL   = "https://alifhosson-json-api.vercel.app/data/emoji.json";

const REMOTE_REFRESH_MS = 3 * 60 * 1000;  // ✅ FIX: 5min → 3min refresh

// ── Seen IDs persistence ──────────────────────────────────────────────────────
// ✅ FIX-CORE: seenIds এখন Map<key, timestamp> — শুধু key নয়, কখন দেখা হয়েছে সেটাও রাখে
// এতে TTL-based cleanup সম্ভব: পুরোনো OTP expire হলে মুছে যায়, নতুন OTP কখনো miss হয় না
// আগে Set<key> ছিল, MAX_SEEN পার হলে পুরোনো key delete হতো — তখন পুরোনো OTP আবার নতুন মনে হতো
const SEEN_IDS_FILE = path.join(__dirname, ".local_db/.seen_ids.json");
const SEEN_TTL_MS   = 30 * 60 * 60 * 1000;  // ৩০ ঘন্টা — API restart/reset-এও duplicate OTP যাবে না

function loadSeenIds() {
    try {
        const dir = path.dirname(SEEN_IDS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(SEEN_IDS_FILE)) {
            const raw  = JSON.parse(fs.readFileSync(SEEN_IDS_FILE, "utf8"));
            const now  = Date.now();
            const map  = new Map();
            // পুরোনো format (Array) — সব entry কে "এইমাত্র দেখা" timestamp দাও
            if (Array.isArray(raw)) {
                raw.forEach(k => map.set(k, now));
                console.log(`[seenIds] Loaded ${map.size} IDs from disk (legacy format — timestamped now)`);
            }
            // নতুন format (Object) — শুধু TTL এর মধ্যে থাকা entries load করো
            else if (raw && typeof raw === "object") {
                for (const [k, ts] of Object.entries(raw)) {
                    if (now - ts < SEEN_TTL_MS) map.set(k, ts);
                }
                console.log(`[seenIds] Loaded ${map.size} IDs from disk (restart protection active)`);
            }
            return map;
        } else {
            fs.writeFileSync(SEEN_IDS_FILE, JSON.stringify({}));
            console.log("[seenIds] New .seen_ids.json file created");
        }
    } catch (e) {
        console.error("[seenIds] Failed to load seen IDs from disk:", e.message);
    }
    return new Map();
}

function saveSeenIds(seenMap) {
    try {
        const dir = path.dirname(SEEN_IDS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // শুধু TTL এর মধ্যে থাকা entries সেভ করো — মেয়াদ শেষ হওয়া গুলো বাদ
        const now  = Date.now();
        const obj  = {};
        for (const [k, ts] of seenMap.entries()) {
            if (now - ts < SEEN_TTL_MS) obj[k] = ts;
        }
        fs.writeFileSync(SEEN_IDS_FILE, JSON.stringify(obj));
    } catch (e) {
        console.error("[seenIds] Failed to save seen IDs:", e.message);
    }
}

// seenIds এ key আছে কিনা চেক করে (Map হওয়ায় .has() সরাসরি কাজ করে)
function seenHas(seenMap, key) {
    const ts = seenMap.get(key);
    if (ts === undefined) return false;
    if (Date.now() - ts >= SEEN_TTL_MS) {
        seenMap.delete(key);  // expire হয়ে গেছে, আর নতুন হলে ঢুকতে পারবে
        return false;
    }
    return true;
}

// seenIds এ নতুন key যোগ করে, সাথে timestamp
function seenAdd(seenMap, key) {
    seenMap.set(key, Date.now());
}

// TTL পার হওয়া entries পরিষ্কার করো (loop-এ মাঝে মাঝে call করো)
function seenCleanup(seenMap) {
    const now = Date.now();
    for (const [k, ts] of seenMap.entries()) {
        if (now - ts >= SEEN_TTL_MS) seenMap.delete(k);
    }
}

// row valid কিনা — number থাকতে হবে, আর otp বা meaningful message যেকোনো একটা থাকতে হবে
function isValidSmsRow(item) {
    const number  = String(item.number  || "").replace(/\D/g, "").trim();
    if (number.length === 0) return false;
    const otp     = String(item.otp || item.code || "").trim();
    const message = String(item.message || "").trim();
    // otp থাকলেই যথেষ্ট — message "$" বা ফাঁকা হলেও চলবে
    if (otp.length > 0) return true;
    // otp না থাকলে message-এ অর্থপূর্ণ কিছু থাকতে হবে (minimum 5 char, not just "$")
    return message.length >= 5 && !/^\$+$/.test(message);
}

class Alif extends EventEmitter {
    constructor() {
        super();
        this.config         = null;
        this.botGroup       = null;
        this.botUser        = null;
        this.NumberModel    = null;
        this.seenIds        = loadSeenIds();
        this.isInitialized  = false;
        this.MAX_SEEN       = 500;
        this.MAX_RETRIES    = 2;
        this.serviceData    = {};
        this.emojiData      = {};
        this.flagToggle     = false;
        this.btnColorToggle = false;
        this._refreshTimer  = null;
    }

    async setConfig(config) {
        this.config = config;
        await this.loadRemoteData();
        this.initializeBots();
        this.initializeDatabase();
    }

    async loadRemoteData() {
        try {
            const [cRes, sRes, eRes] = await Promise.all([
                axios.get(CONFIG_JSON_URL),
                axios.get(SERVICE_JSON_URL),
                axios.get(EMOJI_JSON_URL)
            ]);
            const configData = cRes.data;
            if (configData && configData.api_url) {
                API_URL = configData.api_url;
            } else {
                this.emit('error', '❌ api_url not found in config JSON');
            }
            this.serviceData = sRes.data;
            this.emojiData   = eRes.data;
        } catch (e) {
            this.emit('error', '❌ Failed to load remote JSON data');
        }
    }

    async refreshServiceAndEmojiData() {
        try {
            const [sRes, eRes] = await Promise.all([
                axios.get(SERVICE_JSON_URL),
                axios.get(EMOJI_JSON_URL)
            ]);
            this.serviceData = sRes.data;
            this.emojiData   = eRes.data;
            console.log('[refresh] service.json & emoji.json updated');
        } catch (e) {
            console.error('[refresh] Failed to refresh service/emoji JSON:', e.message);
        }
    }

    async refreshApiUrl() {
        try {
            const cRes = await axios.get(CONFIG_JSON_URL);
            if (cRes.data && cRes.data.api_url) {
                if (cRes.data.api_url !== API_URL) {
                    console.log('[refresh] api_url changed ->', cRes.data.api_url);
                }
                API_URL = cRes.data.api_url;
            }
        } catch (e) {
            console.error('[refresh] Failed to refresh api_url:', e.message);
        }
    }

    startRemoteRefreshLoop() {
        if (this._refreshTimer) clearInterval(this._refreshTimer);
        this._refreshTimer = setInterval(() => {
            this.refreshServiceAndEmojiData();
            this.refreshApiUrl();
        }, REMOTE_REFRESH_MS);
    }

    initializeBots() {
        const opts = { polling: false, request: { timeout: 15000 } };
        this.botGroup = new TelegramBot(this.config.BOT_TOKENS.NOTIFICATION_BOT, opts);
        this.botUser  = new TelegramBot(this.config.BOT_TOKENS.USER_BOT, opts);
    }

    initializeDatabase() {
        const conn = mongoose.createConnection(this.config.NUMBER_DB_URI, {
            serverSelectionTimeoutMS: 10000,
            family: 4,
            maxPoolSize: 50,
            minPoolSize: 5,
            retryWrites: true,
        });

        const numberSchema = new mongoose.Schema({
            number:      { type: String, index: true },
            country:     String,
            flag:        String,
            sector:      { type: String, default: 'facebook' },
            status:      String,
            price:       { type: Number, default: null },
            assigned_to: { type: Number, index: true, default: null },
            assigned_at: { type: Date, default: null }
        }, { strict: false });

        const seenIdSchema = new mongoose.Schema({
            _id:     { type: String },
            savedAt: { type: Date, default: Date.now }
        });

        this.NumberModel   = conn.model('Number', numberSchema);
        this.SeenIdModel   = conn.model('SeenId', seenIdSchema);
        this.isDBReady     = false;
        this.isUserDBReady = false;
        this.WalletModel   = null;
        this.ConfigModel   = null;

        conn.on('connected', async () => {
            this.isDBReady = true;
            console.log('[panel] ✅ Number DB connected — loading seenIds from MongoDB...');
            try {
                await this.NumberModel.collection.createIndex({ number: 1, status: 1 });
                await this.NumberModel.collection.createIndex({ assigned_to: 1, status: 1 });
                console.log('[panel] ✅ DB indexes ensured');
            } catch(e) {
                console.warn('[panel] Index creation skipped:', e.message);
            }
            try {
                const docs = await this.SeenIdModel.find({}, { _id: 1 }).lean();
                if (docs.length > 0) {
                    docs.forEach(d => seenAdd(this.seenIds, d._id));
                    console.log('[seenIds] Loaded ' + docs.length + ' IDs from MongoDB');
                    saveSeenIds(this.seenIds);
                }
                const usedCount     = await this.NumberModel.countDocuments({ status: 'Used' });
                const assignedCount = await this.NumberModel.countDocuments({ status: 'Used', assigned_to: { $ne: null } });
                console.log(`[panel] 📊 Numbers in DB — Used: ${usedCount}, With assigned_to: ${assignedCount}`);
            } catch(e) {
                console.error('[seenIds] MongoDB load error:', e.message);
            }
        });
        conn.on('error', (e) => {
            this.isDBReady = false;
            console.error('[panel] ❌ Number DB error:', e.message);
        });

        if (this.config.USER_DB_URI) {
            const userConn = mongoose.createConnection(this.config.USER_DB_URI, {
                serverSelectionTimeoutMS: 10000,
                family: 4,
                maxPoolSize: 20,
                minPoolSize: 3,
                retryWrites: true,
            });

            const walletSchema = new mongoose.Schema({
                telegramId:  { type: Number, unique: true, required: true },
                firstName:   { type: String, default: '' },
                balance:     { type: Number, default: 0 },
                referredBy:  { type: Number, default: null },
                referCount:  { type: Number, default: 0 },
            });

            const configSchema = new mongoose.Schema({
                key:   { type: String, unique: true, required: true },
                value: { type: String, required: true },
            });

            this.WalletModel = userConn.model('WalletUser', walletSchema);
            this.ConfigModel = userConn.model('Config', configSchema);

            userConn.on('connected', () => {
                this.isUserDBReady = true;
                console.log('[panel] User DB connected');
            });
            userConn.on('error', (e) => {
                this.isUserDBReady = false;
                console.log('[panel] User DB error:', e.message);
            });
        } else {
            console.log('[panel] USER_DB_URI missing! Balance/commission disabled.');
        }
    }

    async getRefLevels() {
        try {
            if (!this.ConfigModel) return null;
            const conf = await this.ConfigModel.findOne({ key: 'ref_levels' });
            if (conf) return JSON.parse(conf.value);
        } catch(e) {}
        return null;
    }

    getReferralLevel(referCount, levels) {
        const REF_LEVELS = levels || [
            { level: 1, minRefs:   0, commission: 0.0002 },
            { level: 2, minRefs:  50, commission: 0.0004 },
            { level: 3, minRefs: 100, commission: 0.0006 },
            { level: 4, minRefs: 150, commission: 0.0008 },
            { level: 5, minRefs: 200, commission: 0.0010 },
        ];
        let current = REF_LEVELS[0];
        for (const lvl of REF_LEVELS) {
            if (referCount >= lvl.minRefs) current = lvl;
        }
        return current;
    }

    async payCommission(assignedUserId, numberPrice) {
        try {
            if (!this.isUserDBReady || !this.WalletModel) {
                console.log('[payCommission] UserDB not ready');
                return null;
            }

            let updatedBalance = null;

            if (numberPrice && numberPrice > 0) {
                const updated = await this.WalletModel.findOneAndUpdate(
                    { telegramId: assignedUserId },
                    { $inc: { balance: numberPrice } },
                    { returnDocument: 'after' }
                );
                if (updated) {
                    updatedBalance = updated.balance;
                    console.log(`[payCommission] +$${numberPrice.toFixed(4)} -> user ${assignedUserId} | balance: $${updated.balance.toFixed(4)}`);
                } else {
                    console.log(`[payCommission] WalletUser not found for: ${assignedUserId}`);
                }
            } else {
                console.log(`[payCommission] No price on number, skipping user balance`);
                const wallet = await this.WalletModel.findOne({ telegramId: assignedUserId }).lean();
                if (wallet) updatedBalance = wallet.balance;
            }

            let seller = await this.WalletModel.findOne({ telegramId: assignedUserId });
            if (!seller) {
                seller = await this.WalletModel.findOneAndUpdate(
                    { telegramId: assignedUserId },
                    { $setOnInsert: { telegramId: assignedUserId, balance: 0, referredBy: null, referCount: 0 } },
                    { upsert: true, returnDocument: 'after' }
                ).catch((e) => {
                    console.error('[payCommission] seller upsert error:', e.message);
                    return null;
                });
            }
            if (!seller || !seller.referredBy) {
                console.log(`[payCommission] No referrer for user ${assignedUserId}`);
                return updatedBalance;
            }

            const referrer = await this.WalletModel.findOne({ telegramId: seller.referredBy });
            if (!referrer) {
                console.log(`[payCommission] Referrer ${seller.referredBy} not found`);
                return updatedBalance;
            }

            const levels = await this.getRefLevels();
            const lvl    = this.getReferralLevel(referrer.referCount || 0, levels);

            const updatedRef = await this.WalletModel.findOneAndUpdate(
                { telegramId: referrer.telegramId },
                { $inc: { balance: lvl.commission } },
                { returnDocument: 'after' }
            );

            if (updatedRef) {
                console.log(`[payCommission] +$${lvl.commission.toFixed(4)} -> referrer ${referrer.telegramId} (L${lvl.level}) | balance: $${updatedRef.balance.toFixed(4)}`);
            }

            return updatedBalance;

        } catch(e) {
            console.error('[payCommission] Error:', e.message);
            return null;
        }
    }

    async sendTelegramWithRetry(bot, chatId, message, options, _attempt = 0) {
        try {
            return await bot.sendMessage(chatId, message, options);
        } catch (error) {
            const msg = error.message || '';
            const retryMatch = msg.match(/retry after (\d+)/i);
            if (retryMatch && _attempt < 2) {
                const waitSec = Math.min(parseInt(retryMatch[1]) + 1, 30);
                console.warn(`[sendTelegram] 429 — waiting ${waitSec}s for chatId ${chatId}`);
                await new Promise(r => setTimeout(r, waitSec * 1000));
                return this.sendTelegramWithRetry(bot, chatId, message, options, _attempt + 1);
            }
            if (msg.includes("can't parse entities") && options && options.parse_mode) {
                console.warn(`[sendTelegram] HTML parse error for chatId ${chatId} — retrying as plain text`);
                const safeOptions = { ...options };
                delete safeOptions.parse_mode;
                const plainMsg = message.replace(/<[^>]*>/g, '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
                try { return await bot.sendMessage(chatId, plainMsg, safeOptions); } catch(_) {}
            }
            console.error(`[sendTelegram] Failed for chatId ${chatId}:`, error.message);
            return null;
        }
    }

    getCountryShortCode(number) {
        try {
            if (!number || number === "0") return "XX";
            let s = number.startsWith("+") ? number : "+" + number.replace(/^00/, "");
            const p = parsePhoneNumberFromString(s);
            return p ? p.country || "XX" : "XX";
        } catch (e) { return "XX"; }
    }

    getDynamicFlag(number) {
        try {
            if (!number || number === "0") return "🌍";
            let s = number.startsWith("+") ? number : "+" + number.replace(/^00/, "");
            const p = parsePhoneNumberFromString(s);
            if (!p) return "🌍";
            const countryName = countryEmoji.name(p.country);
            const data = this.emojiData[countryName];
            if (data) {
                this.flagToggle = !this.flagToggle;
                const premiumId = this.flagToggle ? (data.p1 || data.p2) : (data.p2 || data.p1);
                return premiumId ? `<tg-emoji emoji-id="${premiumId}">${data.n || "🏳️"}</tg-emoji>` : (data.n || "🏳️");
            }
            return countryEmoji.flag(p.country) || "🌍";
        } catch (e) { return "🌍"; }
    }

    getDynamicServiceEmoji(serviceName) {
        if (!serviceName) return `<tg-emoji emoji-id="6273838538073050691">📱</tg-emoji>`;
        const key  = Object.keys(this.serviceData).find(k => k.toLowerCase() === serviceName.toLowerCase());
        const data = this.serviceData[key];
        if (data && data.p) return `<tg-emoji emoji-id="${data.p}">${data.n || "📱"}</tg-emoji>`;
        return data?.n || `<tg-emoji emoji-id="6273838538073050691">📱</tg-emoji>`;
    }

    extractOtp(text) {
        if (!text) return null;
        // HTML tag এবং invisible unicode character সরাও
        let clean = text.replace(/<[^>]*>?/gm, ' ').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');

        // Priority 1: keyword এর পরে পুরো digit block (4-8 digits)
        // "Your code is 123456", "OTP: 7890", "কোড: 123456" ইত্যাদি
        let m = clean.match(/(?:code|otp|pin|pass|kod|kode|\u0643\u0648\u062f|\u0631\u0645\u0632|\uc9c4\uc99d|\u9a8c\u8bc1\u7801|\u30b3\u30fc\u30c9|\u0915\u094b\u0921|\u0995\u09cb\u09a1|\u043a\u043e\u0434)[^\d]{0,20}(\d[\d\s\-]{1,9}\d)/i);
        if (m) {
            const digits = m[1].replace(/\D/g, '');
            if (digits.length >= 4 && digits.length <= 8) return digits;
        }

        // Priority 2: "is XXXXXX" বা ": XXXXXX" বা "= XXXXXX" pattern
        m = clean.match(/(?:is|are|[:=])\s*(\d[\d\s\-]{1,9}\d)/i);
        if (m) {
            const digits = m[1].replace(/\D/g, '');
            if (digits.length >= 4 && digits.length <= 8) return digits;
        }

        // Priority 3: XXX-XXX বা XXX XXX format (6 digit with separator)
        m = clean.match(/\b(\d{3}[\-\s]\d{3})\b/);
        if (m) return m[1].replace(/\D/g, '');

        // Priority 4: standalone 4-8 digit block (word boundary দিয়ে)
        m = clean.match(/\b(\d{4,8})\b/);
        if (m) return m[1];

        return null;
    }

    async sendToGroup(sms) {
    const otp          = sms.otp || this.extractOtp(sms.message) || "N/A";
    const language     = sms.language || "English";
    const shortCode    = this.getCountryShortCode(sms.number);
    const flag         = this.getDynamicFlag(sms.number);
    const service      = sms.service || "Unknown";
    const serviceEmoji = this.getDynamicServiceEmoji(service);

    let maskedNumber = String(sms.number || "").replace(/\D/g, "");
    const isInvalid = (!maskedNumber || maskedNumber === "0");

    if (maskedNumber.length >= 9) {
        maskedNumber =
            maskedNumber.slice(0, 4) +
            '<tg-emoji emoji-id="6235253239080555488">✅</tg-emoji>' +
            maskedNumber.slice(-3);
    }

    const finalMsg = `${flag}<b>${shortCode}</b>${serviceEmoji}| <b>+${maskedNumber || "0"}</b> |<tg-emoji emoji-id="6235307467337635626">🖥</tg-emoji><b>${language}</b>\n`;

    this.btnColorToggle = !this.btnColorToggle;
    const otpStyle  = this.btnColorToggle ? 'success' : 'primary';
    const subStyle  = this.btnColorToggle ? 'primary' : 'success';

    const options = {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: ` ${otp}`,
                        copy_text: { text: otp },
                        icon_custom_emoji_id: "6206420230269310869",
                        style: otpStyle
                    }
                ],
                [
                    {
                        text: "Panel",
                        url: this.config.GROUP_LINKS.NUMBER_PANEL_LINK,
                        icon_custom_emoji_id: "5197630131534836123",
                        style: subStyle
                    },
                    {
                        text: "METHOD",
                        url: this.config.GROUP_LINKS.MAIN_CHANNEL_LINK,
                        icon_custom_emoji_id: "5321505140199418151",
                        style: subStyle
                    }
                ]
            ]
        }
    };

        await this.sendTelegramWithRetry(this.botGroup, this.config.GROUP_LINKS.OTP_GROUP_ID, finalMsg, options);
    }

    async sendToUser(sms) {
        try {
            const cleanNum = String(sms.number || "").replace(/\D/g, "");
            if (!cleanNum || cleanNum === "0") return;

            if (!this.isDBReady) {
                console.warn(`[sendToUser] DB not ready, skipping OTP for +${cleanNum}`);
                return;
            }

            const numVariants = [
                cleanNum,
                '+' + cleanNum,
                '00' + cleanNum,
            ];

            let record = await this.NumberModel.findOne({
                number: { $in: numVariants },
                status: 'Used',
                assigned_to: { $ne: null }
            }).lean();

            if (!record) {
                record = await this.NumberModel.findOne({
                    number: { $regex: cleanNum.slice(-9) + '$' },
                    status: 'Used',
                    assigned_to: { $ne: null }
                }).lean();
            }

            if (!record) {
                return;
            }

            const otp          = sms.otp || this.extractOtp(sms.message);
            const flag         = this.getDynamicFlag(sms.number);
            const serviceEmoji = this.getDynamicServiceEmoji(sms.service);

            let newBalance = null;
            if (typeof global.payOtpCommission === 'function') {
                await global.payOtpCommission(
                    record.assigned_to,
                    { username: '', first_name: '' },
                    record.price || 0
                );
                try {
                    if (this.isUserDBReady && this.WalletModel) {
                        const wallet = await this.WalletModel.findOne({ telegramId: record.assigned_to }).lean();
                        if (wallet) newBalance = wallet.balance;
                    }
                } catch(_) {}
            } else {
                try {
                    const updated = await this.payCommission(record.assigned_to, record.price || 0);
                    if (updated !== null && updated !== undefined) newBalance = updated;
                } catch(_) {}
            }

            const priceLine = (record.price && record.price > 0)
                ? `\n<tg-emoji emoji-id="5472250091332993630">💳</tg-emoji> <b>Earned: +$${record.price.toFixed(4)}</b>`
                : '';

            const balanceLine = (newBalance !== null && newBalance !== undefined)
                ? `\n<tg-emoji emoji-id="5332600543963522398">💵</tg-emoji> <b>Balance: $${newBalance.toFixed(4)}</b>`
                : '';

            const otpLine = otp
                ? `\n<tg-emoji emoji-id="6206420230269310869">🔑</tg-emoji> <b>OTP: <code>${otp}</code></b>`
                : '';

            const shortCode = this.getCountryShortCode(sms.number);

            const finalMsg =
                `${serviceEmoji} <b>${sms.service || "Unknown"} OTP Received!</b>\n` +
                `${flag} <b>Country: ${record.country || shortCode}</b>\n` +
                `<tg-emoji emoji-id="6224104294254124352">📞</tg-emoji> <b>Number: <code>+${cleanNum}</code></b>` +
                otpLine + priceLine + balanceLine;

            const replyMarkup = otp ? {
                inline_keyboard: [[
                    {
                        text: `🔑 Copy OTP: ${otp}`,
                        copy_text: { text: otp }
                    }
                ]]
            } : undefined;

            const options = {
                parse_mode: "HTML",
                ...(replyMarkup ? { reply_markup: replyMarkup } : {})
            };

            const result = await this.sendTelegramWithRetry(this.botUser, record.assigned_to, finalMsg, options);
            if (result) {
                console.log(`[sendToUser] ✅ OTP sent to user ${record.assigned_to} for +${cleanNum}`);
            } else {
                console.error(`[sendToUser] ❌ Failed to send to user ${record.assigned_to}`);
            }
        } catch (e) {
            console.error('[sendToUser] Error:', e.message);
        }
    }

    async fetchFromApi() {
        try {
            if (!API_URL) {
                console.warn('[fetchFromApi] API_URL not loaded yet, skipping...');
                return [];
            }
            const res = await axios.get(`${API_URL}?key=${API_KEY}`, { timeout: 8000 });  // ✅ FIX: timeout 5s → 8s
            const raw = res.data?.ok ? (res.data.data || []) : [];

            // ✅ FIX: number বা message ফাঁকা হলে বাদ দাও
            const filtered = raw.filter(item => {
                if (!isValidSmsRow(item)) {
                    console.log(`[fetchFromApi] Skipped blank row — number: "${item.number}", message: "${item.message}"`);
                    return false;
                }
                return true;
            });

            // [v4] INTRA-POLL DEDUPE — getItemKey এর মতোই logic রাখো
            const seenInThisPoll = new Set();
            const deduped = [];
            for (const item of filtered) {
                const num = String(item.number || '').replace(/\D/g, '').slice(-10);
                // otp: item.otp → item.code → message → client
                let otp = String(item.otp || item.code || '').trim();
                if (!otp) {
                    // message "$" হলে client থেকে চেষ্টা
                    const msgText = String(item.message || '').trim();
                    const srcText = (msgText.length < 5 || /^\$+$/.test(msgText))
                        ? String(item.client || msgText)
                        : msgText;
                    const otpMatch = srcText.match(/\b(\d{4,8})\b/);
                    if (otpMatch) otp = otpMatch[1];
                }
                otp = otp.slice(0, 10);

                let pollKey = null;
                if (num && otp) {
                    pollKey = `${num}|${otp}`;
                } else if (num) {
                    let rawMsg = String(item.message || '').trim();
                    if (rawMsg.length < 5 || /^\$+$/.test(rawMsg)) rawMsg = String(item.client || rawMsg);
                    if (rawMsg && rawMsg.length >= 5) {
                        let h = 5381;
                        for (let i = 0; i < rawMsg.length; i++) h = ((h << 5) + h) ^ rawMsg.charCodeAt(i);
                        pollKey = `${num}|${(h >>> 0).toString(16)}`;
                    }
                }
                if (!pollKey) { deduped.push(item); continue; }
                if (seenInThisPoll.has(pollKey)) {
                    console.log(`[fetchFromApi] Intra-poll duplicate skipped: ${pollKey}`);
                    continue;
                }
                seenInThisPoll.add(pollKey);
                deduped.push(item);
            }
            return deduped;
        } catch (error) { return []; }
    }

    getItemKey(item) {
        // [v4] API id সম্পূর্ণ ignore — number+otp-ই একমাত্র stable key
        const num = String(item.number || '').replace(/\D/g, '').slice(-10);

        // OTP বের করো: item.otp → item.code → message extract → client field extract
        const rawOtp = String(item.otp || item.code || '').trim();
        let otp = rawOtp.length > 0 ? rawOtp : (this.extractOtp(item.message) || '');
        // message "$" বা ছোট হলে client field থেকে OTP try করো
        if (!otp && item.client) {
            otp = this.extractOtp(String(item.client)) || '';
        }
        otp = otp.slice(0, 10);

        // PRIMARY KEY: number + otp
        if (num && otp) return `otp_${num}_${otp}`;

        // FALLBACK: meaningful message hash
        // message "$" হলে client field থেকে নাও
        let rawMsg = String(item.message || '').trim();
        if (!rawMsg || rawMsg.length < 5 || /^\$+$/.test(rawMsg)) {
            rawMsg = String(item.client || '').trim();
        }
        if (num && rawMsg && rawMsg.length >= 5) {
            let h = 5381;
            for (let i = 0; i < rawMsg.length; i++) h = ((h << 5) + h) ^ rawMsg.charCodeAt(i);
            return `msg_${num}_${(h >>> 0).toString(16)}`;
        }

        return null;
    }

    async loop() {
        try {
            const items = await this.fetchFromApi();

            if (!this.isInitialized) {
                if (!API_URL) {
                    console.log('[init] Waiting for API_URL to load...');
                    setTimeout(() => this.loop(), 1000);
                    return;
                }
                if (!items || items.length === 0) {
                    console.log('[init] API_URL ready but no items yet — retrying in 1.5s...');
                    setTimeout(() => this.loop(), 1500);  // ✅ FIX: 3s → 1.5s
                    return;
                }
                let marked = 0;
                for (const item of items) {
                    const key = this.getItemKey(item);
                    if (!key) {
                        console.warn('[init] No key for item:', JSON.stringify(item).slice(0, 100));
                        continue;
                    }
                    if (!seenHas(this.seenIds, key)) {
                        seenAdd(this.seenIds, key);
                        marked++;
                    }
                    if (this.isDBReady && this.SeenIdModel) {
                        this.SeenIdModel.findOneAndUpdate(
                            { _id: key },
                            { $setOnInsert: { savedAt: new Date() } },
                            { upsert: true }
                        ).catch(() => {});
                    }
                }
                saveSeenIds(this.seenIds);
                console.log(`[init] ✅ Startup done — ${marked} OTPs marked as seen (total: ${this.seenIds.size}). Now listening for NEW OTPs only.`);
                this.isInitialized = true;
                this._startupTime = Date.now();
                this._loopCount   = 0;   // periodic cleanup counter
                setTimeout(() => this.loop(), POLL_MS);
                return;
            }

            if (items && items.length > 0) {
                const newItems = items.filter(item => {
                    const key = this.getItemKey(item);
                    if (!key) return false;
                    return !seenHas(this.seenIds, key);  // TTL-aware চেক
                });

                if (newItems.length > 0) {
                    for (const item of newItems) {
                        const key = this.getItemKey(item);
                        seenAdd(this.seenIds, key);  // timestamp সহ add

                        if (this.isDBReady && this.SeenIdModel) {
                            this.SeenIdModel.findOneAndUpdate(
                                { _id: key },
                                { $setOnInsert: { savedAt: new Date() } },
                                { upsert: true, returnDocument: 'after' }
                            ).catch((e) => {
                                console.error('[seenIds] MongoDB save error:', e.message);
                            });
                        }

                        // message "$" হলে client field থেকে নাও
                        const rawMessage = String(item.message || '').trim();
                        const resolvedMessage = (rawMessage.length < 5 || /^\$+$/.test(rawMessage))
                            ? String(item.client || item.message || '')
                            : rawMessage;

                        const sms = {
                            number:   item.number,
                            service:  item.service,
                            message:  resolvedMessage,
                            otp:      item.otp,
                            language: item.language,
                            country:  item.country
                        };

                        const filterCache = global.OTP_FILTER_CACHE || [];
                        if (filterCache.length > 0 && sms.number) {
                            let smsCountryCode = '';
                            try {
                                const numStr = sms.number.startsWith('+') ? sms.number : '+' + sms.number.replace(/^00/, '');
                                const parsed = parsePhoneNumberFromString(numStr);
                                if (parsed && parsed.country) smsCountryCode = parsed.country;
                            } catch(e) {}
                            if (!smsCountryCode && sms.country && /^[A-Za-z]{2}/.test(sms.country.trim())) {
                                smsCountryCode = sms.country.trim().toUpperCase();
                            }
                            console.log(`[OTPFilter] number: ${sms.number}, ISO: ${smsCountryCode}, service: ${sms.service}`);
                            if (smsCountryCode) {
                                const isBlocked = filterCache.some(f =>
                                    f.country === smsCountryCode.toUpperCase() &&
                                    f.service === (sms.service || '').toLowerCase()
                                );
                                if (isBlocked) {
                                    console.log(`[OTPFilter] BLOCKED — ${smsCountryCode} / ${sms.service}`);
                                    if (newItems.length > 1) await new Promise(r => setTimeout(r, 50));
                                    continue;
                                }
                            }
                        }

                        // OTP থাকলে sms-এ সেট করো, না থাকলেও পাঠাবে (N/A দেখাবে)
                        const resolvedOtp = sms.otp || this.extractOtp(sms.message);
                        if (resolvedOtp) sms.otp = resolvedOtp;
                        console.log(`[OTP] New SMS — number: ${sms.number}, service: ${sms.service}, otp: ${sms.otp || 'N/A'}`);
                        await this.sendToGroup(sms);
                        await this.sendToUser(sms);

                        if (newItems.length > 1) await new Promise(r => setTimeout(r, 20));
                    }

                    saveSeenIds(this.seenIds);
                }

                // ✅ FIX: count-based trim বাদ — এটাই পুরোনো OTP আবার ঢোকার কারণ ছিল
                // প্রতি ২০০ loop-এ TTL-based cleanup — মেয়াদ শেষ হওয়া entries মুছে দেয়
                this._loopCount = (this._loopCount || 0) + 1;
                if (this._loopCount % 200 === 0) {
                    seenCleanup(this.seenIds);
                    saveSeenIds(this.seenIds);
                }
            }
        } catch (e) {
            console.error('[loop] Error:', e.message);
            await new Promise(r => setTimeout(r, 1000));
        } finally {
            setTimeout(() => this.loop(), POLL_MS);
        }
    }

    async start() {
        this.emit('log', `🚀 Fast OTP Worker Started`);
        this.startRemoteRefreshLoop();
        this.loop();
    }
}

module.exports = Alif;
