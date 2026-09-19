/* ========= Number Bot (Optimized: High Concurrency + Smooth Animation) =========== */

process.env.NTBA_FIX_350 = 1;
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const axios = require('axios');

// ===============================================
// 📥 SAFE FILE DOWNLOAD HELPER (replaces buggy `request` lib)
// `request` is deprecated and throws raw AggregateError on DNS
// failures under modern Node.js, causing unhandled rejections.
// This wraps axios with retry + clean error messages instead.
// ===============================================
async function safeDownloadBuffer(url, { retries = 2, timeout = 20000 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout
            });
            return { buffer: Buffer.from(res.data), error: null };
        } catch (e) {
            lastErr = e;
            // Small backoff before retry (network blips / DNS hiccups)
            if (attempt < retries) await new Promise(r => setTimeout(r, 800));
        }
    }
    return { buffer: null, error: lastErr };
}
const countryEmoji = require('country-emoji');
const { parsePhoneNumber } = require('libphonenumber-js');
const mongoose = require('mongoose');

// ── Failover DB System ──────────────────────────────────────────────────────
const dbSetup = require('../db/db-setup');
let sync = null; // SyncHelper — initDBConnections() এ set হয়

// ===============================================

// ===============================================
// ⚙️ CONFIGURATION LOADING (FIXED)
// ===============================================
const SYSTEM_CONFIG = global.NUMBER_BOT_CONFIG || {};
const BOT_TOKEN = SYSTEM_CONFIG.BOT_TOKEN || '';
const OTP_GROUP_URL = SYSTEM_CONFIG.OTP_GROUP_URL || '';
const PAY_GROUP_URL = SYSTEM_CONFIG.PAY_GROUP_URL || '';

// index.js থেকে ADMIN_INFO বের করে আনা
const ADMIN_INFO_FROM_INDEX = SYSTEM_CONFIG.ADMIN_INFO || {};

// এখন সঠিক পাথ থেকে ডেটা অ্যাসাইন করা
const ADMIN_IDS = ADMIN_INFO_FROM_INDEX.ADMIN_IDS || [];
const REQUIRED_CHANNELS = ADMIN_INFO_FROM_INDEX.REQUIRED_JOIN || [];
const SUPPORT_USERNAME = ADMIN_INFO_FROM_INDEX.SUPPORT || '';

const GITHUB_USERNAME = "Alif586";
const GITHUB_REPO_NAME = "NEXOZONE";
const GITHUB_FILE_PATH = "users2.0.json";

const NUMBER_DB_URI     = SYSTEM_CONFIG.NUMBER_DB_URI     || "";
const USER_DB_URI       = SYSTEM_CONFIG.USER_DB_URI       || "";
const USER_STATUS_DB    = SYSTEM_CONFIG.USER_STATUS_DB    || "";


// ── Alif Auto-Pay API (BEP20/TRX withdraw) ──
// Priority: index.js -> global.NUMBER_BOT_CONFIG.ALIF_API_BASE_URL / ALIF_API_KEY
//           -> .env  -> process.env.ALIF_API_BASE_URL / ALIF_API_KEY
//           -> hardcoded fallback (so the bot still works if neither is set)
const ALIF_API_BASE_URL = SYSTEM_CONFIG.ALIF_API_BASE_URL || process.env.ALIF_API_BASE_URL || '';
const ALIF_API_KEY = SYSTEM_CONFIG.ALIF_API_KEY || process.env.ALIF_API_KEY || '';

// ── Withdraw Notification Group ──
// index.js-এ WITHDRAW_GROUP_ID সেট করুন (Telegram group chat_id, e.g. -1001234567890)
const WITHDRAW_GROUP_ID = SYSTEM_CONFIG.WITHDRAW_GROUP_ID || process.env.WITHDRAW_GROUP_ID || null;

// Helper: শেষ ৬টা সংখ্যা হাইড করে (bKash/Nagad নম্বরের জন্য)
function maskAddress(address) {
    if (!address) return '';
    // Crypto wallet address (0x... বা TRX/BEP20 style): প্রথম ৮ char দেখাও, বাকি হাইড
    if (/^0x/i.test(address) || (address.length >= 30 && /^[A-Za-z0-9]+$/.test(address))) {
        return address.slice(0, 8) + '••••••••••••';
    }
    // শুধু সংখ্যা থাকলে (phone number) শেষ ৬টা হাইড
    const digitsOnly = address.replace(/\D/g, '');
    if (digitsOnly.length >= 8 && digitsOnly.length === address.replace(/[\s\-\+]/g, '').length) {
        const visible = address.slice(0, address.length - 6);
        return visible + '••••••';
    }
    return address;
}

// Helper: walletMethod থেকে board URL অটো-ডিটেক্ট
function getBoardUrl(walletMethod) {
    const m = (walletMethod || '').toUpperCase();
    if (m === 'BKASH' || m.includes('BKASH')) return 'https://www.bkash.com/';
    if (m === 'NAGAD' || m.includes('NAGAD')) return 'https://nagad.com.bd/';
    if (m === 'BEP20' || m === 'USDT_BEP20' || m.includes('BEP20')) return 'https://bscscan.com/';
    if (m === 'TRX' || m.includes('TRX') || m.includes('TRON')) return 'https://tronscan.org/';
    if (m === 'BINANCE' || m.includes('BINANCE')) return 'https://www.binance.com/';
    return null;
}

// Helper: গ্রুপে withdraw success / approve মেসেজ পাঠানো
async function getNextPaymentNo() {
    try {
        const total = await WithdrawRequest.countDocuments({ status: 'approved' });
        return total + 1;
    } catch (e) {
        return null;
    }
}

async function sendWithdrawGroupMsg(text, buttons) {
    if (!WITHDRAW_GROUP_ID) return;
    try {
        const markup = buttons && buttons.length > 0
            ? { inline_keyboard: [buttons] }
            : undefined;
        await bot.sendMessage(WITHDRAW_GROUP_ID, text, {
            parse_mode: 'HTML',
            ...(markup ? { reply_markup: markup } : {})
        });
    } catch (e) {
        console.log('Withdraw group notify error:', e.message);
    }
}

// Helper: withdraw request এর walletMethod BEP20/USDT_BEP20 type কিনা চেক
// (pending list থেকে দেখানোর সময় dynamicPayMethods এর type দেখে)
function isMethodBEP20Type(walletMethod) {
    if (!walletMethod) return false;
    const staticBEP20 = ['BEP20', 'Binance'];
    if (staticBEP20.includes(walletMethod)) return true;
    // dynamic method হলে dynamicPayMethods array থেকে type দেখো
    const dm = (typeof dynamicPayMethods !== 'undefined' ? dynamicPayMethods : [])
        .find(m => m.id === walletMethod);
    return dm && dm.type === 'USDT_BEP20';
}


// ── Remove CC Helper ─────────────────────────────────────────────────
// ইউজারের Remove CC সেটিং চেক করা (ConfigModel থেকে)
async function isRemoveCCOn(userId) {
    try {
        const doc = await ConfigModel.findOne({ key: `remove_cc:${userId}` });
        return doc ? doc.value === '1' : false;
    } catch(e) { return false; }
}

// নাম্বার থেকে Country Code সরিয়ে দেওয়া (+880XXXXXXXX → 0XXXXXXXX বা XXXXXXXX)
function stripCountryCode(number) {
    if (!number) return number;
    const raw = number.startsWith('+') ? number.slice(1) : number;
    // libphonenumber দিয়ে parse করার চেষ্টা
    try {
        const parsed = parsePhoneNumber(number.startsWith('+') ? number : '+' + number);
        if (parsed) {
            // nationalNumber = CC ছাড়া local নাম্বার
            return parsed.nationalNumber;
        }
    } catch(e) {}
    // Fallback: + দিয়ে শুরু হলে প্রথম ১-৩ সংখ্যা বাদ দিয়ে দাও (simple strip)
    return raw.replace(/^\d{1,3}/, '');
}



const COOLDOWN_TIME = 2;

const NOTIFICATION_DELETE_TIME = 60 * 60 * 1000; // ১ ঘণ্টা
let activeNotification = {
    msgIds: {}, // { channelId: messageId }
    data: [],   // [{ country, sector, flag }]
    timer: null,
    lastUpdate: 0
};



// ===============================================
// 📱 SECTOR DEFINITIONS
// ===============================================
// ===============================================
// 📱 UPDATED SECTOR DEFINITIONS
// ===============================================
const SECTORS = [
    { 
        id: 'facebook',  
        label: '𝐅𝐚𝐜𝐞𝐛𝐨𝐨𝐤',  
        emoji: '💙', 
        icon_custom_emoji_id: "5389064576333527180", 
        style: 'success'
    },
    { 
        id: 'whatsapp',  
        label: '𝐖𝐡𝐚𝐭𝐬𝐀𝐩𝐩',  
        emoji: '💚', 
        icon_custom_emoji_id: "5233354831984353090", 
        style: 'success'
    },
    { 
        id: 'telegram',  
        label: '𝐓𝐞𝐥𝐞𝐠𝐫𝐚𝐦',  
        emoji: '🩵', 
        icon_custom_emoji_id: "5364125616801073577", 
        style: 'primary'
    },
    { 
        id: 'instagram',  
        label: '𝐈𝐧𝐬𝐭𝐚𝐠𝐫𝐚𝐦',  
        emoji: '🩵', 
        icon_custom_emoji_id: "5364310996179503764", 
        style: 'success' 
    },
    { 
        id: 'tiktok',  
        label: '𝐓𝐢𝐤 𝐓𝐨𝐤',  
        emoji: '🩵', 
        icon_custom_emoji_id: "5391044040860906456", 
        style: 'success' 
    },
    { 
        id: 'imo',  
        label: '𝐈𝐌𝐎',  
        emoji: '🩵', 
        icon_custom_emoji_id: "6219680125751926660", 
        style: 'success' 
    },
    { 
        id: 'apple',  
        label: '𝐀𝐩𝐩𝐥𝐞',  
        emoji: '🩵', 
        icon_custom_emoji_id: "5318795767454923927", 
        style: 'success' 
    },
    { 
        id: 'chatgpt',  
        label: '𝐂𝐡𝐚𝐭 𝐆𝐩𝐭',  
        emoji: '🩵', 
        icon_custom_emoji_id: "5310259124817134249", 
        style: 'success' 
    },

];

let disabledSectors = []; 

// 🔢 Hi T Count toggle — যে এডমিনের জন্য count hide আছে তাদের userId রাখা হবে
const adminHideCountSet = new Set();

async function loadDisabledSectors() {
    if (isUserDBReady) {
        try {
            const conf = await ConfigModel.findOne({ key: "disabled_sectors" });
            if (conf) {
                disabledSectors = JSON.parse(conf.value);
            }
        } catch(e) { console.log("Error loading sectors:", e.message); }
    }
}

// ── Disabled Countries (Per-Sector & Global) ──────────────────────────
// disabledCountriesBySector: { sectorId: ["Bangladesh", "India", ...], ... }
// disabledCountriesGlobal: ["Bangladesh", ...] — All Country OFF/ON থেকে
let disabledCountriesBySector = {}; // per-sector
let disabledCountriesGlobal = [];   // global (All Country)

// Legacy compat: সব জায়গায় যেখানে disabledCountries ব্যবহার হয়েছিল
// সেখানে এখন isCountryDisabled(country, sectorId) দিয়ে চেক হবে
function isCountryDisabled(country, sectorId = null) {
    if (disabledCountriesGlobal.includes(country)) return true;
    if (sectorId && disabledCountriesBySector[sectorId] && disabledCountriesBySector[sectorId].includes(country)) return true;
    return false;
}

// Legacy ensureDisabledCountriesArray — আর array নেই, তাই noop
function ensureDisabledCountriesArray() {}

async function loadDisabledCountries() {
    if (isUserDBReady) {
        try {
            // Global disabled countries
            const confGlobal = await ConfigModel.findOne({ key: "disabled_countries_global" });
            if (confGlobal && confGlobal.value) {
                const parsed = JSON.parse(confGlobal.value);
                disabledCountriesGlobal = Array.isArray(parsed) ? parsed : [];
            } else {
                // Legacy fallback: পুরনো "disabled_countries" key থেকে migrate
                const confLegacy = await ConfigModel.findOne({ key: "disabled_countries" });
                if (confLegacy && confLegacy.value) {
                    const parsed = JSON.parse(confLegacy.value);
                    disabledCountriesGlobal = Array.isArray(parsed) ? parsed : [];
                } else {
                    disabledCountriesGlobal = [];
                }
            }
            // Per-sector disabled countries
            const confSector = await ConfigModel.findOne({ key: "disabled_countries_by_sector" });
            if (confSector && confSector.value) {
                const parsed = JSON.parse(confSector.value);
                disabledCountriesBySector = (parsed && typeof parsed === 'object') ? parsed : {};
            } else {
                disabledCountriesBySector = {};
            }
        } catch(e) {
            disabledCountriesGlobal = [];
            disabledCountriesBySector = {};
            console.log("Error loading disabled countries:", e.message);
        }
    }
}

async function saveDisabledCountriesGlobal() {
    if (!isUserDBReady) return;
    await ConfigModel.findOneAndUpdate(
        { key: "disabled_countries_global" },
        { value: JSON.stringify(disabledCountriesGlobal) },
        { upsert: true }
    );
}

async function saveDisabledCountriesBySector() {
    if (!isUserDBReady) return;
    await ConfigModel.findOneAndUpdate(
        { key: "disabled_countries_by_sector" },
        { value: JSON.stringify(disabledCountriesBySector) },
        { upsert: true }
    );
}

// মেনটেনেন্স 
let isMaintenanceMode = false;
let maintenanceMessage = "বট বর্তমানে মেইনটেন্যান্স মুডে আছে। অনুগ্রহ করে পরে চেষ্টা করুন।";

async function loadMaintenanceConfig() {
    if (isUserDBReady) {
        try {
            const mode = await ConfigModel.findOne({ key: "maint_mode" });
            const msg = await ConfigModel.findOne({ key: "maint_msg" });
            if (mode) isMaintenanceMode = JSON.parse(mode.value);
            if (msg) maintenanceMessage = msg.value;
        } catch(e) { console.log("Error loading maintenance config:", e.message); }
    }
}

// userConn.on('connected', ...) এর ভেতর loadMaintenanceConfig(); কল করে দিবেন।

// ── Leaderboard ON/OFF Config ───────────────────────────────────────
let isLeaderboardEnabled = true; // Default: ON

async function loadLbConfig() {
    if (isUserDBReady) {
        try {
            const conf = await ConfigModel.findOne({ key: 'lb_enabled' });
            if (conf) isLeaderboardEnabled = JSON.parse(conf.value);
        } catch(e) { console.log('Error loading lb_enabled config:', e.message); }
    }
}

// ── Payment Method & Withdraw Config ───────────────────────────────
let disabledPayMethods = []; // disabled method key list e.g. ['bKash','Nagad']
let isWithdrawDisabled = false;
let minWithdrawLimit = 0.10; // Default $0.10

async function loadPayMethodConfig() {
    if (isUserDBReady) {
        try {
            const dm = await ConfigModel.findOne({ key: 'disabled_pay_methods' });
            if (dm) disabledPayMethods = JSON.parse(dm.value);
            const wd = await ConfigModel.findOne({ key: 'withdraw_disabled' });
            if (wd) isWithdrawDisabled = JSON.parse(wd.value);
            const wl = await ConfigModel.findOne({ key: 'min_withdraw_limit' });
            if (wl) minWithdrawLimit = parseFloat(wl.value) || 0.10;
        } catch(e) { console.log('Error loading pay method config:', e.message); }
    }
}

// Load guide photos for each WALLET_METHOD from DB (set by admin)
async function loadGuidePhotos() {
    if (!isUserDBReady) return;
    try {
        for (const m of WALLET_METHODS) {
            const conf = await ConfigModel.findOne({ key: `guide_photo_${m.key}` });
            if (conf && conf.value) m.guidePhoto = conf.value;
        }
        // Also load dynamic method guide photos
        for (const dm of dynamicPayMethods) {
            const conf = await ConfigModel.findOne({ key: `guide_photo_${dm.id}` });
            if (conf && conf.value) dm.guidePhoto = conf.value;
        }
        console.log('\u2705 Guide photos loaded from DB');
    } catch(e) { console.log('Error loading guide photos:', e.message); }
}

async function loadRefLevels() {
    if (isUserDBReady) {
        try {
            const conf = await ConfigModel.findOne({ key: 'ref_levels' });
            if (conf) {
                const saved = JSON.parse(conf.value);
                if (Array.isArray(saved) && saved.length > 0) {
                    REF_LEVELS.length = 0;
                    saved.forEach(l => REF_LEVELS.push(l));
                    console.log('✅ REF_LEVELS loaded from DB:', REF_LEVELS.length, 'levels');
                }
            }
        } catch(e) { console.log('Error loading ref_levels:', e.message); }
    }
}
// ══════════════════════════════════════════════════════════════
//  PREMIUM EMOJI ENGINE
//  — Premium users see animated emoji
//  — Normal users see plain emoji (Telegram fallback)
//  — Use emoji characters directly in messages; E() wraps them
// ══════════════════════════════════════════════════════════════
const _EMOJI_MAP = {
  // ── Contact / Social ────────────────────────────────────────
  '💬': '5443038326535759644', '📨': '5454113432284446338',  '✉': '6077801662154546383',  '📥': '5433811242135331842',  '📤': '5433614747381538714',  '📭': '5352896944496728039',  '📬': '5976712752075381213', '🔔': '6120729709954208730',

  // ── Finance / Payment / Crypto ─────────────────────────────
  '💰': '6077687686607414392',  '💵': '5409048419211682843',  '💸': '6235445786759402354',  '💲': '5310177404474390190',  '💳': '5472250091332993630',  '🏦': '5264895611517300926',  '🪙': '5832692572971077565',  '♾': '5463199581628025829',  '🔶': '5388622778817589921',

  // ── User / Profile ─────────────────────────────────────────
  '👤': '5798505243180273024',  '👥': '5453957997418004470',  '🥇': '5294205834144795719',  '🥈': '6206222099132978580',  '🥉': '5453902265922376865',  '👑': '6125115309650089324',  '🆔': '5354972242629383937',  '🌟': '6159107733824999752',
  // ── Actions / Controls ─────────────────────────────────────
  '✅': '5976409802262190486',  '❌': '6212807916085317716',  '⚠️': '5420323339723881652',  '🚫': '5240241223632954241',  '🛑': '5240151566190656407',  '🔄': '6122764622509380932',  '➕': '5226893010737854842',  '🗑': '5372825386591732174',  '🔙': '6300794233859084755',  '➡️': '5215677360774324968',  '◀️': '5215260113291455937',

  // ── Security / System ──────────────────────────────────────
  '🔐': '6129559793347595176',  '🔒': '5895685239098838464',  '🔓': '5429405838345265327',  '🔑': '5238132025323444613',  '⚙️': '6122716050724230012',  '🛠': '5462921117423384478',  '🔧': '6314559960525052872',

  // ── Navigation / General UI ───────────────────────────────
  '🏠': '5195140682590722632',  '🌍': '5343789187172670307',  '🌐': '5287292843763713628',  '🔗': '5271604874419647061',  '📱': '6158892349805040268',  '📲': '6275857834127134596',  '💻': '5282843764451195532',

  // ── Stats / Data ───────────────────────────────────────────
  '📊': '5253748096914980273',  '📈': '5244837092042750681',  '📉': '6235636139709962407',  '🔍': '5807468998840814853',  '📋': '5197269100878907942',  '📝': '6314399517726746272',  '📜': '5355127402617918364',

  // ── Time / Status ──────────────────────────────────────────
  '⏱': '5996553250420037768',  '⏳': '6215133834149629990',  '⏰': '5215394081911351762',  '🕒': '6001162025206550903',  '⏸': '5454380420336466255',  '🔟': '5226929552319594190',

  // ── Alerts / Highlight ─────────────────────────────────────
  '🔥': '6235628846855492222',  '🚨': '5395695537687123235',  '⚡': '5224607267797606837',  '💡': '5422439311196834318',  '🎯': '5463274047771000031',  '🏆': '5188344996356448758',  '🎉': '6125457176161948466',  '🎁': '6156923364997862692',  '💎': '5039999772300149658',

  // ── Bot / System / Special ─────────────────────────────────
  '🤖': '5353025608832004653',  '✨': '5422649047334794716',  '🚀': '6235302918967269680',

  // ── Media / Platform ───────────────────────────────────────
  '🖼': '5364310996179503764',  '✈️': '5229055548246231595',  '📞': '5233354831984353090',
  // ── Misc ───────────────────────────────────────────────────
  '❓': '5463139580934892960',  '📦': '5465137208878969279',  '📅': '5413879192267805083',  '🔊': '5388632425314140043',  '🔘': '5850526539904453814',  '🟢': '5355160327837210118',  '⚪': '6078127456898785994',  '🟡': '5390831560238839648',  '◉': '5210935111289159311',  '⬆️': '5463122435425448565',  '👋': '5199885118214255386',  '🖤': '5323812284961678044',  '💼': '5456121282250687894',  '📢': '6159148926856336305',  '👥': '5453957997418004470',
  '🔴': '5411225014148014586', '💥': '6235646232883107337', '🙏': '5458774648621643551', '📌': '5397782960512444700',
  // ── Leaderboard extra ───────────────────────────────────────
  '⭐': '5253589999168810882',  '💫': '5348181392528253881',  '⏳': '5875457905934735257',
  '👈': '5269720500468201056',  '😴': '5938368980568773431',
  // ── Notification extra ──────────────────────────────────────
  '📣': '6077793982753022077', '☎️': '5438511323631609540', '😎': '6271387924223234127', '👮': '5253743295141538873'
};

const _EM_PATTERN = new RegExp(
  Object.keys(_EMOJI_MAP)
    .map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g'
);

/** Wraps emoji in <tg-emoji> for Premium animation */
function E(text) {
  if (!text) return '';
  return text.replace(_EM_PATTERN,
    m => `<tg-emoji emoji-id="${_EMOJI_MAP[m]}">${m}</tg-emoji>`
  );
}

/** Strips <tg-emoji> tags — used for keyboard buttons & fallback */
const _STRIP_RE = /<tg-emoji[^>]*>(.*?)<\/tg-emoji>/g;
function strip(text) {
  return (text || '').replace(_STRIP_RE, '$1');
}

// ── Button Emoji Map (for inline/reply buttons) ─────────────────────
const _BTN_EM = {
    get_number:        { id: '6275857834127134596', em: '📲' },
    avail_country:     { id: '5224450179368767019', em: '🌍' },
    support:           { id: '5438511323631609540', em: '📞' },
    refer:             { id: '5453957997418004470', em: '👥' },
    wallet:            { id: '6077687686607414392', em: '💰' },
    admin_menu:        { id: '5238132025323444613', em: '🔑' },
  add:               { id: '5206607081334906820', em: '➕' },
  broadcast:         { id: '6159148926856336305', em: '📢' },
  status:            { id: '5226711870492126219', em: '📊' },
  delete:            { id: '5372825386591732174', em: '🗑' },
  platform:          { id: '6122716050724230012', em: '⚙️' },
  mainten:           { id: '5462921117423384478', em: '🛠' },
  restart:           { id: '5375338737028841420', em: '🔄' },
  pay_pending:       { id: '5433811242135331842', em: '📥' },
  pay_method:        { id: '5472250091332993630', em: '💳' },
  bonus:             { id: '6156923364997862692', em: '🎁' },
  main_menu:         { id: '5215677360774324968', em: '➡️' },
  view_otp:          { id: '6181422017368037915', em: '💬' },
  change_number:     { id: '6159066021102621785', em: '🔄' },
  change_country:    { id: '5253690290950141189', em: '🌍' },
  back:              { id: '6300794233859084755', em: '🔙' },
  verify:            { id: '5976409802262190486', em: '✅' },
  set_wallet:        { id: '5472250091332993630', em: '💳' },
  withdraw:          { id: '5433614747381538714', em: '📤' },
  copy_link:         { id: '5354972242629383937', em: '🔗' },
  open_bot:          { id: '6080352185533602200', em: '🚀' },
  del_country:       { id: '6188045471118790922', em: '🌍' },
  back_admin:        { id: '6300794233859084755', em: '🔙' },
  approve:           { id: '5976409802262190486', em: '✅' },
  reject:            { id: '6212807916085317716', em: '❌' },
  method:            { id: '5321505140199418151', em: '🎥' },
  leaderboard:       { id: '5188344996356448758', em: '🏆' },
  contact_admin:     { id: '6077801662154546383', em: '✉' },
  // ── Assignment template special emoji ────────────────────
  assign_sparkle:    { id: '5253744033875915388', em: '✨' },
  assign_heart:      { id: '6080324989800685712', em: '❤️' },
  assign_flower:     { id: '5042136067558343759', em: '🌸' },
  assign_heart2:     { id: '5253737930727384427', em: '❤️' },
  // ── Maintenance mode message ──────────────────────────────
  maint_icon:        { id: '5366231924597604153', em: '🛠' },
  maint_megaphone:   { id: '6077793982753022077', em: '📣' },
  // ── Notification (sendUpdateNotification) ─────────────────
  notif_check:       { id: '5208880351690112495', em: '✅' },
  notif_rocket:      { id: '6316535490862388610', em: '🚀' },
  notif_traffic:     { id: '5976758716815382517', em: '🚀' },
  removecc:     { id: '4958526153955476488', em: '❌' },
 verifycc:     { id: '4974333549160170695', em: '✅' },
};

/** Build a premium button label: strips existing emoji, prefixes with premium icon */
const BTN_LABEL = (key, label) => {
  const b = _BTN_EM[key];
  if (!b) return label;
  return label; // text stays plain; icon_custom_emoji_id carries the premium emoji
};

// ===============================================
// 🎯 PREMIUM EMOJI HELPER
// ===============================================
function getSectorEmoji(sector) {
    if (sector && sector.icon_custom_emoji_id) {
        return `<tg-emoji emoji-id="${sector.icon_custom_emoji_id}">${sector.emoji}</tg-emoji>`;
    }
    return sector ? sector.emoji : '';
}

// ===============================================
// 🌍 SMART COUNTRY PREMIUM FLAG SYSTEM
// ===============================================
let countryEmojiData = {}; 


function findEmojiEntry(countryName) {
    if (!countryName) return null;


    let cleaned = countryName.split('(')[0].trim();
    if (countryEmojiData[cleaned]) return countryEmojiData[cleaned];
    if (countryEmojiData[countryName]) return countryEmojiData[countryName];


    const sortedCountries = Object.keys(countryEmojiData).sort((a, b) => b.length - a.length);
    for (const country of sortedCountries) {
        if (countryName.includes(country)) {
            return countryEmojiData[country];
        }
    }
    return null;
}

function cleanCountryName(name) {
    if (!name) return name;
    return name.split('(')[0].trim();
}

async function loadCountryEmojiData() {
    try {
        const https = require('https');
        const data = await new Promise((resolve, reject) => {
            https.get('https://alifhosson-json-api.vercel.app/data/emoji.json', (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch(e) { reject(e); }
                });
            }).on('error', reject);
        });
        countryEmojiData = data;
        console.log(`✅ Country emoji data loaded: ${Object.keys(data).length} countries`);
    } catch(e) { console.log('⚠️ Emoji Data Error:', e.message); }
}

// ─── emoji text টা valid কিনা চেক করে (corrupt byte থাকলে false) ───────────
function _isSafeEmojiText(str) {
    if (!str || str.length === 0) return false;
    // কোনো HTML special char থাকলে tag break হবে
    if (/[<>&]/.test(str)) return false;
    for (const cp of str) {
        const c = cp.codePointAt(0);
        if (c === 0) return false;
        // Unassigned supplementary plane (U+C0000–U+DFFFF) — garbage/corrupt bytes
        if (c >= 0xC0000 && c <= 0xDFFFF) return false;
        // Tag characters / Variation selectors supplement (U+E0000–U+EFFFF)
        if (c >= 0xE0000 && c <= 0xEFFFF) return false;
        // Supplementary Private Use Area-A/B (U+F0000–U+10FFFF)
        if (c >= 0xF0000) return false;
    }
    return true;
}

function getPremiumFlag(countryName, normalFlag) {
    const entry = findEmojiEntry(countryName);
    if (entry && (entry.p1 || entry.p2)) {
        const emojiId = String(entry.p1 || entry.p2).trim();
        // ─── emoji-id অবশ্যই numeric string হতে হবে ────────────────────
        if (!emojiId || !/^\d+$/.test(emojiId)) return normalFlag || '🌍';

        // ─── entry.n corrupt হলে normalFlag ব্যবহার করো ──────────────
        const innerText = _isSafeEmojiText(entry.n) ? entry.n
                        : _isSafeEmojiText(normalFlag) ? normalFlag
                        : '🌍';

        return `<tg-emoji emoji-id="${emojiId}">${innerText}</tg-emoji>`;
    }
    return normalFlag || '🌍';
}

function makeCountryButton(countryName, normalFlag, extraText, callbackData, userId = null, priceText = "") {
    const cleaned = cleanCountryName(countryName);
    const entry = findEmojiEntry(countryName);
    const emojiId = entry ? (entry.p1 || entry.p2 || null) : null;

    // priceText সবাই দেখবে, extraText (count) শুধু admin দেখবে
    let displayExtra = priceText || "";
    if (userId && isAdmin(userId)) {
        displayExtra += extraText || "";
    }

    let buttonText = `${cleaned}${displayExtra}`;

    if (!emojiId) {
        const displayFlag = (entry && entry.n) ? entry.n : (normalFlag || '🌍');
        buttonText = `${displayFlag} ${buttonText}`;
    }
    const btn = { text: buttonText, callback_data: callbackData, style: 'primary' };
    if (emojiId) btn.icon_custom_emoji_id = emojiId;
    return btn;
}


// ===============================================
// 🆕 মেসেজ টেমপ্লেট
// ===============================================


const ASSIGNMENT_MESSAGE_TEMPLATE = (
  flag,
  country_name,
  number,
  action_text,
  platform_label = ""
) => {
  const cleanedName = cleanCountryName(country_name);
  const premiumFlag = getPremiumFlag(cleanedName, flag);

  return `<blockquote><b>${premiumFlag} ${cleanedName} <tg-emoji emoji-id="${_BTN_EM.assign_sparkle.id}">✨</tg-emoji>${platform_label}</b>                              </blockquote>
<blockquote><b><tg-emoji emoji-id="${_BTN_EM.assign_heart.id}">❤️</tg-emoji>𝐖𝐚𝐢𝐭𝐢𝐧𝐠 𝐅𝐨𝐫 𝐎𝐓𝐏<tg-emoji emoji-id="${_BTN_EM.assign_flower.id}">🌸</tg-emoji></b></blockquote>
<blockquote><b><tg-emoji emoji-id="${_BTN_EM.assign_heart2.id}">❤️</tg-emoji>Work hard & grow your balance.<tg-emoji emoji-id="${_BTN_EM.assign_flower.id}">🌸</tg-emoji></b></blockquote>

`;
};




const NEW_FOOTER_QUOTE = ""; // Optional footer text (empty by default)

// =====================================
// 🗄️ DATABASE CONNECTION SETUP (FIXED & OPTIMIZED)
// ===================================
const dbOptions = {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 30000,
    family: 4,
    maxPoolSize: 100,       // বেশি concurrent query সামলাতে
    minPoolSize: 10,
    connectTimeoutMS: 10000,
    maxIdleTimeMS: 60000,
    compressors: 'zlib',
    tls: true,
    tlsAllowInvalidCertificates: false,
    tlsAllowInvalidHostnames: false,
    retryWrites: true,
    retryReads: true,
    bufferCommands: false,  // Local DB নেই, buffering বন্ধ — fast fail
    autoIndex: false        // Production-এ index আলাদা করে তৈরি করা হয়
};

// ── Connections: initialized in initDBConnections() ──────────────────────
// Local MongoDB is optional; Replit uses Atlas as the primary connection.
let numberConn = null;
let userConn   = null;
let statusConn = null;

let isNumberDBReady = false;
let isUserDBReady   = false;
let isStatusDBReady = false;

// ── DB init (called once inside startBot before waitForDB) ────────────────
async function initDBConnections() {
    const result = await dbSetup.init({
        NUMBER_DB_URI  : NUMBER_DB_URI,
        USER_DB_URI    : USER_DB_URI,
        USER_STATUS_DB : USER_STATUS_DB,
    });

    numberConn = result.numberConn;
    userConn   = result.userConn;
    statusConn = result.statusConn;
    sync       = result.sync;
    const primaryDbLabel = result.usingLocal ? "Local" : "Atlas";

    // ── Primary DB event listeners ────────────────────────────────────────
    numberConn.on('connected', async () => {
        console.log(`✅ Number DB (${primaryDbLabel}) Connected!`);
        isNumberDBReady = true;
        await setupDatabaseIndexes();
    });
    numberConn.on('error', (err) => {
        console.error("❌ Number DB Error:", err.message);
        isNumberDBReady = false;
    });
    numberConn.on('disconnected', () => {
        console.log("⚠️ Number DB Disconnected!");
        isNumberDBReady = false;
    });
    numberConn.on('reconnected', () => {
        console.log("✅ Number DB Reconnected!");
        isNumberDBReady = true;
    });

    userConn.on('connected', () => {
        console.log(`✅ User & Config DB (${primaryDbLabel}) Connected!`);
        isUserDBReady = true;
        syncSystem();
        loadDisabledSectors();
        loadDisabledCountries();
        loadCustomSectors();
        loadRefLevels();
        loadLbBonus();
        loadMaintenanceConfig();
        loadLbConfig();
        loadPayMethodConfig();
        loadDynamicPayMethods();
        loadGuidePhotos();
    });
    userConn.on('error', (err) => {
        console.error("❌ User DB Error:", err.message);
        isUserDBReady = false;
    });
    userConn.on('disconnected', () => {
        console.log("⚠️ User DB Disconnected!");
        isUserDBReady = false;
    });
    userConn.on('reconnected', () => {
        console.log("✅ User DB Reconnected!");
        isUserDBReady = true;
    });

    if (USER_STATUS_DB) {
        statusConn.on('connected', () => {
            console.log(`✅ Status DB (${primaryDbLabel}) Connected!`);
            isStatusDBReady = true;
        });
        statusConn.on('error', (err) => {
            console.error("❌ Status DB Error:", err.message);
            isStatusDBReady = false;
        });
        statusConn.on('disconnected', () => {
            console.log("⚠️ Status DB Disconnected!");
            isStatusDBReady = false;
        });
    } else {
        console.log("ℹ️ USER_STATUS_DB not set — OTP stats stored in User DB.");
        userConn.on('connected',    () => { isStatusDBReady = true;  });
        userConn.on('disconnected', () => { isStatusDBReady = false; });
        userConn.on('error',        () => { isStatusDBReady = false; });
    }

    // ── Register all Mongoose models against the primary connections ───────
    NumberModel        = numberConn.model('Number',          numberSchema);
    UserModel          = userConn.model('User',              userSchema);
    ConfigModel        = userConn.model('Config',            configSchema);
    WalletUser         = userConn.model('WalletUser',        walletSchema);
    WithdrawRequest    = userConn.model('WithdrawRequest',   withdrawSchema);
    SubAdminModel      = userConn.model('SubAdmin',          subAdminSchema);
    CountryMethodModel = userConn.model('CountryMethod',     countryMethodSchema);
    OtpFilterModel     = userConn.model('OtpFilter',         otpFilterSchema);
    CustomSectorModel  = userConn.model('CustomSector',      customSectorSchema);
    DynamicPayMethod   = userConn.model('DynamicPayMethod',  dynamicPayMethodSchema);
    NoLimitBatch       = numberConn.model('NoLimitBatch',    noLimitBatchSchema);

    const _sCon = statusConn;
    BotStat     = _sCon ? _sCon.model('BotStat',     botStatSchema)     : null;
    OtpHistory  = _sCon ? _sCon.model('OtpHistory',  otpHistorySchema)  : null;
    UserOtpStat = _sCon ? _sCon.model('UserOtpStat', userOtpStatSchema) : null;

    console.log(`✅ All Mongoose models registered on ${primaryDbLabel.toLowerCase()} connections`);

    // ── Register same schemas on Atlas connections (for background sync) ──
    if (result.failoverSystem.handlers['number']) {
        const nh = result.failoverSystem.handlers['number'];
        nh.registerAtlasModel('Number',       numberSchema);
        nh.registerAtlasModel('NoLimitBatch', noLimitBatchSchema);
    }
    if (result.failoverSystem.handlers['user']) {
        const uh = result.failoverSystem.handlers['user'];
        uh.registerAtlasModel('User',             userSchema);
        uh.registerAtlasModel('Config',           configSchema);
        uh.registerAtlasModel('WalletUser',       walletSchema);
        uh.registerAtlasModel('WithdrawRequest',  withdrawSchema);
        uh.registerAtlasModel('SubAdmin',         subAdminSchema);
        uh.registerAtlasModel('CountryMethod',    countryMethodSchema);
        uh.registerAtlasModel('OtpFilter',        otpFilterSchema);
        uh.registerAtlasModel('CustomSector',     customSectorSchema);
        uh.registerAtlasModel('DynamicPayMethod', dynamicPayMethodSchema);
    }
    if (result.failoverSystem.handlers['status']) {
        const sh = result.failoverSystem.handlers['status'];
        sh.registerAtlasModel('BotStat',     botStatSchema);
        sh.registerAtlasModel('OtpHistory',  otpHistorySchema);
        sh.registerAtlasModel('UserOtpStat', userOtpStatSchema);
    }

    // Atlas sync logging
    result.failoverSystem.on('sync:done', ({ dbKey, synced, failed }) => {
        if (synced > 0 || failed > 0)
            console.log(`[Atlas Sync] ✅ ${dbKey}: ${synced} synced, ${failed} re-queued`);
    });

    return result;
}

const numberSchema = new mongoose.Schema({
    number: { type: String, required: true },
    country: { type: String, required: true },
    flag: { type: String, default: "🌍" },
    sector: { type: String, default: 'facebook' }, // facebook | whatsapp | telegram | tiktok
    status: { type: String, enum: ['Available', 'Used', 'Used_History'], default: 'Available' },
    assigned_to: { type: Number, default: null },
    assigned_at: { type: Date, default: null },
    created_at: { type: Date, default: Date.now },
    price: { type: Number, default: null }, // price per number in USD
    no_limit: { type: Boolean, default: false }, // ♾️ no limit batch — শেষ হলে auto re-add
});
// Compound unique: same number can exist in different sectors
numberSchema.index({ number: 1, sector: 1 }, { unique: true });

const userSchema = new mongoose.Schema({
    userId: { type: Number, unique: true, required: true },
    joined_at: { type: Date, default: Date.now }
});

const configSchema = new mongoose.Schema({
    key: { type: String, unique: true, required: true },
    value: { type: String, required: true }
});

// ── Wallet/Referral Schema ──────────────────────────────────────────
const walletSchema = new mongoose.Schema({
    telegramId:         { type: Number, unique: true, required: true },
    username:           { type: String, default: '' },
    firstName:          { type: String, default: '' },
    balance:            { type: Number, default: 0 },
    withdrawn:          { type: Number, default: 0 },
    referredBy:         { type: Number, default: null },
    referCount:         { type: Number, default: 0 },
    walletMethod:       { type: String, default: '' },
    walletAddress:      { type: String, default: '' },
    commissionNotif:    { type: Boolean, default: true }, // true = ON, false = OFF
    joinedAt:           { type: Date, default: Date.now },
});

// ── Withdraw Request Schema ─────────────────────────────────────────
const withdrawSchema = new mongoose.Schema({
    userId:        { type: Number, required: true },
    username:      { type: String, default: '' },
    firstName:     { type: String, default: '' },
    amount:        { type: Number, required: true },
    walletMethod:  { type: String, default: '' },
    walletAddress: { type: String, default: '' },
    status:        { type: String, default: 'pending' }, // pending | processing | approved | rejected | failed
    txHash:        { type: String, default: '' },
    txLink:        { type: String, default: '' },
    blockNumber:   { type: Number, default: 0 },
    failReason:    { type: String, default: '' },
    processedAt:   { type: Date, default: null },
    paymentNo:     { type: Number, default: 0 },
    createdAt:     { type: Date, default: Date.now },
});

// ✅ MongoDB Models — initDBConnections() এ register হয় (lazy init)
// numberConn / userConn are null until initDBConnections() runs.
// We use module-level vars and assign inside initDBConnections.
let NumberModel     = null;
let UserModel       = null;
let ConfigModel     = null;
let WalletUser      = null;
let WithdrawRequest = null;

// Sub-admin schema
const subAdminSchema = new mongoose.Schema({
    userId: { type: Number, unique: true, required: true },
    allowedButtons: { type: [String], default: [] },
    addedAt: { type: Date, default: Date.now }
});
let SubAdminModel = null;

// 🔗 Country Method Link schema — প্রতিটি দেশের জন্য এডমিনের সেট করা মেথড লিংক
const countryMethodSchema = new mongoose.Schema({
    country:   { type: String, required: true, unique: true }, // resolved full country name
    flag:      { type: String, default: '🌍' },
    link:      { type: String, required: true },
    updatedAt: { type: Date, default: Date.now }
});
let CountryMethodModel = null;

// 🚫 OTP Filter Schema — নির্দিষ্ট দেশের নির্দিষ্ট সার্ভিসের OTP ব্লক করার জন্য
const otpFilterSchema = new mongoose.Schema({
    country:   { type: String, required: true }, // ISO কোড, যেমন BD, IN
    service:   { type: String, required: true }, // যেমন TikTok, WhatsApp
    createdAt: { type: Date, default: Date.now }
});
otpFilterSchema.index({ country: 1, service: 1 }, { unique: true });
let OtpFilterModel = null;

// In-memory filter cache — nexo-panel এ এক্সেস করার জন্য
global.OTP_FILTER_CACHE = []; // [{ country: 'BD', service: 'TikTok' }, ...]

async function syncOtpFilterCache() {
    try {
        const filters = await OtpFilterModel.find({});
        global.OTP_FILTER_CACHE = filters.map(f => ({
            country: f.country.toUpperCase(),
            service: f.service.toLowerCase()
        }));
    } catch(e) { console.error('[OtpFilter] Cache sync error:', e.message); }
}

// ➕ Custom Platform/Sector schema — এডমিন রানটাইমে নতুন প্ল্যাটফর্ম যুক্ত করলে এখানে সেভ হবে
const customSectorSchema = new mongoose.Schema({
    id:                    { type: String, required: true, unique: true }, // slug, callback_data এ ব্যবহার হবে
    label:                 { type: String, required: true },
    emoji:                 { type: String, default: '📱' },           // নরমাল ফলব্যাক ইমোজি (premium না দেখালে এটা দেখাবে)
    icon_custom_emoji_id:  { type: String, default: null },           // প্রিমিয়াম ইমোজি আইডি
    style:                 { type: String, default: 'success' },
    createdAt:             { type: Date, default: Date.now }
});
let CustomSectorModel = null;

// ── Dynamic Pay Method schema — এডমিন রানটাইমে নতুন পেমেন্ট মেথড যুক্ত করলে এখানে সেভ হবে ──
const dynamicPayMethodSchema = new mongoose.Schema({
    id:                   { type: String, required: true, unique: true }, // slug key (callback_data এ ব্যবহার)
    label:                { type: String, required: true },               // ডিসপ্লে নাম
    emoji:                { type: String, default: '💳' },               // fallback emoji
    icon_custom_emoji_id: { type: String, default: null },               // প্রিমিয়াম ইমোজি আইডি
    type:                 { type: String, enum: ['USDT_BEP20', 'MANUAL'], default: 'MANUAL' }, // পেমেন্ট টাইপ
    enabled:              { type: Boolean, default: true },
    createdAt:            { type: Date, default: Date.now }
});
let DynamicPayMethod = null;

// ── No Limit Batch Schema — যেসব batch "no limit" দিয়ে add হয়েছে ──────
// file_id + numbers সেভ থাকবে, শেষ হলে silently re-add হবে
const noLimitBatchSchema = new mongoose.Schema({
    country:  { type: String, required: true },
    flag:     { type: String, default: '🌍' },
    sectors:  [{ type: String }],          // ['facebook', 'whatsapp', ...]
    price:    { type: Number, default: null },
    file_id:  { type: String, required: true }, // Telegram file_id
    numbers:  [{ type: String }],          // pre-parsed number list (backup)
    createdAt:{ type: Date, default: Date.now }
});
noLimitBatchSchema.index({ country: 1 });
let NoLimitBatch = null;

// ── Status DB Schemas (USER_STATUS_db) ────────────────────────────
// ১. Global counter — মোট OTP count (singleton)
const botStatSchema = new mongoose.Schema({
    _id:       { type: String, default: 'global' },
    totalOtp:  { type: Number, default: 0 },
    updatedAt: { type: Date,   default: Date.now }
}, { _id: false });

// ২. OTP History — প্রতিটা OTP আলাদা record
const otpHistorySchema = new mongoose.Schema({
    userId:    { type: Number, required: true }, // যে user-এর নাম্বারে OTP এসেছে
    username:  { type: String, default: '' },
    firstName: { type: String, default: '' },
    receivedAt:{ type: Date,   default: Date.now }
});
otpHistorySchema.index({ userId: 1 });
otpHistorySchema.index({ receivedAt: -1 });

// ৩. Per-user OTP count — প্রতি user কতটা OTP পেয়েছে
const userOtpStatSchema = new mongoose.Schema({
    userId:        { type: Number, unique: true, required: true },
    username:      { type: String, default: '' },
    firstName:     { type: String, default: '' },
    otpCount:      { type: Number, default: 0 },
    dailyOtpCount: { type: Number, default: 0 }, // প্রতিদিন সকাল ৬টায় রিসেট হয়
    dailyEarning:  { type: Number, default: 0 }, // আজকের OTP থেকে আর্ন (প্রতিদিন রিসেট হয়)
    lastOtpAt:     { type: Date,   default: null }
});

let BotStat     = null;
let OtpHistory  = null;
let UserOtpStat = null;

// Global OTP counter increment
async function incStat(field, amount = 1) {
    if (!isStatusDBReady) return;
    try {
        await BotStat.findOneAndUpdate(
            { _id: 'global' },
            { $inc: { [field]: amount }, $set: { updatedAt: new Date() } },
            { upsert: true, returnDocument: 'after' }
        );
    } catch(e) { console.error('BotStat update error:', e.message); }
}

// Global OTP count পড়া
async function getBotStat() {
    if (!isStatusDBReady) return null;
    try {
        const doc = await BotStat.findOne({ _id: 'global' });
        return doc || { totalOtp: 0 };
    } catch(e) { return null; }
}

// OTP এলে — history save + user count update
async function recordOtp(userId, from = {}) {
    if (!isStatusDBReady) return;
    try {
        const uName = from.username  || '';
        let fName = from.first_name || '';

        // firstName না থাকলে WalletUser বা UserOtpStat থেকে নাও
        if (!fName) {
            try {
                if (isUserDBReady && WalletUser) {
                    const wallet = await WalletUser.findOne({ telegramId: userId }).lean();
                    if (wallet && wallet.firstName) fName = wallet.firstName;
                }
                if (!fName && UserOtpStat) {
                    const existing = await UserOtpStat.findOne({ userId }).lean();
                    if (existing && existing.firstName) fName = existing.firstName;
                }
            } catch(_) {}
        }

        // History record
        await OtpHistory.create({ userId, username: uName, firstName: fName });
        // Per-user count (total + daily) — firstName শুধু আপডেট করো যদি নতুন ভ্যালু থাকে
        const setFields = { username: uName, lastOtpAt: new Date() };
        if (fName) setFields.firstName = fName;
        await UserOtpStat.findOneAndUpdate(
            { userId },
            { $inc: { otpCount: 1, dailyOtpCount: 1 }, $set: setFields },
            { upsert: true, returnDocument: 'after' }
        );
        // Global count
        await incStat('totalOtp');
    } catch(e) { console.error('recordOtp error:', e.message); }
}

// User-এর OTP count পড়া
async function getUserOtpCount(userId) {
    if (!isStatusDBReady) return 0;
    try {
        const doc = await UserOtpStat.findOne({ userId });
        return doc ? (doc.otpCount || 0) : 0;
    } catch(e) { return 0; }
}

// ── Dynamic Pay Methods রানটাইম ক্যাশ ──
let dynamicPayMethods = []; // DB থেকে লোড হওয়া মেথড লিস্ট

async function loadDynamicPayMethods() {
    if (!isUserDBReady) return;
    try {
        dynamicPayMethods = await DynamicPayMethod.find({});
        console.log(`✅ Dynamic Pay Methods loaded: ${dynamicPayMethods.length}`);
    } catch(e) { console.log('⚠️ Dynamic Pay Method Load Error:', e.message); }
}

// বট স্টার্টআপে এডমিনের আগে যুক্ত করা কাস্টম প্ল্যাটফর্মগুলো SECTORS এ লোড করা
async function loadCustomSectors() {
    if (!isUserDBReady) return;
    try {
        const customSectors = await CustomSectorModel.find({});
        customSectors.forEach(cs => {
            if (!SECTORS.find(s => s.id === cs.id)) {
                SECTORS.push({
                    id: cs.id,
                    label: cs.label,
                    emoji: cs.emoji || '📱',
                    icon_custom_emoji_id: cs.icon_custom_emoji_id || null,
                    style: cs.style || 'success'
                });
            }
        });
        console.log(`✅ Custom platforms loaded: ${customSectors.length}`);
    } catch (e) { console.log('⚠️ Custom Sector Load Error:', e.message); }
}

// প্ল্যাটফর্মের নাম থেকে slug/id তৈরি করা (ইউনিক callback_data এর জন্য)
function slugifyPlatformName(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_+|_+$/g, '') || 'platform';
}

// দেশের নাম normalize করার helper — case/space ভেদে একই দেশ হিসেবে ম্যাচ করার জন্য
function normalizeCountryKey(name) {
    return cleanCountryName(String(name || '')).trim().toLowerCase();
}

// admin ইনপুট (country name / short name / country code) থেকে ফুল নাম + ফ্ল্যাগ বের করা
function resolveCountryInput(rawInput) {
    const input = String(rawInput || '').trim();
    const flagRegex = /[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]/;
    const manualFlagMatch = input.match(flagRegex);

    if (manualFlagMatch) {
        const flag = manualFlagMatch[0];
        const name = cleanCountryName(input.replace(flag, '').trim());
        return { name: name || input, flag };
    }

    const detectedFlag = countryEmoji.flag(input);
    const detectedName = countryEmoji.name(input);
    if (detectedFlag && detectedName) {
        return { name: detectedName, flag: detectedFlag };
    }

    // exact resolve না হলে যা টাইপ করেছে সেটাই নাম, ফ্ল্যাগ যদি cache এ থাকে সেটা নেয়, না থাকলে 🌍
    const cachedFlag = country_data_cache[input]?.flag || countryEmoji.flag(input) || '🌍';
    return { name: cleanCountryName(input), flag: cachedFlag };
}

// মেথড বাটন তৈরি — 🎥 সবসময় প্রিমিয়াম আইকন থাকবে, ফ্ল্যাগ টেক্সটে প্লেইন emoji হিসেবে থাকবে
function buildMethodButton(methodEntry, countryName) {
    const flagInfo = findEmojiEntry(countryName);
    const premiumFlagId = flagInfo ? (flagInfo.p1 || flagInfo.p2 || null) : null;
    const normalFlag = (flagInfo && flagInfo.n) ? flagInfo.n : (methodEntry.flag || '🌍');
    // প্রিমিয়াম ফ্ল্যাগ আইকন পাওয়া গেলে টেক্সটে আলাদা flag glyph রাখা হচ্ছে না (নাহলে ডাবল ফ্ল্যাগ দেখাবে)
    const btnText = premiumFlagId ? `Method` : `${normalFlag} Method`;
    const btn = { text: btnText, url: methodEntry.link, style: 'primary' };
    if (premiumFlagId) btn.icon_custom_emoji_id = premiumFlagId;
    return btn;
}

// একটি দেশের জন্য সেভ করা মেথড লিংক খোঁজা (case-insensitive)
async function getCountryMethod(countryName) {
    if (!countryName) return null;
    const key = normalizeCountryKey(countryName);
    if (!key) return null;
    try {
        const all = await CountryMethodModel.find({});
        return all.find(m => normalizeCountryKey(m.country) === key) || null;
    } catch (e) {
        return null;
    }
}

// ── Referral Commission Config ──────────────────────────────────────
let REF_LEVELS = [
    { level: 1, minRefs:   0, commission: 0.0002 },
    { level: 2, minRefs:  50, commission: 0.0004 },
    { level: 3, minRefs: 100, commission: 0.0006 },
    { level: 4, minRefs: 150, commission: 0.0008 },
    { level: 5, minRefs: 200, commission: 0.0010 },
];

function getReferralLevel(referCount) {
    let current = REF_LEVELS[0];
    for (const lvl of REF_LEVELS) {
        if (referCount >= lvl.minRefs) current = lvl;
    }
    return current;
}

// ── Leaderboard Daily Bonus Config (1st/2nd/3rd) ────────────────────
// Admin প্যানেল থেকে সেট করা যাবে, প্রতিদিন ৬AM রিসেটের সময় দেওয়া হবে
let LB_BONUS = {
    first:  0.50, // ১ম স্থানের জন্য বোনাস ($)
    second: 0.30, // ২য় স্থানের জন্য বোনাস ($)
    third:  0.10  // ৩য় স্থানের জন্য বোনাস ($)
};

async function loadLbBonus() {
    if (!isUserDBReady) return;
    try {
        const conf = await ConfigModel.findOne({ key: 'lb_bonus' }).lean();
        if (conf) {
            const saved = JSON.parse(conf.value);
            if (saved && typeof saved === 'object') {
                LB_BONUS.first  = parseFloat(saved.first)  || LB_BONUS.first;
                LB_BONUS.second = parseFloat(saved.second) || LB_BONUS.second;
                LB_BONUS.third  = parseFloat(saved.third)  || LB_BONUS.third;
                console.log('✅ LB_BONUS loaded:', LB_BONUS);
            }
        }
    } catch(e) { console.log('Error loading lb_bonus:', e.message); }
}

async function saveLbBonus() {
    try {
        await ConfigModel.findOneAndUpdate(
            { key: 'lb_bonus' },
            { key: 'lb_bonus', value: JSON.stringify(LB_BONUS) },
            { upsert: true }
        );
    } catch(e) { console.log('Error saving lb_bonus:', e.message); }
}

async function getWalletUser(telegramId, from = null) {
    let u = await WalletUser.findOne({ telegramId });
    if (!u && from) {
        u = await WalletUser.create({
            telegramId,
            username:  from.username  || '',
            firstName: from.first_name || '',
        });
    }
    return u;
}

// ── Wallet Method Validity Check ────────────────────────────────────
// ইউজারের সেভ করা wallet method এখনো active আছে কিনা চেক করে।
// Admin যদি method টা disable বা delete করে দেয়, তাহলে user এর wallet clear করে
// নতুন setup চাইবে। Returns true = valid, false = invalid (already handled).
async function validateUserWallet(chatId, userId, wUser) {
    if (!wUser || !wUser.walletMethod) return true; // wallet set নেই, অন্য জায়গায় handle হবে

    const savedMethod = wUser.walletMethod;

    // Static methods চেক — disabled list এ আছে কিনা
    const isStaticMethod = WALLET_METHODS.find(m => m.key === savedMethod);
    // Dynamic methods চেক — exist করে এবং enabled আছে কিনা
    const dynMethod = dynamicPayMethods.find(dm => dm.id === savedMethod);
    const isDynActive = dynMethod && dynMethod.enabled && !disabledPayMethods.includes(savedMethod);

    const isValid = isStaticMethod
        ? !disabledPayMethods.includes(savedMethod)   // static: disabled list এ নেই
        : isDynActive;                                 // dynamic: active আছে

    if (!isValid) {
        // DB তে wallet clear করো
        await WalletUser.findOneAndUpdate(
            { telegramId: userId },
            { walletMethod: '', walletAddress: '' }
        );
        // ইউজারকে জানাও এবং নতুন setup করতে বলো
        await bot.sendMessage(chatId,
            E(`⚠️ <b>Wallet Reset!</b>\n\n` +
            `আপনার আগের payment method (<b>${savedMethod}</b>) বর্তমানে উপলব্ধ নেই।\n` +
            `Admin এটি বন্ধ বা মুছে দিয়েছেন।\n\n` +
            `📌 অনুগ্রহ করে নতুন একটি wallet সেট করুন।`),
            {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[
                    { text: 'Set Wallet', icon_custom_emoji_id: _BTN_EM.set_wallet.id, style: 'primary', callback_data: 'wallet_set' }
                ]]}
            }
        );
        return false;
    }
    return true;
}

// ── Payment wallet methods ──────────────────────────────────────────
const WALLET_METHODS = [
    { label: '🔶 Binance UID', key: 'Binance',  eid: '5388622778817589921',
      guideText: `🔶 Send your <b>Binance UID</b>:\n📌 <i>Binance App → Profile → Copy UID number</i>`,
      guidePhoto: null },
    { label: '💲 BEP20',       key: 'BEP20',    eid: '5310177404474390190',
      guideText: `💲 Send your <b>USDT BEP20 (BSC)</b> address from your 💲 <b>BEP20</b> wallet:\n📌 Follow the guide above to find your address.`,
      guidePhoto: process.env.BEP20_GUIDE_PHOTO || null },
    { label: '🪙 TRX',         key: 'TRX',      eid: '5832692572971077565',
      guideText: `🪙 Send your <b>USDT TRC20 (TRON)</b> address from your 🪙 <b>TRX</b> wallet:\n📌 Follow the guide above to find your address.`,
      guidePhoto: process.env.TRX_GUIDE_PHOTO || null },
    { label: '💵 bKash',       key: 'bKash',    eid: '6077789481627295920',
      guideText: `💵 Send your <b>bKash number</b>:\n📌 <i>Enter your 11-digit bKash mobile number (e.g. 01XXXXXXXXX)</i>`,
      guidePhoto: null },
    { label: '💴 Nagad',       key: 'Nagad',    eid: '6077835824324420166',
      guideText: `💴 Send your <b>Nagad number</b>:\n📌 <i>Enter your 11-digit Nagad mobile number (e.g. 01XXXXXXXXX)</i>`,
      guidePhoto: null },
];

function walletMethodKeyboard() {
    const rows = [];
    // static disabled method বাদ দিয়ে শুধু active method দেখাও
    const activeMethods = WALLET_METHODS.filter(m => !disabledPayMethods.includes(m.key));
    for (let i = 0; i < activeMethods.length; i += 2) {
        const row = [];
        for (let j = i; j < i + 2 && j < activeMethods.length; j++) {
            const m = activeMethods[j];
            const cleanText = m.label.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]\uFE0F?/gu, '').replace(/\s+/g, ' ').trim();
            row.push({ text: cleanText, icon_custom_emoji_id: m.eid, style: 'primary', callback_data: `wmethod_${m.key}` });
        }
        rows.push(row);
    }
    // Dynamic methods (enabled only)
    const activeDyn = dynamicPayMethods.filter(m => m.enabled && !disabledPayMethods.includes(m.id));
    for (let i = 0; i < activeDyn.length; i += 2) {
        const row = [];
        for (let j = i; j < i + 2 && j < activeDyn.length; j++) {
            const dm = activeDyn[j];
            const btn = { text: dm.label, callback_data: `wmethod_${dm.id}`, style: 'primary' };
            if (dm.icon_custom_emoji_id) btn.icon_custom_emoji_id = dm.icon_custom_emoji_id;
            row.push(btn);
        }
        rows.push(row);
    }
    if (activeMethods.length === 0 && activeDyn.length === 0) {
        rows.push([{ text: '⚠️ কোনো পেমেন্ট মেথড চালু নেই', callback_data: 'ignore', style: 'danger' }]);
    }
    // Back বাটন সবসময় শেষে
    rows.push([{ text: '◀️ Back', callback_data: 'wallet_back', style: 'primary' }]);
    return { reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML' };
}

// ── Called from panel.js (global) when OTP received for a user ─────
global.payOtpCommission = async function(assignedUserId, fromUser = {}, otpPrice = 0) {
    try {
        // OTP history + user count + global count
        recordOtp(assignedUserId, fromUser).catch(() => {});

        if (!isUserDBReady) return;

        // ── Seller নিজের balance add ──────────────────────────────────────
        let seller = null;
        if (otpPrice && otpPrice > 0) {
            // balance আছে — সরাসরি add করো (না থাকলে upsert করবে না, তাই আগে চেক করি)
            seller = await WalletUser.findOneAndUpdate(
                { telegramId: assignedUserId },
                { $inc: { balance: otpPrice } },
                { returnDocument: 'after' }
            );
            if (seller) {
                console.log(`[commission] +$${otpPrice.toFixed(4)} -> user ${assignedUserId} | balance: $${seller.balance.toFixed(4)}`);
            } else {
                // নতুন user — create করো তারপর balance দাও
                seller = await WalletUser.findOneAndUpdate(
                    { telegramId: assignedUserId },
                    { $setOnInsert: { telegramId: assignedUserId, balance: otpPrice, referredBy: null, referCount: 0 } },
                    { upsert: true, returnDocument: 'after' }
                );
                console.log(`[commission] new user created +$${otpPrice.toFixed(4)} -> ${assignedUserId}`);
            }
        } else {
            // price 0 — seller খোঁজো referrer commission এর জন্য
            seller = await WalletUser.findOne({ telegramId: assignedUserId });
            if (!seller) {
                seller = await WalletUser.findOneAndUpdate(
                    { telegramId: assignedUserId },
                    { $setOnInsert: { telegramId: assignedUserId, balance: 0, referredBy: null, referCount: 0 } },
                    { upsert: true, returnDocument: 'after' }
                );
            }
        }

        // আজকের earning ট্র্যাক
        if (isStatusDBReady && UserOtpStat && otpPrice > 0) {
            UserOtpStat.findOneAndUpdate(
                { userId: assignedUserId },
                { $inc: { dailyEarning: otpPrice } },
                { upsert: false }
            ).catch(() => {});
        }

        // ── Referrer commission ──────────────────────────────────────────
        if (!seller || !seller.referredBy) return;

        const referrer = await WalletUser.findOne({ telegramId: seller.referredBy });
        if (!referrer) return;

        const lvl = getReferralLevel(referrer.referCount || 0);
        const updatedRef = await WalletUser.findOneAndUpdate(
            { telegramId: referrer.telegramId },
            { $inc: { balance: lvl.commission } },
            { returnDocument: 'after' }
        );
        if (!updatedRef) return;

        console.log(`[commission] referral +$${lvl.commission.toFixed(4)} -> referrer ${referrer.telegramId} (L${lvl.level})`);

        // commissionNotif false হলে notification পাঠাবে না
        if (referrer.commissionNotif === false) return;

        bot.sendMessage(referrer.telegramId,
            E(`💰 <b>Commission Received!</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 <b>${escapeHtml(seller.firstName) || 'Your referral'}</b> received an OTP.\n` +
            `🎯 Commission (L${lvl.level}): <b>+$${lvl.commission.toFixed(4)}</b>\n` +
            `💰 New Balance: <b>$${updatedRef.balance.toFixed(4)}</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `/CommissionNotificationOFF\n` +
            `/CommissionNotificationON`),
            { parse_mode: 'HTML' }
        ).catch(() => {});
    } catch(e) { console.error('[payOtpCommission] Error:', e.message); }
};

// ✅ Connection event handlers moved to initDBConnections() above

async function waitForDB() {
    console.log("⏳ Waiting for Database connections...");
    let attempts = 0;
    while ((!isNumberDBReady || !isUserDBReady) && attempts < 120) {
        await new Promise(resolve => setTimeout(resolve, 500));
        attempts++;
    }
    if (!isNumberDBReady || !isUserDBReady) {
        console.warn("⚠️ DB connection timeout — continuing anyway...");
    } else {
        console.log("🚀 All Databases Ready! Starting Bot...");
    }
    return true;
}

const bot = new TelegramBot(BOT_TOKEN, { 
    polling: false
});

// ── Daily Leaderboard Reset — প্রতিদিন সকাল ৬:০০ AM (Bangladesh Time UTC+6) ──
function scheduleDailyLeaderboardReset() {
    function getBDNow() {
        const now = new Date();
        const bdOffset = 6 * 60; // UTC+6 in minutes
        const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
        return new Date(utcMs + bdOffset * 60000);
    }

    function msUntilNext6AM() {
        const bdNow = getBDNow();
        const next6AM = new Date(bdNow);
        next6AM.setHours(6, 0, 0, 0);
        if (bdNow.getHours() >= 6) next6AM.setDate(next6AM.getDate() + 1);
        return next6AM - bdNow;
    }

    // আজকের BD তারিখ string হিসেবে, e.g. "2024-07-24"
    function getBDDateStr(date) {
        const d = date || getBDNow();
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    async function doReset(reason) {
        try {
            if (!isStatusDBReady || !UserOtpStat) {
                console.log('[leaderboard-reset] StatusDB not ready, skipping reset.');
            } else {
                // ── রিসেটের আগে Top 3 কে বোনাস দাও ──────────────────────
                await distributeLeaderboardBonus();

                const todayStr = getBDDateStr();
                const result = await UserOtpStat.updateMany({}, { $set: { dailyOtpCount: 0, dailyEarning: 0 } });
                // DB-তে শেষ রিসেটের তারিখ সেভ করো
                await ConfigModel.findOneAndUpdate(
                    { key: 'leaderboard_last_reset_date' },
                    { key: 'leaderboard_last_reset_date', value: todayStr },
                    { upsert: true }
                );
                // ── Atlas Sync ─────────────────────────────────────────────────────────
                if (sync) sync.configUpsert({ key: 'leaderboard_last_reset_date', value: todayStr });
                console.log(`[leaderboard-reset] ✅ ${reason || 'Scheduled'} reset — ${result.modifiedCount} users (date: ${todayStr})`);
            }
        } catch(e) {
            console.error('[leaderboard-reset] ❌ Error:', e.message);
        }
        // পরের দিন আবার schedule করো
        setTimeout(() => { doReset('Scheduled'); }, msUntilNext6AM());
    }

    // ── Top 3 লিডারবোর্ড বোনাস বিতরণ ───────────────────────────────
    async function distributeLeaderboardBonus() {
        try {
            if (!isStatusDBReady || !UserOtpStat || !isUserDBReady || !WalletUser) return;

            // ── আজকে আগেই bonus দেওয়া হয়েছে কিনা চেক করো ──────────────
            const todayStr = getBDDateStr();
            const bonusDoneConf = await ConfigModel.findOne({ key: 'leaderboard_bonus_date' }).lean();
            if (bonusDoneConf && bonusDoneConf.value === todayStr) {
                console.log(`[lb-bonus] ⏭️ Bonus already distributed today (${todayStr}), skipping.`);
                return;
            }
            const topUsers = await UserOtpStat.find({ dailyOtpCount: { $gt: 0 } })
                .sort({ dailyOtpCount: -1 })
                .limit(3)
                .lean();

            if (topUsers.length === 0) {
                // এডমিনকে জানাও — আজকে কেউ কাজ করেনি
                for (const adminId of ADMIN_IDS) {
                    bot.sendMessage(adminId,
                        `🏆 <b>লিডারবোর্ড রিসেট সামারি</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `📅 আজকে কোনো OTP সেন্ড হয়নি।\n` +
                        `💸 কোনো বোনাস বিতরণ করা হয়নি।`,
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                }
                return;
            }

            const bonusAmounts = [LB_BONUS.first, LB_BONUS.second, LB_BONUS.third];
            const rankNames    = ['🥇 ১ম', '🥈 ২য়', '🥉 ৩য়'];
            const rankEmojis   = ['🥇', '🥈', '🥉'];

            // ── উইনার তথ্য কালেক্ট করো (broadcast + admin summary-র জন্য) ──
            const winnerResults = [];

            for (let i = 0; i < topUsers.length; i++) {
                const u      = topUsers[i];
                const bonus  = bonusAmounts[i] || 0;
                if (bonus <= 0) { winnerResults.push({ u, bonus: 0, newBal: null }); continue; }

                try {
                    // WalletUser balance-এ যোগ করো
                    const updated = await WalletUser.findOneAndUpdate(
                        { telegramId: u.userId },
                        { $inc: { balance: bonus } },
                        { upsert: true, returnDocument: 'after' }
                    );
                    const newBal = updated ? updated.balance.toFixed(4) : '—';
                    console.log(`[lb-bonus] ${rankNames[i]} user ${u.userId} → +$${bonus.toFixed(4)}`);
                    winnerResults.push({ u, bonus, newBal, rank: i });

                    // ── ব্যক্তিগত নোটিফিকেশন — ইউজারকে পাঠাও ──
                    const firstName = escapeHtml(u.firstName) || 'User';
                    const notifText =
                        `🎉 <b>লিডারবোর্ড বোনাস পেয়েছেন!</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `${rankEmojis[i]} <b>${rankNames[i]} স্থান</b> অর্জন করেছেন!\n\n` +
                        `📊 আজকের OTP: <b>${u.dailyOtpCount}</b>\n` +
                        `🎁 বোনাস: <b>+$${bonus.toFixed(4)}</b>\n` +
                        `💰 নতুন ব্যালেন্স: <b>$${newBal}</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `🏆 আগামীকালও সেরা থাকুন!`;
                    bot.sendMessage(u.userId, notifText, { parse_mode: 'HTML' }).catch(() => {});
                } catch(e) {
                    console.error(`[lb-bonus] Error for user ${u.userId}:`, e.message);
                }
            }

            // ── বোনাস বিতরণ সম্পন্ন — আজকের তারিখ সেভ করো ──────────────
            await ConfigModel.findOneAndUpdate(
                { key: 'leaderboard_bonus_date' },
                { key: 'leaderboard_bonus_date', value: todayStr },
                { upsert: true }
            );

            // ── সবাইকে ব্রডকাস্ট নোটিফিকেশন পাঠাও (আজকের উইনার) ──
            if (winnerResults.length > 0) {
                await broadcastWinnerNotification(winnerResults, rankEmojis, rankNames);
            }

            // ── এডমিনকে সামারি পাঠাও ──
            await sendWinnerSummaryToAdmin(winnerResults, rankEmojis, rankNames, topUsers);

        } catch(e) {
            console.error('[lb-bonus] distributeLeaderboardBonus error:', e.message);
        }
    }

    // ── সবাইকে আজকের উইনার ব্রডকাস্ট করো ─────────────────────────────
    async function broadcastWinnerNotification(winnerResults, rankEmojis, rankNames) {
        try {
            const botLink = bot_username ? `https://t.me/${bot_username}?start=start` : null;

            const bdNow = getBDNow();
            const dateStr = `${bdNow.getDate().toString().padStart(2,'0')}/${(bdNow.getMonth()+1).toString().padStart(2,'0')}/${bdNow.getFullYear()}`;

            // মেসেজ তৈরি (premium format)
            let broadcastText =
                `<tg-emoji emoji-id="5188344996356448758">🏆</tg-emoji> <b>𝗧𝗼𝗱𝗮𝘆'𝘀 𝗹𝗲𝗮𝗱𝗲𝗿𝗯𝗼𝗮𝗿𝗱 𝘄𝗶𝗻𝗻𝗲𝗿</b><tg-emoji emoji-id="5251227707026470504">🎁</tg-emoji>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `<tg-emoji emoji-id="5413879192267805083">📅</tg-emoji> তারিখ: <b>${dateStr}</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n`;

            for (const wr of winnerResults) {
                if (!wr || wr.bonus <= 0) continue;
                const { u, bonus, rank } = wr;
                const firstName = escapeHtml(u.firstName) || 'User';
                broadcastText +=
                    `<blockquote>${rankEmojis[rank]} <b>${rankNames[rank]} স্থান</b>\n` +
                    `   <tg-emoji emoji-id="5798505243180273024">👤</tg-emoji> <b>${firstName}</b>\n` +
                    `   <tg-emoji emoji-id="6275857834127134596">📲</tg-emoji> OTP: <b>${u.dailyOtpCount}</b>\n` +
                    `   <tg-emoji emoji-id="6156923364997862692">🎁</tg-emoji> বোনাস: <b>+$${bonus.toFixed(4)}</b></blockquote>\n`;
            }

            broadcastText +=
                `\n━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `<tg-emoji emoji-id="6235302918967269680">🚀</tg-emoji> আগামীকাল আপনিও টপে আসতে পারেন!`;

            // বাটন (বট লিংক)
            const markup = botLink ? {
                inline_keyboard: [[
                    { text: 'ᴊᴏɪɴ ʙᴏᴛ', url: botLink, style: 'primary', icon_custom_emoji_id: _BTN_EM.open_bot.id }
                ]]
            } : undefined;

            // সব ইউজারকে পাঠাও (batch করে, rate limit এড়াতে)
            const usersArray = Array.from(bot_users);
            const batchSize = 25;
            let success = 0, fail = 0;

            for (let i = 0; i < usersArray.length; i += batchSize) {
                const batch = usersArray.slice(i, i + batchSize);
                await Promise.all(batch.map(async (targetId) => {
                    try {
                        await bot.sendMessage(targetId, broadcastText, {
                            parse_mode: 'HTML',
                            ...(markup ? { reply_markup: markup } : {})
                        });
                        success++;
                    } catch (e) {
                        if (e.response && e.response.statusCode === 403) {
                            bot_users.delete(targetId);
                        }
                        fail++;
                    }
                }));
                // Rate limit এড়াতে ১ সেকেন্ড অপেক্ষা
                await new Promise(r => setTimeout(r, 1000));
            }
            console.log(`[lb-broadcast] ✅ Winner broadcast done — Success: ${success}, Fail: ${fail}`);
        } catch(e) {
            console.error('[lb-broadcast] broadcastWinnerNotification error:', e.message);
        }
    }

    // ── এডমিনকে সামারি পাঠাও ──────────────────────────────────────────
    async function sendWinnerSummaryToAdmin(winnerResults, rankEmojis, rankNames, topUsers) {
        try {
            const bdNow = getBDNow();
            const dateStr = `${bdNow.getDate().toString().padStart(2,'0')}/${(bdNow.getMonth()+1).toString().padStart(2,'0')}/${bdNow.getFullYear()}`;

            let totalBonusPaid = 0;
            winnerResults.forEach(wr => { if (wr && wr.bonus > 0) totalBonusPaid += wr.bonus; });

            let summaryText =
                `📊 <b>লিডারবোর্ড রিসেট সামারি</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `📅 তারিখ: <b>${dateStr}</b> (সকাল ৬:০০ AM)\n` +
                `👥 আজকে মোট কাজ করেছে: <b>${topUsers.length}+</b> জন\n` +
                `💸 মোট বোনাস বিতরণ: <b>$${totalBonusPaid.toFixed(4)}</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🏆 <b>আজকের উইনার:</b>\n\n`;

            for (const wr of winnerResults) {
                if (!wr) continue;
                const { u, bonus, newBal, rank } = wr;
                const firstName = escapeHtml(u.firstName) || 'User';
                const rawUid = String(u.userId || '');
                summaryText +=
                    `${rankEmojis[rank]} ${rankNames[rank]} — <b>${firstName}</b>\n` +
                    `   🆔 ID: <code>${rawUid}</code>\n` +
                    `   📲 OTP: <b>${u.dailyOtpCount}</b>\n` +
                    `   🎁 বোনাস: <b>+$${bonus > 0 ? bonus.toFixed(4) : '0.0000'}</b>\n` +
                    `   💰 নতুন ব্যালেন্স: <b>$${newBal || '—'}</b>\n\n`;
            }

            summaryText +=
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `✅ সব উইনারের ব্যালেন্সে বোনাস যোগ হয়েছে।\n` +
                `📢 সব ইউজারকে ব্রডকাস্ট নোটিফিকেশন পাঠানো হয়েছে।`;

            for (const adminId of ADMIN_IDS) {
                bot.sendMessage(adminId, summaryText, { parse_mode: 'HTML' }).catch(() => {});
            }
            console.log(`[lb-admin-summary] ✅ Summary sent to ${ADMIN_IDS.length} admin(s)`);
        } catch(e) {
            console.error('[lb-admin-summary] sendWinnerSummaryToAdmin error:', e.message);
        }
    }

    // বট চালু হওয়ার সময় চেক করো — বন্ধ থাকার কারণে রিসেট মিস হয়েছে কিনা
    async function checkMissedReset() {
        try {
            if (!isStatusDBReady || !UserOtpStat || !ConfigModel) return;
            const bdNow = getBDNow();
            // আজকে ৬AM পার হয়েছে কিনা
            if (bdNow.getHours() < 6) {
                // এখনো ৬AM হয়নি, সরাসরি schedule করো
                setTimeout(() => { doReset('Scheduled'); }, msUntilNext6AM());
                return;
            }

            const todayStr = getBDDateStr(bdNow);
            const conf = await ConfigModel.findOne({ key: 'leaderboard_last_reset_date' }).lean();
            const lastResetDate = conf ? conf.value : null;

            if (lastResetDate !== todayStr) {
                // আজকে রিসেট হয়নি — এখনই করো
                console.log(`[leaderboard-reset] ⚠️ Missed reset! Last: ${lastResetDate}, Today: ${todayStr}. Resetting now...`);
                await doReset('Missed-reset recovery');
            } else {
                // আজকে রিসেট হয়ে গেছে, পরের দিন schedule করো
                console.log(`[leaderboard-reset] ✅ Today's reset already done (${todayStr}).`);
                const delay = msUntilNext6AM();
                const hours = Math.floor(delay / 3600000);
                const mins  = Math.floor((delay % 3600000) / 60000);
                console.log(`[leaderboard-reset] ⏰ পরবর্তী রিসেট ${hours}h ${mins}m পরে`);
                setTimeout(() => { doReset('Scheduled'); }, delay);
            }
        } catch(e) {
            console.error('[leaderboard-reset] ❌ checkMissedReset error:', e.message);
            // error হলেও scheduler চালু রাখো
            setTimeout(() => { doReset('Scheduled'); }, msUntilNext6AM());
        }
    }

    const delay = msUntilNext6AM();
    const hours = Math.floor(delay / 3600000);
    const mins  = Math.floor((delay % 3600000) / 60000);
    console.log(`[leaderboard-reset] ⏰ চেক শুরু — পরবর্তী রিসেট ${hours}h ${mins}m পরে (সকাল ৬:০০ AM BD time)`);

    // বট চালু হওয়ার সময় missed reset চেক করো
    checkMissedReset();
}

async function startBot() {
    try {
        await initDBConnections(); // ✅ Local + Atlas connections setup
        await waitForDB();
        await loadCountryEmojiData(); // ✅ emoji data আগে load করো
        await syncOtpFilterCache();   // ✅ OTP filter cache লোড করো
        bot.startPolling();
        scheduleDailyLeaderboardReset(); // ✅ প্রতিদিন ৬AM রিসেট scheduler চালু করো
        console.log(`✅ Bot Username: @${bot_username || 'Loading...'}`);
    } catch (error) {
        console.error("❌ Failed to start bot:", error);
    }
}

// ===============================================
// 🔥 DATABASE INDEX SETUP
// ===============================================
async function setupDatabaseIndexes() {
    try {
        if (!isNumberDBReady) return;

        // পুরনো single number unique index drop করো (same number আলাদা sector-এ এড হতে দেবে)
        try {
            const indexes = await NumberModel.collection.indexes();
            for (const idx of indexes) {
                const keys = Object.keys(idx.key);
                if (keys.length === 1 && keys[0] === 'number' && idx.unique) {
                    await NumberModel.collection.dropIndex(idx.name);
                    console.log("Dropped old single-number unique index:", idx.name);
                }
            }
        } catch(e) { console.log("Index drop check:", e.message); }

        // Correct compound unique: same number আলাদা sector-এ থাকতে পারবে
        await NumberModel.collection.createIndex({ number: 1, sector: 1 }, { unique: true });
        console.log("✅ Index: number + sector (unique)");

        await NumberModel.collection.createIndex({ country: 1, status: 1 });
        console.log("✅ Index: country + status");

        await NumberModel.collection.createIndex({ sector: 1, status: 1 });
        console.log("✅ Index: sector + status");

        await NumberModel.collection.createIndex({ assigned_to: 1, status: 1 });
        console.log("✅ Index: assigned_to + status");

        await NumberModel.collection.createIndex(
            { assigned_at: 1 },
            {
                expireAfterSeconds: 7200,
                partialFilterExpression: { status: 'Used' }
            }
        );
        console.log("✅ TTL Index: Auto-delete after 2 hours");

    } catch (error) {
        console.error("❌ Index error (Non-fatal):", error.message);
    }
}


// ===============================================
// 🛡️ ERROR HANDLING
// ===============================================
bot.on('polling_error', (error) => {
    console.log(`[Polling Error] ${error.code}: ${error.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
    const safeErrors = [
        'query is too old',
        'message is not modified',
        'bot was blocked',
        'user is deactivated',
        'ETELEGRAM: 403',
        'socket hang up'
    ];

    const errorMsg = reason?.message || String(reason);

    if (!safeErrors.some(err => errorMsg.includes(err))) {
        console.error('⚠️ Unhandled Rejection:', errorMsg);
    }
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
});

// ===============================================
// 🗂️ GLOBAL VARIABLES
// ===============================================
let bot_users = new Set();
let admin_country_temp_data = {};
let last_action_time = {};
let user_details_cache = {};
let country_data_cache = {};
let user_states = {};
let admin_file_buffer = {};

// ── Broadcast History ────────────────────────────────────────────────────────
// প্রতিটা broadcast পাঠানোর পর এখানে store হবে
// { id, sentAt, fromChatId, messageId, preview, sentMsgIds: [{ userId, msgId }] }
const BROADCAST_HISTORY_FILE = path.join(process.cwd(), 'broadcast_history.json');
let broadcast_history = [];
try {
    if (fs.existsSync(BROADCAST_HISTORY_FILE)) {
        broadcast_history = JSON.parse(fs.readFileSync(BROADCAST_HISTORY_FILE, 'utf8'));
        console.log(`[BroadcastHistory] ✅ ${broadcast_history.length} টি ব্রডকাস্ট লোড হয়েছে`);
    }
} catch(e) { broadcast_history = []; }

// ── Active Broadcast Stop Flag ──
const activeBroadcasts = {}; // { adminUserId: { stopped: false, bcId } }

function saveBroadcastHistory() {
    try {
        fs.writeFileSync(BROADCAST_HISTORY_FILE, JSON.stringify(broadcast_history, null, 2), 'utf8');
    } catch(e) { console.error('[BroadcastHistory] save error:', e.message); }
}
// ────────────────────────────────────────────────────────────────────────────
let subadmin_add_temp = {}; // temp data for subadmin add flow

// Scheduled add timers: userId → { timer, scheduledAt, label }
const scheduled_add_timers = {};

// Sub-admin permission button definitions
const ADMIN_BUTTONS = [
    { key: 'ADD',       label: '➕ ADD',       text: '➕ ADD' },
    { key: 'BROADCAST', label: '📢 Broadcast', text: '📢 Broadcast' },
    { key: 'STATUS',    label: '📊 Status',    text: '📊 Status' },
    { key: 'DELETE',    label: '🗑️ Delete',    text: '🗑️ Delete' },
    { key: 'RESTART',   label: '🔄 Restart',   text: '🔄 Restart' },
];
let last_change_time = {};
let country_assignment_locks = {};
let countryToIndex = {};
let indexToCountry = {};
let bot_username = "";
let bot_name = "";
let add_session_data = [];
let last_add_timestamp = 0;
let last_channel_msg_ids = {};
const USER_LIST_FILE = path.join(process.cwd(), 'bot_users.json');

bot.getMe().then((me) => {
    bot_username = me.username;
    bot_name = me.first_name || me.username;
    startBot(); 
});

// ===============================================
// 🔧 UTILITY FUNCTIONS
// ===============================================
async function safeEditMessage(chatId, msgId, text, options = {}) {
    try {
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: msgId,
            ...options
        });
    } catch (error) {
        const errDesc = (error.response && error.response.body && error.response.body.description) || error.message || '';
        if (errDesc.includes('message is not modified')) return; // same content — no action needed
        // edit fail হলে পুরনো message delete না করে নতুন পাঠাও
        // (delete করলে পরের callback-এ message_id invalid হয়ে chain error হয়)
        try {
            await bot.sendMessage(chatId, text, options);
        } catch (e2) {
            console.error('safeEditMessage fallback error:', e2.message);
        }
    }
}

async function safeAnswerCallback(callbackQueryId, options = {}) {
    try {
        await bot.answerCallbackQuery(callbackQueryId, options);
    } catch (error) {
        if (!error.message.includes('query is too old')) {
            console.error('Callback error:', error.message);
        }
    }
}


// ====================================
// 🕐 AUTO DELETE CLAIMED NUMBERS AFTER 2 HOURS
// =====================================
async function autoDeleteExpiredNumbers() {
    if (!isNumberDBReady) return;

    try {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        await NumberModel.deleteMany({
            status: 'Used',
            assigned_at: { $lt: twoHoursAgo }
        });
        const stats = await NumberModel.aggregate([
            {
                $group: {
                    _id: "$country",
                    total: { $sum: 1 },
                    available: { 
                        $sum: { $cond: [{ $eq: ["$status", "Available"] }, 1, 0] } 
                    }
                }
            },
            { $match: { available: 0 } }
        ]);

        if (stats.length > 0) {
            const countriesToDelete = stats.map(s => s._id);
            console.log(`🗑️ Auto-cleaning empty countries: ${countriesToDelete.join(', ')}`);
            await NumberModel.deleteMany({ country: { $in: countriesToDelete } });
            await rebuildCountryCache();
        }

    } catch (error) {
        console.error("Auto-delete error:", error);
    }
}

setInterval(autoDeleteExpiredNumbers, 10 * 60 * 1000);

// ===============================================
// 🔄 GITHUB & DB SYNC LOGIC
// ===============================================
async function getGitHubToken() {
    if (!isUserDBReady) return null; // ✅ Safety Check
    const conf = await ConfigModel.findOne({ key: "github_token" });
    return conf ? conf.value : null;
}

async function fetchGithubUsers(token) {
    if (!token) return null;
    const url = `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO_NAME}/contents/${GITHUB_FILE_PATH}`;

    try {
        const res = await axios.get(url, {
            headers: { 'User-Agent': 'NodeBot', 'Authorization': `token ${token}` },
            timeout: 15000
        });
        if (res.status !== 200) {
            console.log("GitHub Fetch Error or 404 (File might not exist yet).");
            return null;
        }
        const json = res.data;
        const content = Buffer.from(json.content, 'base64').toString('utf8');
        return { content: JSON.parse(content), sha: json.sha };
    } catch (e) {
        console.log("GitHub Fetch Error or 404 (File might not exist yet):", e.message);
        return null;
    }
}

async function uploadToGithub(usersArray, token, sha = null) {
    if (!token) return;
    const url = `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO_NAME}/contents/${GITHUB_FILE_PATH}`;
    const contentEncoded = Buffer.from(JSON.stringify(usersArray, null, 2)).toString('base64');

    const bodyData = {
        message: "Update user.json via Bot",
        content: contentEncoded,
        sha: sha
    };

    try {
        await axios.put(url, bodyData, {
            headers: {
                'User-Agent': 'NodeBot',
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            },
            timeout: 15000
        });
        console.log("✅ GitHub Updated Successfully.");
    } catch (err) {
        console.error("GitHub Upload Error:", err.message);
    }
}

async function syncSystem() {
    if (!isUserDBReady) return; // ✅ Safety Check
    console.log("🔄 Starting Sync System...");
    const token = await getGitHubToken();

    try {
        const mongoUsersDocs = await UserModel.find({});
        const mongoUserIds = new Set(mongoUsersDocs.map(u => u.userId));

        let githubData = await fetchGithubUsers(token);
        let githubUserIds = new Set();
        if (githubData && Array.isArray(githubData.content)) {
            githubUserIds = new Set(githubData.content);
        }

        const allUsers = new Set([...mongoUserIds, ...githubUserIds, ...bot_users]);
        ADMIN_IDS.forEach(id => allUsers.add(id));

        bot_users = allUsers;

        const newForMongo = [];
        allUsers.forEach(uid => {
            if (!mongoUserIds.has(uid)) {
                newForMongo.push({ userId: uid });
            }
        });

        if (newForMongo.length > 0) {
            await UserModel.insertMany(newForMongo, { ordered: false }).catch(() => {});
            console.log(`📥 Added ${newForMongo.length} users to MongoDB from Sync.`);
        }

        if (token) {
            const finalArray = Array.from(allUsers);
            if (finalArray.length !== githubUserIds.size || newForMongo.length > 0) {
                await uploadToGithub(finalArray, token, githubData ? githubData.sha : null);
            }
        }

        try {
            fs.writeFileSync(USER_LIST_FILE, JSON.stringify(Array.from(allUsers), null, 4));
        } catch (e) {}

        console.log(`✅ Sync Complete. Total Users: ${allUsers.size}`);
    } catch (error) {
        console.error("Sync Error:", error);
    }
}

async function addUserToLocalDb(userId, from = null) {
    // firstName সবসময় sync করো (নতুন user হোক বা পুরনো)
    if (from && from.first_name && isUserDBReady && WalletUser) {
        try {
            await WalletUser.findOneAndUpdate(
                { telegramId: userId },
                { $set: { firstName: from.first_name, username: from.username || '' } },
                { upsert: false } // শুধু exist করা user আপডেট করো, নতুন তৈরি নয়
            );
        } catch (_) {}
    }

    if (!bot_users.has(userId)) {
        bot_users.add(userId);

        if (isUserDBReady) {
            try {
                await UserModel.findOneAndUpdate({ userId: userId }, { $setOnInsert: { userId: userId } }, { upsert: true });
            } catch (e) {}
        }

        try {
            fs.writeFileSync(USER_LIST_FILE, JSON.stringify(Array.from(bot_users), null, 4));
        } catch (e) {}

        if (isUserDBReady) {
            const token = await getGitHubToken();
            if (token) {
                const ghData = await fetchGithubUsers(token);
                await uploadToGithub(Array.from(bot_users), token, ghData ? ghData.sha : null);
            }
        }
    }
}

// =====================================
// ⚙️ Helper Functions
// =====================================
let lastCacheRebuild = 0;
const CACHE_REBUILD_INTERVAL = 5000; // 5 seconds minimum

async function rebuildCountryCache() {
    if (!isNumberDBReady) return; 
    const now = Date.now();

    if (now - lastCacheRebuild < CACHE_REBUILD_INTERVAL) return;
    lastCacheRebuild = now;

    try {
        const result = await NumberModel.aggregate([
            {
                $group: {
                    _id: "$country",
                    flag: { $first: "$flag" },
                    total: { $sum: 1 },
                    available: { 
                        $sum: { 
                            $cond: [{ $eq: ["$status", "Available"] }, 1, 0] 
                        } 
                    }
                }
            },
            { $sort: { _id: 1 } }
        ]).allowDiskUse(true);

        country_data_cache = {};
        countryToIndex = {};
        indexToCountry = {};

        let idx = 0;
        result.forEach(r => {
            country_data_cache[r._id] = { 
                flag: r.flag, 
                available: r.available, 
                total: r.total 
            };
            countryToIndex[r._id] = idx;
            indexToCountry[idx] = r._id;
            idx++;
        });

    } catch (e) {
        console.error("Cache rebuild error:", e);
    }
}

function isAdmin(userId) {
    return ADMIN_IDS.map(id => Number(id)).includes(Number(userId));
}

// ── Sub-Admin helpers ─────────────────────────────────────────────────
function mkInlineBtn(label, callbackOrUrl, style = 'primary', isUrl = false) {
    let btn = { style, text: label };
    if (isUrl) btn.url = callbackOrUrl;
    else btn.callback_data = callbackOrUrl;
    for (const [key, val] of Object.entries(_BTN_EM)) {
        if (val.em && label.includes(val.em)) {
            btn.icon_custom_emoji_id = val.id;
            break;
        }
    }
    return btn;
}

async function isSubAdmin(userId) {
    if (isAdmin(userId)) return false;
    try {
        const sa = await SubAdminModel.findOne({ userId: Number(userId) });
        return !!sa;
    } catch(e) { return false; }
}

async function getSubAdminPermissions(userId) {
    try {
        const sa = await SubAdminModel.findOne({ userId: Number(userId) });
        return sa ? sa.allowedButtons : [];
    } catch(e) { return []; }
}

async function hasAdminAccess(userId) {
    if (isAdmin(userId)) return true;
    return await isSubAdmin(userId);
}

function getSubAdminPermKeyboard(selectedKeys = []) {
    const rows = ADMIN_BUTTONS.map(btn => {
        const isSelected = selectedKeys.includes(btn.key);
        return [mkInlineBtn(`${isSelected ? '\u2705' : '\u2611\uFE0F'} ${btn.label}`, `sa_toggle:${btn.key}`, isSelected ? 'success' : 'primary')];
    });
    rows.push([mkInlineBtn('\uD83D\uDCBE Save & Add Admin', 'sa_confirm', 'success')]);
    rows.push([mkInlineBtn('\u274C Cancel', 'sa_cancel', 'danger')]);
    return { inline_keyboard: rows };
}

// ── Number Limit Config ──────────────────────────────────────────────
async function getNumberLimit(countryName) {
    try {
        const doc = await ConfigModel.findOne({ key: `num_limit:${countryName}` });
        if (doc) { const n = parseInt(doc.value); return isNaN(n) || n < 1 ? 2 : n; }
    } catch(e) {}
    return 2; // ডিফল্ট লিমিট ২ — admin চাইলে কমাতে/বাড়াতে পারবে
}

async function sendNumberLimitMenu(chatId, msgId = null) {
    const countries = Object.keys(country_data_cache);
    if (countries.length === 0) {
        const txt = '❌ কোন Country পাওয়া যায়নি। আগে নাম্বার add করুন।';
        const back = { inline_keyboard: [[mkInlineBtn('🔙 Back', 'cfg_back', 'primary')]] };
        if (msgId) await safeEditMessage(chatId, msgId, txt, { reply_markup: back });
        else await bot.sendMessage(chatId, txt, { reply_markup: back });
        return;
    }
    const limits = await Promise.all(countries.map(c => getNumberLimit(c)));
    let text = '🔢 <b>Number Limit per Country</b>\n\n';
    countries.forEach((c, i) => {
        const flag = country_data_cache[c]?.flag || '🌍';
        text += `${flag} <b>${c}</b>: <code>${limits[i]}</code> টি\n`;
    });
    const rows = [];
    for (let i = 0; i < countries.length; i += 2) {
        const row = [];
        const c1 = countries[i];
        const f1 = country_data_cache[c1]?.flag || '🌍';
        row.push(mkInlineBtn(`${f1} ${c1} (${limits[i]})`, `nl_set:${c1}`, 'primary'));
        if (countries[i+1]) {
            const c2 = countries[i+1];
            const f2 = country_data_cache[c2]?.flag || '🌍';
            row.push(mkInlineBtn(`${f2} ${c2} (${limits[i+1]})`, `nl_set:${c2}`, 'primary'));
        }
        rows.push(row);
    }
    rows.push([mkInlineBtn('🔙 Back', 'cfg_back', 'primary')]);
    const opt = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
    if (msgId) await safeEditMessage(chatId, msgId, text, opt);
    else await bot.sendMessage(chatId, text, opt);
}
// ─────────────────────────────────────────────────────────────────────

// ── Price Update: Sector selection menu (Config থেকে) ────────────────
async function sendPriceSectorMenu(chatId, msgId = null) {
    const rows = [];
    for (let i = 0; i < SECTORS.length; i += 2) {
        const row = [];
        [SECTORS[i], SECTORS[i + 1]].forEach(s => {
            if (!s) return;
            const btn = { text: s.label, callback_data: `cfg_price_sector:${s.id}`, style: 'primary' };
            if (s.icon_custom_emoji_id) btn.icon_custom_emoji_id = s.icon_custom_emoji_id;
            row.push(btn);
        });
        rows.push(row);
    }
    rows.push([mkInlineBtn('🔙 Back', 'cfg_back', 'primary')]);

    const text = '💵 <b>Price Update</b>\n\nকোন প্ল্যাটফর্মের দেশের price বদলাবেন?';
    const opt = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
    if (msgId) await safeEditMessage(chatId, msgId, text, opt);
    else await bot.sendMessage(chatId, text, opt);
}

// ── Price Update: নির্দিষ্ট সেক্টরের দেশের লিস্ট, প্রতিটার পাশে current price ──
async function sendPriceCountryMenu(chatId, msgId, sectorId) {
    const sectorInfo = SECTORS.find(s => s.id === sectorId);
    const countries = await NumberModel.aggregate([
        { $match: { sector: sectorId } },
        { $group: { _id: '$country', flag: { $first: '$flag' }, price: { $first: '$price' } } },
        { $sort: { _id: 1 } }
    ]);

    if (countries.length === 0) {
        await safeEditMessage(chatId, msgId,
            `❌ ${sectorInfo ? sectorInfo.label : sectorId} এ কোন দেশ পাওয়া যায়নি।`,
            { reply_markup: { inline_keyboard: [[mkInlineBtn('🔙 Back', 'cfg_price_menu', 'primary')]] } }
        );
        return;
    }

    let text = `💵 <b>${sectorInfo ? sectorInfo.label : sectorId} — Price Update</b>\n\nদেশ সিলেক্ট করুন, price দেখতে/বদলাতে:\n`;
    const rows = [];
    for (let i = 0; i < countries.length; i += 2) {
        const row = [];
        const c1 = countries[i];
        const p1 = (c1.price != null && c1.price > 0) ? `$${c1.price}` : 'সেট নেই';
        row.push(mkInlineBtn(`${c1.flag || '🌍'} ${cleanCountryName(c1._id)} (${p1})`, `editprice:${sectorId}:${c1._id}`, 'primary'));

        if (countries[i + 1]) {
            const c2 = countries[i + 1];
            const p2 = (c2.price != null && c2.price > 0) ? `$${c2.price}` : 'সেট নেই';
            row.push(mkInlineBtn(`${c2.flag || '🌍'} ${cleanCountryName(c2._id)} (${p2})`, `editprice:${sectorId}:${c2._id}`, 'primary'));
        }
        rows.push(row);
    }
    rows.push([mkInlineBtn('🔙 Back', 'cfg_price_menu', 'primary')]);

    await safeEditMessage(chatId, msgId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}
// ─────────────────────────────────────────────────────────────────────

// 🚫 OTP Filter মেনু দেখানো
async function showOtpFilterMenu(chatId, msgId = null) {
    const filters = await OtpFilterModel.find({}).sort({ country: 1, service: 1 });

    let text = `🚫 <b>OTP ফিল্টার ম্যানেজার</b>\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📌 নির্দিষ্ট দেশের নির্দিষ্ট সার্ভিসের OTP বট থেকে আড়াল করুন।\n\n`;

    const rows = [];

    if (filters.length === 0) {
        text += `📭 এখনো কোনো ফিল্টার সেট করা হয়নি।\n`;
        text += `নিচের বাটন চেপে নতুন ফিল্টার যোগ করুন।`;
    } else {
        text += `🔴 <b>সক্রিয় ফিল্টার (${filters.length}টি):</b>\n`;
        filters.forEach((f, i) => {
            text += `${i + 1}. 🌍 <b>${f.country}</b> → 📵 <b>${f.service}</b>\n`;
        });
        text += `\nডিলিট করতে নিচের বাটন চাপুন:`;

        // প্রতিটি ফিল্টারের জন্য Delete বাটন
        filters.forEach(f => {
            rows.push([
                mkInlineBtn(`🗑 ${f.country} → ${f.service}`, `cfg_filter_del:${f._id}`, 'danger')
            ]);
        });

        // সব মুছে ফেলার বাটন
        rows.push([mkInlineBtn('🗑️ সব ফিল্টার মুছুন', 'cfg_filter_clear_all', 'danger')]);
    }

    rows.push([mkInlineBtn('➕ নতুন ফিল্টার যোগ করুন', 'cfg_filter_add', 'success')]);
    rows.push([mkInlineBtn('🔙 Back', 'cfg_back', 'primary')]);

    const opt = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
    if (msgId) {
        await safeEditMessage(chatId, msgId, text, opt);
    } else {
        await bot.sendMessage(chatId, text, opt);
    }
}

async function sendSubAdminList(chatId, msgId = null) {
    const subAdmins = await SubAdminModel.find({});
    const fileAdmins = ADMIN_IDS;
    let text = `\uD83D\uDC64 <b>Admin List</b>\n\n`;
    text += `\uD83D\uDCC1 <b>File Admins (\u09B8\u09AC access):</b>\n`;
    fileAdmins.forEach((id, i) => { text += `${i + 1}. <code>${id}</code>\n`; });
    text += `\n\uD83D\uDEE1\uFE0F <b>Sub Admins (Board \u09A5\u09C7\u0995\u09C7 Add):</b>\n`;
    if (subAdmins.length === 0) {
        text += `\u274C \u0995\u09CB\u09A8 Sub Admin \u09A8\u09C7\u0987\u0964\n`;
    } else {
        subAdmins.forEach((sa, i) => {
            const perms = sa.allowedButtons.length > 0
                ? sa.allowedButtons.map(k => ADMIN_BUTTONS.find(b => b.key === k)?.label || k).join(', ')
                : '\u0995\u09CB\u09A8 access \u09A8\u09C7\u0987';
            text += `${i + 1}. <code>${sa.userId}</code>\n   \uD83D\uDCCB Access: ${perms}\n`;
        });
    }
    const markup = {
        inline_keyboard: [
            [mkInlineBtn('👤 Add New Admin', 'sa_add_start', 'success'), mkInlineBtn('🗑️ Delete Admin', 'sa_delete_menu', 'danger')],
            [mkInlineBtn('📊 Stock & Price Status', 'cfg_stock_status', 'success'), mkInlineBtn('💵 Price Update', 'cfg_price_menu', 'primary')],
            [mkInlineBtn('🔢 Number Limit', 'cfg_numlimit', 'primary'), mkInlineBtn('🔗 Select Method', 'cfg_method_start', 'success')],
            [mkInlineBtn('📜 Method List', 'cfg_method_list', 'primary'), mkInlineBtn('❌ Close', 'sa_close', 'primary')],
            [mkInlineBtn('🛠 Mainten', 'cfg_mainten', 'primary'), mkInlineBtn('🎁 Bonus', 'cfg_bonus', 'success')],
            [mkInlineBtn('🏆 Leaderboard', 'cfg_lb_panel', 'success'), mkInlineBtn('🔄 Backup Sync', 'cfg_backup_sync', 'primary')],
            [mkInlineBtn('🚫 OTP Filter', 'cfg_filter_menu', 'danger')],
        ]
    };
    if (msgId) {
        await safeEditMessage(chatId, msgId, text, { parse_mode: 'HTML', reply_markup: markup });
    } else {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: markup });
    }
}

async function sendSubAdminDeleteMenu(chatId, msgId) {
    const subAdmins = await SubAdminModel.find({});
    if (subAdmins.length === 0) {
        await safeEditMessage(chatId, msgId, '\u274C \u0995\u09CB\u09A8 Sub Admin \u09A8\u09C7\u0987 \u09AF\u09BE\u0995\u09C7 delete \u0995\u09B0\u09AC\u09C7\u09A8\u0964', {
            reply_markup: { inline_keyboard: [[mkInlineBtn('\uD83D\uDD19 Back', 'sa_list_back', 'primary')]] }
        });
        return;
    }
    const rows = subAdmins.map(sa => [
        mkInlineBtn(`\uD83D\uDDD1\uFE0F Remove: ${sa.userId}`, `sa_remove:${sa.userId}`, 'danger')
    ]);
    rows.push([mkInlineBtn('\uD83D\uDD19 Back', 'sa_list_back', 'primary')]);
    await safeEditMessage(chatId, msgId, '\uD83D\uDDD1\uFE0F <b>\u0995\u09CB\u09A8 Sub Admin \u0995\u09C7 Remove \u0995\u09B0\u09AC\u09C7\u09A8?</b>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: rows }
    });
}
// ─────────────────────────────────────────────────────────────────────

// যেসব চ্যানেল/গ্রুপে ইউজার এখনো জয়েন করেনি, শুধু সেগুলোর লিস্ট রিটার্ন করে
async function getUnjoinedChannels(userId) {
    const validStatuses = ['member', 'administrator', 'creator'];

    const checkPromises = REQUIRED_CHANNELS.map(channel =>
        bot.getChatMember(channel.id, userId)
            .then(member => (validStatuses.includes(member.status) ? null : channel))
            .catch(() => channel) // চেক করতে না পারলে ধরে নেওয়া হবে জয়েন করেনি
    );

    const results = await Promise.all(checkPromises);
    return results.filter(Boolean);
}

async function isUserMember(userId) {
    if (isAdmin(userId)) return true;

    const unjoined = await getUnjoinedChannels(userId);
    return unjoined.length === 0;
}

// HTML special chars + bold unicode থেকে safe করো (Telegram parse error এড়াতে)
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// /start এর স্টাইলে সুন্দর ওয়েলকাম মেসেজ বানানোর জন্য রিইউজেবল ফাংশন
function buildWelcomeText(userId, from) {
    const firstName = escapeHtml((from && from.first_name) || '');
    const lastName  = escapeHtml((from && from.last_name)  || '');
    const fullName  = (firstName + ' ' + lastName).trim() || 'User';
    const userMention = `<a href="tg://user?id=${userId}">${fullName}</a>`;

    return E(
        `🖤 <b>Welcome to ${bot_name}</b> 🖤\n` +
            `ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ᴛʜᴇ ᴏꜰꜰɪᴄɪᴀʟ ʙᴏᴛ ᴏꜰ\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 <b>Name:</b> ${userMention}\n` +
            `🆔 <b>ID:</b> <code>${userId}</code>\n` +
            `━━━━━━━━━━━━━━━━━━━━`
    );
}

function getAvailableCountriesData() {
    const countryData = {};
    for (const [country, data] of Object.entries(country_data_cache)) {
        if (data.available > 0) countryData[country] = { flag: data.flag, count: data.available };
    }
    return countryData;
}

function getAllCountryList() {
    const countryData = {};
    for (const [country, data] of Object.entries(country_data_cache)) {
        countryData[country] = { flag: data.flag, count: data.total };
    }
    return countryData;
}

function isUserAllowedAction(userId) {
    if (isAdmin(userId)) return { allowed: true, remaining: 0 };
    const currentTime = Date.now() / 1000;
    if (last_action_time[userId] && (currentTime - last_action_time[userId]) < COOLDOWN_TIME) {
        const remaining = (COOLDOWN_TIME - (currentTime - last_action_time[userId])).toFixed(1);
        return { allowed: false, remaining: remaining };
    }
    last_action_time[userId] = currentTime;
    return { allowed: true, remaining: 0 };
}

// =====================================
// 📱 SECTOR KEYBOARDS
// =====================================
// অ্যাডমিনদের জন্য মাল্টি-সেক্টর সিলেকশন কিবোর্ড (প্রতি লাইনে ২টা)
// ── Sector selection মেসেজ text build করার helper ──────────────────────
function buildSectorSelectionText(buf) {
    const buf2 = buf || {};
    const pFlag = getPremiumFlag(buf2.country || '', buf2.flag || '🌍');
    const numCount = buf2.numbers ? buf2.numbers.length : '?';
    const priceStr = (buf2.price != null) ? `$${buf2.price}` : 'নেই';
    const noLimitLine = buf2.no_limit ? '\n♾️ <b>No Limit:</b> চালু' : '';
    const timeLine = buf2.schedule_time ? `\n⏰ <b>Schedule:</b> ${buf2.schedule_time}` : '';
    return `${pFlag} <b>${buf2.country || ''}</b> — ${numCount} নাম্বার\n💵 Price: ${priceStr}${noLimitLine}${timeLine}\n\n📱 সেক্টর সিলেক্ট করুন এবং অপশন বেছে নিন:`;
}

function getSectorSelectionKeyboard(selectedSectors = [], opts = {}) {
    // opts: { noLimit: bool, scheduleTime: string|null }
    const noLimit      = opts.noLimit      || false;
    const scheduleTime = opts.scheduleTime || null;

    const rows = [];
    for (let i = 0; i < SECTORS.length; i += 2) {
        const row = [];
        [SECTORS[i], SECTORS[i + 1]].forEach(s => {
            if (!s) return;
            const isSelected = selectedSectors.includes(s.id);
            const btn = {
                text: `${isSelected ? '✅' : '⬜'} ${s.label}`,
                callback_data: `toggle_sector:${s.id}`,
                style: isSelected ? 'success' : 'primary'
            };
            if (s.icon_custom_emoji_id) btn.icon_custom_emoji_id = s.icon_custom_emoji_id;
            row.push(btn);
        });
        rows.push(row);
    }

    // ── Options row: NO LIMIT toggle + SET TIME toggle ──────────────────
    rows.push([
        {
            text: noLimit ? '✅ ♾️ NO LIMIT' : '⬜ ♾️ NO LIMIT',
            callback_data: 'toggle_no_limit',
            style: noLimit ? 'success' : 'primary'
        },
        {
            text: scheduleTime ? `✅ ⏰ ${scheduleTime}` : '⬜ ⏰ SET TIME',
            callback_data: 'toggle_set_time',
            style: scheduleTime ? 'success' : 'primary'
        }
    ]);

    // ── Confirm button label shows what will happen ──────────────────────
    let confirmLabel = 'CONFIRM & ADD';
    if (noLimit && scheduleTime) confirmLabel = '⏰♾️ SCHEDULE + NO LIMIT';
    else if (noLimit)            confirmLabel = '♾️ NO LIMIT ADD';
    else if (scheduleTime)       confirmLabel = `⏰ SCHEDULE (${scheduleTime})`;

    rows.push([
        { text: confirmLabel, callback_data: 'confirm_sector_add', icon_custom_emoji_id: _BTN_EM.pay_pending.id, style: 'success' }
    ]);
    rows.push([{ text: "Cancel", callback_data: 'cancel_add', icon_custom_emoji_id: _BTN_EM.reject.id, style: 'danger' }]);

    return { inline_keyboard: rows };
}

// ইউজারদের জন্য সেক্টর সিলেকশন কিবোর্ড (বড় বাটন স্টাইল)
async function getGetNumberSectorKeyboard() {
    const buttons = [];
    // শুধুমাত্র সেই সেক্টরগুলো ফিল্টার করা হয়েছে যেগুলো এডমিন অফ করেনি
    const activeSectors = SECTORS.filter(s => !disabledSectors.includes(s.id));

    // প্রতিটি সেক্টরে প্রতিটি দেশে available নাম্বার কাউন্ট
    const sectorCounts = await NumberModel.aggregate([
        { $match: { status: 'Available', sector: { $in: activeSectors.map(s => s.id) } } },
        { $group: { _id: { sector: '$sector', country: '$country' }, total: { $sum: 1 } } }
    ]);
    // sector → দেশের set (disabled বাদে যেগুলো আছে)
    const sectorVisibleCountryMap = {};
    sectorCounts.forEach(sc => {
        const sec = sc._id.sector;
        const country = sc._id.country;
        // per-sector বা global disable চেক
        if (!isCountryDisabled(country, sec)) {
            if (!sectorVisibleCountryMap[sec]) sectorVisibleCountryMap[sec] = 0;
            sectorVisibleCountryMap[sec] += sc.total;
        }
    });

    // নাম্বার নেই বা সব দেশ disabled এমন sector hide করা হচ্ছে
    const visibleSectors = activeSectors.filter(s => (sectorVisibleCountryMap[s.id] || 0) > 0);

    for (let i = 0; i < visibleSectors.length; i += 2) {
        const row = [];
        const s1 = visibleSectors[i];
        const btn1 = { text: `${s1.label}`, callback_data: `sector_pick:${s1.id}`, style: 'success' };
        if (s1.icon_custom_emoji_id) btn1.icon_custom_emoji_id = s1.icon_custom_emoji_id;
        row.push(btn1);

        const s2 = visibleSectors[i + 1];
        if (s2) {
            const btn2 = { text: `${s2.label}`, callback_data: `sector_pick:${s2.id}`, style: 'success' };
            if (s2.icon_custom_emoji_id) btn2.icon_custom_emoji_id = s2.icon_custom_emoji_id;
            row.push(btn2);
        }
        buttons.push(row);
    }
    return { inline_keyboard: buttons };
}

// ডিলিট মেনুর কিবোর্ড — যেসব প্ল্যাটফর্মে নাম্বার নেই সেগুলো হাইড, প্রতি লাইনে ২টা
async function getDeleteSectorKeyboard() {
    // কোন সেক্টরে কতটা নাম্বার আছে সেটা একবারেই চেক করা
    const counts = await NumberModel.aggregate([
        { $group: { _id: '$sector', total: { $sum: 1 } } }
    ]);
    const countMap = {};
    counts.forEach(c => { countMap[c._id] = c.total; });

    // নাম্বার আছে এমন সেক্টর ফিল্টার
    const visibleSectors = SECTORS.filter(s => (countMap[s.id] || 0) > 0);

    const rows = [];
    for (let i = 0; i < visibleSectors.length; i += 2) {
        const row = [];
        [visibleSectors[i], visibleSectors[i + 1]].forEach(s => {
            if (!s) return;
            const btn = { text: `🗑 ${s.label}`, callback_data: `del_sector:${s.id}`, style: 'danger' };
            if (s.icon_custom_emoji_id) btn.icon_custom_emoji_id = s.icon_custom_emoji_id;
            row.push(btn);
        });
        rows.push(row);
    }

    rows.push([{ text: "দেশ অনুযায়ী Delete", callback_data: 'del_by_country', icon_custom_emoji_id: _BTN_EM.del_country.id, style: 'danger' }]);
    rows.push([{ text: "Back to Admin Menu", callback_data: 'cancel_delete', icon_custom_emoji_id: _BTN_EM.back_admin.id, style: 'primary' }]);

    return { inline_keyboard: rows };
}


function getMainMenuKeyboard(userId, inSession = false) {
    if (inSession) return { keyboard: [[{ text: "Stop", icon_custom_emoji_id: _BTN_EM.reject.id, style: 'danger' }]], resize_keyboard: true };
    const keyboard = [
        [
            { text: "𝐆𝐞𝐭 𝐍𝐮𝐦𝐛𝐞𝐫", icon_custom_emoji_id: _BTN_EM.get_number.id, style: 'success' }, 
            { text: "𝐀𝐯𝐚𝐢𝐥𝐚𝐛𝐥𝐞 𝐒𝐞𝐫𝐯𝐢𝐜𝐞", icon_custom_emoji_id: _BTN_EM.avail_country.id, style: 'primary' }
        ],
        [

        ],
        [
            { text: "𝐑𝐞𝐟𝐞𝐫 𝐅𝐫𝐢𝐞𝐧𝐝", icon_custom_emoji_id: _BTN_EM.refer.id, style: 'danger' },
            { text: "𝐌𝐲 𝐖𝐚𝐥𝐥𝐞𝐭", icon_custom_emoji_id: _BTN_EM.wallet.id, style: 'success' }
        ]
    ];
    if (isLeaderboardEnabled) {
        keyboard.push([{ text: "𝐋𝐞𝐚𝐝𝐞𝐫𝐛𝐨𝐚𝐫𝐝", icon_custom_emoji_id: _BTN_EM.leaderboard.id, style: 'primary' }, { text: "𝐒𝐮𝐩𝐩𝐨𝐫𝐭", icon_custom_emoji_id: _BTN_EM.support.id, style: 'danger' }]);
    } else {
        keyboard.push([{ text: "𝐒𝐮𝐩𝐩𝐨𝐫𝐭", icon_custom_emoji_id: _BTN_EM.support.id, style: 'danger' }]);
    }

    if (isAdmin(userId)) keyboard.push([{ text: "Admin Menu", icon_custom_emoji_id: _BTN_EM.admin_menu.id, style: 'danger' }]);
    return { keyboard: keyboard, resize_keyboard: true };
}




// ── Pay Method Panel Keyboard ───────────────────────────────────────
function getPayMethodKeyboard() {
    const rows = [];
    // ── Static methods (built-in) ──
    for (const m of WALLET_METHODS) {
        const isOff = disabledPayMethods.includes(m.key);
        const cleanLabel = m.label.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]\uFE0F?/gu, '').replace(/\s+/g, ' ').trim();
        rows.push([
            {
                text: `${isOff ? '🔴 OFF' : '🟢 ON'} — ${cleanLabel}`,
                callback_data: `toggle_paymethod:${m.key}`,
                icon_custom_emoji_id: m.eid,
                style: isOff ? 'danger' : 'success'
            },
            {
                text: m.guidePhoto ? '📸✅' : '📸',
                callback_data: `set_guide_photo:${m.key}`,
                style: 'primary'
            }
        ]);
    }

    // ── Dynamic methods (admin-added) — edit/delete বাটনসহ ──
    if (dynamicPayMethods.length > 0) {
        rows.push([{ text: '── Custom Methods ──', callback_data: 'ignore', style: 'primary' }]);
        for (const dm of dynamicPayMethods) {
            const isOff = disabledPayMethods.includes(dm.id) || !dm.enabled;
            const typeLabel = dm.type === 'USDT_BEP20' ? '🔶BEP20' : '✋MANUAL';
            const methodBtn = {
                text: `${isOff ? '🔴' : '🟢'} ${dm.label} [${typeLabel}]`,
                callback_data: `toggle_dynpaymethod:${dm.id}`,
                style: isOff ? 'danger' : 'success'
            };
            if (dm.icon_custom_emoji_id) methodBtn.icon_custom_emoji_id = dm.icon_custom_emoji_id;
            rows.push([
                methodBtn,
                { text: dm.guidePhoto ? '📸✅' : '📸', callback_data: `set_guide_photo:${dm.id}`, style: 'primary' },
                { text: '✏️', callback_data: `edit_dynpaymethod:${dm.id}`, style: 'primary' },
                { text: '🗑', callback_data: `del_dynpaymethod:${dm.id}`, icon_custom_emoji_id: _BTN_EM.delete.id, style: 'danger' }
            ]);
        }
    }

    // ── Add Pay Method button ──
    rows.push([{
        text: '➕ Add Pay Method',
        callback_data: 'add_dynpaymethod',
        icon_custom_emoji_id: _BTN_EM.add.id,
        style: 'success'
    }]);

    rows.push([{
        text: isWithdrawDisabled ? '🔴 Withdraw: OFF — Turn ON' : '🟢 Withdraw: ON — Turn OFF',
        callback_data: 'toggle_withdraw',
        style: isWithdrawDisabled ? 'success' : 'danger'
    }]);
    rows.push([{
        text: `💲 Min Limit: $${minWithdrawLimit.toFixed(2)} — Change`,
        callback_data: 'change_min_withdraw',
        style: 'primary'
    }]);
    rows.push([{ text: '🔙 Back', callback_data: 'back_admin_menu', icon_custom_emoji_id: _BTN_EM.back_admin.id, style: 'primary' }]);
    return { inline_keyboard: rows };
}

function getAdminMenuKeyboard(inSession = false) {
    if (inSession) return { keyboard: [[{ text: "Stop", icon_custom_emoji_id: _BTN_EM.reject.id, style: 'danger' }]], resize_keyboard: true };
    return {
        keyboard: [
            [
                { text: "ADD", icon_custom_emoji_id: _BTN_EM.add.id, style: 'success' },
                { text: "Broadcast", icon_custom_emoji_id: _BTN_EM.broadcast.id, style: 'primary' }
            ],
            [
                { text: "Delete", icon_custom_emoji_id: _BTN_EM.delete.id, style: 'danger' },
                { text: "Platform", icon_custom_emoji_id: _BTN_EM.platform.id, style: 'primary' }
            ],
            [
                { text: "Pay Pending", icon_custom_emoji_id: _BTN_EM.pay_pending.id, style: 'primary' },
                { text: "Restart", icon_custom_emoji_id: _BTN_EM.restart.id, style: 'danger' }
            ],
            [
                { text: "Pay Method", icon_custom_emoji_id: _BTN_EM.pay_method.id, style: 'primary' },
                { text: "Config", icon_custom_emoji_id: _BTN_EM.platform.id, style: 'primary' }
            ],
            [
                { text: "Bot Status", icon_custom_emoji_id: _BTN_EM.status.id, style: 'primary' },
                { text: "Find User", icon_custom_emoji_id: _BTN_EM.admin_menu.id, style: 'primary' }
            ],
            [{ text: "Num Info", icon_custom_emoji_id: _BTN_EM.pay_pending.id, style: 'primary' }],
            [{ text: "Main Menu", icon_custom_emoji_id: _BTN_EM.main_menu.id, style: 'success' }]
        ],
        resize_keyboard: true
    };
}

async function getNumberControlKeyboard(number = "", extraNumbers = [], countryName = "", userId = null, forToggle = false) {
    // number = primary number (string)
    // extraNumbers = additional numbers array (strings), for multi-limit
    // forToggle = true হলে copy_text বাদ (editMessageReplyMarkup-এর জন্য)
    const rows = [];
    // দেশের flag emoji_id বের করা
    const flagEntry = findEmojiEntry(countryName);
    const flagEmojiId = flagEntry ? (flagEntry.p1 || flagEntry.p2 || null) : null;

    // Remove CC সেটিং চেক
    const removeCCOn = userId ? await isRemoveCCOn(userId) : false;

    const allNums = [number, ...extraNumbers].filter(Boolean);
    allNums.forEach((n, idx) => {
        const displayNum = removeCCOn ? stripCountryCode(n) : n;
        const btn = forToggle
            ? { text: displayNum, callback_data: 'ignore', style: 'success' }
            : { text: displayNum, copy_text: { text: displayNum }, style: 'success' };
        if (flagEmojiId) btn.icon_custom_emoji_id = flagEmojiId;
        rows.push([btn]);
    });
    // View OTP — একটাই বাটন (সব নাম্বারের OTP একই গ্রুপে আসে), পাশে Method (যদি সেট করা থাকে)
    const otpRow = [{ text: "𝐕𝐢𝐞𝐰 𝐎𝐓𝐏", url: OTP_GROUP_URL, icon_custom_emoji_id: _BTN_EM.view_otp.id, style: 'danger' }];
    const methodEntry = await getCountryMethod(countryName);
    if (methodEntry) {
        otpRow.push(buildMethodButton(methodEntry, countryName));
    }
    rows.push(otpRow);
    // Remove CC toggle বাটন — নামের পাশে country code দেখাব
    // primary number থেকে CC বের করা (+880XXXXXXX → +880)
    let _ccDisplay = '';
    try {
        const _pn = parsePhoneNumber(number.startsWith('+') ? number : '+' + number);
        if (_pn && _pn.countryCallingCode) _ccDisplay = ' | +' + _pn.countryCallingCode;
    } catch(e) {}
    const removeCCLabel = (removeCCOn ? '𝐀𝐝𝐝 𝐂𝐂' : '𝗥𝗲𝗺𝗼𝘃𝗲 𝗖𝗖') + _ccDisplay;
    const removeCCStyle = removeCCOn ? 'success' : 'danger';
    const removeCCBtn = {
        text: removeCCLabel,
        callback_data: `toggle_remove_cc:normal:${countryName}`,
        style: removeCCStyle,
        icon_custom_emoji_id: removeCCOn ? _BTN_EM.verifycc.id : _BTN_EM.removecc.id
    };
    rows.push([removeCCBtn]);
    rows.push([
        { text: "Change Number", callback_data: `change_number_req`, icon_custom_emoji_id: _BTN_EM.change_number.id, style: 'success' },
        { text: "Change Country", callback_data: 'change_country_start', icon_custom_emoji_id: _BTN_EM.change_country.id, style: 'success' }
    ]);
    return { inline_keyboard: rows };
}

async function getSectorNumberControlKeyboard(sectorId, number = "", extraNumbers = [], countryName = "", userId = null, forToggle = false) {
    // forToggle = true হলে copy_text বাদ (editMessageReplyMarkup-এর জন্য)
    const sectorInfo = SECTORS.find(s => s.id === sectorId) || SECTORS[0];
    const rows = [];

    // দেশের flag emoji_id বের করা
    const flagEntry = findEmojiEntry(countryName);
    const flagEmojiId = flagEntry ? (flagEntry.p1 || flagEntry.p2 || null) : null;

    // Remove CC সেটিং চেক
    const removeCCOn = userId ? await isRemoveCCOn(userId) : false;

    const allNums = [number, ...extraNumbers].filter(Boolean);
    // নাম্বার বাটনে alternating ইমোজি: জোড় index → সার্ভিস ইমোজি, বিজোড় index → পতাকা ইমোজি
    allNums.forEach((n, idx) => {
        const displayNum = removeCCOn ? stripCountryCode(n) : n;
        const btn = forToggle
            ? { text: displayNum, callback_data: 'ignore', style: sectorInfo.style || 'success' }
            : { text: displayNum, copy_text: { text: displayNum }, style: sectorInfo.style || 'success' };
        const useServiceEmoji = idx % 2 === 0; // 0, 2, 4 → সার্ভিস; 1, 3, 5 → পতাকা
        if (useServiceEmoji && sectorInfo.icon_custom_emoji_id) {
            btn.icon_custom_emoji_id = sectorInfo.icon_custom_emoji_id;
        } else if (!useServiceEmoji && flagEmojiId) {
            btn.icon_custom_emoji_id = flagEmojiId;
        } else if (sectorInfo.icon_custom_emoji_id) {
            btn.icon_custom_emoji_id = sectorInfo.icon_custom_emoji_id;
        }
        rows.push([btn]);
    });
    const otpRow = [{ text: "𝐕𝐢𝐞𝐰 𝐎𝐓𝐏", url: OTP_GROUP_URL, icon_custom_emoji_id: _BTN_EM.view_otp.id, style: 'primary' }];
    const methodEntry = await getCountryMethod(countryName);
    if (methodEntry) {
        otpRow.push(buildMethodButton(methodEntry, countryName));
    }
    rows.push(otpRow);
    // Remove CC toggle বাটন — নামের পাশে country code দেখাব
    let _ccDisplay2 = '';
    try {
        const _pn2 = parsePhoneNumber(number.startsWith('+') ? number : '+' + number);
        if (_pn2 && _pn2.countryCallingCode) _ccDisplay2 = ' | +' + _pn2.countryCallingCode;
    } catch(e) {}
    const removeCCLabel2 = (removeCCOn ? '𝐀𝐝𝐝 𝐂𝐂' : '𝗥𝗲𝗺𝗼𝘃𝗲 𝗖𝗖') + _ccDisplay2;
    const removeCCStyle2 = removeCCOn ? 'success' : 'danger';
    const removeCCBtn2 = {
        text: removeCCLabel2,
        callback_data: `toggle_remove_cc:sector:${sectorId}:${countryName}`,
        style: removeCCStyle2,
        icon_custom_emoji_id: removeCCOn ? _BTN_EM.verifycc.id : _BTN_EM.removecc.id
    };
    rows.push([removeCCBtn2]);
    rows.push([
        { text: "Change", callback_data: `change_sector_num:${sectorId}`, icon_custom_emoji_id: _BTN_EM.change_number.id, style: 'success' },
        { text: "Back", callback_data: 'back_to_sector_menu', icon_custom_emoji_id: _BTN_EM.platform.id, style: 'success' }
    ]);
    return { inline_keyboard: rows };
}

async function getDeleteCountryKeyboard() {
    const allCountries = getAllCountryList();
    const buttons = [];
    const keys = Object.keys(allCountries).filter(country => {
        return country_data_cache[country] && country_data_cache[country].available > 0;
    }).sort();

    // no_limit batch আছে কোন কোন country-তে
    const noLimitCountries = new Set();
    try {
        const batches = await NoLimitBatch.find({}, { country: 1 }).lean();
        batches.forEach(b => noLimitCountries.add(b.country));
    } catch(e) {}

    for (let i = 0; i < keys.length; i += 2) {
        const row = [];
        const country1 = keys[i];
        const nlTag1 = noLimitCountries.has(country1) ? ' ♾️' : '';
        row.push(makeCountryButton(country1, allCountries[country1].flag, ` (${country_data_cache[country1].available})${nlTag1}`, `sdc:${countryToIndex[country1]}`, ADMIN_IDS[0]));

        if (i + 1 < keys.length) {
            const country2 = keys[i + 1];
            const nlTag2 = noLimitCountries.has(country2) ? ' ♾️' : '';
            row.push(makeCountryButton(country2, allCountries[country2].flag, ` (${country_data_cache[country2].available})${nlTag2}`, `sdc:${countryToIndex[country2]}`, ADMIN_IDS[0]));
        }
        buttons.push(row);
    }
    buttons.push([{ text: "Cancel", callback_data: 'cancel_delete', icon_custom_emoji_id: _BTN_EM.reject.id, style: 'danger' }]);
    return { inline_keyboard: buttons };
}
function getVerificationMarkup(channels) {
    const list = channels || REQUIRED_CHANNELS;
    const buttons = list.map((ch, i) => [{ text: `Join Channel ${i + 1}`, url: ch.url, style: 'primary' }]);
    buttons.push([{ text: "Verify", callback_data: 'verify_check', icon_custom_emoji_id: _BTN_EM.verify.id, style: 'primary' }]);
    return { inline_keyboard: buttons };
}


async function sendVerificationPrompt(userId, messageId = null) {
    const unjoined = await getUnjoinedChannels(userId);
    const text = `⚠️ Access Denied!\nPlease join our channels to use the bot.`;
    const markup = getVerificationMarkup(unjoined);
    if (messageId) {
        try { await safeEditMessage(userId, messageId, text, { parse_mode: 'Markdown', reply_markup: markup }); } catch {}
    } else {
        try {
            await bot.sendMessage(userId, text, { parse_mode: 'Markdown', reply_markup: markup });
        } catch (e) {}
    }
}

// ── Num Info: Pending Scheduled Adds দেখা ─────────────────────────────
async function sendNumInfoPanel(chatId, msgId = null) {
    const entries = Object.entries(scheduled_add_timers);
    let text = `📋 <b>Num Info — Pending Schedule</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n`;
    const rows = [];

    if (entries.length === 0) {
        text += `\n✅ কোনো Pending Scheduled Add নেই।`;
    } else {
        text += `\n⏳ <b>Pending Adds (${entries.length} টি):</b>\n\n`;
        entries.forEach(([uid, info], i) => {
            text += `${i + 1}. 👤 UID: <code>${uid}</code>\n` +
                    `   ⏰ সময়: <b>${info.timeLabel}</b>\n` +
                    `   🌍 দেশ: <b>${info.countryName}</b>\n` +
                    `   📊 নাম্বার: <b>${info.totalNums} টি</b>\n\n`;
            rows.push([{
                text: `🗑️ Delete: ${info.countryName} (${info.timeLabel})`,
                callback_data: `ni_del:${uid}`,
                style: 'danger'
            }]);
        });
    }

    rows.push([{ text: '🔙 Back', callback_data: 'ni_back', icon_custom_emoji_id: _BTN_EM.back_admin.id, style: 'primary' }]);
    const opt = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };
    if (msgId) await safeEditMessage(chatId, msgId, text, opt);
    else await bot.sendMessage(chatId, text, opt);
}

// ── All Number: Platform list (Delete style) ───────────────────────────
async function getAllNumberSectorKeyboard() {
    const counts = await NumberModel.aggregate([
        { $group: { _id: '$sector', total: { $sum: 1 } } }
    ]);
    const countMap = {};
    counts.forEach(c => { countMap[c._id] = c.total; });

    const visibleSectors = SECTORS.filter(s => (countMap[s.id] || 0) > 0);
    const rows = [];
    for (let i = 0; i < visibleSectors.length; i += 2) {
        const row = [];
        [visibleSectors[i], visibleSectors[i + 1]].forEach(s => {
            if (!s) return;
            const btn = { text: `📱 ${s.label}`, callback_data: `an_sector:${s.id}`, style: 'primary' };
            if (s.icon_custom_emoji_id) btn.icon_custom_emoji_id = s.icon_custom_emoji_id;
            row.push(btn);
        });
        rows.push(row);
    }
    // All Country OFF বাটন
    rows.push([{ text: '🌍 All Country OFF/ON', callback_data: 'an_all_country', style: 'danger' }]);
    rows.push([{ text: '🔙 Back', callback_data: 'an_back_main', icon_custom_emoji_id: _BTN_EM.back_admin.id, style: 'primary' }]);
    return { inline_keyboard: rows };
}

// একটা প্ল্যাটফর্মের ভেতরের দেশের অন/অফ লিস্ট
async function getAllNumberCountryInSectorKeyboard(sectorId) {
    const countriesInSector = await NumberModel.aggregate([
        { $match: { sector: sectorId } },
        { $group: { _id: '$country', flag: { $first: '$flag' }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
    ]);

    const rows = countriesInSector.map(c => {
        // per-sector বা global disable চেক — উভয়ই দেখাবে
        const isOffSector = (disabledCountriesBySector[sectorId] || []).includes(c._id);
        const isOffGlobal = disabledCountriesGlobal.includes(c._id);
        const isOff = isOffSector || isOffGlobal;
        const offLabel = isOffGlobal ? '🔴(ALL)' : (isOffSector ? '🔴' : '🟢');
        return [{
            text: `${offLabel} ${c.flag || '🌍'} ${c._id} (${c.count})`,
            callback_data: `an_tog:${sectorId}:${c._id}`,
            style: isOff ? 'danger' : 'success'
        }];
    });

    // সব দেশ OFF / ON for this sector
    const totalCountries = countriesInSector.map(c => c._id);
    rows.push([
        { text: '🔴 সব OFF', callback_data: `an_sec_all_off:${sectorId}`, style: 'danger' },
        { text: '🟢 সব ON', callback_data: `an_sec_all_on:${sectorId}`, style: 'success' }
    ]);
    rows.push([{ text: '🔙 Back', callback_data: 'an_back', icon_custom_emoji_id: _BTN_EM.back_admin.id, style: 'primary' }]);
    return { inline_keyboard: rows };
}

// All Country (সব প্ল্যাটফর্মের সব দেশ একসাথে) অন/অফ
async function getAllCountryToggleKeyboard() {
    const allCountriesInDB = await NumberModel.aggregate([
        { $group: { _id: '$country', flag: { $first: '$flag' }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
    ]);

    const rows = [];
    for (let i = 0; i < allCountriesInDB.length; i += 2) {
        const row = [];
        [allCountriesInDB[i], allCountriesInDB[i + 1]].forEach(c => {
            if (!c) return;
            const isOff = disabledCountriesGlobal.includes(c._id);
            row.push({
                text: `${isOff ? '🔴' : '🟢'} ${c.flag || '🌍'} ${c._id}`,
                callback_data: `an_tog_global:${c._id}`,
                style: isOff ? 'danger' : 'success'
            });
        });
        rows.push(row);
    }
    rows.push([
        { text: '🔴 সব দেশ OFF', callback_data: 'an_global_all_off', style: 'danger' },
        { text: '🟢 সব দেশ ON', callback_data: 'an_global_all_on', style: 'success' }
    ]);
    rows.push([{ text: '🔙 Back', callback_data: 'an_back', icon_custom_emoji_id: _BTN_EM.back_admin.id, style: 'primary' }]);
    return { inline_keyboard: rows };
}

function getManageSectorsKeyboard() {
    const rows = [];
    SECTORS.forEach(s => {
        const isOff = disabledSectors.includes(s.id);
        // Row 1: Status label + Toggle ON/OFF
        rows.push([
            { text: `${isOff ? '🔴' : '🟢'} ${s.label}`, callback_data: 'ignore', style: isOff ? 'danger' : 'success' },
            { text: isOff ? 'Turn ON' : 'Turn OFF', callback_data: `toggle_status:${s.id}`, style: isOff ? 'success' : 'danger' }
        ]);
        // Row 2: Edit + Delete buttons for this platform
        rows.push([
            { text: `✏️ Edit`, callback_data: `edit_platform:${s.id}`, style: 'primary' },
            { text: `🗑️ Delete`, callback_data: `delete_platform:${s.id}`, style: 'danger' }
        ]);
    });
    rows.push([{ text: "➕ Add Platform", callback_data: 'add_platform_start', icon_custom_emoji_id: _BTN_EM.add.id, style: 'success' }]);
    rows.push([{ text: "Back", callback_data: 'back_to_admin', icon_custom_emoji_id: _BTN_EM.back.id, style: 'primary' }]);
    return { inline_keyboard: rows };
}

function getMaintenanceKeyboard() {
    return {
        inline_keyboard: [
            [{ text: `Status: ${isMaintenanceMode ? "ON" : "OFF"}`, callback_data: 'ignore', style: isMaintenanceMode ? 'danger' : 'success' }],
            [{ text: isMaintenanceMode ? "Turn OFF" : "Turn ON", callback_data: 'toggle_maint', style: isMaintenanceMode ? 'success' : 'danger' }],
            [{ text: "Back", callback_data: 'back_to_admin', icon_custom_emoji_id: _BTN_EM.back.id, style: 'primary' }]
        ]
    };
}

// ===============================================
// 📩 COMMAND HANDLER
// ===============================================
bot.on('message', async (msg) => {
    if (!msg.from) return;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    addUserToLocalDb(userId, msg.from);

    if (!isAdmin(userId)) {
        if (!(await isUserMember(userId))) {
            sendVerificationPrompt(userId);
            return;
        }
    }

    if (user_states[userId]) {
        if (text === '🛑 Stop' || text === 'stop' || text === 'Stop') {
            delete user_states[userId];
            delete admin_file_buffer[userId];
            bot.sendMessage(chatId, "Action cancelled.", { reply_markup: isAdmin(userId) ? getAdminMenuKeyboard() : getMainMenuKeyboard(userId) });
            return;
        }



        // GUIDE PHOTO UPLOAD (admin sets guide photo for a wallet method)
        if (typeof user_states[userId] === 'string' && user_states[userId].startsWith('AWAITING_GUIDE_PHOTO:') && isAdmin(userId)) {
            const targetKey = user_states[userId].replace('AWAITING_GUIDE_PHOTO:', '');
            const photo = msg.photo;
            // Handle skip
            if (text && text.toLowerCase() === 'skip') {
                delete user_states[userId];
                bot.sendMessage(chatId, `✅ পিকিচার ছাড়াই <b>${targetKey}</b> এড হয়েছে।`, { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() });
                return;
            }
            if (!photo || photo.length === 0) {
                bot.sendMessage(chatId, '📸 একটি পিকিচার পাঠান, অথবা "skip" লিখুন।', { parse_mode: 'HTML' });
                return;
            }
            const fileId = photo[photo.length - 1].file_id;
            if (isUserDBReady) {
                await ConfigModel.findOneAndUpdate(
                    { key: `guide_photo_${targetKey}` },
                    { value: fileId },
                    { upsert: true }
                );
            }
            const wm = WALLET_METHODS.find(m => m.key === targetKey);
            if (wm) wm.guidePhoto = fileId;
            const dm = dynamicPayMethods.find(d => d.id === targetKey);
            if (dm) dm.guidePhoto = fileId;
            delete user_states[userId];
            await bot.sendMessage(chatId, `✅ গাইড পিকিচার সেট <b>${targetKey}</b>!`, { parse_mode: 'HTML' });
            bot.sendMessage(chatId, E(`💳 <b>Pay Method Control</b>\n━━━━━━━━━━━━━━━━━━━━\n🟢 = চালু  🔴 = বন্ধ`), { parse_mode: 'HTML', reply_markup: getPayMethodKeyboard() });
            return;
        }
        // 👤 SUB-ADMIN UID INPUT
        if (user_states[userId] === 'AWAITING_SA_UID' && isAdmin(userId)) {
            const inputUid = parseInt(text.trim());
            if (isNaN(inputUid) || inputUid <= 0) {
                bot.sendMessage(chatId, "❌ সঠিক User ID দিন (শুধু সংখ্যা):");
                return;
            }
            if (ADMIN_IDS.map(Number).includes(inputUid)) {
                bot.sendMessage(chatId, "⚠️ এই User ইতিমধ্যে File Admin। আলাদাভাবে add করার দরকার নেই।", { reply_markup: getAdminMenuKeyboard() });
                delete user_states[userId];
                delete subadmin_add_temp[userId];
                return;
            }
            subadmin_add_temp[userId] = { targetUid: inputUid, selectedKeys: [] };
            user_states[userId] = 'AWAITING_SA_PERMS';
            bot.sendMessage(chatId,
                `✅ User ID: <code>${inputUid}</code>\n\n📋 এখন এই Admin কে কোন কোন বাটনের access দিবেন সিলেক্ট করুন:`,
                { parse_mode: 'HTML', reply_markup: getSubAdminPermKeyboard([]) }
            );
            return;
        }

        // 🔢 NUMBER LIMIT INPUT
        if (user_states[userId] && user_states[userId].startsWith('AWAITING_NL_INPUT:') && isAdmin(userId)) {
            const countryName = user_states[userId].split('AWAITING_NL_INPUT:')[1];
            const val = parseInt(text.trim());
            if (isNaN(val) || val < 1 || val > 20) {
                bot.sendMessage(chatId, '❌ সংখ্যা দিন (১ থেকে ২০ এর মধ্যে):', { reply_markup: getAdminMenuKeyboard(true) });
                return;
            }
            try {
                await ConfigModel.findOneAndUpdate(
                    { key: `num_limit:${countryName}` },
                    { value: String(val) },
                    { upsert: true, returnDocument: 'after' }
                );
                delete user_states[userId];
                const flag = country_data_cache[countryName]?.flag || '🌍';
                bot.sendMessage(chatId,
                    `✅ <b>${flag} ${countryName}</b> এর Number Limit সেট হয়েছে: <code>${val}</code> টি`,
                    { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
                );
            } catch(e) {
                bot.sendMessage(chatId, '❌ DB Error। আবার চেষ্টা করুন।', { reply_markup: getAdminMenuKeyboard() });
            }
            return;
        }

        // 🔗 METHOD: দেশের নাম ইনপুট
        if (user_states[userId] === 'AWAITING_METHOD_COUNTRY' && isAdmin(userId)) {
            if (!text) return;
            const { name: resolvedName, flag: resolvedFlag } = resolveCountryInput(text.trim());
            if (!resolvedName) {
                bot.sendMessage(chatId, '❌ দেশের নাম বুঝতে পারলাম না। আবার লিখুন:', { reply_markup: getAdminMenuKeyboard(true) });
                return;
            }
            admin_file_buffer[userId] = admin_file_buffer[userId] || {};
            admin_file_buffer[userId].method_country = resolvedName;
            admin_file_buffer[userId].method_flag = resolvedFlag;
            user_states[userId] = 'AWAITING_METHOD_LINK';
            bot.sendMessage(chatId,
                `${resolvedFlag} <b>${resolvedName}</b>\n\n🔗 মেথড লিংক দিন:`,
                { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard(true) }
            );
            return;
        }

        // 🚫 OTP FILTER: দেশের নাম ইনপুট
        if (user_states[userId] === 'FILTER_AWAITING_COUNTRY' && isAdmin(userId)) {
            if (!text) return;
            const rawInput = text.trim().toUpperCase();
            // ISO code সরাসরি দিলে (2 অক্ষর) সেটা use করো, নাহলে countryEmoji দিয়ে resolve করো
            let isoCode = null;
            let countryDisplayName = null;
            if (/^[A-Z]{2}$/.test(rawInput)) {
                isoCode = rawInput;
                countryDisplayName = countryEmoji ? (countryEmoji.name(rawInput) || rawInput) : rawInput;
            } else {
                // নামে দিলে resolve করে ISO বের করো
                const { name: rName, flag: rFlag } = resolveCountryInput(text.trim());
                if (rName) {
                    // flag থেকে ISO code বের করো
                    const flagStr = rFlag || '';
                    if (flagStr.length >= 2 && flagStr.codePointAt(0) > 0x1F1E5) {
                        const c1 = String.fromCodePoint(flagStr.codePointAt(0) - 0x1F1E6 + 65);
                        const c2 = String.fromCodePoint(flagStr.codePointAt(2) - 0x1F1E6 + 65);
                        isoCode = c1 + c2;
                    }
                    countryDisplayName = rName;
                    if (!isoCode) isoCode = rawInput.slice(0, 2); // fallback
                }
            }
            if (!isoCode || !countryDisplayName) {
                bot.sendMessage(chatId, '❌ দেশের নাম বুঝতে পারলাম না। ISO কোড দিন (যেমন: BD বা IN):', { reply_markup: getAdminMenuKeyboard(true) });
                return;
            }
            admin_file_buffer[userId] = admin_file_buffer[userId] || {};
            admin_file_buffer[userId].filter_country = isoCode.toUpperCase();
            admin_file_buffer[userId].filter_country_name = countryDisplayName;
            user_states[userId] = 'FILTER_AWAITING_SERVICE';
            bot.sendMessage(chatId,
                `✅ দেশ: <b>${countryDisplayName}</b> (<code>${isoCode.toUpperCase()}</code>)\n\n` +
                `📵 এখন <b>সার্ভিসের নাম</b> লিখুন:\n(যেমন: <code>TikTok</code>, <code>WhatsApp</code>, <code>Google</code>)`,
                { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard(true) }
            );
            return;
        }

        // 🚫 OTP FILTER: সার্ভিসের নাম ইনপুট
        if (user_states[userId] === 'FILTER_AWAITING_SERVICE' && isAdmin(userId)) {
            if (!text) return;
            const service = text.trim();
            if (service.length < 2 || service.length > 50) {
                bot.sendMessage(chatId, '❌ সার্ভিসের নাম ২-৫০ অক্ষরের মধ্যে হতে হবে।', { reply_markup: getAdminMenuKeyboard(true) });
                return;
            }
            const buf = admin_file_buffer[userId] || {};
            const country = buf.filter_country;
            const countryName = buf.filter_country_name;
            if (!country) {
                delete user_states[userId];
                bot.sendMessage(chatId, '❌ কিছু ভুল হয়েছে, আবার শুরু করুন।', { reply_markup: getAdminMenuKeyboard() });
                return;
            }
            try {
                await OtpFilterModel.findOneAndUpdate(
                    { country: country.toUpperCase(), service: { $regex: new RegExp(`^${service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
                    { country: country.toUpperCase(), service: service.toLowerCase() },
                    { upsert: true, returnDocument: 'after' }
                );
                await syncOtpFilterCache();
                delete user_states[userId];
                delete admin_file_buffer[userId];
                bot.sendMessage(chatId,
                    `✅ <b>OTP ফিল্টার যোগ হয়েছে!</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🌍 দেশ: <b>${countryName}</b> (<code>${country}</code>)\n` +
                    `📵 সার্ভিস: <b>${service}</b>\n\n` +
                    `এখন থেকে ${countryName} এর ${service} OTP আর গ্রুপ/ইউজারে যাবে না।`,
                    { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
                );
            } catch (e) {
                if (e.code === 11000) {
                    bot.sendMessage(chatId, `⚠️ এই ফিল্টারটি আগে থেকেই আছে।`, { reply_markup: getAdminMenuKeyboard() });
                } else {
                    bot.sendMessage(chatId, '❌ DB Error। আবার চেষ্টা করুন।', { reply_markup: getAdminMenuKeyboard() });
                }
                delete user_states[userId];
                delete admin_file_buffer[userId];
            }
            return;
        }

        // 🔗 METHOD: লিংক ইনপুট (নতুন)
        if (user_states[userId] === 'AWAITING_METHOD_LINK' && isAdmin(userId)) {
            if (!text) return;
            const link = text.trim();
            if (!/^https?:\/\//i.test(link)) {
                bot.sendMessage(chatId, '❌ ভ্যালিড লিংক দিন (http:// বা https:// দিয়ে শুরু হতে হবে):', { reply_markup: getAdminMenuKeyboard(true) });
                return;
            }
            const buf = admin_file_buffer[userId] || {};
            const countryName = buf.method_country;
            const flag = buf.method_flag || '🌍';
            if (!countryName) {
                delete user_states[userId];
                bot.sendMessage(chatId, '❌ কিছু ভুল হয়েছে, আবার শুরু করুন।', { reply_markup: getAdminMenuKeyboard() });
                return;
            }
            try {
                await CountryMethodModel.findOneAndUpdate(
                    { country: { $regex: new RegExp(`^${countryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
                    { country: countryName, flag, link, updatedAt: new Date() },
                    { upsert: true, returnDocument: 'after' }
                );
                delete user_states[userId];
                delete admin_file_buffer[userId];
                bot.sendMessage(chatId,
                    `✅ <b>Method Link সেট হয়েছে!</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `${flag} Country: <b>${countryName}</b>\n` +
                    `🔗 Link: <code>${link}</code>`,
                    { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
                );
            } catch (e) {
                bot.sendMessage(chatId, '❌ DB Error। আবার চেষ্টা করুন।', { reply_markup: getAdminMenuKeyboard() });
            }
            return;
        }

        // 🔗 METHOD: লিংক এডিট (Method List থেকে)
        if (typeof user_states[userId] === 'string' && user_states[userId].startsWith('AWAITING_METHOD_LINK_EDIT:') && isAdmin(userId)) {
            if (!text) return;
            const methodId = user_states[userId].split('AWAITING_METHOD_LINK_EDIT:')[1];
            const link = text.trim();
            if (!/^https?:\/\//i.test(link)) {
                bot.sendMessage(chatId, '❌ ভ্যালিড লিংক দিন (http:// বা https:// দিয়ে শুরু হতে হবে):', { reply_markup: getAdminMenuKeyboard(true) });
                return;
            }
            try {
                const updated = await CountryMethodModel.findByIdAndUpdate(
                    methodId,
                    { link, updatedAt: new Date() },
                    { returnDocument: 'after' }
                );
                delete user_states[userId];
                if (!updated) {
                    bot.sendMessage(chatId, '❌ এই এন্ট্রি খুঁজে পাওয়া যায়নি।', { reply_markup: getAdminMenuKeyboard() });
                    return;
                }
                bot.sendMessage(chatId,
                    `✅ <b>Method Link আপডেট হয়েছে!</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `${updated.flag || '🌍'} Country: <b>${updated.country}</b>\n` +
                    `🔗 New Link: <code>${updated.link}</code>`,
                    { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
                );
            } catch (e) {
                bot.sendMessage(chatId, '❌ DB Error। আবার চেষ্টা করুন।', { reply_markup: getAdminMenuKeyboard() });
            }
            return;
        }

        // ✏️ EDIT PLATFORM: নতুন নাম ইনপুট
        if (user_states[userId] === 'AWAITING_EDIT_PLATFORM_NAME' && isAdmin(userId)) {
            if (!text) return;
            const newName = text.trim();
            if (!newName) {
                bot.sendMessage(chatId, '❌ একটি সঠিক নাম লিখুন:', { reply_markup: getAdminMenuKeyboard(true) });
                return;
            }
            const buf = admin_file_buffer[userId] || {};
            const sectorId = buf.edit_platform_id;
            const oldName = buf.edit_platform_old_name;
            const sector = SECTORS.find(s => s.id === sectorId);
            if (!sector) {
                delete user_states[userId];
                delete admin_file_buffer[userId];
                bot.sendMessage(chatId, '❌ প্ল্যাটফর্ম পাওয়া যায়নি।', { reply_markup: getAdminMenuKeyboard() });
                return;
            }
            sector.label = newName;
            try {
                if (isUserDBReady) {
                    await CustomSectorModel.findOneAndUpdate({ id: sectorId }, { label: newName });
                }
            } catch (e) { console.log('Edit platform DB error:', e.message); }
            delete user_states[userId];
            delete admin_file_buffer[userId];
            bot.sendMessage(chatId,
                `✅ <b>প্ল্যাটফর্ম আপডেট হয়েছে!</b>\n\n📱 পুরনো নাম: <b>${oldName}</b>\n📱 নতুন নাম: <b>${newName}</b>`,
                { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
            );
            return;
        }

        // ➕ ADD PLATFORM: নাম ইনপুট
        if (user_states[userId] === 'AWAITING_NEW_PLATFORM_NAME' && isAdmin(userId)) {
            if (!text) return;
            const platformName = text.trim();
            if (!platformName) {
                bot.sendMessage(chatId, '❌ একটি সঠিক নাম লিখুন:', { reply_markup: getAdminMenuKeyboard(true) });
                return;
            }
            const slug = slugifyPlatformName(platformName);
            if (SECTORS.find(s => s.id === slug)) {
                bot.sendMessage(chatId, `❌ "${platformName}" নামে একটি প্ল্যাটফর্ম আগেই আছে। অন্য নাম দিন:`, { reply_markup: getAdminMenuKeyboard(true) });
                return;
            }
            admin_file_buffer[userId] = admin_file_buffer[userId] || {};
            admin_file_buffer[userId].new_platform_name = platformName;
            admin_file_buffer[userId].new_platform_slug = slug;
            user_states[userId] = 'AWAITING_NEW_PLATFORM_EMOJI';
            bot.sendMessage(chatId,
                `📱 প্ল্যাটফর্ম: <b>${platformName}</b>\n\n✨ এখন একটি প্রিমিয়াম ইমোজি সেন্ড করুন (এখান থেকেই আইডি স্বয়ংক্রিয়ভাবে নিয়ে নেওয়া হবে):`,
                { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard(true) }
            );
            return;
        }

        // ➕ ADD PLATFORM: প্রিমিয়াম ইমোজি ইনপুট
        if (user_states[userId] === 'AWAITING_NEW_PLATFORM_EMOJI' && isAdmin(userId)) {
            const customEntity = (msg.entities || []).find(e => e.type === 'custom_emoji');
            if (!customEntity || !text) {
                bot.sendMessage(chatId, '❌ একটি প্রিমিয়াম ইমোজি সেন্ড করুন (টেক্সট না, ইমোজি):', { reply_markup: getAdminMenuKeyboard(true) });
                return;
            }
            // UTF-16 surrogate pair হিসাব করে আসল (normal) ইমোজি ক্যারেক্টার বের করা
            const normalEmoji = text.slice(customEntity.offset, customEntity.offset + customEntity.length) || '📱';
            const premiumId = customEntity.custom_emoji_id;

            const buf = admin_file_buffer[userId] || {};
            const platformName = buf.new_platform_name;
            const slug = buf.new_platform_slug;
            if (!platformName || !slug) {
                delete user_states[userId];
                bot.sendMessage(chatId, '❌ কিছু ভুল হয়েছে, আবার শুরু করুন।', { reply_markup: getAdminMenuKeyboard() });
                return;
            }

            try {
                await CustomSectorModel.create({
                    id: slug,
                    label: platformName,
                    emoji: normalEmoji,
                    icon_custom_emoji_id: premiumId,
                    style: 'success'
                });
                // রানটাইমে সাথে সাথে সক্রিয় করা (রিস্টার্ট ছাড়া)
                if (!SECTORS.find(s => s.id === slug)) {
                    SECTORS.push({ id: slug, label: platformName, emoji: normalEmoji, icon_custom_emoji_id: premiumId, style: 'success' });
                }
                delete user_states[userId];
                delete admin_file_buffer[userId];
                bot.sendMessage(chatId,
                    `✅ <b>নতুন প্ল্যাটফর্ম যুক্ত হয়েছে!</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📱 নাম: <b>${platformName}</b>\n` +
                    `${normalEmoji} ইমোজি (আইডি: <code>${premiumId}</code>)\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━`,
                    { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
                );
            } catch (e) {
                bot.sendMessage(chatId, '❌ DB Error। আবার চেষ্টা করুন।\n' + e.message, { reply_markup: getAdminMenuKeyboard() });
            }
            return;
        }

        // 💵 PRICE INPUT HANDLER
        if (user_states[userId] === 'AWAITING_PRICE_INPUT' && isAdmin(userId)) {
            if (text) {
                const priceVal = parseFloat(text.trim());
                const buf = admin_file_buffer[userId] || {};
                if (isNaN(priceVal) || priceVal < 0) {
                    bot.sendMessage(chatId, "❌ ভ্যালিড price দিন। যেমন: <code>0.002</code> বা <code>1</code>", { parse_mode: 'HTML' });
                    return;
                }
                admin_file_buffer[userId].price = priceVal;
                admin_file_buffer[userId].selected_sectors = admin_file_buffer[userId].selected_sectors || [];
                user_states[userId] = 'ADDING_NUMBER_STEP_3';
                const pFlag3 = getPremiumFlag(buf.country, buf.flag);
                admin_file_buffer[userId].price = priceVal; // already set above but ensure
                bot.sendMessage(chatId,
                    buildSectorSelectionText(admin_file_buffer[userId]),
                    { parse_mode: 'HTML', reply_markup: getSectorSelectionKeyboard([], {}) }
                );
                return;
            }
        }

        // ⏰ SCHEDULE TIME INPUT — buffer-এ সেভ করে sector keyboard-এ ফিরে যাবে
        if (user_states[userId] === 'AWAITING_SCHEDULE_TIME' && isAdmin(userId)) {
            if (!text) return;
            const buf = admin_file_buffer[userId];
            if (!buf || !buf.file_id) {
                bot.sendMessage(chatId, "❌ ডেটা পাওয়া যায়নি। আবার ADD চেষ্টা করুন।");
                delete user_states[userId];
                return;
            }

            function parseBDTimeInput(input) {
                const s = input.trim().toUpperCase();
                const m12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
                if (m12) {
                    let h = parseInt(m12[1]);
                    const min = m12[2] ? parseInt(m12[2]) : 0;
                    const meridiem = m12[3];
                    if (h < 1 || h > 12 || min > 59) return null;
                    if (meridiem === 'AM' && h === 12) h = 0;
                    if (meridiem === 'PM' && h !== 12) h += 12;
                    return { h, min };
                }
                const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
                if (m24) {
                    const h = parseInt(m24[1]);
                    const min = parseInt(m24[2]);
                    if (h > 23 || min > 59) return null;
                    return { h, min };
                }
                return null;
            }

            const parsed = parseBDTimeInput(text);
            if (!parsed) {
                bot.sendMessage(chatId,
                    `❌ সঠিক format দিন।\nযেমন: <code>6:00 AM</code>, <code>11:30 PM</code>, <code>14:30</code>`,
                    { parse_mode: 'HTML' }
                );
                return;
            }

            // সময় label তৈরি
            const isPM_st = parsed.h >= 12;
            const h12_st  = parsed.h === 0 ? 12 : (parsed.h > 12 ? parsed.h - 12 : parsed.h);
            const mm_st   = String(parsed.min).padStart(2,'0');
            const timeLabel = `${h12_st}:${mm_st} ${isPM_st ? 'PM' : 'AM'}`;

            // buffer-এ সেভ করো — confirm চাপলে এই সময় ব্যবহার হবে
            admin_file_buffer[userId].schedule_time = timeLabel;
            delete user_states[userId];

            // sector keyboard-এ ফিরে যাও opts সহ
            const sel_st = buf.selected_sectors || [];
            const opts_st2 = { noLimit: buf.no_limit || false, scheduleTime: timeLabel };
            bot.sendMessage(chatId,
                buildSectorSelectionText(buf),
                { parse_mode: 'HTML', reply_markup: getSectorSelectionKeyboard(sel_st, opts_st2) }
            );
            return;
        }


        if (typeof user_states[userId] === 'string' && user_states[userId].startsWith('WAIT_EDIT_PRICE:') && isAdmin(userId)) {
            if (text) {
                const parts = user_states[userId].split(':');
                const sectorId = parts[1];
                const countryName = parts.slice(2).join(':');
                const newPrice = parseFloat(text.trim());

                if (isNaN(newPrice) || newPrice < 0) {
                    bot.sendMessage(chatId, "❌ ভ্যালিড price দিন। যেমন: <code>0.5</code> বা <code>1</code>", { parse_mode: 'HTML' });
                    return;
                }

                user_states[userId] = null;
                const sectorInfo = SECTORS.find(s => s.id === sectorId);

                if (!isNumberDBReady) {
                    bot.sendMessage(chatId, "❌ DB not ready.");
                    return;
                }

                const result = await NumberModel.updateMany(
                    { sector: sectorId, country: countryName },
                    { $set: { price: newPrice } }
                );

                const pFlagDone = getPremiumFlag(countryName, null);
                bot.sendMessage(chatId,
                    `✅ <b>Price আপডেট হয়েছে!</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📱 Platform: <b>${sectorInfo ? sectorInfo.label : sectorId}</b>\n` +
                    `${pFlagDone} Country: <b>${cleanCountryName(countryName)}</b>\n` +
                    `💵 New Price: <b>$${newPrice}</b>\n` +
                    `🔢 Updated Records: <b>${result.modifiedCount}</b>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back to Country List", callback_data: `cfg_price_sector:${sectorId}`, style: 'primary' }]] }
                    }
                );
                return;
            }
        }

        // 🔄 RESTART PASSWORD CHECK
        if (user_states[userId] === 'AWAITING_PASS_FOR_RST') {
            if (text === 'sms') {
                delete user_states[userId];

                // 🔄 Countdown Message
                const countdownMsg = await bot.sendMessage(
                    chatId, 
                    "🔄 Restarting Bot...\n\n⏳ Please wait: 6 seconds\n\n⚠️ All buttons disabled!", 
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: { remove_keyboard: true }
                    }
                );

                const countdownMsgId = countdownMsg.message_id;

                // 📊 Countdown
                for (let i = 5; i >= 1; i--) {
                    await new Promise(r => setTimeout(r, 1000));
                    try {
                        await bot.editMessageText(
                            `🔄 Restarting Bot...\n\n⏳ Please wait: ${i} seconds\n\n⚠️ All buttons disabled!`,
                            {
                                chat_id: chatId,
                                message_id: countdownMsgId,
                                parse_mode: 'Markdown'
                            }
                        );
                    } catch (e) {}
                }

                // ✅ Final Success Message
                try {
                    await bot.editMessageText(
                        "✅ Restart Successful!\n\n🤖 Bot is now restarting...\n⏰ It will be back online in a moment.",
                        {
                            chat_id: chatId,
                            message_id: countdownMsgId,
                            parse_mode: 'Markdown'
                        }
                    );
                } catch (e) {}

                // 🔄 Git Pull & Restart Specific Process
                const { exec } = require('child_process');
                const BOT_PATH = process.cwd();

                exec(`cd ${BOT_PATH} && git add . && git commit -m "update" || true && git pull origin main --rebase && git push && pm2 restart ${process.env.pm_id}`, (error, stdout, stderr) => {
                    if (error) {
                        bot.sendMessage(chatId, `❌ Restart Failed!\n\n<pre>${error.message}</pre>`, { 
                            parse_mode: 'HTML',
                            reply_markup: getAdminMenuKeyboard() 
                        });
                        return;
                    }
                    setTimeout(() => { process.exit(0); }, 2000);
                });

            } else {
                bot.sendMessage(chatId, "🚫 বাল পাকনা, এটা আপনার জন্য না 😅\n\n" +
"এই অপশনটা শুধু বট ডেভেলপারদের জন্য। ফাইল আপডেট বট আপডেট এর জন্য\n" +
"ভুল করে ঢুকে পড়লে এখনই ব্যাক যান\n👉 @alifhosson", { 
                    reply_markup: getAdminMenuKeyboard() 
                });
                delete user_states[userId];
            }
            return;
        }
        if (user_states[userId] === 'AWAITING_PASS_FOR_TOKEN') {
            if (text === 'alif') {
                user_states[userId] = 'AWAITING_GITHUB_TOKEN';
                bot.sendMessage(chatId, "🔓 Password Accepted!\n\nPlease upload ur github Repo token:", { parse_mode: 'Markdown', reply_markup: getAdminMenuKeyboard(true) });
            } else {
                bot.sendMessage(chatId, "❌ ভুল পাসওয়ার্ড দিলে কিন্তু চলবে না চাচা! 😴\nপাসওয়ার্ড ভুলে গেলে গুগল না, সোজা আলিফ ভাইয়ের কাছে মেসেজ দেন 📩\nবেশি না—মাত্র 5$ দিলেই ঝটপট চেঞ্জ করে দিবে 😂👍\n👉 @alifhosson", { reply_markup: getAdminMenuKeyboard() });
                delete user_states[userId];
            }
            return;
        }

        if (user_states[userId] === 'AWAITING_GITHUB_TOKEN') {
            if (!isUserDBReady) {
                 bot.sendMessage(chatId, "❌ DB Not Ready.", { reply_markup: getAdminMenuKeyboard() });
                 return;
            }
            const newToken = text.trim();
            try {
                await ConfigModel.findOneAndUpdate(
                    { key: "github_token" },
                    { value: newToken },
                    { upsert: true, returnDocument: 'after' }
                );

                bot.sendMessage(chatId, "✅ GitHub Token Saved Successfully!\nSyncing system now...", { parse_mode: 'Markdown', reply_markup: getAdminMenuKeyboard() });
                syncSystem();
            } catch (e) {
                bot.sendMessage(chatId, "❌ Database Error saving token.", { reply_markup: getAdminMenuKeyboard() });
            }
            delete user_states[userId];
            return;
        }

        // 📤 BACKUP FILE UPLOAD: একটা একটা করে collection ফাইল restore করে
        if (user_states[userId] === 'AWAITING_BACKUP_ZIP' && isAdmin(userId)) {
            // Cancel check
            if (text && (text === '/cancel' || text.toLowerCase() === 'cancel' || text === '/done' || text.toLowerCase() === 'done')) {
                const st = user_states[userId + '_backup_state'] || {};
                const restored = st.restored || [];
                delete user_states[userId];
                delete user_states[userId + '_backup_state'];
                const doneMsg = restored.length > 0
                    ? `✅ <b>Backup Restore শেষ!</b>\n\n📂 Restored: <b>${restored.join(', ')}</b>`
                    : '✅ বাতিল করা হয়েছে।';
                bot.sendMessage(chatId, doneMsg, { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() });
                return;
            }

            if (!msg.document) {
                bot.sendMessage(chatId, '⚠️ একটি backup <b>.json</b> ফাইল পাঠান।\n\nশেষ হলে <code>/done</code> অথবা <code>/cancel</code> লিখুন।', { parse_mode: 'HTML' });
                return;
            }

            const fileName = (msg.document.file_name || '').toLowerCase();
            if (!fileName.endsWith('.json')) {
                bot.sendMessage(chatId, '❌ শুধুমাত্র <b>.json</b> ফাইল গ্রহণযোগ্য।\n\nশেষ হলে <code>/done</code> লিখুন।', { parse_mode: 'HTML' });
                return;
            }

            // ফাইলের নাম থেকে collection key বের করা
            // backup_withdraws_... → withdraws
            const restoreMap = {
                'configs':   { model: ConfigModel,     key: 'key',        label: '⚙️ Configs' },
                'users':     { model: UserModel,       key: 'userId',     label: '👥 Users' },
                'wallets':   { model: WalletUser,      key: 'telegramId', label: '💰 Wallets' },
                'numbers':   { model: NumberModel,     key: 'number',     label: '🔢 Numbers' },
                'otp_stats': { model: UserOtpStat,     key: 'userId',     label: '📊 OTP Stats' },
                'withdraws': { model: WithdrawRequest, key: 'userId',     label: '💸 Withdraws' },
                'meta':      { model: null,             key: null,         label: '🗂️ Meta' },
            };

            // ফাইলের নাম থেকে key detect করা
            let detectedKey = null;
            for (const k of Object.keys(restoreMap)) {
                if (fileName.includes(k)) { detectedKey = k; break; }
            }
            if (!detectedKey) {
                bot.sendMessage(chatId, `⚠️ ফাইলের নাম থেকে collection বোঝা যাচ্ছে না।\n<code>${msg.document.file_name}</code>\n\nফাইলের নামে collection key থাকতে হবে:\n<code>configs, users, wallets, numbers, otp_stats, withdraws, meta</code>`, { parse_mode: 'HTML' });
                return;
            }

            const processingMsg = await bot.sendMessage(chatId,
                `⏳ <b>${restoreMap[detectedKey].label}</b> restore হচ্ছে...\n📦 বড় ফাইল হলে একটু সময় লাগবে...`,
                { parse_mode: 'HTML' }
            );

            try {
                // axios দিয়ে download — 20MB getFileLink limit নেই
                const axios = require('axios');
                const tgFile = await bot.getFile(msg.document.file_id);
                const dlUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${tgFile.file_path}`;
                const resp = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 120000 });
                const rawBuf = Buffer.from(resp.data);

                // JSON validate
                const parsed = JSON.parse(rawBuf.toString('utf8'));
                const targetPath = restoreMap[detectedKey].path;

                // ফাইল সরাসরি লেখা (parse → stringify করি না — বড় ফাইলে memory issue হবে)
                fs.writeFileSync(targetPath, rawBuf);

                // Memory reload
                restoreMap[detectedKey].mem();
                if (detectedKey !== 'meta') { _dirty[detectedKey === 'otp_stats' ? 'otpStats' : detectedKey]?.clear(); }

                // State update
                if (!user_states[userId + '_backup_state']) user_states[userId + '_backup_state'] = { restored: [] };
                user_states[userId + '_backup_state'].restored.push(restoreMap[detectedKey].label);
                const restoredSoFar = user_states[userId + '_backup_state'].restored;

                const sizeMB = (rawBuf.length / 1024 / 1024).toFixed(1);
                await bot.editMessageText(
                    `✅ <b>${restoreMap[detectedKey].label}</b> restore হয়েছে! (${sizeMB} MB)\n\n📂 এখন পর্যন্ত: <b>${restoredSoFar.join(', ')}</b>\n\n➡️ আরো ফাইল পাঠান, অথবা শেষ হলে <code>/done</code> লিখুন।`,
                    { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'HTML' }
                );
            } catch (e) {
                console.error('[Backup Upload] error:', e.message);
                await bot.editMessageText(
                    `❌ <b>Restore-এ সমস্যা</b>\n<code>${e.message}</code>\n\n➡️ আরো ফাইল পাঠান, অথবা <code>/done</code> লিখুন।`,
                    { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'HTML' }
                );
            }
            return;
        }

        if (user_states[userId] === 'ADDING_NUMBER_STEP_1') {
            if (msg.document) {
                admin_file_buffer[userId] = { file_id: msg.document.file_id, selected_sectors: [] };
                user_states[userId] = 'ADDING_NUMBER_STEP_2';
                // Auto-detect country from file
                bot.sendMessage(chatId, "📂 ফাইল পাওয়া গেছে!\n⏳ নাম্বার বিশ্লেষণ করা হচ্ছে...", { parse_mode: 'Markdown' });
                autoDetectCountryFromFile(userId, chatId, msg.document.file_id);
                return;
            } else {
                bot.sendMessage(chatId, "❌ Excel ফাইল পাঠান।", { reply_markup: getAdminMenuKeyboard(true) });
                return;
            }
        }
        if (user_states[userId] === 'ADDING_NUMBER_STEP_2') {
            if (text && text !== '🛑 Stop') {
                const suffix = text.trim();
                const buf = admin_file_buffer[userId] || {};

                const baseCountry = buf.country || '';
                const baseFlag = buf.flag || '🌍';
                // নতুন নাম তৈরি (যেমন: Myanmar Ws)
                const finalCountry = baseCountry ? (baseCountry + ' ' + suffix) : suffix;

                admin_file_buffer[userId].country = finalCountry;
                admin_file_buffer[userId].flag = baseFlag;
                admin_file_buffer[userId].selected_sectors = admin_file_buffer[userId].selected_sectors || [];
                user_states[userId] = 'AWAITING_PRICE_INPUT';

                // প্রিমিয়াম ফ্ল্যাগ এখন স্মার্টলি ডিটেক্ট হবে
                const pFlagStep2 = getPremiumFlag(finalCountry, baseFlag);
                const _numCount2 = admin_file_buffer[userId]?.numbers?.length || '?';
                bot.sendMessage(chatId,
                    `✅ নাম সেট: <b>${pFlagStep2} ${finalCountry}</b>\n📊 নাম্বার: <b>${_numCount2} টি</b>\n\n💵 <b>Number Price দিন (USD)</b>\nযেমন: <code>1</code>, <code>0.002</code>, <code>0.003</code>\n\nঅথবা Skip করুন:`,
                    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "Skip (Price ছাড়া)", callback_data: 'skip_price', style: 'primary' }], [{ text: "Cancel", callback_data: 'cancel_add', style: 'danger' }]] } }
                );
                return;
            }
        }
        if (user_states[userId] === 'BROADCASTING') {
            // আগেরটা চলছে কিনা চেক — চললে নতুন মেসেজ block করো
            if (activeBroadcasts[userId] && !activeBroadcasts[userId].stopped) {
                await bot.sendMessage(userId,
                    '⚠️ <b>একটি ব্রডকাস্ট এখনো চলছে!</b>\n\n🛑 Stop করুন অথবা শেষ হওয়ার জন্য অপেক্ষা করুন।',
                    { parse_mode: 'HTML' }
                );
                return;
            }
            delete user_states[userId]; // সেশন ক্লোজ করো
            processBroadcast(msg);
            return;
        }

        // ── ADMIN: Find User by UID or Username ───────────────────────
        if (user_states[userId] === 'FIND_USER_SEARCH' && isAdmin(userId)) {
            delete user_states[userId];
            const query = text ? text.trim() : '';
            if (!query) {
                bot.sendMessage(chatId, '❌ কিছু লিখুন।', { reply_markup: getAdminMenuKeyboard() });
                return;
            }
            await sendFindUserResult(chatId, userId, query);
            return;
        }

        // ── ADMIN: Add Balance to user ────────────────────────────────
        if (typeof user_states[userId] === 'string' && user_states[userId].startsWith('ADMIN_ADD_BAL:') && isAdmin(userId)) {
            const stateParts = user_states[userId].replace('ADMIN_ADD_BAL:', '').split(':');
            const targetId = Number(stateParts[0]);
            const fromPage = parseInt(stateParts[1]) || 0;
            delete user_states[userId];
            const amount = parseFloat(text);
            if (isNaN(amount) || amount <= 0) {
                bot.sendMessage(chatId, '❌ সঠিক পরিমাণ লিখুন (যেমন: 0.5)', { reply_markup: getAdminMenuKeyboard() });
                return;
            }
            const updated = await WalletUser.findOneAndUpdate(
                { telegramId: targetId },
                { $inc: { balance: amount } },
                { returnDocument: 'after' }
            );
            if (!updated) return bot.sendMessage(chatId, '❌ ইউজার পাওয়া যায়নি।', { reply_markup: getAdminMenuKeyboard() });
            await bot.sendMessage(chatId,
                `✅ <b>+$${amount.toFixed(4)}</b> যোগ হয়েছে!\n👤 UID: <code>${targetId}</code>\n💰 নতুন ব্যালেন্স: <b>$${updated.balance.toFixed(4)}</b>`,
                { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
            );
            try { await bot.sendMessage(targetId, `✅ আপনার একাউন্টে <b>$${amount.toFixed(4)}</b> যোগ হয়েছে!\n💰 বর্তমান ব্যালেন্স: <b>$${updated.balance.toFixed(4)}</b>`, { parse_mode: 'HTML' }); } catch(e) {}
            return;
        }

        // ── ADMIN: Remove Balance from user ──────────────────────────
        if (typeof user_states[userId] === 'string' && user_states[userId].startsWith('ADMIN_REM_BAL:') && isAdmin(userId)) {
            const stateParts = user_states[userId].replace('ADMIN_REM_BAL:', '').split(':');
            const targetId = Number(stateParts[0]);
            const fromPage = parseInt(stateParts[1]) || 0;
            delete user_states[userId];
            const amount = parseFloat(text);
            if (isNaN(amount) || amount <= 0) {
                bot.sendMessage(chatId, '❌ সঠিক পরিমাণ লিখুন (যেমন: 0.5)', { reply_markup: getAdminMenuKeyboard() });
                return;
            }
            const updated = await WalletUser.findOneAndUpdate(
                { telegramId: targetId },
                { $inc: { balance: -amount } },
                { returnDocument: 'after' }
            );
            if (!updated) return bot.sendMessage(chatId, '❌ ইউজার পাওয়া যায়নি।', { reply_markup: getAdminMenuKeyboard() });
            await bot.sendMessage(chatId,
               `✅ <b>-$${amount.toFixed(4)}</b> কাটা হয়েছে!\n👤 UID: <code>${targetId}</code>\n💰 নতুন ব্যালেন্স: <b>$${updated.balance.toFixed(4)}</b>`,
                { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
            );
            //try { await bot.sendMessage(targetId, `⚠️ আপনার একাউন্ট থেকে <b>$${amount.toFixed(4)}</b> কাটা হয়েছে!\n💰 বর্তমান ব্যালেন্স: <b>$${updated.balance.toFixed(4)}</b>`, { parse_mode: 'HTML' }); } catch(e) {}
            return;
        }

        // ── WALLET: Set wallet address ────────────────────────────────
        if (typeof user_states[userId] === 'string' && user_states[userId].startsWith('WAIT_WALLET_ADDR:')) {
            const methodKey = user_states[userId].replace('WAIT_WALLET_ADDR:', '');
            const _wMethod = WALLET_METHODS.find(m => m.key === methodKey) || dynamicPayMethods.find(dm => dm.id === methodKey);
            const methodLabel = _wMethod ? _wMethod.label : methodKey;
            const address = text ? text.trim() : '';
            if (!address) { bot.sendMessage(chatId, "❌ Please enter a valid address."); return; }

            // ── Validate address/number format based on selected method ──
            const addrValidators = {
                BEP20: {
                    regex: /^0x[0-9a-fA-F]{40}$/,
                    msg: `❌ <b>Invalid Address!</b>\n\n📬 The BEP20 address you entered is not valid.\n⚠️ A valid BEP20 address starts with <b>0x</b> and is 42 characters long.\nPlease check and try again.`,
                },
                TRX: {
                    regex: /^T[a-zA-Z0-9]{33}$/,
                    msg: `❌ <b>Invalid Address!</b>\n\n📬 The TRX (TRC20) address you entered is not valid.\n⚠️ A valid TRX address starts with <b>T</b> and is 34 characters long.\nPlease check and try again.`,
                },
                Binance: {
                    regex: /^[0-9]{6,12}$/,
                    msg: `❌ <b>Invalid UID!</b>\n\n📬 The Binance UID you entered is not valid.\n⚠️ A valid Binance UID contains only numbers.\nPlease check and try again.`,
                },
                bKash: {
                    regex: /^01[0-9]{9}$/,
                    msg: `❌ <b>Invalid Number!</b>\n\n📬 The bKash number you entered is not valid.\n⚠️ A valid number starts with <b>01</b> and is 11 digits long.\nPlease check and try again.`,
                },
                Nagad: {
                    regex: /^01[0-9]{9}$/,
                    msg: `❌ <b>Invalid Number!</b>\n\n📬 The Nagad number you entered is not valid.\n⚠️ A valid number starts with <b>01</b> and is 11 digits long.\nPlease check and try again.`,
                },
            };
            // Check validator: static method key OR dynamic BEP20 type
            const _dynMethodForVal = dynamicPayMethods.find(dm => dm.id === methodKey);
            const _isDynBEP20Val = _dynMethodForVal && _dynMethodForVal.type === 'USDT_BEP20';
            const validator = addrValidators[methodKey] || (_isDynBEP20Val ? addrValidators['BEP20'] : null);
            if (validator && !validator.regex.test(address)) {
                const _valMethodName = (_dynMethodForVal ? _dynMethodForVal.label : methodKey);
                const _valMsg = _isDynBEP20Val
                    ? `❌ <b>Invalid Address!</b>\n\n` +
                      `The <b>${_valMethodName}</b> USDT BEP20 address is not valid.\n` +
                      `A valid address starts with <b>0x</b> and is 42 characters long.\n` +
                      `\nPlease check and try again.`
                    : validator.msg;
                bot.sendMessage(chatId, E(_valMsg), { parse_mode: 'HTML' });
                return;
            }

            if (isUserDBReady) {
                await WalletUser.findOneAndUpdate(
                    { telegramId: userId },
                    { walletMethod: methodKey, walletAddress: address },
                    { upsert: true }
                );
            }
            delete user_states[userId];
            bot.sendMessage(chatId,
                E(`✅ <b>Wallet Set!</b>\n\n💳 Method: <b>${methodLabel}</b>\n📬 Address: <code>${address}</code>`),
                { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard(userId) }
            );
            return;
        }

        // ── WALLET: Withdraw amount input ─────────────────────────────
        if (user_states[userId] === 'WAIT_WITHDRAW_AMOUNT') {
            const amount = parseFloat(text ? text.trim() : '');
            const minW = minWithdrawLimit;
            if (isNaN(amount) || amount < minW) {
                bot.sendMessage(chatId, `❌ Minimum withdrawal is <b>$${minW.toFixed(2)}</b>.`, { parse_mode: 'HTML' });
                return;
            }
            const wUserWd = await getWalletUser(userId, msg.from);
            if (!await validateUserWallet(chatId, userId, wUserWd)) { delete user_states[userId]; return; }
            if (!wUserWd || (wUserWd.balance || 0) < amount) {
                bot.sendMessage(chatId, `❌ Insufficient balance: <b>$${(wUserWd ? wUserWd.balance : 0).toFixed(4)}</b>.`, { parse_mode: 'HTML' });
                return;
            }

            const toAddress = (wUserWd.walletAddress || '').trim();
            const payAmount = amount.toFixed(4);
            const uName = msg.from.first_name || msg.from.username || 'User';
            const wMethod = wUserWd.walletMethod || '';
            const AUTO_PAY_METHODS = ['BEP20', 'TRX', 'Binance'];
            // Dynamic USDT_BEP20 methods ও auto-pay হবে
            const dynMethod = dynamicPayMethods.find(dm => dm.id === wMethod);
            const isDynBEP20 = dynMethod && dynMethod.type === 'USDT_BEP20';
            const isAutoPay = AUTO_PAY_METHODS.includes(wMethod) || isDynBEP20;
            // Display label: dynamic method হলে label দেখাও, না হলে raw id
            const wMethodLabel = dynMethod ? dynMethod.label : wMethod;

            // Deduct balance immediately
            await WalletUser.findOneAndUpdate(
                { telegramId: userId },
                { $inc: { balance: -amount, withdrawn: amount } }
            );
            // Keep local object in sync for reads below
            wUserWd.balance   = (wUserWd.balance   || 0) - amount;
            wUserWd.withdrawn = (wUserWd.withdrawn || 0) + amount;

            // ── MANUAL METHODS (bKash / Nagad): skip auto-pay, go straight to admin pending queue ──
            if (!isAutoPay) {
                const wReqManual = await WithdrawRequest.create({
                    userId, username: msg.from.username || '', firstName: msg.from.first_name || '',
                    amount, walletMethod: wMethod, walletAddress: toAddress, status: 'pending',
                });
                delete user_states[userId];

                bot.sendMessage(chatId,
                    E(`✅ <b>Withdrawal Request pending!</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `💵 Amount: <b>$${payAmount}</b>\n` +
                    `💳 Method: <b>${wMethodLabel}</b>\n` +
                    `📬 Address: <code>${toAddress}</code>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `⏳ Admin will process your request shortly.`),
                    { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard(userId) }
                );

                // ── গ্রুপে withdraw pending নোটিফিকেশন ──
                {
                    const maskedAddr = maskAddress(toAddress);
                    const boardUrl = getBoardUrl(wMethod);
                    const groupText = E(`📥 <b>New Withdraw Request</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `👤 User   : <b>${uName}</b> (<code>${userId}</code>)\n` +
                        `💵 Amount : <b>$${payAmount}</b>\n` +
                        `💳 Method : <b>${wMethodLabel}</b>\n` +
                        `📬 Number : <code>${maskedAddr}</code>\n` +
                        `📅 Date   : ${wReqManual.createdAt.toLocaleString()}\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `⏳ Pending — Waiting for admin approval`);
                    const groupBtns = boardUrl
                        ? [{ text: "🤖𝐎𝐩𝐞𝐧 𝐁𝐨𝐭", url: `https://t.me/${bot_username}?start=start`, icon_custom_emoji_id: _BTN_EM.open_bot.id, style: 'primary' }]
                        : [];
                    await sendWithdrawGroupMsg(groupText, groupBtns);
                }

                // Notify admins with Approve/Reject buttons
                for (const adminId of ADMIN_IDS) {
                    bot.sendMessage(adminId,
                        E(`📥 <b>New Withdraw Request</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `👤 User   : <b>${uName}</b> (<code>${userId}</code>)\n` +
                        `💵 Amount : <b>$${payAmount}</b>\n` +
                        `💳 Method : <b>${wMethodLabel}</b>\n` +
                        `📬 Number : <code>${toAddress}</code>\n` +
                        `📅 Date   : ${wReqManual.createdAt.toLocaleString()}`),
                        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
                            { text: 'Approve', callback_data: `wpay_approve:${wReqManual._id}`, icon_custom_emoji_id: _BTN_EM.approve.id, style: 'success' },
                            { text: 'Reject',  callback_data: `wpay_reject:${wReqManual._id}`,  icon_custom_emoji_id: _BTN_EM.reject.id,  style: 'danger'  },
                        ]]}}
                    ).catch(() => {});
                }
                return;
            }

            // ── AUTO-PAY METHODS (BEP20 / TRX / Binance) ──
            // Create DB record
            const wReq = await WithdrawRequest.create({
                userId, username: msg.from.username || '', firstName: msg.from.first_name || '',
                amount, walletMethod: wMethod, walletAddress: toAddress, status: 'processing',
            });
            delete user_states[userId];

            // Tell user payment is processing
            bot.sendMessage(chatId,
                E(`⏳ <b>Processing Payment...</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `💵 Amount : <b>$${payAmount} USDT</b>\n` +
                `📬 Address: <code>${toAddress}</code>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🔄 Please wait a moment...`),
                { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard(userId) }
            );

            // ── AUTO PAYMENT via Alif API ──
            let apiResult = null;
            let paySuccess = false;
            try {
                const axios = require('axios');
                const network = wMethod === 'TRX' ? 'trx' : 'bnb';
                const apiUrl = `${ALIF_API_BASE_URL}?key=${encodeURIComponent(ALIF_API_KEY)}&network=${network}&token=USDT&to=${encodeURIComponent(toAddress)}&amount=${payAmount}`;
                const apiRes = await axios.get(apiUrl, { timeout: 30000 });
                apiResult = apiRes.data;
                if (apiResult && apiResult.status === true && apiResult.data && apiResult.data.txHash) {
                    paySuccess = true;
                }
            } catch (fetchErr) {
                const errData = fetchErr.response ? fetchErr.response.data : null;
                apiResult = errData || { error: fetchErr.message };
            }

            if (paySuccess) {
                // ✅ Payment SUCCESS
                const txData = apiResult.data;
                const txHashShort = txData.txHash.substring(0, 10) + '••••••••';
                const txDate = txData.timestamp
                    ? new Date(txData.timestamp).toISOString().replace('T', ' ').substring(0, 16)
                    : new Date().toISOString().replace('T', ' ').substring(0, 16);

                wReq.status = 'approved';
                wReq.txHash = txData.txHash;
                wReq.txLink = txData.txLink;
                wReq.blockNumber = txData.blockNumber;
                wReq.processedAt = new Date();
                await WithdrawRequest.findOneAndUpdate(
                    { _id: wReq._id },
                    { $set: { status: 'approved', txHash: txData.txHash, txLink: txData.txLink, blockNumber: txData.blockNumber, processedAt: wReq.processedAt } }
                );


                // Notify user with receipt
                bot.sendMessage(userId,
                    E(`✅ <b>Payment Successful Check wallet 💰</b>\n` +
                    `-----------------------------------------\n` +
                    `<blockquote>` +
                    `👤 User : <b>${uName}</b>\n\n` +
                    `‣ Amount  : <b>$${payAmount} USDT</b>\n\n` +
                    `</blockquote>` +
                    `<blockquote>` +
                    `‣ Network : <b>${wMethod === 'TRX' ? 'TRC20 (TRON)' : 'BEP20 (BSC)'}</b>\n` +
                    `‣ TxHash   : <code>${txHashShort}</code>\n` +
                    `‣ Date : <b>${txDate}</b>\n` +
                    `</blockquote>` +
                    `-----------------------------------------\n` +
                    `🎉 Your withdrawal has been Processed!`),
                    {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: '🔍View Details', url: txData.txLink, icon_custom_emoji_id: _BTN_EM.open_bot.id, style: 'primary' }, { text: '💰𝐏𝐫𝐨𝐨𝐟', url: PAY_GROUP_URL, icon_custom_emoji_id: _BTN_EM.open_bot.id, style: 'primary' }]] }
                    }
                ).catch(() => {});

                // ── গ্রুপে API auto-pay success নোটিফিকেশন (২ বাটন) ──
                {
                    const maskedAddr = maskAddress(toAddress);
                    const boardUrl = getBoardUrl(wMethod);
                    const _pNo = await getNextPaymentNo();
                    const _pTag = _pNo ? `#${_pNo} ` : '';
                    const groupSuccessText = E(`✅ <b>${_pTag}Payment Successful!</b>\n` +
    `----------------------------------------\n` +
    `<blockquote>` +
    `👤 User   : <b>${uName}</b> (<code>${userId}</code>)\n\n` +
    `‣ Amount : <b>$${payAmount} USDT</b>\n\n` +
    `</blockquote>` +
    `<blockquote>` +
    `‣ Method : <b>${wMethodLabel}</b>\n` +
    `‣ Address : <code>${maskedAddr}</code>\n` +
    `‣ Date    : <b>${txDate}</b>\n` +
    `</blockquote>` +
    `----------------------------------------\n` +
    `🎉 Payment processed via TEAM X4X`);
                    const groupAutoBtn = [];
                    if (txData.txLink) groupAutoBtn.push({ text: '🔍𝐏𝐚𝐲𝐦𝐞𝐧𝐭 𝐬𝐭𝐚𝐭𝐮𝐬', url: txData.txLink, icon_custom_emoji_id: _BTN_EM.open_bot.id, style: 'primary' });
                    if (boardUrl) groupAutoBtn.push({ text: "🤖𝐎𝐩𝐞𝐧 𝐁𝐨𝐭", url: `https://t.me/${bot_username}?start=start`, icon_custom_emoji_id: _BTN_EM.open_bot.id, style: 'primary' });
                    await sendWithdrawGroupMsg(groupSuccessText, groupAutoBtn);
                }

            } else {
                // ❌ Auto-payment FAILED — fall back to manual pending queue (do NOT refund yet, admin will decide)
                const errMsg = (apiResult && (apiResult.error || apiResult.msg)) || 'Unknown error';

                wReq.status = 'pending';
                wReq.failReason = errMsg;
                await WithdrawRequest.findOneAndUpdate(
                    { _id: wReq._id },
                    { $set: { status: 'pending', failReason: errMsg } }
                );

                // Notify user that it's now pending manual review
                bot.sendMessage(userId,
                    E(`✅ <b>Withdrawal Request pending!</b>\n` +
                    `---------------------------------------\n` +
                    `‣ User : <b>${uName}</b>\n` +
                    `‣ User   : <b>${uName}</b> (<code>${userId}</code>)\n` +
                    `‣ Amount: <b>$${payAmount}</b>\n\n` +
                    `‣ Method: <b>${wMethodLabel}</b>\n` +
                    `‣ Address: <code>${toAddress}</code>\n` +
                    `---------------------------------------\n` +
                    `⏳ Admin will process your request shortly.`),
                    { parse_mode: 'HTML' }
                ).catch(() => {});

                // BEP20 (static বা dynamic USDT_BEP20) gets a 3rd button to retry the API; others get 2-button manual flow
                const adminButtons = (wMethod === 'BEP20' || isDynBEP20)
                    ? [[
                        { text: 'Approve (Manual)', callback_data: `wpay_manual:${wReq._id}`, icon_custom_emoji_id: _BTN_EM.approve.id, style: 'success' },
                        { text: 'Approve via API',  callback_data: `wpay_retry_api:${wReq._id}`, icon_custom_emoji_id: _BTN_EM.restart.id, style: 'primary' },
                      ], [
                        { text: 'Reject', callback_data: `wpay_reject:${wReq._id}`, icon_custom_emoji_id: _BTN_EM.reject.id, style: 'danger' },
                      ]]
                    : [[
                        { text: 'Approve', callback_data: `wpay_approve:${wReq._id}`, icon_custom_emoji_id: _BTN_EM.approve.id, style: 'success' },
                        { text: 'Reject',  callback_data: `wpay_reject:${wReq._id}`,  icon_custom_emoji_id: _BTN_EM.reject.id,  style: 'danger'  },
                      ]];

                // Notify admin to process manually (or retry API for BEP20)
                for (const adminId of ADMIN_IDS) {
                    bot.sendMessage(adminId,
                        E(`⚠️ <b>Auto Payment Failed — Needs Manual Review</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `👤 User   : <b>${uName}</b> (<code>${userId}</code>)\n` +
                        `💵 Amount : <b>$${payAmount} USDT</b>\n` +
                        `💳 Method : <b>${wMethodLabel}</b>\n` +
                        `📬 Address: <code>${toAddress}</code>\n` +
                        `⚠️ Error  : <b>${errMsg}</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `👇 Choose an action below.`),
                        { parse_mode: 'HTML', reply_markup: { inline_keyboard: adminButtons } }
                    ).catch(() => {});
                }
            }
            return;
        }
        // ── BONUS: Add new REF level ──────────────────────────────────────
        if (user_states[userId] === 'BONUS_ADD_LEVEL' && isAdmin(userId)) {
            const parts = (text || '').trim().split(/\s+/);
            if (parts.length !== 2) {
                bot.sendMessage(chatId, `❌ সঠিক ফরম্যাটে দিন:\n<code>minRefs commission</code>\nযেমন: <code>250 0.0012</code>`, { parse_mode: 'HTML' });
                return;
            }
            const minRefs = parseInt(parts[0]);
            const commission = parseFloat(parts[1]);
            if (isNaN(minRefs) || isNaN(commission) || minRefs < 0 || commission <= 0) {
                bot.sendMessage(chatId, `❌ ভ্যালিড নম্বর দিন।`, { parse_mode: 'HTML' });
                return;
            }
            REF_LEVELS.push({ level: REF_LEVELS.length + 1, minRefs, commission });
            REF_LEVELS.sort((a, b) => a.minRefs - b.minRefs);
            REF_LEVELS.forEach((l, i) => { l.level = i + 1; });
            if (isUserDBReady) {
                await ConfigModel.findOneAndUpdate(
                    { key: 'ref_levels' },
                    { value: JSON.stringify(REF_LEVELS) },
                    { upsert: true }
                );
            }
            delete user_states[userId];
            bot.sendMessage(chatId,
                `✅ <b>নতুন Level যোগ হয়েছে!</b>\n👥 Min Refs: <b>${minRefs}</b>\n💵 Commission: <b>$${commission.toFixed(4)}</b>`,
                { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
            );
            return;
        }
        // ── BONUS: Edit commission of existing level ──────────────────────
        if (typeof user_states[userId] === 'string' && user_states[userId].startsWith('BONUS_EDIT_LEVEL:') && isAdmin(userId)) {
            const levelIdx = parseInt(user_states[userId].replace('BONUS_EDIT_LEVEL:', ''));
            const newCommission = parseFloat((text || '').trim());
            if (isNaN(newCommission) || newCommission <= 0) {
                bot.sendMessage(chatId, `❌ ভ্যালিড commission দিন। যেমন: <code>0.0015</code>`, { parse_mode: 'HTML' });
                return;
            }
            if (!REF_LEVELS[levelIdx]) {
                bot.sendMessage(chatId, `❌ Level পাওয়া যায়নি।`, { reply_markup: getAdminMenuKeyboard() });
                delete user_states[userId];
                return;
            }
            REF_LEVELS[levelIdx].commission = newCommission;
            if (isUserDBReady) {
                await ConfigModel.findOneAndUpdate(
                    { key: 'ref_levels' },
                    { value: JSON.stringify(REF_LEVELS) },
                    { upsert: true }
                );
            }
            delete user_states[userId];
            bot.sendMessage(chatId,
                `✅ <b>Level ${REF_LEVELS[levelIdx].level} আপডেট!</b>\n💵 নতুন Commission: <b>$${newCommission.toFixed(4)}</b>`,
                { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
            );
            return;
        }
        // ── BONUS: Edit minRefs of existing level ─────────────────────────
        if (typeof user_states[userId] === 'string' && user_states[userId].startsWith('BONUS_EDIT_MINREFS:') && isAdmin(userId)) {
            const levelIdx = parseInt(user_states[userId].replace('BONUS_EDIT_MINREFS:', ''));
            const newMinRefs = parseInt((text || '').trim());
            if (isNaN(newMinRefs) || newMinRefs < 0) {
                bot.sendMessage(chatId, `❌ ভ্যালিড minRefs দিন। যেমন: <code>300</code>`, { parse_mode: 'HTML' });
                return;
            }
            if (!REF_LEVELS[levelIdx]) {
                bot.sendMessage(chatId, `❌ Level পাওয়া যায়নি।`, { reply_markup: getAdminMenuKeyboard() });
                delete user_states[userId];
                return;
            }
            REF_LEVELS[levelIdx].minRefs = newMinRefs;
            REF_LEVELS.sort((a, b) => a.minRefs - b.minRefs);
            REF_LEVELS.forEach((l, i) => { l.level = i + 1; });
            if (isUserDBReady) {
                await ConfigModel.findOneAndUpdate(
                    { key: 'ref_levels' },
                    { value: JSON.stringify(REF_LEVELS) },
                    { upsert: true }
                );
            }
            delete user_states[userId];
            bot.sendMessage(chatId,
                `✅ <b>Level আপডেট!</b>\n👥 নতুন Min Refs: <b>${newMinRefs}</b>`,
                { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
            );
            return;
        }


        // ── LB BONUS: Set bonus amount for 1st/2nd/3rd ────────────────────
        if (typeof user_states[userId] === 'string' && user_states[userId].startsWith('LB_BONUS_SET:') && isAdmin(userId)) {
            const rank = user_states[userId].replace('LB_BONUS_SET:', ''); // 'first' | 'second' | 'third'
            const val  = parseFloat((text || '').trim());
            if (isNaN(val) || val < 0) {
                return bot.sendMessage(chatId, `❌ ভ্যালিড পরিমাণ দিন (যেমন: <code>0.50</code>)`, { parse_mode: 'HTML' });
            }
            LB_BONUS[rank] = val;
            await saveLbBonus();
            delete user_states[userId];
            const rankNames = { first: '🥇 ১ম', second: '🥈 ২য়', third: '🥉 ৩য়' };
            bot.sendMessage(chatId,
                `✅ <b>${rankNames[rank]} স্থানের বোনাস আপডেট হয়েছে!</b>\n💵 নতুন বোনাস: <b>$${val.toFixed(4)}</b>\n\n` +
                `🥇 ১ম: $${LB_BONUS.first.toFixed(4)}\n🥈 ২য়: $${LB_BONUS.second.toFixed(4)}\n🥉 ৩য়: $${LB_BONUS.third.toFixed(4)}`,
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🏆 LB Bonus Menu', callback_data: 'cfg_lb_bonus', style: 'success' }], [{ text: '🔙 Admin Menu', callback_data: 'sa_list_back', style: 'primary' }]] } }
            );
            return;
        }

        // ── DYNAMIC PAY METHOD: মেথডের নাম ইনপুট ──
        if (user_states[userId] === 'AWAITING_DYNPAY_NAME' && isAdmin(userId)) {
            const methodName = text.trim();
            if (!methodName || methodName.length < 2) {
                return bot.sendMessage(chatId, '❌ নাম কমপক্ষে ২ অক্ষরের হতে হবে।', { parse_mode: 'HTML' });
            }
            user_states[userId] = 'AWAITING_DYNPAY_ICON';
            user_states[userId + '_dynpay_pending'] = { label: methodName };
            return bot.sendMessage(chatId,
                E(`✅ নাম সেট: <b>${methodName}</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🎨 এখন একটি <b>প্রিমিয়াম ইমোজি</b> পাঠান এই মেথডের আইকন হিসেবে:\n\n` +
                `<i>প্রিমিয়াম ইমোজি না থাকলে "skip" লিখুন</i>`),
                { parse_mode: 'HTML', reply_markup: { keyboard: [[{ text: 'skip' }, { text: 'Stop', icon_custom_emoji_id: _BTN_EM.reject.id, style: 'danger' }]], resize_keyboard: true } }
            );
        }

        // ── DYNAMIC PAY METHOD: ইমোজি/আইকন ইনপুট ──
        if (user_states[userId] === 'AWAITING_DYNPAY_ICON' && isAdmin(userId)) {
            const pending = user_states[userId + '_dynpay_pending'];
            if (!pending) { delete user_states[userId]; return; }
            let customEmojiId = null;
            let emojiChar = '💳';
            if (msg.entities) {
                const ce = msg.entities.find(e => e.type === 'custom_emoji');
                if (ce) {
                    customEmojiId = ce.custom_emoji_id;
                    // premium emoji এর text content সরাসরি extract করো
                    // Telegram এ custom emoji পাঠালে text এ শুধু placeholder থাকে,
                    // তাই আগে text থেকে real Unicode emoji খোঁজো, না পেলে '💳' fallback
                    const _rawSlice = text.substring(ce.offset, ce.offset + ce.length);
                    const _emojiInText = text.match(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/u);
                    emojiChar = (_emojiInText && _emojiInText[0]) || _rawSlice || '💳';
                }
            }
            if (text.toLowerCase() !== 'skip') {
                pending.icon_custom_emoji_id = customEmojiId;
                pending.emoji = emojiChar;
            }
            user_states[userId] = 'AWAITING_DYNPAY_TYPE';
            user_states[userId + '_dynpay_pending'] = pending;
            return bot.sendMessage(chatId,
                E(`✅ আইকন সেট!\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `⚙️ এখন পেমেন্ট টাইপ সিলেক্ট করুন:`),
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[
                        { text: '🔶 USDT BEP20 (Auto API)', callback_data: `dynpay_type:USDT_BEP20:${userId}`, style: 'primary' },
                        { text: '✋ MANUAL', callback_data: `dynpay_type:MANUAL:${userId}`, style: 'success' }
                    ]] }
                }
            );
        }

        // ── DYNAMIC PAY METHOD EDIT: নতুন নাম ──
        if (user_states[userId] && typeof user_states[userId] === 'string' && user_states[userId].startsWith('AWAITING_DYNPAY_EDIT_NAME:') && isAdmin(userId)) {
            const dmId = user_states[userId].replace('AWAITING_DYNPAY_EDIT_NAME:', '');
            const newName = text.trim();
            const dmDoc = await DynamicPayMethod.findOne({ id: dmId });
            if (!dmDoc) { delete user_states[userId]; return; }
            if (newName.toLowerCase() !== 'same' && newName.length >= 2) {
                dmDoc.label = newName;
                await dmDoc.save();
            }
            user_states[userId] = `AWAITING_DYNPAY_EDIT_ICON:${dmId}`;
            return bot.sendMessage(chatId,
                E(`✅ নাম আপডেট: <b>${dmDoc.label}</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🎨 নতুন প্রিমিয়াম ইমোজি আইকন পাঠান:\n` +
                `<i>পরিবর্তন না করতে "skip" লিখুন</i>`),
                { parse_mode: 'HTML', reply_markup: { keyboard: [[{ text: 'skip' }, { text: 'Stop', icon_custom_emoji_id: _BTN_EM.reject.id, style: 'danger' }]], resize_keyboard: true } }
            );
        }

        // ── DYNAMIC PAY METHOD EDIT: নতুন আইকন ──
        if (user_states[userId] && typeof user_states[userId] === 'string' && user_states[userId].startsWith('AWAITING_DYNPAY_EDIT_ICON:') && isAdmin(userId)) {
            const dmId = user_states[userId].replace('AWAITING_DYNPAY_EDIT_ICON:', '');
            const dmDoc = await DynamicPayMethod.findOne({ id: dmId });
            if (!dmDoc) { delete user_states[userId]; return; }
            if (text.toLowerCase() !== 'skip' && msg.entities) {
                const ce = msg.entities.find(e => e.type === 'custom_emoji');
                if (ce) {
                    dmDoc.icon_custom_emoji_id = ce.custom_emoji_id;
                    dmDoc.emoji = text.substring(ce.offset, ce.offset + ce.length) || dmDoc.emoji;
                    await dmDoc.save();
                }
            }
            delete user_states[userId];
            await loadDynamicPayMethods();
            return bot.sendMessage(chatId,
                E(`✅ <b>${dmDoc.label}</b> আপডেট সম্পন্ন!\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `⚙️ টাইপ পরিবর্তন করতে চান? বর্তমান: <b>${dmDoc.type}</b>`),
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[
                        { text: '🔶 USDT BEP20', callback_data: `dynpay_edittype:USDT_BEP20:${dmId}`, style: 'primary' },
                        { text: '✋ MANUAL', callback_data: `dynpay_edittype:MANUAL:${dmId}`, style: 'success' },
                        { text: '✅ রাখুন', callback_data: 'admin_pay_method_view', style: 'success' }
                    ]] }
                }
            );
        }

} // এখানে if (user_states[userId]) ব্লকটি শেষ হয়েছে

    // সেক্টর ম্যানেজমেন্ট বাটন চাপলে যা হবে
    if (text === 'Platform' && isAdmin(userId)) {
        return bot.sendMessage(chatId, "⚙️ <b>সেক্টর ম্যানেজমেন্ট</b>\nনিচ থেকে কোনো সার্ভিস বন্ধ বা চালু করতে পারেন।", { 
            parse_mode: 'HTML', 
            reply_markup: getManageSectorsKeyboard() 
        });
    }

    // মেইনটেন্যান্স মুড চেক
    if (isMaintenanceMode && !isAdmin(userId)) {
        return bot.sendMessage(chatId, `<tg-emoji emoji-id="${_BTN_EM.maint_icon.id}">🛠</tg-emoji> <b>Maintenance Mode Active</b> <tg-emoji emoji-id="${_BTN_EM.maint_icon.id}">🛠</tg-emoji>\n\n<tg-emoji emoji-id="${_BTN_EM.maint_megaphone.id}">📣</tg-emoji> ${maintenanceMessage}`, { parse_mode: 'HTML' });
    }

    // মেইনটেন্যান্স বাটন হ্যান্ডলার
    if (text === 'Mainten' && isAdmin(userId)) {
        return bot.sendMessage(chatId, "🛠 <b>বট মেইনটেন্যান্স কন্ট্রোল</b>\n\nচালু থাকলে সাধারণ ইউজাররা বট ব্যবহার করতে পারবে না।", { 
            parse_mode: 'HTML', 
            reply_markup: getMaintenanceKeyboard() 
        });
    }

    if (text === 'Pay Method' && isAdmin(userId)) {
        return bot.sendMessage(chatId,
            E(`💳 <b>Pay Method Control</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🟢 = চালু &nbsp; 🔴 = বন্ধ\n\n` +
            `প্রতিটি পেমেন্ট মেথড আলাদাভাবে ON/OFF করুন।\n` +
            `Withdraw সম্পূর্ণ বন্ধ করতে নিচের বাটন ব্যবহার করুন।`),
            { parse_mode: 'HTML', reply_markup: getPayMethodKeyboard() }
        );
    }

    // মেইনটেন্যান্স মেসেজ সেভ করা
    if (user_states[userId] === 'AWAITING_MIN_WITHDRAW_LIMIT' && isAdmin(userId)) {
        delete user_states[userId];
        const newLimit = parseFloat(text);
        if (isNaN(newLimit) || newLimit <= 0) {
            return bot.sendMessage(chatId,
                E(`❌ <b>ভুল ইনপুট!</b>\n\nসঠিক সংখ্যা দিন। যেমন: <code>0.50</code> বা <code>1.00</code>`),
                { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
            );
        }
        minWithdrawLimit = newLimit;
        if (isUserDBReady) {
            await ConfigModel.findOneAndUpdate(
                { key: 'min_withdraw_limit' },
                { value: String(newLimit) },
                { upsert: true }
            );
        }
        return bot.sendMessage(chatId,
            E(`✅ <b>Minimum Withdraw Limit আপডেট হয়েছে!</b>\n\n` +
            `💲 নতুন লিমিট: <b>$${newLimit.toFixed(2)}</b>`),
            { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
        );
    }

    if (user_states[userId] === 'AWAITING_MAINTENANCE_MSG' && isAdmin(userId)) {
        maintenanceMessage = text;
        isMaintenanceMode = true;
        delete user_states[userId];

        if (isUserDBReady) {
            await ConfigModel.findOneAndUpdate({ key: "maint_mode" }, { value: "true" }, { upsert: true });
            await ConfigModel.findOneAndUpdate({ key: "maint_msg" }, { value: text }, { upsert: true });
        }
        return bot.sendMessage(chatId, "✅ Maintenance Mode চালু হয়েছে!", { reply_markup: getAdminMenuKeyboard() });
    }

    if (!text) return; // এখান থেকে আপনার পুরনো কোড শুরু হবে

    if (text === '/start' || text.startsWith('/start ')) {
        const refParam = text.split(' ')[1] || '';
        const refId = refParam.startsWith('ref_') ? Number(refParam.replace('ref_', '')) : null;

        // Ensure wallet user exists — নতুন হলে তৈরি হবে
        const wUser = await getWalletUser(userId, msg.from);

        // Process referral only once — নতুন user এবং আগে refer হয়নি
        if (refId && refId !== userId && isUserDBReady && wUser && !wUser.referredBy) {
            try {
                const referrer = await WalletUser.findOne({ telegramId: refId });
                if (referrer) {
                    // atomic update — race condition এড়ানোর জন্য findOneAndUpdate
                    const updated = await WalletUser.findOneAndUpdate(
                        { telegramId: userId, referredBy: null },
                        { $set: { referredBy: refId } },
                        { returnDocument: 'after' }
                    );
                    if (updated) {
                        // referredBy সফলভাবে সেট হয়েছে, এখন referrer-এর count বাড়াও
                        const updatedReferrer = await WalletUser.findOneAndUpdate(
                            { telegramId: refId },
                            { $inc: { referCount: 1 } },
                            { returnDocument: 'after' }
                        );
                        if (updatedReferrer) {
                            const newLvl = getReferralLevel(updatedReferrer.referCount);
                            bot.sendMessage(refId,
                                E(`🎉 <b>New Referral Joined!</b>\n` +
                                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                                `👤 <b>${escapeHtml(msg.from.first_name) || 'A user'}</b> joined via your link.\n` +
                                `👥 Total Referrals: <b>${updatedReferrer.referCount}</b>\n` +
                                `💡 Earn <b>$${newLvl.commission.toFixed(4)}</b> per OTP (Level ${newLvl.level})!`),
                                { parse_mode: 'HTML' }
                            ).catch(() => {});
                        }
                    }
                }
            } catch(e) {
                console.error('Referral error:', e.message);
            }
        }

        const welcomeText = buildWelcomeText(userId, msg.from);

        bot.sendMessage(chatId, welcomeText, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard(userId) });

    } else if (text === '/restart' && isAdmin(userId)) {
        user_states[userId] = 'AWAITING_PASS_FOR_RST';
        bot.sendMessage(chatId, "🔒 Enter Restart Password:", { 
            parse_mode: 'Markdown', 
            reply_markup: getAdminMenuKeyboard(true) 
        });

    } else if (text === 'Bonus' && isAdmin(userId)) {
        // REF_LEVELS দেখাও এবং এডিট/অ্যাড করার অপশন দাও
        const BADGES = ['🥇','🥈','🥉','💎','👑','🌟','⭐','🎖️','🏆','💠'];
        let msg = `🎁 <b>Referral Commission Levels</b>\n══════════════════════\n`;
        REF_LEVELS.forEach((lvl, idx) => {
            const badge = BADGES[idx] || '🔹';
            msg += `${badge} <b>Level ${lvl.level}</b> | MinRefs: <b>${lvl.minRefs}</b> | Commission: <b>$${lvl.commission.toFixed(4)}</b>/OTP\n`;
        });
        msg += `══════════════════════\n`;
        msg += `💡 নিচ থেকে যেকোনো Level এডিট করুন বা নতুন Level যোগ করুন।`;

        // বাটন তৈরি
        const keyboard = [];
        REF_LEVELS.forEach((lvl, idx) => {
            keyboard.push([
                { text: `L${lvl.level} Commission এডিট`, callback_data: `bonus_edit_comm:${idx}`, style: 'primary' },
                { text: `L${lvl.level} MinRefs এডিট`, callback_data: `bonus_edit_minrefs:${idx}`, style: 'primary' },
            ]);
        });
        keyboard.push([{ text: 'নতুন Level যোগ করুন', callback_data: 'bonus_add_level', style: 'success' }]);
        keyboard.push([{ text: 'শেষ Level মুছুন', callback_data: 'bonus_del_last', style: 'danger' }]);

        return bot.sendMessage(chatId, msg, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        });

    } else if (text === 'Pay Pending' && isAdmin(userId)) {
        if (!isUserDBReady) return bot.sendMessage(chatId, "❌ DB not ready.");
        const pending = await WithdrawRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(10);
        if (!pending.length) {
            return bot.sendMessage(chatId, `📥 <b>No Pending Withdrawals</b>`, { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() });
        }
        bot.sendMessage(chatId, E(`📥 <b>${pending.length} Pending Withdrawals:</b>`), { parse_mode: 'HTML' });
        for (const req of pending) {
            const kb = isMethodBEP20Type(req.walletMethod)
                ? [[
                    { text: 'Approve (Manual)', callback_data: `wpay_manual:${req._id}`, icon_custom_emoji_id: _BTN_EM.approve.id, style: 'success' },
                    { text: 'Approve via API',  callback_data: `wpay_retry_api:${req._id}`, icon_custom_emoji_id: _BTN_EM.restart.id, style: 'primary' },
                  ], [
                    { text: 'Reject', callback_data: `wpay_reject:${req._id}`, icon_custom_emoji_id: _BTN_EM.reject.id, style: 'danger' },
                  ]]
                : [[
                    { text: 'Approve', callback_data: `wpay_approve:${req._id}`, icon_custom_emoji_id: _BTN_EM.approve.id, style: 'success' },
                    { text: 'Reject',  callback_data: `wpay_reject:${req._id}`,  icon_custom_emoji_id: _BTN_EM.reject.id,  style: 'danger'  },
                  ]];
            await bot.sendMessage(chatId,
                E(`📥 <b>Withdraw Request</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `👤 <b>${req.firstName}</b> (<code>${req.userId}</code>)\n` +
                `💵 Amount: <b>$${req.amount.toFixed(4)}</b>\n` +
                `💳 Method: <b>${(dynamicPayMethods.find(dm => dm.id === req.walletMethod) || {}).label || req.walletMethod}</b>\n` +
                `📬 Address: <code>${req.walletAddress}</code>\n` +
                `📅 ${req.createdAt.toLocaleString()}`),
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } }
            );
        }

    } else if (text === 'Admin Menu' || text === '/admin') {
        if (!isAdmin(userId)) return; // non-admin কে কোনো response নেই
        delete user_states[userId];
        bot.sendMessage(chatId, "Admin Panel", { parse_mode: 'Markdown', reply_markup: getAdminMenuKeyboard() });

    } else if (text === 'Main Menu') {
        delete user_states[userId];
        bot.sendMessage(chatId, "Returning to Main Menu...", { reply_markup: getMainMenuKeyboard(userId) });

    } else if (text && text.startsWith('/setguide') && isAdmin(userId)) {
        // Usage: /setguide BEP20  (then send a photo)
        const parts = text.split(' ');
        const targetKey = parts[1] || '';
        if (!targetKey) {
            const keyList = WALLET_METHODS.map(m => `<code>/setguide ${m.key}</code>`).join('\n');
            return bot.sendMessage(chatId, `📸 <b>Set Guide Photo</b>\n\nUsage:\n${keyList}\n\nThen send the photo.`, { parse_mode: 'HTML' });
        }
        const validKey = WALLET_METHODS.find(m => m.key === targetKey) || dynamicPayMethods.find(dm => dm.id === targetKey);
        if (!validKey) return bot.sendMessage(chatId, `❌ Invalid method key: <code>${targetKey}</code>`, { parse_mode: 'HTML' });
        user_states[userId] = `AWAITING_GUIDE_PHOTO:${targetKey}`;
        bot.sendMessage(chatId, `📸 Now send the guide photo for <b>${validKey.label}</b>`, { parse_mode: 'HTML' });
    } else if (text === 'Token' && isAdmin(userId)) {
        user_states[userId] = 'AWAITING_PASS_FOR_TOKEN';
        bot.sendMessage(chatId, "🔒 Enter Password:", { reply_markup: getAdminMenuKeyboard(true) });

        } else if (text === '𝐒𝐮𝐩𝐩𝐨𝐫𝐭') {

            const markup = {
                inline_keyboard: [[
                    {
                        text: "Contact Admin",
                        url: `https://t.me/${SUPPORT_USERNAME}`,
                        icon_custom_emoji_id: _BTN_EM.contact_admin.id,
                        style: 'primary'
                    }
                ]]
            };

            bot.sendMessage(
                chatId,
                E("☎️ <b>𝐂𝐨𝐧𝐭𝐚𝐜𝐭 𝐒𝐮𝐩𝐩𝐨𝐫𝐭😎</b>\n\n<blockquote>👮<b>এডমিন অনলাইনে থাকলে অবশ্যই আপনাকে মেসেজ দিবে তাই বারবার মেসেজ না করে শুধু একটি মেসেজ দিয়ে অপেক্ষা করুন। ধন্যবাদ।</b> 🙏</blockquote>"),
                {
                    parse_mode: 'HTML',
                    reply_markup: markup
                }
            );


    } else if (text === 'Num Info' && isAdmin(userId)) {
        const rows = [
            [{ text: '⏳ Pending Schedule', callback_data: 'ni_pending', style: 'primary' }],
            [{ text: '🔢 All Number', callback_data: 'an_back', style: 'primary' }],
            [{ text: '🔙 Back', callback_data: 'ni_back', icon_custom_emoji_id: _BTN_EM.back_admin.id, style: 'primary' }]
        ];
        bot.sendMessage(chatId,
            `📋 <b>Num Info</b>\n━━━━━━━━━━━━━━━━━━━━━━━\nকী দেখতে চান?`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
        );

    } else if (text === 'Restart' && isAdmin(userId)) {
        user_states[userId] = 'AWAITING_PASS_FOR_RST';
        bot.sendMessage(chatId, "🔒 Enter Restart Password:", { 
            parse_mode: 'Markdown', 
            reply_markup: getAdminMenuKeyboard(true) 
        });

    } else if (text === 'ADD' && isAdmin(userId)) {
        user_states[userId] = 'ADDING_NUMBER_STEP_1';
        admin_file_buffer[userId] = { selected_sectors: [] };
        bot.sendMessage(chatId, "Add Number\nExcel ফাইল পাঠান:", { reply_markup: getAdminMenuKeyboard(true) });

    } else if (text === 'Broadcast' && isAdmin(userId)) {
        // দুইটা অপশন দেখাও — Send Broadcast অথবা Delete Broadcast
        await bot.sendMessage(chatId, '📢 <b>Broadcast Panel</b>\n\nকী করতে চান?', {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📤 Send Broadcast', callback_data: 'bc_send' }],
                    [{ text: '🗑️ Delete Broadcast', callback_data: 'bc_delete_list' }],
                    [{ text: '🛑 Stop Broadcast', callback_data: 'bc_stop' }]
                ]
            }
        });

    } else if ((text === 'Config') && isAdmin(userId)) {
        await sendSubAdminList(chatId);

    } else if (text === 'Bot Status' && isAdmin(userId)) {
        await sendAdminStatus(chatId);

    } else if (text === 'Find User' && isAdmin(userId)) {
        delete user_states[userId];
        await sendFindUserList(chatId, userId, 0);

    } else if (text === 'Delete' && isAdmin(userId)) {
        await rebuildCountryCache();
        bot.sendMessage(chatId, "কোন সেক্টর থেকে ডিলিট করবেন?", { parse_mode: 'Markdown', reply_markup: await getDeleteSectorKeyboard() });

    } else if (text === '𝐆𝐞𝐭 𝐍𝐮𝐦𝐛𝐞𝐫') {
        handleNumberSelectionStart(userId, '𝐆𝐞𝐭 𝐍𝐮𝐦𝐛𝐞𝐫');

    } else if (text === '𝐀𝐯𝐚𝐢𝐥𝐚𝐛𝐥𝐞 𝐒𝐞𝐫𝐯𝐢𝐜𝐞') {
        await sendStatus(chatId, userId);

    } else if (text === '𝐑𝐞𝐟𝐞𝐫 𝐅𝐫𝐢𝐞𝐧𝐝') {
        const wUser = await getWalletUser(userId, msg.from);
        const referLink = `https://t.me/${bot_username}?start=ref_${userId}`;
        const refs = wUser ? (wUser.referCount || 0) : 0;
        const curLvl = getReferralLevel(refs);
        const nextLvl = REF_LEVELS.find(l => l.minRefs > refs);
        const BADGES = ['🥇','🥈','🥉','💎','👑'];
        const maxRefs = 200;
        const filled = Math.min(Math.round((refs / maxRefs) * 10), 10);
        const bar = '█'.repeat(filled) + '👑'.repeat(10 - filled);
        const nextLine = nextLvl
            ? `🎯 <b>${nextLvl.minRefs - refs}</b> more referrals → ${BADGES[nextLvl.level - 1]} Level ${nextLvl.level}\n`
            : `👑 <b>MAX LEVEL REACHED!</b>\n`;

        let table = '';
        for (const lvl of REF_LEVELS) {
            const isCur = lvl.level === curLvl.level;
            const badge = BADGES[lvl.level - 1];
            const arrow = isCur ? '  ✦' : '';
            const b = isCur ? '<b>' : '';
            const be = isCur ? '</b>' : '';
            table += `${b}${badge} L${lvl.level}  $${lvl.commission.toFixed(4)}/OTP  (${lvl.minRefs}+ refs)${arrow}${be}\n`;
        }

        const notifStatus = wUser && wUser.commissionNotif === false ? '🔕 OFF' : '🔔 ON';
        bot.sendMessage(chatId,
            E(`🌟 <b>Referral Dashboard</b>\n` +
            `══════════════════════\n` +
            `${BADGES[curLvl.level - 1]} Rank: <b>Level ${curLvl.level}</b>\n` +
            `👥 Referrals: <b>${refs}</b>\n` +
            `💵 Balance: <b>$${(wUser ? wUser.balance : 0).toFixed(4)}</b>\n` +
            `📊 Progress: [${bar}] ${refs}/${maxRefs}\n\n` +
            nextLine +
            `──────────────────────\n` +
            `💠 <b>Commission Tiers</b>\n` +
            `──────────────────────\n` +
            table +
            `──────────────────────\n` +
            `💡 Every OTP your referral receives\n` +
            `    = instant commission for you!\n\n` +
            `🔗 <b>Your Invite Link:</b>\n` +
            `<code>${referLink}</code>\n\n` +
            `🔔 Commission Notification: <b>${notifStatus}</b>\n` +
            `/CommissionNotificationOFF\n` +
            `/CommissionNotificationON`),
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{
                        text: '🔗 Copy Invite Link',
                        copy_text: { text: referLink },
                        icon_custom_emoji_id: _BTN_EM.copy_link.id,
                        style: 'primary',
                    }]],
                }
            }
        );

    } else if (text === '/CommissionNotificationOFF' || text === '/commissionnotificationoff') {
        // ── Commission Notification বন্ধ করা ────────────────────────────
        if (isUserDBReady) {
            await WalletUser.findOneAndUpdate(
                { telegramId: userId },
                { $set: { commissionNotif: false } },
                { upsert: true }
            );
        }
        return bot.sendMessage(chatId,
            E(`🔕 <b>Commission Notification বন্ধ!</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `আপনি এখন থেকে Commission Notification পাবেন না।\n\n` +
            `আবার চালু করতে /CommissionNotificationON ব্যবহার করুন।`),
            { parse_mode: 'HTML' }
        );

    } else if (text === '/CommissionNotificationON' || text === '/commissionnotificationon') {
        // ── Commission Notification চালু করা ────────────────────────────
        if (isUserDBReady) {
            await WalletUser.findOneAndUpdate(
                { telegramId: userId },
                { $set: { commissionNotif: true } },
                { upsert: true }
            );
        }
        return bot.sendMessage(chatId,
            E(`🔔 <b>Commission Notification চালু!</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `আপনি এখন থেকে প্রতিটি Commission এর জন্য Notification পাবেন।\n\n` +
            `বন্ধ করতে /CommissionNotificationOFF ব্যবহার করুন।`),
            { parse_mode: 'HTML' }
        );

    } else if (text === '𝐋𝐞𝐚𝐝𝐞𝐫𝐛𝐨𝐚𝐫𝐝') {
        // ── Daily Leaderboard — Top 10 OTP senders today ──────────────
        if (!isStatusDBReady || !UserOtpStat) {
            return bot.sendMessage(chatId, E(`🏆 <b>লিডারবোর্ড</b>\n\n❌ ডেটাবেজ এখনো রেডি হয়নি।`), { parse_mode: 'HTML' });
        }
        try {
            const { msg, page, totalPages } = await buildLeaderboardMsg(userId, 0);
            bot.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: buildLeaderboardKb(page, totalPages) });
        } catch(e) {
            console.error('[leaderboard] Error:', e.message);
            bot.sendMessage(chatId, `❌ লিডারবোর্ড লোড করতে সমস্যা হয়েছে।`);
        }

    } else if (text === '𝐌𝐲 𝐖𝐚𝐥𝐥𝐞𝐭') {
        // ── Payment Proof Group Join Gate ────────────────────────────────
        // WITHDRAW_GROUP_ID গ্রুপে ইউজার জয়েন আছে কিনা চেক করো
        if (WITHDRAW_GROUP_ID) {
            let isInPayGroup = false;
            try {
                const member = await bot.getChatMember(WITHDRAW_GROUP_ID, userId);
                const status = member && member.status;
                isInPayGroup = ['member', 'administrator', 'creator'].includes(status);
            } catch (e) {
                isInPayGroup = false;
            }

            if (!isInPayGroup) {
                // জয়েন নেই → join link + Verify বাটন দেখাও, wallet দেখাবে না
                const payGroupLink = PAY_GROUP_URL;
                return bot.sendMessage(chatId,
                    E(`💰 <b>𝐖𝐚𝐥𝐥𝐞𝐭</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `⚠️ <b>Join Required!</b>\n\n` +
                    `𝐖𝐚𝐥𝐥𝐞𝐭 ব্যবহার করতে আমাদের\n` +
                    `<b>Payment Proof</b> গ্রুপে জয়েন করুন।\n\n` +
                    `👇 নিচের বাটনে ক্লিক করে জয়েন করুন,\n` +
                    `তারপর <b>✅ Verify</b> চাপুন।`),
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '👥 Join Payment Proof Group', url: payGroupLink }
                                ],
                                [
                                    { text: '✅ Verify', callback_data: 'wallet_verify_group' }
                                ]
                            ]
                        }
                    }
                );
            }
        }
        // ── জয়েন আছে → স্বাভাবিক Wallet দেখাও ──────────────────────────
        const wUser = await getWalletUser(userId, msg.from);
        if (!await validateUserWallet(chatId, userId, wUser)) return;
        const minW = minWithdrawLimit;
        const walletLine = (wUser && wUser.walletMethod && wUser.walletAddress)
            ? `💳 Method: <b>${(dynamicPayMethods.find(dm => dm.id === wUser.walletMethod) || {}).label || wUser.walletMethod}</b>\n📬 Address: <code>${maskAddress(wUser.walletAddress)}</code>`
            : `💳 𝐖𝐚𝐥𝐥𝐞𝐭: <i>Not set yet</i>`;
        const myOtpCount = await getUserOtpCount(userId);

        bot.sendMessage(chatId,
            E(`💰 <b>𝐖𝐚𝐥𝐥𝐞𝐭</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🆔 User ID: <code>${userId}</code>\n` +
            `💵 Balance: <b>$${(wUser ? wUser.balance : 0).toFixed(4)}</b>\n` +
            `📤 Total Withdrawn: <b>$${(wUser ? wUser.withdrawn : 0).toFixed(4)}</b>\n` +
            `👥 Referrals: <b>${wUser ? wUser.referCount : 0}</b>\n` +
            `📲 OTP Received: <b>${myOtpCount}</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚠️ Minimum Withdraw: <b>$${minW.toFixed(2)}</b>\n` +
            `🎁 Fee: <b>Free 0%</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `${walletLine}`),
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '𝗦𝗲𝘁 𝐖𝐚𝐥𝐥𝐞𝐭', icon_custom_emoji_id: _BTN_EM.set_wallet.id, style: 'primary', callback_data: 'wallet_set' },
                            { text: '𝐖𝐢𝐭𝐡𝐝𝐫𝐚𝐰', icon_custom_emoji_id: _BTN_EM.withdraw.id, style: 'success', callback_data: 'wallet_withdraw' },
                        ]
                    ]
                }
            }
        );
    }
});



// ===============================================
// 📌 END OF COMMAND HANDLER
// ===============================================

// ===============================================
// 📂 FILE PROCESSOR (UPDATED FOR SMART NAME & FLAG)
// ===============================================
async function processUploadedFile(userId, fileId, inputName) {
    if (!isNumberDBReady) {
        bot.sendMessage(userId, "❌ DB Connection Lost. Try again later.", { reply_markup: getAdminMenuKeyboard() });
        return;
    }

    bot.sendMessage(userId, "⏳ Processing (Smart Extract)...");

    let rawInput = inputName.trim();
    let flag = "🌍"; // Default Flag
    let countryName = cleanCountryName(rawInput);

    const flagRegex = /[\uD83C][\uDDE6-\uDDFF][\uD83C][\uDDE6-\uDDFF]/;
    const manualFlagMatch = rawInput.match(flagRegex);

    if (manualFlagMatch) {
       flag = manualFlagMatch[0];
        countryName = rawInput.replace(flag, '').trim(); 
    } else {
        const parts = rawInput.split(/\s+/);
        const firstWord = parts[0]; 
        const restOfText = parts.slice(1).join(' '); 

        const detectedFlag = countryEmoji.flag(firstWord);
        const detectedName = countryEmoji.name(firstWord);

        if (detectedFlag && detectedName) {

            flag = detectedFlag;
            countryName = restOfText ? `${detectedName} ${restOfText}` : detectedName;
        } else {
            flag = countryEmoji.flag(rawInput) || "🌍";
            countryName = rawInput;
        }
    }

    try {
        const fileLink = await bot.getFileLink(fileId);
        const { buffer, error: err } = await safeDownloadBuffer(fileLink);
        (async () => {
            if (err) {
                console.error("Number file download error:", err.message);
                bot.sendMessage(userId, "❌ Error. (Network/Download issue, try again)", { reply_markup: getAdminMenuKeyboard() });
                return;
            }
            try {
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

                let batchNumbers = [];
                let processedSet = new Set();

                jsonData.forEach(row => {
                    row.forEach(cell => {
                        if (cell) {
                            const cellText = String(cell).replace(/\+/g, '');
                            const matches = cellText.match(/\d+/g);

                            if (matches) {
                                matches.forEach(rawNum => {
                                    // শুধু ৮ সংখ্যার বেশি নাম্বার নেবে (৭ বা কম বাদ)
                                    if (rawNum.length >= 8) {
                                        // leading zeros বাদ দিয়ে clean করা
                                        const cleanNum = rawNum.replace(/^0+/, '') || rawNum;
                                        // + prefix যোগ করে সেভ করা
                                        const finalNum = '+' + cleanNum;
                                        if (!processedSet.has(finalNum)) {
                                            processedSet.add(finalNum);
                                            batchNumbers.push({
                                                number: finalNum,
                                                country: countryName,
                                                flag: flag,
                                                status: 'Available'
                                            });
                                        }
                                    }
                                });
                            }
                        }
                    });
                });

                if (batchNumbers.length > 0) {
                    try {
                        // insertMany এর বদলে bulkWrite — Used নাম্বারও Available-এ reset হবে
                        const ops = batchNumbers.map(doc => ({
                            updateOne: {
                                filter: { number: doc.number, sector: doc.sector || 'facebook' },
                                update: {
                                    $set: {
                                        status: 'Available',
                                        country: doc.country,
                                        flag: doc.flag,
                                        assigned_to: null,
                                        assigned_at: null
                                    },
                                    $setOnInsert: {
                                        number: doc.number,
                                        sector: doc.sector || 'facebook',
                                        created_at: new Date()
                                    }
                                },
                                upsert: true
                            }
                        }));
                        const result = await NumberModel.bulkWrite(ops, { ordered: false });
                        await rebuildCountryCache();

                        const addedCount = (result.upsertedCount || 0) + (result.modifiedCount || 0);

                        // ✅ Output Message Updated
                        const pFlagOld = getPremiumFlag(countryName, flag);
                        bot.sendMessage(userId, `✅ <b>Added Successfully!</b>\n📂 ${pFlagOld} ${countryName}\n🔢 Count: <code>${addedCount}</code>`, { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() });


                        const currentTime = Date.now();
                        const sessionDuration = 30 * 60 * 1000;

                        if (currentTime - last_add_timestamp > sessionDuration) {
                            add_session_data = [];
                        }

                        add_session_data.push({
                            flag: flag,
                            country: countryName,
                            count: addedCount
                        });

                        last_add_timestamp = currentTime;

                        let notificationMsg = `<tg-emoji emoji-id="5253744033875915388">✨</tg-emoji> <b>𝐅𝐫𝐞𝐬𝐡 𝐍𝐮𝐦𝐛𝐞𝐫 𝐀𝐝𝐝𝐞𝐝!</b>\n`;
                        notificationMsg += `━━━━━━━━━━━━━━━━━━━━\n`;

                        add_session_data.forEach(item => {
                            const nFlag = getPremiumFlag(item.country, item.flag);
                            notificationMsg += `<tg-emoji emoji-id="5343789187172670307">🌍</tg-emoji> <b>${item.country}</b> ${nFlag}\n`;
                            notificationMsg += `<tg-emoji emoji-id="6275857834127134596">📲</tg-emoji> Count: <b>${item.count}</b> <tg-emoji emoji-id="5224607267797606837">⚡</tg-emoji>\n`;
                        });

                        notificationMsg += `━━━━━━━━━━━━━━━━━━━━\n`;
                        notificationMsg += `<tg-emoji emoji-id="6235302918967269680">🚀</tg-emoji> <b>𝐓𝐫𝐚𝐟𝐟𝐢𝐜 𝐇𝐢𝐠𝐡.</b> <tg-emoji emoji-id="6235628846855492222">🔥</tg-emoji>\n`;
                        notificationMsg += `<tg-emoji emoji-id="5353025608832004653">🤖</tg-emoji> @${bot_username}`;

                        for (const channel of REQUIRED_CHANNELS) {
                            const chatID = channel.id;
                            if (last_channel_msg_ids[chatID]) {
                                try { await bot.deleteMessage(chatID, last_channel_msg_ids[chatID]); } catch (e) { console.log("Del msg fail"); }
                            }
                            try {
                                const sentMsg = await bot.sendMessage(chatID, notificationMsg, {
                                    parse_mode: 'HTML',
                                    reply_markup: {
                                        inline_keyboard: [[{
                                            text: '🤖 Open Bot',
                                            url: `https://t.me/${bot_username}?start=start`,
                                            icon_custom_emoji_id: '6080352185533602200',
                                            style: 'primary'
                                        }]]
                                    }
                                });
                                last_channel_msg_ids[chatID] = sentMsg.message_id;
                            } catch (e) { console.log("Send msg fail"); }
                        }

                    } catch (e) {
                        const count = e.insertedDocs ? e.insertedDocs.length : 0;
                        await rebuildCountryCache();
                        bot.sendMessage(userId, `⚠️ Partial Add!\nUnique Added: \`${count}\`\n(Duplicates ignored)`, { parse_mode: 'Markdown', reply_markup: getAdminMenuKeyboard() });
                    }
                } else {
                    bot.sendMessage(userId, `❌ No valid numbers found (Minimum 8 digits required).`, { reply_markup: getAdminMenuKeyboard() });
                }
            } catch (e) {
                console.error("Number file read error:", e.message);
                bot.sendMessage(userId, `❌ File Read Error.`, { reply_markup: getAdminMenuKeyboard() });
            }
        })();
    } catch (e) {
        console.error("Number file process error:", e.message);
        bot.sendMessage(userId, `❌ Process Error.`, { reply_markup: getAdminMenuKeyboard() });
    }
}

// ===============================================
// 🌍 AUTO COUNTRY DETECT FROM PHONE NUMBER
// ===============================================
// Phone prefix → country mapping (top countries)
// ===============================================
// 🌍 AUTO COUNTRY DETECT — libphonenumber-js
// ===============================================

function getCountryFlag(isoCode) {
    try {
        // ISO code থেকে flag emoji তৈরি (regional indicator letters)
        return isoCode.toUpperCase().replace(/./g, ch =>
            String.fromCodePoint(0x1F1E6 - 65 + ch.charCodeAt(0))
        );
    } catch(e) {
        return '🌍';
    }
}

function getCountryFullName(isoCode) {
    try {
        const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
        return displayNames.of(isoCode) || isoCode;
    } catch(e) {
        return isoCode;
    }
}

function detectCountryFromNumber(numStr) {
    try {
        // + এবং স্পেস clean করা
        let clean = numStr.replace(/\s/g, '');
        if (!clean.startsWith('+')) clean = '+' + clean.replace(/^0+/, '');

        const parsed = parsePhoneNumber(clean);
        if (parsed && parsed.country) {
            const isoCode = parsed.country;
            const fullName = getCountryFullName(isoCode);
            const flag = getCountryFlag(isoCode);
            return { country: fullName, flag: flag };
        }
    } catch(e) {}
    return null;
}

async function autoDetectCountryFromFile(userId, chatId, fileId) {
    try {
        const fileLink = await bot.getFileLink(fileId);
        const { buffer, error: err } = await safeDownloadBuffer(fileLink);
        (async () => {
            if (err) {
                console.error("autoDetectCountryFromFile download error:", err.message);
                bot.sendMessage(chatId, "❌ ফাইল পড়তে সমস্যা হয়েছে। (নেটওয়ার্ক/ডাউনলোড এরর, আবার চেষ্টা করুন)", { reply_markup: getAdminMenuKeyboard(true) });
                return;
            }
            try {
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

                // Extract numbers
                let numbers = [];
                let processedSet = new Set();
                jsonData.forEach(row => {
                    row.forEach(cell => {
                        if (cell) {
                            const cellText = String(cell).replace(/\+/g, '');
                            const matches = cellText.match(/\d+/g);
                            if (matches) {
                                matches.forEach(rawNum => {
                                    if (rawNum.length >= 8) {
                                        const cleanNum = rawNum.replace(/^0+/, '') || rawNum;
                                        const finalNum = '+' + cleanNum;
                                        if (!processedSet.has(finalNum)) {
                                            processedSet.add(finalNum);
                                            numbers.push(finalNum);
                                        }
                                    }
                                });
                            }
                        }
                    });
                });

                if (numbers.length === 0) {
                    bot.sendMessage(chatId, "❌ ফাইলে কোন নাম্বার পাওয়া যায়নি।", { reply_markup: getAdminMenuKeyboard(true) });
                    return;
                }

                // Detect country from first few numbers
                let detected = null;
                for (const num of numbers.slice(0, 10)) {
                    detected = detectCountryFromNumber(num);
                    if (detected) break;
                }

                // Save numbers in buffer
                admin_file_buffer[userId].numbers = numbers;

                if (detected) {
                    const realCountryName = cleanCountryName(detected.country);
                    const normalFlag = detected.flag;
                    const msgFlag = getPremiumFlag(realCountryName, normalFlag);
                    const entry = countryEmojiData[realCountryName];
                    const displayFlag = (entry && entry.n) ? entry.n : normalFlag;

                    admin_file_buffer[userId].country = realCountryName;
                    admin_file_buffer[userId].flag = normalFlag;

                    const confirmBtn = { text: `ADDT — ${displayFlag} ${realCountryName} (${numbers.length} নাম্বার)`, callback_data: 'confirm_country_auto', style: 'success' };
                    const emojiId = entry ? (entry.p1 || entry.p2 || null) : null;
                    if (emojiId) confirmBtn.icon_custom_emoji_id = emojiId;

                    const markup = {
                        inline_keyboard: [
                            [confirmBtn],
                            [{ text: "Edit Name", callback_data: 'edit_country_name', style: 'primary' }],
                            [{ text: "Cancel", callback_data: 'cancel_add', style: 'danger' }]
                        ]
                    };
                    bot.sendMessage(chatId,
                        `🌍 <b>Auto Detected:</b> ${msgFlag} ${realCountryName}\n📊 মোট নাম্বার: <b>${numbers.length}</b> টি\n\nএই নাম দিয়ে এড করবেন, নাকি নাম পরিবর্তন করবেন?`,
                        { parse_mode: 'HTML', reply_markup: markup }
                    );
                } else {
                    // Can't detect — ask manually
                    admin_file_buffer[userId].country = null;
                    const markup = {
                        inline_keyboard: [[{ text: "Cancel", callback_data: 'cancel_add', style: 'danger' }]]
                    };
                    bot.sendMessage(chatId,
                        `📊 মোট নাম্বার: <b>${numbers.length}</b> টি\n\n⚠️ দেশ বোঝা যায়নি। দেশের নাম লিখুন:`,
                        { parse_mode: 'HTML', reply_markup: markup }
                    );
                }
            } catch(e) {
                bot.sendMessage(chatId, "❌ ফাইল রিড এরর।", { reply_markup: getAdminMenuKeyboard(true) });
            }
        })();
    } catch(e) {
        console.error("autoDetectCountryFromFile process error:", e.message);
        bot.sendMessage(chatId, "❌ প্রসেস এরর।", { reply_markup: getAdminMenuKeyboard(true) });
    }
}


// ♾️ No Limit Re-Add Engine — Available ≤ 2 হলে silently re-add করো
const noLimitReAddInProgress = new Set(); // একসাথে দুইবার না চলে

async function checkNoLimitReAdd(countryName, sectorId) {
    if (!isNumberDBReady) return;
    const key = `${countryName}|${sectorId}`;
    if (noLimitReAddInProgress.has(key)) return;

    try {
        const availCount = await NumberModel.countDocuments({
            country: countryName,
            sector: sectorId,
            status: 'Available',
            no_limit: true
        });

        if (availCount > 2) return; // এখনো যথেষ্ট আছে

        // batch খুঁজে নাও
        const batch = await NoLimitBatch.findOne({
            country: countryName,
            sectors: sectorId
        }).lean();
        if (!batch) return;

        noLimitReAddInProgress.add(key);

        // silently re-add — Used/Used_History → Available reset করো
        const nums = batch.numbers || [];
        if (nums.length === 0) {
            noLimitReAddInProgress.delete(key);
            return;
        }

        const ops = nums.map(num => ({
            updateOne: {
                filter: { number: num, sector: sectorId },
                update: {
                    $set: {
                        status: 'Available',
                        country: countryName,
                        flag: batch.flag,
                        assigned_to: null,
                        assigned_at: null,
                        no_limit: true,
                        ...(batch.price !== null ? { price: batch.price } : {})
                    },
                    $setOnInsert: {
                        number: num,
                        sector: sectorId,
                        created_at: new Date()
                    }
                },
                upsert: true
            }
        }));

        await NumberModel.bulkWrite(ops, { ordered: false });
        await rebuildCountryCache();
        console.log(`[no-limit] ♾️ Re-added ${nums.length} numbers for ${countryName}/${sectorId}`);
    } catch(e) {
        console.error('[no-limit] checkNoLimitReAdd error:', e.message);
    } finally {
        noLimitReAddInProgress.delete(key);
    }
}

async function processUploadedFileMultiSector(userId, fileId, countryName, flag, sectors, preNumbers, price = null, noLimit = false) {
    if (!isNumberDBReady) {
        bot.sendMessage(userId, "❌ DB Connection Lost.", { reply_markup: getAdminMenuKeyboard() });
        return;
    }

    if (preNumbers && preNumbers.length > 0) {
        await _insertMultiSector(userId, preNumbers, countryName, flag, sectors, price, noLimit);
    } else {
        try {
            const fileLink = await bot.getFileLink(fileId);
            const { buffer, error: err } = await safeDownloadBuffer(fileLink);
            if (err) {
                console.error("processUploadedFileMultiSector download error:", err.message);
                bot.sendMessage(userId, "❌ ফাইল ডাউনলোড এরর। (নেটওয়ার্ক সমস্যা, আবার চেষ্টা করুন)", { reply_markup: getAdminMenuKeyboard() });
                return;
            }
            try {
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                let uniqueNumbers = [];
                let processedSet = new Set();
                jsonData.forEach(row => {
                    row.forEach(cell => {
                        if (cell) {
                            const cellText = String(cell).replace(/\+/g, '');
                            const matches = cellText.match(/\d+/g);
                            if (matches) matches.forEach(rawNum => {
                                if (rawNum.length >= 8) {
                                    const cleanNum = rawNum.replace(/^0+/, '') || rawNum;
                                    const finalNum = '+' + cleanNum;
                                    if (!processedSet.has(finalNum)) {
                                        processedSet.add(finalNum);
                                        uniqueNumbers.push(finalNum);
                                    }
                                }
                            });
                        }
                    });
                });
                if (uniqueNumbers.length === 0) {
                    bot.sendMessage(userId, "❌ ফাইলে কোন ভ্যালিড নাম্বার নেই।", { reply_markup: getAdminMenuKeyboard() });
                    return;
                }
                await _insertMultiSector(userId, uniqueNumbers, countryName, flag, sectors, price, noLimit);
            } catch(e) {
                console.error("processUploadedFileMultiSector read error:", e.message);
                bot.sendMessage(userId, "❌ ফাইল রিড এরর।", { reply_markup: getAdminMenuKeyboard() });
            }
        } catch(e) {
            console.error("processUploadedFileMultiSector process error:", e.message);
            bot.sendMessage(userId, "❌ প্রসেস এরর।", { reply_markup: getAdminMenuKeyboard() });
        }
    }
}

async function _insertMultiSector(userId, preNumbers, countryName, flag, sectors, price = null, noLimit = false) {
    const buf = admin_file_buffer[userId];
    let multiData = buf && buf.multiCountryData ? buf.multiCountryData : null;
    if (!multiData) {
        multiData = { [countryName]: { flag: flag, numbers: preNumbers } };
    }

    let reportLines = [];
    let addedItems = [];

    for (const sectorId of sectors) {
        const sectorInfo = SECTORS.find(s => s.id === sectorId);
        let sectorAddedCount = 0;

        for (const name in multiData) {
            const countryInfo = multiData[name];
            const ops = countryInfo.numbers.map(num => ({
                updateOne: {
                    filter: { number: num, sector: sectorId },
                    update: {
                        $set: {
                            // Used বা Used_History হলে Available-এ reset করো
                            status: 'Available',
                            country: name,
                            flag: countryInfo.flag,
                            assigned_to: null,
                            assigned_at: null,
                            no_limit: noLimit,
                            ...(price !== null ? { price } : {})
                        },
                        $setOnInsert: {
                            number: num,
                            sector: sectorId,
                            created_at: new Date()
                        }
                    },
                    upsert: true
                }
            }));

            try {
                const result = await NumberModel.bulkWrite(ops, { ordered: false });
                const addedOrReset = (result.upsertedCount || 0) + (result.modifiedCount || 0);
                if (addedOrReset > 0) {
                    sectorAddedCount += addedOrReset;
                    addedItems.push({ country: name, sector: sectorInfo.label, flag: countryInfo.flag });
                    // ── Atlas Sync ─────────────────────────────────────────────────────────
                    if (sync) sync.numberBulkUpsert({
                        numbers : countryInfo.numbers,
                        country : name,
                        flag    : countryInfo.flag,
                        sector  : sectorId,
                        price   : price || null,
                        no_limit: noLimit,
                    });
                }
            } catch(e) {}
        }
        reportLines.push(`${getSectorEmoji(sectorInfo)} ${sectorInfo.label}: ${sectorAddedCount} টি ✅`);
    }

    await rebuildCountryCache();
    const noLimitTag = noLimit ? `\n♾️ <b>No Limit mode চালু</b> — শেষ হলে auto re-add হবে` : '';
    bot.sendMessage(userId, `✅ <b>এড সম্পন্ন!</b>\n\n` + reportLines.join('\n') + noLimitTag, { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() });

    // নোটিফিকেশন ফাংশন কল করা
    if (addedItems.length > 0) {
        sendUpdateNotification(addedItems);
    }

    delete admin_file_buffer[userId];
    delete user_states[userId];
}


async function processBroadcast(msg) {
    const userId = msg.from.id;
    const totalUsers = bot_users.size;

    // ── ব্রডকাস্ট entry তৈরি ও stop flag রেজিস্টার ──
    const bcEntry = {
        id:          Date.now().toString(16) + Math.random().toString(16).slice(2, 8),
        sentAt:      Date.now(),
        fromChatId:  msg.chat.id,
        messageId:   msg.message_id,
        preview:     (msg.text || msg.caption || '[Media]').slice(0, 80),
        sentMsgIds:  []
    };
    activeBroadcasts[userId] = { stopped: false, bcId: bcEntry.id };

    const statusMsg = await bot.sendMessage(
        userId, 
        `📡 Broadcasting to ${totalUsers}...\n⏳ Estimated time: ${Math.ceil(totalUsers * 0.1)} seconds`, 
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '🛑 Stop Broadcast', callback_data: 'bc_stop_now' }]]
            }
        }
    );

    let success = 0, fail = 0, blocked = 0;
    const usersArray = Array.from(bot_users);
    const batchSize = 20;

    for (let i = 0; i < usersArray.length; i += batchSize) {
        // ── Stop চেক ──
        if (activeBroadcasts[userId]?.stopped) break;

        const batch = usersArray.slice(i, i + batchSize);

        await Promise.all(batch.map(async (targetId) => {
            if (ADMIN_IDS.includes(targetId)) return;

            try {
                const sent = await bot.copyMessage(targetId, msg.chat.id, msg.message_id);
                bcEntry.sentMsgIds.push({ userId: targetId, msgId: sent.message_id });
                success++;
            } catch (e) {
                if (e.response && e.response.statusCode === 403) {
                    blocked++;
                    bot_users.delete(targetId);
                } else {
                    fail++;
                }
            }
        }));

        await new Promise(r => setTimeout(r, 1000));

        if (i % 100 === 0 && i > 0) {
            try {
                await safeEditMessage(
                    userId, 
                    statusMsg.message_id, 
                    `📡 Broadcasting...\n✅ Sent: ${success}\n❌ Failed: ${fail}\n🚫 Blocked: ${blocked}\n⏳ Progress: ${Math.round((i / totalUsers) * 100)}%`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '🛑 Stop Broadcast', callback_data: 'bc_stop_now' }]]
                        }
                    }
                );
            } catch (e) {}
        }
    }

    const wasStopped = activeBroadcasts[userId]?.stopped;
    delete activeBroadcasts[userId];

    // ── history save করো ──
    bcEntry.successCount = success;
    broadcast_history.unshift(bcEntry);
    if (broadcast_history.length > 50) broadcast_history = broadcast_history.slice(0, 50);
    saveBroadcastHistory();

    // ১. স্ট্যাটাস মেসেজ এডিট করে ফাইনাল রেজাল্ট দেখাও
    const finalText = wasStopped
        ? `🛑 *Broadcast Stopped!*\n🟢 Sent: ${success}\n❌ Failed: ${fail}\n🚫 Blocked: ${blocked}`
        : `✅ *Broadcast Complete!*\n🟢 Success: ${success}\n🔴 Failed: ${fail}\n🚫 Blocked: ${blocked}`;

    await safeEditMessage(
        userId,
        statusMsg.message_id,
        finalText,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] } }
    );

    // ২. আগের Stop কিবোর্ড সরাও, তারপর এডমিন মেনু দাও
    await bot.sendMessage(userId, '✅ ব্রডকাস্ট সেশন শেষ।', {
        reply_markup: { remove_keyboard: true }
    });
    await bot.sendMessage(userId, 'Admin Menu:', {
        reply_markup: getAdminMenuKeyboard()
    });

    delete user_states[userId];
    syncSystem();
}

// ─── Last-resort HTML sanitizer ────────────────────────────────────────────
// যদি কোনোভাবে unclosed <tg-emoji> tag তৈরি হয়,
// পাঠানোর আগে সেটা সরিয়ে শুধু fallback text রাখে।
// এটা double-safety — getPremiumFlag fix-ই প্রধান সমাধান।
function sanitizeTelegramHTML(html) {
    if (!html) return html;
    // Step 1: valid pair গুলো placeholder দিয়ে replace করো (এগুলো ঠিক আছে)
    const pairs = [];
    let safe = html.replace(/<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>/g, (m) => {
        pairs.push(m);
        return '\x00PAIR' + (pairs.length - 1) + '\x00';
    });
    // Step 2: এখন safe-এ শুধু unclosed/orphan tag থাকতে পারে — সব সরাও
    safe = safe.replace(/<tg-emoji\b[^>]*>/g, '');   // orphan opening
    safe = safe.replace(/<\/tg-emoji>/g, '');          // orphan closing
    // Step 3: placeholder restore
    safe = safe.replace(/\x00PAIR(\d+)\x00/g, (_, i) => pairs[+i]);
    return safe;
}

async function sendStatus(chatId, userId = null) {
    const isAdminUser = userId ? isAdmin(userId) : true; // chatId দিয়ে কল হলে (পুরনো admin flow) ডিফল্ট admin ধরা হবে

    if (!isNumberDBReady) {
        bot.sendMessage(chatId, "⚠️ DB connecting...", { reply_markup: isAdminUser ? getAdminMenuKeyboard() : getMainMenuKeyboard(userId) });
        return;
    }

    try {
        // ডাটাবেস থেকে এভেলেবল নাম্বারের তথ্য সংগ্রহ
        const stats = await NumberModel.aggregate([
            { $match: { status: 'Available' } },
            { 
                $group: {
                    _id: { sector: "$sector", country: "$country" },
                    count: { $sum: 1 },
                    flag: { $first: "$flag" },
                    price: { $first: "$price" }
                }
            },
            { $sort: { "_id.sector": 1, "_id.country": 1 } }
        ]);

        let statusMsg = E(`<blockquote>🔥 <b>LIVE-STOCK STATUS.</b>💥</blockquote>\n`);
        if (isAdminUser) {
            statusMsg += `━━━━━<b>Total:</b> ${stats.reduce((sum, s) => sum + s.count, 0)}━━━━━\n`;
        }



        // সেক্টর অনুযায়ী ডাটা গ্রুপ করা
        const groupedStats = {};
        SECTORS.forEach(s => {
            groupedStats[s.id] = { 
                info: s, // পুরো সেক্টর অবজেক্ট রাখা হলো যাতে ইমোজি ফাংশন ব্যবহার করা যায়
                total: 0, 
                countries: [] 
            };
        });

        stats.forEach(res => {
            const sId = res._id.sector;
            if (groupedStats[sId]) {
                groupedStats[sId].total += res.count;
                groupedStats[sId].countries.push({
                    name: res._id.country,
                    count: res.count,
                    flag: res.flag,
                    price: res.price
                });
            }
        });

        let hasData = false;

        for (const sId in groupedStats) {
            const group = groupedStats[sId];

            if (group.total > 0) {
                hasData = true;

                const premiumPlatformEmoji = getSectorEmoji(group.info);

                const showCount =
                    isAdminUser && !adminHideCountSet.has(String(userId));

                const totalStr = showCount ? ` [${group.total}]` : '';

                // Platform + সব country একই blockquote
                let block = `<blockquote>${premiumPlatformEmoji} <b>${group.info.label}${totalStr}</b>\n`;

                group.countries.forEach(c => {
                    const pFlag = getPremiumFlag(c.name, c.flag);

                    const priceStr =
                        c.price != null && c.price > 0
                            ? ` — $${c.price}`
                            : '';

                    const countStr = showCount
                        ? ` (${c.count})`
                        : '';

                    block += ` └${pFlag} ${c.name}${countStr}${priceStr}\n`;
                });

                block += `</blockquote>`;

                statusMsg += block;
            }
        }

        if (!hasData) {
            statusMsg += E(`❌ বর্তমানে কোনো নাম্বার স্টক নেই।\n━━━━━━━━━━━━━━━━━\n`);
        }

        // নিচের স্ট্যাটাস অংশ — শুধু admin দেখবে (business metrics)
        if (isAdminUser) {
            const totalUsers = bot_users.size;
            const usedNumbers = await NumberModel.countDocuments({ status: 'Used' });

            statusMsg += E(`\n👥 <b>Total Users:</b> <code>${totalUsers}</code>\n`);
            statusMsg += E(`📢 <b>Broadcast:</b> ${totalUsers} users`);
            statusMsg += `\n━━━━━━━━━━━━━━━━━\n`;

            statusMsg += E(`🔴 <b>Active Lines:</b> <code>${usedNumbers}</code>`);
            statusMsg += E(`\n📅 <b>Date:</b> <code>${new Date().toLocaleDateString()}</code>`);
            statusMsg += `\n━━━━━━━━━━━━━━━━━\n`;
            statusMsg += E(`🤖 <b>Bot:</b> @${bot_username}`);
            statusMsg += E(`\n💡 <b>Developed By:</b> @alifhosson`);
            statusMsg += `\n━━━━━━━━━━━━━━━━━\n`;
        } else {
            statusMsg += E(`\n📅 <b>Date:</b> <code>${new Date().toLocaleDateString()}</code>`);
            statusMsg += `\n━━━━━━━━━━━━━━━━━\n`;
        }




        // ─── পাঠানোর আগে broken tg-emoji tag sanitize ───────────────
        statusMsg = sanitizeTelegramHTML(statusMsg);

        // মেসেজ পাঠানো
        if (isAdminUser) {
            const isHidden = adminHideCountSet.has(String(userId));
            bot.sendMessage(chatId, statusMsg, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{
                        text: isHidden ? '🔢 Hi T Count: OFF' : '🔢 Hi T Count: ON',
                        callback_data: 'hitcount_toggle',
                        style: isHidden ? 'danger' : 'success'
                    }]]
                }
            });
        } else {
            bot.sendMessage(chatId, statusMsg, {
                parse_mode: 'HTML',
                reply_markup: getMainMenuKeyboard(userId)
            });
        }

    } catch (error) {
        console.error("Status Error:", error);
        bot.sendMessage(chatId, "❌ স্ট্যাটাস রিপোর্ট লোড করতে সমস্যা হয়েছে।");
    }
}

// ── Find User — ব্যালেন্স আছে এমন ইউজার লিস্ট (পেজিনেশন: ২০ জন, ২ কলাম) ──────────
const FIND_USER_PAGE_SIZE = 20;

async function sendFindUserList(chatId, adminId, page, msgId = null) {
    try {
        const skip = page * FIND_USER_PAGE_SIZE;
        const users = await WalletUser.find({ balance: { $gt: 0 } })
            .sort({ balance: -1 })
            .skip(skip)
            .limit(FIND_USER_PAGE_SIZE)
            .lean();

        const total = await WalletUser.countDocuments({ balance: { $gt: 0 } });
        const totalPages = Math.ceil(total / FIND_USER_PAGE_SIZE);

        if (!users.length) {
            return bot.sendMessage(chatId, '📋 কোনো ইউজার পাওয়া যায়নি।', { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() });
        }

        // ২টা করে UID প্রতি লাইনে
        const rows = [];
        for (let i = 0; i < users.length; i += 2) {
            const row = [];
            const u1 = users[i];
            row.push({ text: `${u1.firstName || u1.username || 'User'} (${u1.telegramId})`, callback_data: `fu_view:${u1.telegramId}:${page}`, style: 'primary' });
            if (users[i + 1]) {
                const u2 = users[i + 1];
                row.push({ text: `${u2.firstName || u2.username || 'User'} (${u2.telegramId})`, callback_data: `fu_view:${u2.telegramId}:${page}`, style: 'primary' });
            }
            rows.push(row);
        }

        // Prev / Next / Find বাটন
        const navRow = [];
        if (page > 0) {
            navRow.push({ text: `⬅️ Prev (${page}/${totalPages})`, callback_data: `fu_page:${page - 1}`, style: 'primary' });
        }
        if (page + 1 < totalPages) {
            navRow.push({ text: `Next ➡️ (${page + 2}/${totalPages})`, callback_data: `fu_page:${page + 1}`, style: 'success' });
        }
        if (navRow.length > 0) rows.push(navRow);
        rows.push([{ text: '🔍 Find', callback_data: 'fu_search', style: 'primary' }, { text: '🔙 Back', callback_data: 'back_to_admin', style: 'primary' }]);

        const text = `👥 <b>Find User</b> — ব্যালেন্স আছে এমন ইউজার\n📊 মোট: <b>${total}</b> জন | পেজ: <b>${page + 1}/${totalPages || 1}</b>`;
        const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } };

        // msgId থাকলে edit করো, না থাকলে নতুন পাঠাও
        if (msgId) {
            await safeEditMessage(chatId, msgId, text, opts);
        } else {
            await bot.sendMessage(chatId, text, opts);
        }
    } catch (e) {
        console.error('[sendFindUserList]', e.message);
        bot.sendMessage(chatId, '❌ লোড করতে সমস্যা হয়েছে।');
    }
}

async function sendFindUserResult(chatId, adminId, query) {
    try {
        let user = null;
        const numId = Number(query);
        if (!isNaN(numId) && numId > 0) {
            user = await WalletUser.findOne({ telegramId: numId }).lean();
        }
        if (!user) {
            const uname = query.replace('@', '');
            user = await WalletUser.findOne({ username: { $regex: new RegExp('^' + uname + '$', 'i') } }).lean();
        }
        if (!user) {
            return bot.sendMessage(chatId, `❌ ইউজার পাওয়া যায়নি: <code>${query}</code>`, { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() });
        }
        await sendUserDetailCard(chatId, adminId, user.telegramId);
    } catch (e) {
        console.error('[sendFindUserResult]', e.message);
        bot.sendMessage(chatId, '❌ সমস্যা হয়েছে।');
    }
}

async function sendUserDetailCard(chatId, adminId, targetId, msgId = null, fromPage = 0) {
    try {
        const user = await WalletUser.findOne({ telegramId: targetId }).lean();
        if (!user) return bot.sendMessage(chatId, '❌ ইউজার পাওয়া যায়নি।', { reply_markup: getAdminMenuKeyboard() });

        let otpCount = 0;
        if (UserOtpStat) {
            const stat = await UserOtpStat.findOne({ userId: targetId }).lean();
            otpCount = stat ? (stat.otpCount || 0) : 0;
        }

        const name = user.firstName || user.username || 'Unknown';
        const uname = user.username ? `@${user.username}` : 'N/A';
        const text =
            `👤 <b>User Info</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🆔 UID: <code>${user.telegramId}</code>\n` +
            `📛 নাম: <b>${name}</b>\n` +
            `🔗 Username: ${uname}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `💰 Balance: <b>$${(user.balance || 0).toFixed(4)}</b>\n` +
            `📤 Total Withdraw: <b>$${(user.withdrawn || 0).toFixed(4)}</b>\n` +
            `📩 Total OTP: <b>${otpCount}</b>\n` +
            `👥 Referrals: <b>${user.referCount || 0}</b>\n` +
            `📅 Joined: ${user.joinedAt ? user.joinedAt.toLocaleDateString('en-GB') : 'N/A'}`;

        const kb = {
            inline_keyboard: [
                [
                    { text: '➕ Add Balance', callback_data: `fu_add:${targetId}:${fromPage}`, style: 'success' },
                    { text: '➖ Remove Balance', callback_data: `fu_rem:${targetId}:${fromPage}`, style: 'danger' }
                ],
                [{ text: '🔙 Back to List', callback_data: `fu_back:${fromPage}`, style: 'primary' }]
            ]
        };

        const opts = { parse_mode: 'HTML', reply_markup: kb };
        if (msgId) {
            await safeEditMessage(chatId, msgId, text, opts);
        } else {
            await bot.sendMessage(chatId, text, opts);
        }
    } catch (e) {
        console.error('[sendUserDetailCard]', e.message);
        bot.sendMessage(chatId, '❌ সমস্যা হয়েছে।');
    }
}

// ── Admin Bot Status — সব metrics একসাথে ─────────────────────────────
async function buildAdminStatusText() {
    const now = new Date();
    const dateStr = now.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true });

    // ── DB থেকে data আনা ──
    const [totalUsers, totalNumbers, availNumbers, usedNumbers, historyNumbers,
           pendingReqs, approvedAgg, pendingAgg, stat, totalOtpHistory, walletAgg] = await Promise.all([
        isUserDBReady   ? UserModel.countDocuments()                             : Promise.resolve(0),
        isNumberDBReady ? NumberModel.countDocuments()                           : Promise.resolve(0),
        isNumberDBReady ? NumberModel.countDocuments({ status: 'Available' })    : Promise.resolve(0),
        isNumberDBReady ? NumberModel.countDocuments({ status: 'Used' })         : Promise.resolve(0),
        isNumberDBReady ? NumberModel.countDocuments({ status: 'Used_History' }) : Promise.resolve(0),
        isUserDBReady   ? WithdrawRequest.countDocuments({ status: 'pending' })  : Promise.resolve(0),
        isUserDBReady   ? WithdrawRequest.aggregate([
            { $match: { status: 'approved' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]) : Promise.resolve([]),
        isUserDBReady   ? WithdrawRequest.aggregate([
            { $match: { status: 'pending' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]) : Promise.resolve([]),
        getBotStat(),
        isStatusDBReady && OtpHistory ? OtpHistory.countDocuments() : Promise.resolve(0),
        isUserDBReady   ? WalletUser.aggregate([
            { $match: { balance: { $gt: 0 } } },
            { $group: { _id: null, total: { $sum: '$balance' } } }
        ]) : Promise.resolve([]),
    ]);

    const totalPaid        = approvedAgg[0]?.total || 0;
    const totalPendingAmt  = pendingAgg[0]?.total  || 0;
    const totalOtp         = stat?.totalOtp || totalOtpHistory || 0;
    const totalWalletBal   = walletAgg[0]?.total   || 0;

    // Premium emoji helper shortcut
    const pe = (id, em) => `<tg-emoji emoji-id="${id}">${em}</tg-emoji>`;

    return (
        `<blockquote>${pe('5226711870492126219','📊')} <b>BOT LIVE STATUS</b>\n🕐 ${dateStr} (BD)</blockquote>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${pe('5453957997418004470','👥')} <b>Users</b>\n` +
        ` ├ মোট ইউজার      : <code>${totalUsers}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${pe('5224607267797606837','📱')} <b>Numbers</b>\n` +
        ` ├ মোট নাম্বার     : <code>${totalNumbers}</code>\n` +
        ` ├ Available       : <code>${availNumbers}</code>\n` +
        ` ├ Active (Used)   : <code>${usedNumbers}</code>\n` +
        ` └ History         : <code>${historyNumbers}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${pe('5443127283898405358','📲')} <b>OTP</b>\n` +
        ` └ মোট OTP Received: <code>${totalOtp}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${pe('5373174941095050893','💰')} <b>Payment</b>\n` +
        ` ├ মোট Paid        : <code>$${totalPaid.toFixed(4)}</code>\n` +
        ` ├ Pending Amount  : <code>$${totalPendingAmt.toFixed(4)}</code>\n` +
        ` ├ Pending Requests: <code>${pendingReqs}</code>\n` +
        ` └ Total Wallet Bal: <code>$${totalWalletBal.toFixed(4)}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${pe('5238132025323444613','🤖')} <b>Bot:</b> @${bot_username}`
    );
}

async function sendAdminStatus(chatId, msgId = null) {
    const refreshBtn = { inline_keyboard: [[
        { text: '🔄 Refresh', callback_data: 'admin_stat_refresh' }
    ]]};

    try {
        const text = await buildAdminStatusText();
        if (msgId) {
            // edit করো (refresh)
            await safeEditMessage(chatId, msgId, text, { parse_mode: 'HTML', reply_markup: refreshBtn });
        } else {
            await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: refreshBtn });
        }
    } catch(e) {
        console.error('sendAdminStatus error:', e.message);
        bot.sendMessage(chatId, '❌ Status লোড করতে সমস্যা হয়েছে।');
    }
}

// ===============================================
// 🟢 USER ACTIONS & CALLBACKS
// ===============================================
async function handleNumberSelectionStart(userId, text) {
    const { allowed, remaining } = isUserAllowedAction(userId);
    if (!allowed) { bot.sendMessage(userId, `Wait ${remaining}s.`, { parse_mode: 'Markdown' }); return; }

    if (!isNumberDBReady) {
        bot.sendMessage(userId, "⏳ System starting up... Please wait.", { parse_mode: 'Markdown' }); 
        return;
    }

    const currentNumber = await NumberModel.findOne({ assigned_to: userId, status: 'Used' });
    if (text === '𝐆𝐞𝐭 𝐍𝐮𝐦𝐛𝐞𝐫' && currentNumber) {
        let displayNum = currentNumber.number.startsWith('+') ? currentNumber.number : '+' + currentNumber.number;
        const sectorInfo = SECTORS.find(s => s.id === currentNumber.sector);
        const sectorLabel = sectorInfo ? `${getSectorEmoji(sectorInfo)} ${sectorInfo.label}` : currentNumber.sector || '';

    }

    // Show sector selection menu
    bot.sendMessage(userId, E('📱 কোন প্ল্যাটফর্মের জন্য নাম্বার নিবেন?'), { 
        parse_mode: 'HTML', 
        reply_markup: await getGetNumberSectorKeyboard() 
    });
}



// 🔥 OPTIMIZED CALLBACK HANDLER
bot.on('callback_query', async (call) => {
    const userId = call.from.id;
    const data = call.data;
    const msgId = call.message.message_id;
    const chatId = call.message.chat.id;

    // মেইনটেন্যান্স মুড চেক — এডমিন সব সময় ব্যবহার করতে পারবে
    if (isMaintenanceMode && !isAdmin(userId)) {
        await safeAnswerCallback(call.id, { text: '🛠 Maintenance Mode Active', show_alert: true });
        return bot.sendMessage(chatId, `<tg-emoji emoji-id="${_BTN_EM.maint_icon.id}">🛠</tg-emoji> <b>Maintenance Mode Active</b> <tg-emoji emoji-id="${_BTN_EM.maint_icon.id}">🛠</tg-emoji>\n\n<tg-emoji emoji-id="${_BTN_EM.maint_megaphone.id}">📣</tg-emoji> ${maintenanceMessage}`, { parse_mode: 'HTML' });
    }

    // ─── BROADCAST: Send Broadcast অপশন ────────────────────────────────────
    if (data === 'bc_send' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        // আগেরটা চলছে কিনা চেক করো
        if (activeBroadcasts[userId] && !activeBroadcasts[userId].stopped) {
            return bot.sendMessage(chatId,
                '⚠️ <b>একটি ব্রডকাস্ট এখনো চলছে!</b>\n\nআগেরটা শেষ হওয়ার পরে বা 🛑 Stop করার পরে নতুন ব্রডকাস্ট পাঠান।',
                { parse_mode: 'HTML' }
            );
        }
        user_states[userId] = 'BROADCASTING';
        return bot.sendMessage(chatId, '📤 Broadcast করতে চান এমন মেসেজটি পাঠান:', {
            reply_markup: getAdminMenuKeyboard(true)
        });
    }

    // ─── BROADCAST: Stop — Broadcast Panel থেকে ─────────────────────────────
    if (data === 'bc_stop' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const running = activeBroadcasts[userId];
        if (!running || running.stopped) {
            return safeEditMessage(chatId, msgId,
                '⚠️ <b>কোনো ব্রডকাস্ট চলছে না।</b>',
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
            );
        }
        activeBroadcasts[userId].stopped = true;
        return safeEditMessage(chatId, msgId,
            '🛑 <b>Stop সিগনাল পাঠানো হয়েছে।</b>\nচলমান ব্যাচ শেষ হলেই ব্রডকাস্ট থামবে।',
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
        );
    }

    // ─── BROADCAST: Stop Now — চলমান ব্রডকাস্টের নিচের বাটন থেকে ────────────
    if (data === 'bc_stop_now' && isAdmin(userId)) {
        await safeAnswerCallback(call.id, '🛑 Stop সিগনাল পাঠানো হয়েছে!');
        const running = activeBroadcasts[userId];
        if (running && !running.stopped) {
            activeBroadcasts[userId].stopped = true;
        }
        return;
    }

    // ─── BROADCAST: Delete Broadcast — লিস্ট দেখাও ──────────────────────────
    if (data === 'bc_delete_list' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        if (broadcast_history.length === 0) {
            return safeEditMessage(chatId, msgId,
                '📭 এখন পর্যন্ত কোনো broadcast পাঠানো হয়নি।',
                { reply_markup: { inline_keyboard: [] } }
            );
        }
        const rows = broadcast_history.map(bc => {
            const date = new Date(bc.sentAt);
            const label = `📨 ${date.toLocaleDateString('bn-BD')} ${date.toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })} — ${bc.preview.slice(0, 30)}`;
            return [{ text: label, callback_data: `bc_view:${bc.id}` }];
        });
        return safeEditMessage(chatId, msgId,
            '🗑️ <b>Delete Broadcast</b>\nকোন ব্রডকাস্টটি ডিলিট করতে চান?',
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
        );
    }

    // ─── BROADCAST: একটি ব্রডকাস্ট ফুল প্রিভিউ দেখাও ────────────────────────
    if (data.startsWith('bc_view:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const bcId = data.slice('bc_view:'.length);
        const bc = broadcast_history.find(b => b.id === bcId);
        if (!bc) return safeEditMessage(chatId, msgId, '❌ ব্রডকাস্ট খুঁজে পাওয়া যায়নি।');
        const date = new Date(bc.sentAt);
        const previewText =
            `📢 <b>Broadcast Preview</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📅 পাঠানো হয়েছে: <b>${date.toLocaleString('bn-BD')}</b>\n` +
            `👥 Recipients: <b>${bc.successCount || bc.sentMsgIds.length}</b> জন\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📝 Content:\n<code>${bc.preview}${bc.preview.length >= 80 ? '…' : ''}</code>`;
        return safeEditMessage(chatId, msgId, previewText, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🗑️ Delete', callback_data: `bc_confirm_del:${bc.id}` },
                        { text: '🚫 Ignore', callback_data: 'bc_delete_list' }
                    ]
                ]
            }
        });
    }

    // ─── BROADCAST: ডিলিট নিশ্চিত করো ───────────────────────────────────────
    if (data.startsWith('bc_confirm_del:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const bcId = data.slice('bc_confirm_del:'.length);
        const bc = broadcast_history.find(b => b.id === bcId);
        if (!bc) return safeEditMessage(chatId, msgId, '❌ ব্রডকাস্ট খুঁজে পাওয়া যায়নি।');

        await safeEditMessage(chatId, msgId,
            `⏳ <b>Deleting broadcast...</b>\n👥 ${bc.sentMsgIds.length} জনের কাছ থেকে মুছে ফেলা হচ্ছে...`,
            { parse_mode: 'HTML' }
        );

        let deleted = 0, delFail = 0;
        const batchSize = 20;
        for (let i = 0; i < bc.sentMsgIds.length; i += batchSize) {
            const batch = bc.sentMsgIds.slice(i, i + batchSize);
            await Promise.all(batch.map(async ({ userId: targetId, msgId: targetMsgId }) => {
                try {
                    await bot.deleteMessage(targetId, targetMsgId);
                    deleted++;
                } catch(e) { delFail++; }
            }));
            await new Promise(r => setTimeout(r, 500));
        }

        // history থেকে সরাও
        broadcast_history = broadcast_history.filter(b => b.id !== bcId);
        saveBroadcastHistory();

        return safeEditMessage(chatId, msgId,
            `✅ <b>Broadcast Deleted!</b>\n🗑️ মুছে গেছে: <b>${deleted}</b> জন\n❌ ব্যর্থ: <b>${delFail}</b> জন`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'bc_delete_list' }]] } }
        );
    }

    // ─── WALLET: Back → Wallet পেজে ফিরে যাও ────────────────────────────
    if (data === 'wallet_back') {
        await safeAnswerCallback(call.id);
        // আগের মেসেজ delete করো
        try { await bot.deleteMessage(chatId, msgId); } catch(e) {}

        const wUser = await getWalletUser(userId, call.from);
        await validateUserWallet(chatId, userId, wUser);
        const minW = minWithdrawLimit;
        const walletLine = (wUser && wUser.walletMethod && wUser.walletAddress)
            ? `💳 Method: <b>${(dynamicPayMethods.find(dm => dm.id === wUser.walletMethod) || {}).label || wUser.walletMethod}</b>\n📬 Address: <code>${maskAddress(wUser.walletAddress)}</code>`
            : `💳 Wallet: <i>Not set yet</i>`;
        const myOtpCount = await getUserOtpCount(userId);

        return bot.sendMessage(chatId,
            E(`💰 <b>Wallet</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🆔 User ID: <code>${userId}</code>\n` +
            `💵 Balance: <b>$${(wUser ? wUser.balance : 0).toFixed(4)}</b>\n` +
            `📤 Total Withdrawn: <b>$${(wUser ? wUser.withdrawn : 0).toFixed(4)}</b>\n` +
            `👥 Referrals: <b>${wUser ? wUser.referCount : 0}</b>\n` +
            `📲 OTP Received: <b>${myOtpCount}</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚠️ Minimum Withdraw: <b>$${minW.toFixed(2)}</b>\n` +
            `🎁 Fee: <b>Free 0%</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `${walletLine}`),
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '𝗦𝗲𝘁 𝐖𝐚𝐥𝐥𝐞𝐭', icon_custom_emoji_id: _BTN_EM.set_wallet.id, style: 'primary', callback_data: 'wallet_set' },
                            { text: '𝐖𝐢𝐭𝐡𝐝𝐫𝐚𝐰', icon_custom_emoji_id: _BTN_EM.withdraw.id, style: 'success', callback_data: 'wallet_withdraw' },
                        ]
                    ]
                }
            }
        );
    }

    // ─── LEADERBOARD PAGINATION & REFRESH ───────────────────────────────
    const lbMatch = data.match(/^leaderboard_(p|r)(\d+)$/);
    if (lbMatch) {
        const isRefresh = lbMatch[1] === 'r';
        const targetPage = parseInt(lbMatch[2]);
        await safeAnswerCallback(call.id, { text: isRefresh ? '🔄 Refreshing...' : '📄 Loading...' });
        if (!isStatusDBReady || !UserOtpStat) return;
        try {
            const { msg, page, totalPages } = await buildLeaderboardMsg(userId, targetPage);
            const kb = buildLeaderboardKb(page, totalPages);

            // লাস্ট পেজে Next ক্লিক করলে safePage = totalPages-1 হয়,
            // msg same হয় → "message is not modified" error আসে — সেটা ignore করো,
            // অন্য কোনো edit error হলে নতুন মেসেজ পাঠাও কিন্তু পুরনোটা delete করো না।
            try {
                await bot.editMessageText(msg, {
                    chat_id: chatId,
                    message_id: call.message.message_id,
                    parse_mode: 'HTML',
                    reply_markup: kb
                });
            } catch (editErr) {
                const desc = (editErr.response && editErr.response.body && editErr.response.body.description) || editErr.message || '';
                if (desc.includes('message is not modified')) {
                    // Same content — কিছু করার নেই, চুপ থাকো
                } else {
                    // অন্য edit error — নতুন মেসেজ পাঠাও (পুরনোটা delete না করে)
                    try {
                        await bot.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: kb });
                    } catch(e2) { console.error('[leaderboard] resend error:', e2.message); }
                }
            }
        } catch(e) {
            console.error('[leaderboard] Error:', e.message);
        }
        return;
    }

    // ─── WALLET: Payment Proof Group Join Verify ─────────────────────────
    if (data === 'wallet_verify_group') {
        await safeAnswerCallback(call.id);
        if (!WITHDRAW_GROUP_ID) return;

        let isInPayGroup = false;
        try {
            const member = await bot.getChatMember(WITHDRAW_GROUP_ID, userId);
            const status = member && member.status;
            isInPayGroup = ['member', 'administrator', 'creator'].includes(status);
        } catch (e) {
            isInPayGroup = false;
        }

        if (!isInPayGroup) {
            // এখনো জয়েন নেই
            const payGroupLink = PAY_GROUP_URL;
            return safeEditMessage(chatId, msgId,
                E(`💰 <b>Wallet</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `❌ <b>এখনো জয়েন হননি!</b>\n\n` +
                `আগে গ্রুপে জয়েন করুন,\n` +
                `তারপর <b>✅ Verify</b> চাপুন।`),
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '👥 Join Payment Proof Group', url: payGroupLink }
                            ],
                            [
                                { text: '✅ Verify', callback_data: 'wallet_verify_group' }
                            ]
                        ]
                    }
                }
            );
        }

        // জয়েন আছে → wallet দেখাও
        const wUser = await getWalletUser(userId, call.from);
        await validateUserWallet(chatId, userId, wUser);
        const minW = minWithdrawLimit;
        const walletLine = (wUser && wUser.walletMethod && wUser.walletAddress)
            ? `💳 Method: <b>${(dynamicPayMethods.find(dm => dm.id === wUser.walletMethod) || {}).label || wUser.walletMethod}</b>\n📬 Address: <code>${maskAddress(wUser.walletAddress)}</code>`
            : `💳 Wallet: <i>Not set yet</i>`;
        const myOtpCount = await getUserOtpCount(userId);

        return safeEditMessage(chatId, msgId,
            E(`💰 <b>Wallet</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🆔 User ID: <code>${userId}</code>\n` +
            `💵 Balance: <b>$${(wUser ? wUser.balance : 0).toFixed(4)}</b>\n` +
            `📤 Total Withdrawn: <b>$${(wUser ? wUser.withdrawn : 0).toFixed(4)}</b>\n` +
            `👥 Referrals: <b>${wUser ? wUser.referCount : 0}</b>\n` +
            `📲 OTP Received: <b>${myOtpCount}</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚠️ Minimum Withdraw: <b>$${minW.toFixed(2)}</b>\n` +
            `🎁 Fee: <b>Free 0%</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `${walletLine}`),
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '𝗦𝗲𝘁 𝐖𝐚𝐥𝐥𝐞𝐭', icon_custom_emoji_id: _BTN_EM.set_wallet.id, style: 'primary', callback_data: 'wallet_set' },
                            { text: '𝐖𝐢𝐭𝐡𝐝𝐫𝐚𝐰', icon_custom_emoji_id: _BTN_EM.withdraw.id, style: 'success', callback_data: 'wallet_withdraw' },
                        ]
                    ]
                }
            }
        );
    }

    // ─── WALLET: Set wallet method ────────────────────────────────────────
    if (data === 'wallet_set') {
        await safeAnswerCallback(call.id);
        // আগের মেসেজ delete করো
        try { await bot.deleteMessage(chatId, msgId); } catch(e) {}
        const wkb = walletMethodKeyboard();
        return bot.sendMessage(chatId,
            E(`💼 <b>Set Payment Method</b>\n\n💳 আপনার পছন্দের payment method বেছে নিন:`),
            wkb
        );
    }

    if (data.startsWith('wmethod_')) {
        await safeAnswerCallback(call.id);
        const methodKey = data.replace('wmethod_', '');
        // Static method চেক
        const method = WALLET_METHODS.find(m => m.key === methodKey);
        // Dynamic method চেক
        const dynMethod = !method ? dynamicPayMethods.find(dm => dm.id === methodKey) : null;
        if (!method && !dynMethod) return;
        const methodLabel = method ? method.label : dynMethod.label;
        user_states[userId] = `WAIT_WALLET_ADDR:${methodKey}`;
        try { await bot.deleteMessage(chatId, msgId); } catch(e) {}
        // Build method-specific address prompt with guide photo
        const _isDynBEP20 = dynMethod && dynMethod.type === 'USDT_BEP20';

        // Clean method name - strip leading emoji (1-2 chars) + space
        const _rawLabel = methodLabel || methodKey;
        const _emojiMatch = _rawLabel.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
        const _titleEmoji = _emojiMatch ? _emojiMatch[0] : '';
        const _cleanMethodName = _rawLabel.replace(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u, '').trim();

        // Get icon for inline display (custom emoji id if available)
        const _iconId = method ? (method.eid || null) : (dynMethod ? (dynMethod.icon_custom_emoji_id || null) : null);
        // Admin এর দেওয়া emoji: dynamic method এ emoji field, অথবা label থেকে extract
        // _adminEmoji must be a real Unicode emoji — if empty/missing, fall back to 💳
        const _rawAdminEmoji = dynMethod ? (dynMethod.emoji || _titleEmoji || '') : (_titleEmoji || '');
        // Validate: must contain at least one actual emoji character
        const _hasEmoji = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u.test(_rawAdminEmoji);
        const _adminEmoji = _hasEmoji ? _rawAdminEmoji : '💳';
        // Build inline icon tag: icon_custom_emoji_id দিয়ে premium animated দেখাবে
        // ভেতরে _adminEmoji (valid emoji) রাখা জরুরি — না হলে Telegram ✖ দেখায়
        const _iconTag = _iconId
            ? `<tg-emoji emoji-id="${_iconId}">${_adminEmoji}</tg-emoji>`
            : _adminEmoji;

        // Get guide photo — always re-fetch from DB to get latest value
        let guidePhoto = null;
        if (isUserDBReady) {
            try {
                const gpConf = await ConfigModel.findOne({ key: `guide_photo_${methodKey}` });
                if (gpConf && gpConf.value) guidePhoto = gpConf.value;
            } catch(e) { console.log('guide_photo DB fetch error:', e.message); }
        }
        // In-memory fallback (in case DB is not ready or key not found)
        if (!guidePhoto && method && method.guidePhoto) guidePhoto = method.guidePhoto;
        if (!guidePhoto && dynMethod && dynMethod.guidePhoto) guidePhoto = dynMethod.guidePhoto;
        if (!guidePhoto && (methodKey === 'BEP20' || _isDynBEP20)) guidePhoto = process.env.BEP20_GUIDE_PHOTO || null;

        // Build guide body text
        let guideBody;
        if (_isDynBEP20) {
            // Dynamic BEP20: show wallet name with its own icon
            guideBody =
                `${_iconTag} Send your <b>USDT BEP20 (BSC)</b> address\n` +
                `from your ${_iconTag} <b>${_cleanMethodName}</b> wallet:\n\n` +
                `📌 Follow the guide above to find your address.`;
        } else if (method && method.guideText) {
            guideBody = method.guideText;
        } else if (methodKey === 'BEP20') {
            guideBody =
                `💲 Send your <b>USDT BEP20 (BSC)</b> address\n` +
                `from your 💲 <b>BEP20</b> wallet:\n\n` +
                `📌 Follow the guide above to find your address.`;
        } else if (methodKey === 'TRX') {
            guideBody =
                `🪙 Send your <b>USDT TRC20 (TRON)</b> address\n` +
                `from your 🪙 <b>TRX</b> wallet:\n\n` +
                `📌 Follow the guide above to find your address.`;
        } else if (methodKey === 'Binance') {
            guideBody =
                `🔶 Send your <b>Binance UID</b>:\n\n` +
                `📌 Binance App → Profile → Copy UID`;
        } else if (methodKey === 'bKash') {
            guideBody =
                `💵 Send your <b>bKash number</b>:\n\n` +
                `📌 11-digit number (e.g. 01XXXXXXXXX)`;
        } else if (methodKey === 'Nagad') {
            guideBody =
                `💴 Send your <b>Nagad number</b>:\n\n` +
                `📌 11-digit number (e.g. 01XXXXXXXXX)`;
        } else {
            guideBody = `Send your address for <b>${_cleanMethodName}</b>.`;
        }

        // Full caption / message text
        // _iconTag already contains <tg-emoji> tags (pre-processed).
        // guideBody either contains _iconTag (dynamic BEP20, already processed)
        // or plain emoji that must stay as-is — so we do NOT wrap either in E().
        const addrPromptText =
            `${_iconTag} <b>Set Wallet — ${_cleanMethodName}</b>\n` +
            `────────────────────\n\n` +
            guideBody;

        // Stop button keyboard
        const _stopKeyboard = {
            keyboard: [[{ text: '🛑 Stop', icon_custom_emoji_id: _BTN_EM.reject.id, style: 'danger' }]],
            resize_keyboard: true,
            one_time_keyboard: false
        };

        // Send with guide photo if available
        if (guidePhoto) {
            try {
                return await bot.sendPhoto(chatId, guidePhoto, {
                    caption: addrPromptText,
                    parse_mode: 'HTML',
                    reply_markup: _stopKeyboard
                });
            } catch(e) { console.log(`⚠️ Guide photo send failed for [${methodKey}]: ${e.message}`); if (e.message && (e.message.includes("wrong file_id") || e.message.includes("file not found") || e.message.includes("Bad Request"))) { try { await ConfigModel.findOneAndDelete({ key: `guide_photo_${methodKey}` }); } catch(_) {} if (method) method.guidePhoto = null; if (dynMethod) dynMethod.guidePhoto = null; } }
        }
        return bot.sendMessage(chatId, addrPromptText, { parse_mode: 'HTML', reply_markup: _stopKeyboard });
    }

    // ─── WALLET: Withdraw ─────────────────────────────────────────────────
    if (data === 'wallet_withdraw') {
        await safeAnswerCallback(call.id);

        // Withdraw সম্পূর্ণ বন্ধ কিনা চেক

        if (isWithdrawDisabled) {
            return bot.sendMessage(
                chatId,
                E(
                    `🔒 <b>Withdraw Temporarily Closed</b>\n\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `⚠️ <b>দুঃখিত!</b>\n` +
                    `বর্তমানে Withdraw সার্ভিসটি সাময়িকভাবে বন্ধ রয়েছে।\n\n` +
                    `🔧 সার্ভিসটি পুনরায় চালু করার কাজ চলছে।\n` +
                    `⏰ অনুগ্রহ করে কিছুক্ষণ পরে আবার চেষ্টা করুন।\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `🙏 <i>আপনার ধৈর্যের জন্য ধন্যবাদ।</i>`
                ),
                { parse_mode: "HTML" }
            );
        }



        const wUser = await getWalletUser(userId, call.from);
        if (!await validateUserWallet(chatId, userId, wUser)) return;
        const minW = minWithdrawLimit;

        if (!wUser || !wUser.walletMethod || !wUser.walletAddress) {
            // আগের মেসেজ delete করো
            try { await bot.deleteMessage(chatId, msgId); } catch(e) {}
            return bot.sendMessage(chatId,
                E(`💳 <b>Wallet Not Set</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `⚠️ আপনার কোনো wallet set করা নেই!\n\n` +
                `Withdraw করতে হলে আগে একটি\n` +
                `payment method ও address সেট করুন।\n\n` +
                `👇 নিচের বাটনে ক্লিক করুন:`),
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
                    [{ text: '💳 Set Wallet', icon_custom_emoji_id: _BTN_EM.set_wallet.id, style: 'primary', callback_data: 'wallet_set' }],
                    [{ text: '◀️ Back', callback_data: 'wallet_back', style: 'primary' }]
                ]}}
            );
        }

        if ((wUser.balance || 0) < minW) {
            return bot.sendMessage(chatId,
                E(`❌ <b>Insufficient Balance</b>\n\n` +
                `💵 Balance: <b>$${(wUser.balance || 0).toFixed(4)}</b>\n` +
                `⚠️ Minimum: <b>$${minW.toFixed(2)}</b>`),
                { parse_mode: 'HTML' }
            );
        }

        user_states[userId] = 'WAIT_WITHDRAW_AMOUNT';
        return bot.sendMessage(chatId,
            E(`💸 <b>Enter Withdrawal Amount</b>\n` +
            `────────────────\n` +
            `💵 Balance: <b>$${(wUser.balance || 0).toFixed(4)}</b>\n` +
            `⚠️ Minimum: <b>$${minW.toFixed(2)}</b>\n` +
            `💳 Method: <b>${(dynamicPayMethods.find(dm => dm.id === wUser.walletMethod) || {}).label || wUser.walletMethod}</b>\n` +
            `📬 Address: <code>${maskAddress(wUser.walletAddress)}</code>\n` +
            `────────────────\n\nType the amount (e.g. <code>0.50</code>):`),
            { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard(userId, true) }
        );
    }

    // ─── ADMIN: Pay Pending list ──────────────────────────────────────────
    if (data === 'admin_pay_pending' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        if (!isUserDBReady) return bot.sendMessage(chatId, "❌ DB not ready.");
        const pending = await WithdrawRequest.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(10);
        if (!pending.length) {
            return bot.sendMessage(chatId, `📥 <b>No Pending Withdrawals</b>`, { parse_mode: 'HTML' });
        }
        for (const req of pending) {
            const kb = { inline_keyboard: isMethodBEP20Type(req.walletMethod)
                ? [[
                    { text: 'Approve (Manual)', callback_data: `wpay_manual:${req._id}`, style: 'success' },
                    { text: 'Approve via API',  callback_data: `wpay_retry_api:${req._id}`, style: 'primary' },
                  ], [
                    { text: 'Reject', callback_data: `wpay_reject:${req._id}`, style: 'danger' },
                  ]]
                : [[
                    { text: 'Approve', callback_data: `wpay_approve:${req._id}`, style: 'success' },
                    { text: 'Reject',  callback_data: `wpay_reject:${req._id}`,  style: 'danger'  },
                  ]] };
            await bot.sendMessage(chatId,
                `📥 <b>Withdraw Request</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `👤 User: <b>${req.firstName}</b> (<code>${req.userId}</code>)\n\n` +
                `💵 Amount: <code>$${req.amount.toFixed(4)}</code>\n\n` +
                `💳 Method: <b>${(dynamicPayMethods.find(dm => dm.id === req.walletMethod) || {}).label || req.walletMethod}</b>\n` +
                `📬 Address: <code>${req.walletAddress}</code>\n` +
                `📅 Date: ${req.createdAt.toLocaleString()}`,
                { parse_mode: 'HTML', reply_markup: kb }
            );
        }
        return;
    }

    if (data.startsWith('wpay_approve:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const reqId = data.replace('wpay_approve:', '');
        const req = await WithdrawRequest.findById(reqId);
        if (!req || req.status !== 'pending') {
            return bot.sendMessage(chatId, `⚠️ Already processed.`, { parse_mode: 'HTML' });
        }
        req.status = 'approved';
        await WithdrawRequest.findOneAndUpdate({ _id: req._id }, { $set: { status: 'approved' } });

        try { await bot.deleteMessage(chatId, msgId); } catch(e) {}
        bot.sendMessage(chatId, `✅ <b>Approved!</b> User <code>${req.userId}</code> notified.`, { parse_mode: 'HTML' });
        bot.sendMessage(req.userId,
            E(`✅ <b>Payment Successful!</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `💵 Amount: <b>$${req.amount.toFixed(4)}</b>\n\n` +
            `💳 Method: <b>${(dynamicPayMethods.find(dm => dm.id === req.walletMethod) || {}).label || req.walletMethod}</b>\n` +
            `📬 Address: <code>${req.walletAddress}</code>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🎉 Payment has been processed!`),
            { parse_mode: 'HTML' }
        ).catch(() => {});

        // ── গ্রুপে manual approve নোটিফিকেশন (১ বাটন: Open Board) ──
        {
            const maskedAddr = maskAddress(req.walletAddress);
            const boardUrl = getBoardUrl(req.walletMethod);
            const _pNoA = await getNextPaymentNo();
            const _pTagA = _pNoA ? `#${_pNoA} ` : '';
            const groupApproveText = E(`✅ <b>${_pTagA}Payment Successful!</b>\n` +
                `--------------------------------------\n` +
                `<blockquote>` +
                `👤 User   : <b>${req.firstName || req.username || 'User'}</b> (<code>${req.userId}</code>)\n\n` +
                `‣ Amount : <b>$${req.amount.toFixed(4)}</b>\n\n` +
                `</blockquote>` +
                `<blockquote>` +
                `‣ Method : <b>${(dynamicPayMethods.find(dm => dm.id === req.walletMethod) || {}).label || req.walletMethod}</b>\n` +
                `‣ Address: <code>${maskedAddr}</code>\n` +
                `</blockquote>` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `🎉 Payment has been processed manually!`);
            const groupApproveBtn = boardUrl ? [{ text: "🤖𝐎𝐩𝐞𝐧 𝐁𝐨𝐭", url: `https://t.me/${bot_username}?start=start`, icon_custom_emoji_id: _BTN_EM.open_bot.id, style: 'primary' }] : [];
            await sendWithdrawGroupMsg(groupApproveText, groupApproveBtn);
        }
        return;
    }

    // ─── ADMIN: Manual approve (BEP20 3-button flow) — identical effect to wpay_approve ──
    if (data.startsWith('wpay_manual:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const reqId = data.replace('wpay_manual:', '');
        const req = await WithdrawRequest.findById(reqId);
        if (!req || req.status !== 'pending') {
            return bot.sendMessage(chatId, `⚠️ Already processed.`, { parse_mode: 'HTML' });
        }
        req.status = 'approved';
        await WithdrawRequest.findOneAndUpdate({ _id: req._id }, { $set: { status: 'approved' } });

        try { await bot.deleteMessage(chatId, msgId); } catch(e) {}
        bot.sendMessage(chatId, `✅ <b>Approved (Manual)!</b> User <code>${req.userId}</code> notified.`, { parse_mode: 'HTML' });
        bot.sendMessage(req.userId,
            E(`✅ <b>Payment Successful!</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `<blockquote>` +
            `💵 Amount: <b>$${req.amount.toFixed(4)}</b>\n` +
            `💳 Method: <b>${(dynamicPayMethods.find(dm => dm.id === req.walletMethod) || {}).label || req.walletMethod}</b>\n` +
            `📬 Address: <code>${req.walletAddress}</code>\n` +
            `</blockquote>` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🎉 Payment has been processed!`),
            { parse_mode: 'HTML' }
        ).catch(() => {});

        // ── গ্রুপে wpay_manual approve নোটিফিকেশন (১ বাটন: Open Board) ──
        {
            const maskedAddr = maskAddress(req.walletAddress);
            const boardUrl = getBoardUrl(req.walletMethod);
            const _pNoM = await getNextPaymentNo();
            const _pTagM = _pNoM ? `#${_pNoM} ` : '';
            const groupManualText = E(`✅ <b>${_pTagM}Payment Successful!</b>\n` +
                `--------------------------------------\n` +
                `<blockquote>` +
                `👤 User   : <b>${req.firstName || req.username || 'User'}</b> (<code>${req.userId}</code>)\n\n` +
                `‣ Amount : <b>$${req.amount.toFixed(4)}</b>\n\n` +
                `</blockquote>` +
                `<blockquote>` +
                `‣ Method : <b>${(dynamicPayMethods.find(dm => dm.id === req.walletMethod) || {}).label || req.walletMethod}</b>\n` +
                `‣ Address : <code>${maskedAddr}</code>\n` +
                `</blockquote>` +
                `--------------------------------------\n` +
                `🎉 Payment has been processed manually!`);
            const groupManualBtn = boardUrl ? [{ text: "🤖𝐎𝐩𝐞𝐧 𝐁𝐨𝐭", url: `https://t.me/${bot_username}?start=start`, icon_custom_emoji_id: _BTN_EM.open_bot.id, style: 'primary' }] : [];
            await sendWithdrawGroupMsg(groupManualText, groupManualBtn);
        }
        return;
    }

    // ─── ADMIN: Retry Alif API payment (BEP20 only) ──────────────────────
    if (data.startsWith('wpay_retry_api:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const reqId = data.replace('wpay_retry_api:', '');
        const req = await WithdrawRequest.findById(reqId);
        if (!req || req.status !== 'pending') {
            return bot.sendMessage(chatId, `⚠️ Already processed.`, { parse_mode: 'HTML' });
        }

        bot.sendMessage(chatId, `🔄 <b>Retrying API payment...</b>`, { parse_mode: 'HTML' }).catch(() => {});

        const payAmountRetry = req.amount.toFixed(4);
        let apiResultRetry = null;
        let paySuccessRetry = false;
        try {
            const axios = require('axios');
            const apiUrl = `${ALIF_API_BASE_URL}?key=${encodeURIComponent(ALIF_API_KEY)}&network=bnb&token=USDT&to=${encodeURIComponent(req.walletAddress)}&amount=${payAmountRetry}`;
            const apiRes = await axios.get(apiUrl, { timeout: 30000 });
            apiResultRetry = apiRes.data;
            if (apiResultRetry && apiResultRetry.status === true && apiResultRetry.data && apiResultRetry.data.txHash) {
                paySuccessRetry = true;
            }
        } catch (fetchErr) {
            const errData = fetchErr.response ? fetchErr.response.data : null;
            apiResultRetry = errData || { error: fetchErr.message };
        }

        if (paySuccessRetry) {
            const txData = apiResultRetry.data;
            const txHashShort = txData.txHash.substring(0, 10) + '••••••••';
            const txDate = txData.timestamp
                ? new Date(txData.timestamp).toISOString().replace('T', ' ').substring(0, 16)
                : new Date().toISOString().replace('T', ' ').substring(0, 16);

            req.status = 'approved';
            req.txHash = txData.txHash;
            req.txLink = txData.txLink;
            req.blockNumber = txData.blockNumber;
            req.processedAt = new Date();
            await WithdrawRequest.findOneAndUpdate(
                { _id: req._id },
                { $set: { status: 'approved', txHash: txData.txHash, txLink: txData.txLink, blockNumber: txData.blockNumber, processedAt: req.processedAt } }
            );


            try { await bot.deleteMessage(chatId, msgId); } catch(e) {}
            bot.sendMessage(chatId, `✅ <b>Payment Successful!</b> User <code>${req.userId}</code> notified.`, { parse_mode: 'HTML' });
            bot.sendMessage(req.userId,
                E(`✅ <b>Payment Successful Check wallet💰</b>\n` +
                `-----------------------------------------\n` +
                `<blockquote>` +
                `‣ Amount  : <b>$${payAmountRetry} USDT</b>\n\n` +
                `‣ Network : <b>BEP20 (BSC)</b>\n` +
                `‣ TxHash   : <code>${txHashShort}</code>\n` +
                `‣ Date : <b>${txDate}</b>\n` +
                `</blockquote>` +
                `-----------------------------------------\n` +
                `🎉 Your withdrawal has been Processed!`),
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '🔍 View Details', url: txData.txLink, icon_custom_emoji_id: _BTN_EM.open_bot.id, style: 'primary' }, { text: '💰𝐏𝐫𝐨𝐨𝐟', url: PAY_GROUP_URL, icon_custom_emoji_id: _BTN_EM.open_bot.id, style: 'primary' }]] }
                }
            ).catch(() => {});

            // ── গ্রুপে retry API success নোটিফিকেশন (২ বাটন) ──
            {
                const maskedAddr = maskAddress(req.walletAddress);
                const boardUrl = getBoardUrl(req.walletMethod);
                const _pNoR = await getNextPaymentNo();
                const _pTagR = _pNoR ? `#${_pNoR} ` : '';
                const groupRetryText = E(`✅ <b>${_pTagR}Payment Successful!</b>\n` +
                    `---------------------------------------\n` +
                    `<blockquote>` +
                    `👤 User   : <b>${req.firstName || req.username || 'User'}</b> (<code>${req.userId}</code>)\n\n` +
                    `‣ Amount : <b>$${payAmountRetry} USDT</b>\n\n` +
                    `</blockquote>` +
                    `<blockquote>` +
                    `‣ Method : <b>${(dynamicPayMethods.find(dm => dm.id === req.walletMethod) || {}).label || req.walletMethod}</b>\n` +
                    `‣ Address: <code>${maskedAddr}</code>\n` +
                    `‣ Date    : <b>${txDate}</b>\n` +
                    `</blockquote>` +
                    `---------------------------------------\n` +
                    `🎉 Payment processed via TEAM X4X`);
                const groupRetryBtn = [];
                if (txData.txLink) groupRetryBtn.push({ text: '🔍𝐏𝐚𝐲𝐦𝐞𝐧𝐭 𝐬𝐭𝐚𝐭𝐮𝐬', url: txData.txLink, icon_custom_emoji_id: _BTN_EM.open_bot.id, style: 'primary' });
                if (boardUrl) groupRetryBtn.push({ text: "🤖𝐎𝐩𝐞𝐧 𝐁𝐨𝐭", url: `https://t.me/${bot_username}?start=start`, icon_custom_emoji_id: _BTN_EM.open_bot.id, style: 'primary' });
                await sendWithdrawGroupMsg(groupRetryText, groupRetryBtn);
            }
        } else {
            const errMsg = (apiResultRetry && (apiResultRetry.error || apiResultRetry.msg)) || 'Unknown error';
            req.failReason = errMsg;
            await WithdrawRequest.findOneAndUpdate({ _id: req._id }, { $set: { failReason: errMsg } });

            bot.sendMessage(chatId,
                E(`❌ <b>API Retry Failed Again</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `👤 User   : <code>${req.userId}</code>\n` +
                `💵 Amount : <b>$${payAmountRetry} USDT</b>\n` +
                `📬 Address: <code>${req.walletAddress}</code>\n` +
                `⚠️ Error  : <b>${errMsg}</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `👇 Choose an action below.`),
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
                    { text: 'Approve (Manual)', callback_data: `wpay_manual:${req._id}`, icon_custom_emoji_id: _BTN_EM.approve.id, style: 'success' },
                    { text: 'Approve via API',  callback_data: `wpay_retry_api:${req._id}`, icon_custom_emoji_id: _BTN_EM.restart.id, style: 'primary' },
                ], [
                    { text: 'Reject', callback_data: `wpay_reject:${req._id}`, icon_custom_emoji_id: _BTN_EM.reject.id, style: 'danger' },
                ]]}}
            ).catch(() => {});
        }
        return;
    }

    if (data.startsWith('wpay_reject:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const reqId = data.replace('wpay_reject:', '');
        const req = await WithdrawRequest.findById(reqId);
        if (!req || req.status !== 'pending') {
            return bot.sendMessage(chatId, `⚠️ Already processed.`, { parse_mode: 'HTML' });
        }
        // Refund balance
        await WalletUser.findOneAndUpdate(
            { telegramId: req.userId },
            { $inc: { balance: req.amount } }
        );
        req.status = 'rejected';
        await WithdrawRequest.findOneAndUpdate({ _id: req._id }, { $set: { status: 'rejected' } });
        try { await bot.deleteMessage(chatId, msgId); } catch(e) {}
        bot.sendMessage(chatId, E(`❌ <b>Rejected.</b> Balance refunded to user.`), { parse_mode: 'HTML' });
        bot.sendMessage(req.userId,
            E(`❌ <b>Withdrawal Rejected</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `💵 Amount: <b>$${req.amount.toFixed(4)}</b>\n` +
            `🔄 Balance has been refunded.`),
            { parse_mode: 'HTML' }
        ).catch(() => {});
        return;
    }

    // ─── ADMIN: Bonus / REF_LEVELS callbacks ─────────────────────────────
    if (data === 'bonus_add_level' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        user_states[userId] = 'BONUS_ADD_LEVEL';
        return bot.sendMessage(chatId,
            `➕ <b>নতুন Referral Level যোগ করুন</b>\n\n` +
            `ফরম্যাট: <code>minRefs commission</code>\n` +
            `উদাহরণ: <code>250 0.0012</code>\n\n` +
            `(minRefs = কতজন রেফার করলে এই লেভেল পাবে, commission = প্রতি OTP তে কত ডলার)`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'bonus_cancel', style: 'danger' }]] } }
        );
    }

    if (data === 'bonus_del_last' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        if (REF_LEVELS.length <= 1) {
            return bot.answerCallbackQuery(call.id, { text: '❌ অন্তত ১টি Level রাখতে হবে!', show_alert: true });
        }
        const removed = REF_LEVELS.pop();
        if (isUserDBReady) {
            await ConfigModel.findOneAndUpdate(
                { key: 'ref_levels' },
                { value: JSON.stringify(REF_LEVELS) },
                { upsert: true }
            );
        }
        return bot.sendMessage(chatId,
            `🗑️ <b>Level ${removed.level} মুছে ফেলা হয়েছে!</b>\n` +
            `👥 MinRefs ছিল: <b>${removed.minRefs}</b>\n` +
            `💵 Commission ছিল: <b>$${removed.commission.toFixed(4)}</b>`,
            { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
        );
    }

    if (data === 'bonus_cancel' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        delete user_states[userId];
        return bot.sendMessage(chatId, `✅ বাতিল করা হয়েছে।`, { reply_markup: getAdminMenuKeyboard() });
    }

    // ─── ADMIN: Leaderboard ON/OFF Toggle ────────────────────────────────
    // ─── ADMIN: Leaderboard Panel ─────────────────────────────────────────
    if (data === 'cfg_lb_panel' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        return sendLbPanel(chatId, msgId);
    }

    if (data === 'cfg_lb_toggle' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        isLeaderboardEnabled = !isLeaderboardEnabled;
        try {
            await ConfigModel.findOneAndUpdate(
                { key: 'lb_enabled' },
                { $set: { key: 'lb_enabled', value: JSON.stringify(isLeaderboardEnabled) } },
                { upsert: true }
            );
        } catch(e) { console.log('Error saving lb_enabled:', e.message); }
        return sendLbPanel(chatId, msgId);
    }

    // ─── ADMIN: Leaderboard Manual Reset ─────────────────────────────────
    if (data === 'cfg_lb_reset' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        // confirm চাওয়া হবে
        return safeEditMessage(chatId, msgId,
            `🔄 <b>Leaderboard Reset</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚠️ <b>সতর্কতা!</b>\n\n` +
            `এই অপারেশন সব ইউজারের আজকের OTP কাউন্ট ও daily earning রিসেট করবে।\n\n` +
            `আপনি কি নিশ্চিত?`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            mkInlineBtn('✅ হ্যাঁ, Reset করুন', 'cfg_lb_reset_confirm', 'danger'),
                            mkInlineBtn('❌ বাতিল', 'cfg_lb_panel', 'primary')
                        ]
                    ]
                }
            }
        );
    }

    if (data === 'cfg_lb_reset_confirm' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        try {
            if (!isStatusDBReady || !UserOtpStat) {
                return safeEditMessage(chatId, msgId,
                    `❌ <b>Reset ব্যর্থ!</b>\n\nStatusDB এখনো রেডি হয়নি।`,
                    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[mkInlineBtn('🔙 Back', 'cfg_lb_panel', 'primary')]] } }
                );
            }
            const nowBD = new Date(Date.now() + 6 * 3600000);
            const todayStr = `${nowBD.getFullYear()}-${String(nowBD.getMonth()+1).padStart(2,'0')}-${String(nowBD.getDate()).padStart(2,'0')}`;
            const result = await UserOtpStat.updateMany({}, { $set: { dailyOtpCount: 0, dailyEarning: 0 } });
            await ConfigModel.findOneAndUpdate(
                { key: 'leaderboard_last_reset_date' },
                { key: 'leaderboard_last_reset_date', value: todayStr },
                { upsert: true }
            );
            console.log(`[leaderboard-reset] ✅ Manual reset by admin ${userId} — ${result.modifiedCount} users`);
            return safeEditMessage(chatId, msgId,
                `✅ <b>Leaderboard Reset সফল!</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `👥 মোট <b>${result.modifiedCount}</b> জন ইউজারের ডেটা রিসেট হয়েছে।\n` +
                `📅 তারিখ: <b>${todayStr}</b>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[mkInlineBtn('🔙 LB Panel', 'cfg_lb_panel', 'primary')]] }
                }
            );
        } catch(e) {
            console.error('[leaderboard-reset] Manual reset error:', e.message);
            return safeEditMessage(chatId, msgId,
                `❌ <b>Reset ব্যর্থ!</b>\n\nError: ${e.message}`,
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[mkInlineBtn('🔙 Back', 'cfg_lb_panel', 'primary')]] } }
            );
        }
    }

    // ─── ADMIN: Leaderboard Daily Bonus (Top 3) ───────────────────────────
    if (data === 'cfg_lb_bonus' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        return sendLbBonusMenu(chatId, msgId);
    }

    if (data === 'lb_bonus_set_first' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        user_states[userId] = 'LB_BONUS_SET:first';
        return safeEditMessage(chatId, msgId,
            `🥇 <b>১ম স্থানের বোনাস সেট করুন</b>\n\n` +
            `বর্তমান: <b>$${LB_BONUS.first.toFixed(4)}</b>\n\n` +
            `নতুন পরিমাণ লিখুন (যেমন: <code>0.50</code>):`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'lb_bonus_back', style: 'danger' }]] } }
        );
    }
    if (data === 'lb_bonus_set_second' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        user_states[userId] = 'LB_BONUS_SET:second';
        return safeEditMessage(chatId, msgId,
            `🥈 <b>২য় স্থানের বোনাস সেট করুন</b>\n\n` +
            `বর্তমান: <b>$${LB_BONUS.second.toFixed(4)}</b>\n\n` +
            `নতুন পরিমাণ লিখুন (যেমন: <code>0.30</code>):`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'lb_bonus_back', style: 'danger' }]] } }
        );
    }
    if (data === 'lb_bonus_set_third' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        user_states[userId] = 'LB_BONUS_SET:third';
        return safeEditMessage(chatId, msgId,
            `🥉 <b>৩য় স্থানের বোনাস সেট করুন</b>\n\n` +
            `বর্তমান: <b>$${LB_BONUS.third.toFixed(4)}</b>\n\n` +
            `নতুন পরিমাণ লিখুন (যেমন: <code>0.10</code>):`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'lb_bonus_back', style: 'danger' }]] } }
        );
    }
    if (data === 'lb_bonus_back' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        delete user_states[userId];
        return sendLbBonusMenu(chatId, msgId);
    }

    if (data.startsWith('bonus_edit_comm:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const levelIdx = parseInt(data.replace('bonus_edit_comm:', ''));
        if (!REF_LEVELS[levelIdx]) return;
        user_states[userId] = `BONUS_EDIT_LEVEL:${levelIdx}`;
        return bot.sendMessage(chatId,
            `✏️ <b>Level ${REF_LEVELS[levelIdx].level} Commission এডিট</b>\n\n` +
            `বর্তমান: <b>$${REF_LEVELS[levelIdx].commission.toFixed(4)}</b>\n\n` +
            `নতুন commission দিন (যেমন: <code>0.0015</code>):`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'bonus_cancel', style: 'danger' }]] } }
        );
    }

    if (data.startsWith('bonus_edit_minrefs:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const levelIdx = parseInt(data.replace('bonus_edit_minrefs:', ''));
        if (!REF_LEVELS[levelIdx]) return;
        user_states[userId] = `BONUS_EDIT_MINREFS:${levelIdx}`;
        return bot.sendMessage(chatId,
            `📊 <b>Level ${REF_LEVELS[levelIdx].level} MinRefs এডিট</b>\n\n` +
            `বর্তমান: <b>${REF_LEVELS[levelIdx].minRefs}</b> রেফার\n\n` +
            `নতুন minRefs দিন (যেমন: <code>300</code>):`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'bonus_cancel', style: 'danger' }]] } }
        );
    }

    if (data === 'verify_check') {
        if (isAdmin(userId)) {
            await safeAnswerCallback(call.id);
            try { await bot.deleteMessage(chatId, msgId); } catch (e) {}
            const welcomeText = buildWelcomeText(userId, call.from);
            bot.sendMessage(chatId, welcomeText, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard(userId) });
            return;
        }

        const unjoined = await getUnjoinedChannels(userId);
        if (unjoined.length === 0) {
            await safeAnswerCallback(call.id);
            try { await bot.deleteMessage(chatId, msgId); } catch (e) {}
            const welcomeText = buildWelcomeText(userId, call.from);
            bot.sendMessage(chatId, welcomeText, { parse_mode: 'HTML', reply_markup: getMainMenuKeyboard(userId) });
        } else {
            // যেসব চ্যানেল বাকি আছে শুধু সেগুলোর বাটন দিয়ে মেসেজ আপডেট করা হচ্ছে
            await safeEditMessage(chatId, msgId, `⚠️ Access Denied!\nPlease join our channels to use the bot.`, {
                parse_mode: 'Markdown',
                reply_markup: getVerificationMarkup(unjoined)
            });
            try {
                await bot.answerCallbackQuery(call.id, { text: "❌ Join channels!", show_alert: true });
            } catch (e) {}
        }
        return;
    }

    if (data.startsWith('toggle_status:') && isAdmin(userId)) {
        const sectorId = data.split(':')[1];

        if (disabledSectors.includes(sectorId)) {
            disabledSectors = disabledSectors.filter(id => id !== sectorId); // On করা হলো
        } else {
            disabledSectors.push(sectorId); // Off করা হলো
        }

        if (isUserDBReady) {
            await ConfigModel.findOneAndUpdate(
                { key: "disabled_sectors" },
                { value: JSON.stringify(disabledSectors) },
                { upsert: true }
            );
        }

        await safeAnswerCallback(call.id, { text: "আপডেট হয়েছে!" });
        return safeEditMessage(chatId, msgId, "⚙️ <b>সেক্টর ম্যানেজমেন্ট</b>", { 
            parse_mode: 'HTML', 
            reply_markup: getManageSectorsKeyboard() 
        });
    }

    // ➕ ADD PLATFORM: শুরু — প্ল্যাটফর্মের নাম চাওয়া
    if (data === 'add_platform_start' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        user_states[userId] = 'AWAITING_NEW_PLATFORM_NAME';
        await safeEditMessage(chatId, msgId,
            `➕ <b>নতুন প্ল্যাটফর্ম যুক্ত করুন</b>\n\nপ্ল্যাটফর্মের নাম লিখুন (যেমন: <code>Snapchat</code>):`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: 'cancel_add_platform', style: 'danger' }]] } }
        );
        bot.sendMessage(userId, `✏️ প্ল্যাটফর্মের নাম লিখুন:`, { reply_markup: getAdminMenuKeyboard(true) });
        return;
    }

    // ➕ ADD PLATFORM: বাতিল
    if (data === 'cancel_add_platform' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        delete user_states[userId];
        delete admin_file_buffer[userId];
        return safeEditMessage(chatId, msgId, "⚙️ <b>সেক্টর ম্যানেজমেন্ট</b>", { 
            parse_mode: 'HTML', 
            reply_markup: getManageSectorsKeyboard() 
        });
    }

    // ✏️ EDIT PLATFORM: নাম পরিবর্তন শুরু
    if (data.startsWith('edit_platform:') && isAdmin(userId)) {
        const sectorId = data.split(':')[1];
        const sectorInfo = SECTORS.find(s => s.id === sectorId);
        if (!sectorInfo) {
            await safeAnswerCallback(call.id, { text: "প্ল্যাটফর্ম পাওয়া যায়নি!" });
            return;
        }
        await safeAnswerCallback(call.id);
        if (!admin_file_buffer[userId]) admin_file_buffer[userId] = {};
        admin_file_buffer[userId].edit_platform_id = sectorId;
        admin_file_buffer[userId].edit_platform_old_name = sectorInfo.label;
        user_states[userId] = 'AWAITING_EDIT_PLATFORM_NAME';
        return safeEditMessage(chatId, msgId,
            `✏️ <b>প্ল্যাটফর্ম এডিট করুন</b>\n\nবর্তমান নাম: <b>${sectorInfo.label}</b>\n\nনতুন নাম লিখুন:`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: 'cancel_add_platform', style: 'danger' }]] } }
        );
    }

    // 🗑️ DELETE PLATFORM: নিশ্চিতকরণ চাওয়া
    if (data.startsWith('delete_platform:') && isAdmin(userId)) {
        const sectorId = data.split(':')[1];
        const sectorInfo = SECTORS.find(s => s.id === sectorId);
        if (!sectorInfo) {
            await safeAnswerCallback(call.id, { text: "প্ল্যাটফর্ম পাওয়া যায়নি!" });
            return;
        }
        await safeAnswerCallback(call.id);
        return safeEditMessage(chatId, msgId,
            `🗑️ <b>প্ল্যাটফর্ম ডিলিট করুন</b>\n\n⚠️ আপনি কি নিশ্চিত?\n\nপ্ল্যাটফর্ম: <b>${sectorInfo.label}</b>\n\nএই প্ল্যাটফর্ম ডিলিট করলে আর ফিরিয়ে আনা যাবে না।`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "✅ হ্যাঁ, ডিলিট করুন", callback_data: `confirm_delete_platform:${sectorId}`, style: 'danger' },
                            { text: "❌ না, বাতিল", callback_data: 'cancel_add_platform', style: 'success' }
                        ]
                    ]
                }
            }
        );
    }

    // 🗑️ DELETE PLATFORM: নিশ্চিত হয়ে ডিলিট করা
    if (data.startsWith('confirm_delete_platform:') && isAdmin(userId)) {
        const sectorId = data.split(':')[1];
        const sectorIndex = SECTORS.findIndex(s => s.id === sectorId);
        if (sectorIndex === -1) {
            await safeAnswerCallback(call.id, { text: "প্ল্যাটফর্ম পাওয়া যায়নি!" });
            return;
        }
        const sectorLabel = SECTORS[sectorIndex].label;
        SECTORS.splice(sectorIndex, 1);
        try {
            if (isUserDBReady) {
                await CustomSectorModel.deleteOne({ id: sectorId });
            }
        } catch (e) { console.log('Delete platform DB error:', e.message); }
        await safeAnswerCallback(call.id, { text: `✅ "${sectorLabel}" ডিলিট হয়েছে!` });
        return safeEditMessage(chatId, msgId, `✅ <b>"${sectorLabel}"</b> প্ল্যাটফর্ম ডিলিট করা হয়েছে।\n\n⚙️ <b>সেক্টর ম্যানেজমেন্ট</b>`, {
            parse_mode: 'HTML',
            reply_markup: getManageSectorsKeyboard()
        });
    }

    if (data === 'back_to_admin' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        await sendSubAdminList(chatId, msgId);
        return;
    }

    // ═══════════════════════════════════════════════════════
    // 🔢 HI T COUNT — এডমিন কাস্টম কাউন্ট সেট করার Flow
    // ═══════════════════════════════════════════════════════

    // Step 1: সেক্টর সিলেক্ট মেনু দেখাও
    // 🔢 HI T COUNT TOGGLE — এডমিনের কাউন্ট দেখানো ON/OFF করা
    if (data === 'hitcount_toggle' && isAdmin(userId)) {
        const key = String(userId);
        const wasHidden = adminHideCountSet.has(key);
        if (wasHidden) {
            adminHideCountSet.delete(key); // OFF ছিল → ON করো
        } else {
            adminHideCountSet.add(key);    // ON ছিল → OFF করো
        }
        const isNowHidden = adminHideCountSet.has(key);
        await safeAnswerCallback(call.id, { text: isNowHidden ? '🔢 Count Hidden' : '🔢 Count Visible' });
        // শুধু inline keyboard টা update করো — মেসেজ text ঠেকেই থাকুক
        return bot.editMessageReplyMarkup(
            {
                inline_keyboard: [[{
                    text: isNowHidden ? '🔢 Hi T Count: OFF' : '🔢 Hi T Count: ON',
                    callback_data: 'hitcount_toggle',
                    style: isNowHidden ? 'danger' : 'success'
                }]]
            },
            { chat_id: chatId, message_id: msgId }
        );
    }

    if (data === 'admin_stat_refresh' && isAdmin(userId)) {
        await safeAnswerCallback(call.id, { text: '🔄 Refreshing...' });
        return sendAdminStatus(chatId, msgId);
    }

    if (data === 'toggle_maint' && isAdmin(userId)) {
        if (isMaintenanceMode) {
            // অফ করা
            isMaintenanceMode = false;
            if (isUserDBReady) await ConfigModel.findOneAndUpdate({ key: "maint_mode" }, { value: "false" }, { upsert: true });
            await safeAnswerCallback(call.id, { text: "Maintenance OFF" });
            return safeEditMessage(chatId, msgId, "⚙️ মেইনটেন্যান্স অফ করা হয়েছে।", { reply_markup: getMaintenanceKeyboard() });
        } else {
            // অন করার জন্য মেসেজ চাওয়া
            user_states[userId] = 'AWAITING_MAINTENANCE_MSG';
            await safeAnswerCallback(call.id);
            return bot.sendMessage(chatId, "📝 ইউজারদের জন্য একটি নোটিশ লিখুন (কেন মেইনটেন্যান্স করা হচ্ছে):", { reply_markup: { keyboard: [[{ text: "Stop", icon_custom_emoji_id: _BTN_EM.reject.id, style: 'danger' }]], resize_keyboard: true } });
        }
    }

    // ─── ADD DYNAMIC PAY METHOD (admin) ────────────────────────────────
    if (data === 'add_dynpaymethod' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        user_states[userId] = 'AWAITING_DYNPAY_NAME';
        return bot.sendMessage(chatId,
            E(`➕ <b>Add Pay Method</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📝 নতুন পেমেন্ট মেথডের <b>নাম</b> লিখুন:\n` +
            `<i>উদাহরণ: bKash, Rocket, Nagad Pro</i>`),
            { parse_mode: 'HTML', reply_markup: { keyboard: [[{ text: 'Stop', icon_custom_emoji_id: _BTN_EM.reject.id, style: 'danger' }]], resize_keyboard: true } }
        );
    }

    // ─── TOGGLE DYNAMIC PAY METHOD (admin) ──────────────────────────────
    if (data.startsWith('toggle_dynpaymethod:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const dmId = data.replace('toggle_dynpaymethod:', '');
        const dmDoc = await DynamicPayMethod.findOne({ id: dmId });
        if (!dmDoc) return;
        dmDoc.enabled = !dmDoc.enabled;
        await dmDoc.save();
        await loadDynamicPayMethods();
        await safeAnswerCallback(call.id, { text: `${dmDoc.label} ${dmDoc.enabled ? 'ON ✅' : 'OFF ❌'}` });
        return safeEditMessage(chatId, msgId,
            E(`💳 <b>Pay Method Control</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🟢 = চালু  🔴 = বন্ধ\n\n` +
            `প্রতিটি পেমেন্ট মেথড আলাদাভাবে ON/OFF করুন।`),
            { parse_mode: 'HTML', reply_markup: getPayMethodKeyboard() }
        );
    }

    // ─── DELETE DYNAMIC PAY METHOD (admin) ──────────────────────────────
    if (data.startsWith('del_dynpaymethod:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const dmId = data.replace('del_dynpaymethod:', '');
        await DynamicPayMethod.deleteOne({ id: dmId });
        await loadDynamicPayMethods();
        return safeEditMessage(chatId, msgId,
            E(`💳 <b>Pay Method Control</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🗑 মেথড ডিলিট করা হয়েছে।\n\n` +
            `🟢 = চালু  🔴 = বন্ধ`),
            { parse_mode: 'HTML', reply_markup: getPayMethodKeyboard() }
        );
    }

    // ─── EDIT DYNAMIC PAY METHOD (admin) ────────────────────────────────
    if (data.startsWith('edit_dynpaymethod:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const dmId = data.replace('edit_dynpaymethod:', '');
        const dmDoc = await DynamicPayMethod.findOne({ id: dmId });
        if (!dmDoc) return;
        user_states[userId] = `AWAITING_DYNPAY_EDIT_NAME:${dmId}`;
        return bot.sendMessage(chatId,
            E(`✏️ <b>Edit Pay Method: ${dmDoc.label}</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📝 নতুন নাম লিখুন (পুরনো: <b>${dmDoc.label}</b>):\n` +
            `<i>পরিবর্তন না করতে চাইলে "same" লিখুন</i>`),
            { parse_mode: 'HTML', reply_markup: { keyboard: [[{ text: 'Stop', icon_custom_emoji_id: _BTN_EM.reject.id, style: 'danger' }]], resize_keyboard: true } }
        );
    }

    // ─── SELECT TYPE FOR DYNAMIC PAY METHOD (USDT_BEP20 or MANUAL) ────
    if (data.startsWith('dynpay_type:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const [, type, pendingId] = data.split(':');
        // pendingId = temp state key stored in user_states
        const pendingData = user_states[userId + '_dynpay_pending'];
        if (!pendingData) return;
        pendingData.type = type;

        // Auto-generate ID from label
        const autoId = 'dpm_' + slugifyPlatformName(pendingData.label) + '_' + Date.now().toString(36);
        try {
            const newMethod = await DynamicPayMethod.create({
                id: autoId,
                label: pendingData.label,
                emoji: pendingData.emoji || '💳',
                icon_custom_emoji_id: pendingData.icon_custom_emoji_id || null,
                type: type,
                enabled: true
            });
            await loadDynamicPayMethods();
            // Reload to get the saved doc reference
            const savedDm = dynamicPayMethods.find(dm => dm.id === autoId);

            // Success message
            await bot.sendMessage(chatId,
                E(`✅ <b>Pay Method Added!</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `💳 নাম  : <b>${newMethod.label}</b>\n` +
                `🆔 ID   : <code>${newMethod.id}</code>\n` +
                `📌 Type : <b>${type === 'USDT_BEP20' ? '💲 USDT BEP20 (Auto API)' : '📝 Manual'}</b>`),
                { parse_mode: 'HTML' }
            );

            // If USDT_BEP20 type: ask admin to send guide photo
            if (type === 'USDT_BEP20') {
                delete user_states[userId];
                delete user_states[userId + '_dynpay_pending'];
                user_states[userId] = `AWAITING_GUIDE_PHOTO:${autoId}`;
                return bot.sendMessage(chatId,
                    E(`📸 <b>Guide Photo</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `এখন <b>${newMethod.label}</b> ওয়ালেটের জন্য গাইড পিকিচার পাঠান\n` +
                    `<i>(পিকিচার না দিতে চাইলে "skip" লিখুন)</i>`),
                    { parse_mode: 'HTML', reply_markup: { keyboard: [[{ text: 'skip' }, { text: 'Stop', style: 'danger' }]], resize_keyboard: true } }
                );
            }

            delete user_states[userId];
            delete user_states[userId + '_dynpay_pending'];
            return bot.sendMessage(chatId,
                E(`💳 <b>Pay Method Control</b>\n━━━━━━━━━━━━━━━━━━━━\n🟢 = চালু  🔴 = বন্ধ`),
                { parse_mode: 'HTML', reply_markup: getPayMethodKeyboard() }
            );
        } catch (e) {
            return bot.sendMessage(chatId, `❌ Error: ${e.message}`, { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() });
        }
    }

    // ─── PAY METHOD TOGGLE (admin) ──────────────────────────────────────
    if (data.startsWith('toggle_paymethod:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const methodKey = data.replace('toggle_paymethod:', '');
        if (disabledPayMethods.includes(methodKey)) {
            disabledPayMethods = disabledPayMethods.filter(k => k !== methodKey);
        } else {
            disabledPayMethods.push(methodKey);
        }
        if (isUserDBReady) {
            await ConfigModel.findOneAndUpdate(
                { key: 'disabled_pay_methods' },
                { value: JSON.stringify(disabledPayMethods) },
                { upsert: true }
            );
        }
        const isOff = disabledPayMethods.includes(methodKey);
        await safeAnswerCallback(call.id, { text: `${methodKey} ${isOff ? 'OFF ❌' : 'ON ✅'}` });
        return safeEditMessage(chatId, msgId,
            E(`💳 <b>Pay Method Control</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🟢 = চালু  🔴 = বন্ধ\n\n` +
            `প্রতিটি পেমেন্ট মেথড আলাদাভাবে ON/OFF করুন।\n` +
            `Withdraw সম্পূর্ণ বন্ধ করতে নিচের বাটন ব্যবহার করুন।`),
            { parse_mode: 'HTML', reply_markup: getPayMethodKeyboard() }
        );
    }

    // ─── GUIDE PHOTO SET (📸 বাটন থেকে) ────────────────────────────────
    if (data.startsWith('set_guide_photo:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const targetKey = data.replace('set_guide_photo:', '');
        const validMethod = WALLET_METHODS.find(m => m.key === targetKey) || dynamicPayMethods.find(dm => dm.id === targetKey);
        if (!validMethod) return;
        user_states[userId] = `AWAITING_GUIDE_PHOTO:${targetKey}`;
        return bot.sendMessage(chatId,
            E(`📸 <b>Guide Photo Set</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
            `<b>${validMethod.label}</b> এর জন্য গাইড পিকিচার পাঠান।\n\n` +
            `<i>(পিকিচার বাদ দিতে চাইলে "skip" লিখুন)</i>`),
            { parse_mode: 'HTML', reply_markup: { keyboard: [[{ text: 'skip' }]], resize_keyboard: true, one_time_keyboard: true } }
        );
    }

    // ─── EDIT TYPE FOR DYNAMIC PAY METHOD ──────────────────────────────
    if (data.startsWith('dynpay_edittype:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const parts = data.split(':');
        const newType = parts[1];
        const dmId = parts[2];
        const dmDoc = await DynamicPayMethod.findOne({ id: dmId });
        if (dmDoc) {
            dmDoc.type = newType;
            await dmDoc.save();
            await loadDynamicPayMethods();
        }
        return safeEditMessage(chatId, msgId,
            E(`💳 <b>Pay Method Control</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `✅ টাইপ আপডেট: <b>${newType}</b>\n` +
            `🟢 = চালু  🔴 = বন্ধ`),
            { parse_mode: 'HTML', reply_markup: getPayMethodKeyboard() }
        );
    }

    // ─── VIEW PAY METHOD PANEL (admin shortcut) ─────────────────────────
    if (data === 'admin_pay_method_view' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        return safeEditMessage(chatId, msgId,
            E(`💳 <b>Pay Method Control</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🟢 = চালু  🔴 = বন্ধ\n\n` +
            `প্রতিটি পেমেন্ট মেথড আলাদাভাবে ON/OFF করুন।`),
            { parse_mode: 'HTML', reply_markup: getPayMethodKeyboard() }
        );
    }

    // ─── WITHDRAW TOGGLE (admin) ─────────────────────────────────────────
    if (data === 'toggle_withdraw' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        isWithdrawDisabled = !isWithdrawDisabled;
        if (isUserDBReady) {
            await ConfigModel.findOneAndUpdate(
                { key: 'withdraw_disabled' },
                { value: JSON.stringify(isWithdrawDisabled) },
                { upsert: true }
            );
        }
        await safeAnswerCallback(call.id, { text: `Withdraw ${isWithdrawDisabled ? 'OFF ❌' : 'ON ✅'}` });
        return safeEditMessage(chatId, msgId,
            E(`💳 <b>Pay Method Control</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🟢 = চালু  🔴 = বন্ধ\n\n` +
            `প্রতিটি পেমেন্ট মেথড আলাদাভাবে ON/OFF করুন।\n` +
            `Withdraw সম্পূর্ণ বন্ধ করতে নিচের বাটন ব্যবহার করুন।`),
            { parse_mode: 'HTML', reply_markup: getPayMethodKeyboard() }
        );
    }

    // ─── CHANGE MIN WITHDRAW LIMIT (admin) ──────────────────────────────
    if (data === 'change_min_withdraw' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        user_states[userId] = 'AWAITING_MIN_WITHDRAW_LIMIT';
        return bot.sendMessage(chatId,
            E(`💲 <b>Minimum Withdraw Limit পরিবর্তন</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `⚙️ বর্তমান লিমিট: <b>$${minWithdrawLimit.toFixed(2)}</b>\n\n` +
            `নতুন লিমিট টাইপ করুন (যেমন: <code>0.50</code> বা <code>1.00</code>):`),
            { parse_mode: 'HTML', reply_markup: { keyboard: [[{ text: 'Stop', icon_custom_emoji_id: _BTN_EM.reject.id, style: 'danger' }]], resize_keyboard: true } }
        );
    }

    // ─── SUB-ADMIN MANAGEMENT CALLBACKS ─────────────────────────────────
    if (data === 'sa_add_start' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        user_states[userId] = 'AWAITING_SA_UID';
        subadmin_add_temp[userId] = {};
        await safeEditMessage(chatId, msgId, "👤 নতুন Sub Admin এর <b>User ID</b> পাঠান:", { parse_mode: 'HTML' });
        bot.sendMessage(userId, "✏️ Sub Admin এর Telegram User ID লিখুন:", { reply_markup: getAdminMenuKeyboard(true) });
        return;
    }

    if (data.startsWith('sa_toggle:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const key = data.split(':')[1];
        if (!subadmin_add_temp[userId]) subadmin_add_temp[userId] = { selectedKeys: [] };
        const sel = subadmin_add_temp[userId].selectedKeys || [];
        const idx = sel.indexOf(key);
        if (idx === -1) sel.push(key); else sel.splice(idx, 1);
        subadmin_add_temp[userId].selectedKeys = sel;
        const uid = subadmin_add_temp[userId].targetUid;
        await safeEditMessage(chatId, msgId,
            `✅ User ID: <code>${uid}</code>\n\n📋 বাটন সিলেক্ট করুন (✅ = allowed):`,
            { parse_mode: 'HTML', reply_markup: getSubAdminPermKeyboard(sel) }
        );
        return;
    }

    if (data === 'sa_confirm' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const temp = subadmin_add_temp[userId];
        if (!temp || !temp.targetUid) {
            await safeEditMessage(chatId, msgId, "❌ ডেটা পাওয়া যায়নি। আবার চেষ্টা করুন।");
            return;
        }
        const { targetUid, selectedKeys } = temp;
        try {
            await SubAdminModel.findOneAndUpdate(
                { userId: targetUid },
                { userId: targetUid, allowedButtons: selectedKeys },
                { upsert: true, returnDocument: 'after' }
            );
            delete subadmin_add_temp[userId];
            delete user_states[userId];
            const permsText = selectedKeys.length > 0
                ? selectedKeys.map(k => ADMIN_BUTTONS.find(b => b.key === k)?.label || k).join(', ')
                : 'কোন access নেই';
            await safeEditMessage(chatId, msgId,
                `✅ <b>Sub Admin Add সম্পন্ন!</b>\n\n👤 UID: <code>${targetUid}</code>\n📋 Access: ${permsText}`,
                { parse_mode: 'HTML' }
            );
            bot.sendMessage(userId, "Admin Panel", { reply_markup: getAdminMenuKeyboard() });
        } catch(e) {
            await safeEditMessage(chatId, msgId, "❌ DB Error। আবার চেষ্টা করুন।");
        }
        return;
    }

    if (data === 'sa_cancel' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        delete subadmin_add_temp[userId];
        delete user_states[userId];
        await safeEditMessage(chatId, msgId, "✅ বাতিল করা হয়েছে।");
        bot.sendMessage(userId, "Admin Panel", { reply_markup: getAdminMenuKeyboard() });
        return;
    }

    if (data === 'sa_close' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        try { await bot.deleteMessage(chatId, msgId); } catch(e) {}
        return;
    }

    if (data === 'sa_delete_menu' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        await sendSubAdminDeleteMenu(chatId, msgId);
        return;
    }

    if (data.startsWith('sa_remove:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const targetUid = parseInt(data.split(':')[1]);
        try {
            await SubAdminModel.deleteOne({ userId: targetUid });
            await safeEditMessage(chatId, msgId,
                `✅ Sub Admin <code>${targetUid}</code> Remove করা হয়েছে।`,
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[mkInlineBtn('🔙 Back', 'sa_list_back', 'primary')]] } }
            );
        } catch(e) {
            await safeEditMessage(chatId, msgId, "❌ Remove করতে সমস্যা হয়েছে।");
        }
        return;
    }

    if (data === 'sa_list_back' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        await sendSubAdminList(chatId, msgId);
        return;
    }

    // 📊 STOCK & PRICE STATUS (moved here from old standalone Status button)
    if (data === 'cfg_stock_status' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        await sendStatus(chatId, userId);
        return;
    }

    // 🔄 BACKUP SYNC: Sub-menu — ৩টি অপশন দেখাবে
    if (data === 'cfg_backup_sync' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const lastBackupText = 'MongoDB Direct (No local cache)';
        const subMarkup = {
            inline_keyboard: [
                [mkInlineBtn('📥 Backup Download', 'cfg_backup_dl', 'success')],
                [mkInlineBtn('📤 Upload Backup', 'cfg_backup_upload', 'primary')],
                [mkInlineBtn('🔄 Backup Sync', 'cfg_backup_do_sync', 'primary')],
                [mkInlineBtn('🔙 Back', 'cfg_back', 'primary')],
            ]
        };
        await safeEditMessage(chatId, msgId,
            `📦 <b>Backup & Sync</b>\n\n🕒 সর্বশেষ Backup: <code>${lastBackupText}</code>\n\nনিচ থেকে অপশন বেছে নিন:`,
            { parse_mode: 'HTML', reply_markup: subMarkup }
        );
        return;
    }

    // 📥 BACKUP DOWNLOAD: প্রতিটা collection আলাদা ফাইল হিসেবে পাঠাবে (big file safe)
    if (data === 'cfg_backup_dl' && isAdmin(userId)) {
        await safeAnswerCallback(call.id, { text: '📥 Backup তৈরি হচ্ছে...' });
        await safeEditMessage(chatId, msgId,
            `⏳ <b>Backup তৈরি হচ্ছে...</b>\nপ্রতিটা collection আলাদা ফাইলে পাঠানো হবে...`,
            { parse_mode: 'HTML' }
        );
        try {
            const nowStr = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour12: false })
                .replace(/[/:,\s]+/g, '-');
            const timeLabel = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour12: true });

            // MongoDB থেকে সরাসরি export করো
            const exportMap = [
                { key: 'configs',   model: ConfigModel,    label: '⚙️ Configs' },
                { key: 'wallets',   model: WalletUser,     label: '💰 Wallets' },
                { key: 'numbers',   model: NumberModel,    label: '🔢 Numbers' },
                { key: 'withdraws', model: WithdrawRequest,label: '💸 Withdraws' },
                { key: 'users',     model: UserModel,      label: '👥 Users' },
                { key: 'otp_stats', model: UserOtpStat,    label: '📊 OTP Stats' },
            ];

            const headerText = `📦 <b>DB Backup শুরু হচ্ছে (MongoDB)</b>\n🕒 <code>${timeLabel}</code>\n👤 By: <code>${userId}</code>\n\n📂 মোট ${exportMap.length}টি collection export হবে:`;
            for (const adminId of ADMIN_IDS) {
                try { await bot.sendMessage(adminId, headerText, { parse_mode: 'HTML' }); } catch(e) {}
            }

            let sentCount = 0;
            let failCount = 0;
            for (const { key, model, label } of exportMap) {
                if (!model) continue;
                try {
                    const docs = await model.find({}).lean();
                    const jsonBuf = Buffer.from(JSON.stringify(docs, null, 2), 'utf8');
                    const sizeMB = (jsonBuf.length / 1024 / 1024).toFixed(1);
                    const fName = `backup_${key}_${nowStr}.json`;
                    const cap = `${label}\n📁 <code>${fName}</code>\n📦 Size: <b>${sizeMB} MB</b>\n📊 Docs: <b>${docs.length}</b>`;
                    for (const adminId of ADMIN_IDS) {
                        try {
                            await bot.sendDocument(adminId, jsonBuf,
                                { caption: cap, parse_mode: 'HTML' },
                                { filename: fName, contentType: 'application/json' }
                            );
                        } catch(e) { console.error(`[Backup DL] ${key} → admin ${adminId}:`, e.message); }
                    }
                    sentCount++;
                } catch(e) {
                    console.error(`[Backup DL] read ${key}:`, e.message);
                    failCount++;
                }
            }

            const subMarkup = { inline_keyboard: [[mkInlineBtn('🔙 Back', 'cfg_backup_sync', 'primary')]] };
            await safeEditMessage(chatId, msgId,
                `✅ <b>Backup সম্পন্ন!</b>\n\n📂 Sent: <b>${sentCount}</b> ফাইল${failCount > 0 ? `\n⚠️ Failed: <b>${failCount}</b>` : ''}\n📨 সব এডমিনকে পাঠানো হয়েছে।\n\n💡 Upload করতে: এই ফাইলগুলো একটা একটা করে <b>Upload Backup</b> এ পাঠান।`,
                { parse_mode: 'HTML', reply_markup: subMarkup }
            );
        } catch (e) {
            console.error('[Backup DL] error:', e.message);
            await safeEditMessage(chatId, msgId,
                `❌ <b>Backup তৈরিতে সমস্যা হয়েছে</b>\n<code>${e.message}</code>`,
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[mkInlineBtn('🔙 Back', 'cfg_backup_sync', 'primary')]] } }
            );
        }
        return;
    }

    // 📤 UPLOAD BACKUP: এডমিন zip ফাইল আপলোড করে restore করবে
    if (data === 'cfg_backup_upload' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        user_states[userId] = 'AWAITING_BACKUP_ZIP';
        await safeEditMessage(chatId, msgId,
            `📤 <b>Backup আপলোড</b>\n\n⚠️ প্রতিটা ফাইল আলাদাভাবে restore হবে।\n\n📋 <b>নিয়ম:</b>\n• Backup Download এ পাঠানো <b>.json</b> ফাইলগুলো একটা একটা করে এখানে পাঠান\n• বড় ফাইল (withdraws) একটু সময় নেবে\n• সব ফাইল পাঠানো হলে <code>/done</code> লিখুন\n• বাতিল করতে <code>/cancel</code> লিখুন`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[mkInlineBtn('❌ Cancel', 'cfg_backup_sync', 'danger')]] } }
        );
        return;
    }

    // 🔄 BACKUP DO SYNC: Remote DB-তে sync
    if (data === 'cfg_backup_do_sync' && isAdmin(userId)) {
        await safeAnswerCallback(call.id, { text: '🔄 Sync শুরু হচ্ছে...' });

        const dbStatus = [isNumberDBReady, isUserDBReady, isStatusDBReady].filter(Boolean).length;
        const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour12: true });

        await safeEditMessage(chatId, msgId,
            `🔄 <b>Backup Sync চলছে...</b>\nMongoDB সরাসরি ব্যবহার হচ্ছে।\nদয়া করে একটু অপেক্ষা করুন...`,
            { parse_mode: 'HTML' }
        );

        let ok = true;
        // MongoDB-তে সরাসরি write হয়, আলাদা sync দরকার নেই
        const lastBackupText = now;
        const resultMsg = dbStatus >= 2
            ? `✅ <b>MongoDB সরাসরি ব্যবহার হচ্ছে!</b>\n\n🔗 DB Connected: <b>${dbStatus}/3</b>\n🕒 Current Time: <code>${lastBackupText}</code>\n\n💡 Local DB নেই — সব data সরাসরি MongoDB-তে যাচ্ছে।`
            : `⚠️ <b>DB Connection সমস্যা</b>\n\n🔗 DB Connected: <b>${dbStatus}/3</b>\n\nMongoDB reconnect এর জন্য অপেক্ষা করুন।`;

        await safeEditMessage(chatId, msgId, resultMsg,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[mkInlineBtn('🔙 Back', 'cfg_backup_sync', 'primary')]] } }
        );
        return;
    }

    // 💵 PRICE UPDATE CALLBACKS (Config থেকে)
    if (data === 'cfg_price_menu' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        await sendPriceSectorMenu(chatId, msgId);
        return;
    }

    if (data.startsWith('cfg_price_sector:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const sectorId = data.split(':')[1];
        await sendPriceCountryMenu(chatId, msgId, sectorId);
        return;
    }

    // 🔢 NUMBER LIMIT CALLBACKS
    if (data === 'cfg_numlimit' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        await rebuildCountryCache();
        await sendNumberLimitMenu(chatId, msgId);
        return;
    }

    if (data.startsWith('nl_set:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const countryName = data.slice('nl_set:'.length);
        const currentLimit = await getNumberLimit(countryName);
        const flag = country_data_cache[countryName]?.flag || '🌍';
        user_states[userId] = `AWAITING_NL_INPUT:${countryName}`;
        await safeEditMessage(chatId, msgId,
            `🔢 <b>${flag} ${countryName}</b>\n\nCurrent limit: <code>${currentLimit}</code> টি\n\nনতুন limit লিখুন (১-২০):`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[mkInlineBtn('❌ Cancel', 'cfg_numlimit', 'danger')]] } }
        );
        bot.sendMessage(userId, `✏️ ${flag} ${countryName} এর limit লিখুন:`, { reply_markup: getAdminMenuKeyboard(true) });
        return;
    }

    if (data === 'cfg_back' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        delete user_states[userId];
        await sendSubAdminList(chatId, msgId);
        return;
    }

    // ════════════════════════════════════════════════════════
    // 🚫 OTP FILTER SYSTEM
    // ════════════════════════════════════════════════════════

    // Filter মেনু দেখানো
    if (data === 'cfg_filter_menu' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        await showOtpFilterMenu(chatId, msgId);
        return;
    }

    // নতুন ফিল্টার যোগ করা শুরু
    if (data === 'cfg_filter_add' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        user_states[userId] = 'FILTER_AWAITING_COUNTRY';
        await safeEditMessage(chatId, msgId,
            `🚫 <b>নতুন OTP ফিল্টার যোগ করুন</b>\n\n` +
            `📌 কোন <b>দেশের</b> ফিল্টার করতে চান?\n` +
            `দেশের ISO কোড বা নাম লিখুন:\n` +
            `(যেমন: <code>BD</code> বা <code>Bangladesh</code>)\n` +
            `(যেমন: <code>IN</code> বা <code>India</code>)`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[mkInlineBtn('❌ বাতিল', 'cfg_filter_menu', 'danger')]] } }
        );
        bot.sendMessage(userId, `✏️ দেশের নাম বা ISO কোড লিখুন:`, { reply_markup: getAdminMenuKeyboard(true) });
        return;
    }

    // একটি ফিল্টার ডিলিট করা
    if (data.startsWith('cfg_filter_del:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const filterId = data.split(':')[1];
        try {
            await OtpFilterModel.findByIdAndDelete(filterId);
            await syncOtpFilterCache();
            await showOtpFilterMenu(chatId, msgId);
        } catch(e) {
            await safeEditMessage(chatId, msgId, `❌ ডিলিট করতে সমস্যা হয়েছে।`, {
                reply_markup: { inline_keyboard: [[mkInlineBtn('🔙 Back', 'cfg_filter_menu', 'primary')]] }
            });
        }
        return;
    }

    // সব ফিল্টার একসাথে ডিলিট
    if (data === 'cfg_filter_clear_all' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        await safeEditMessage(chatId, msgId,
            `⚠️ <b>সব ফিল্টার মুছে ফেলবেন?</b>\n\nএই কাজটি পূর্বাবস্থায় ফেরানো যাবে না!`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
                [mkInlineBtn('✅ হ্যাঁ, সব মুছুন', 'cfg_filter_clear_confirm', 'danger')],
                [mkInlineBtn('🔙 না, ফিরে যান', 'cfg_filter_menu', 'primary')]
            ]}}
        );
        return;
    }

    if (data === 'cfg_filter_clear_confirm' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        await OtpFilterModel.deleteMany({});
        await syncOtpFilterCache();
        await showOtpFilterMenu(chatId, msgId);
        return;
    }

    // 🛠 MAINTEN: Config থেকে ট্রিগার
    if (data === 'cfg_mainten' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        return bot.sendMessage(chatId, "🛠 <b>বট মেইনটেন্যান্স কন্ট্রোল</b>\n\nচালু থাকলে সাধারণ ইউজাররা বট ব্যবহার করতে পারবে না।", {
            parse_mode: 'HTML',
            reply_markup: getMaintenanceKeyboard()
        });
    }

    // 🎁 BONUS: Config থেকে ট্রিগার
    if (data === 'cfg_bonus' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const BADGES = ['🥇','🥈','🥉','💎','👑','🌟','⭐','🎖️','🏆','💠'];
        let msg = `🎁 <b>Referral Commission Levels</b>\n══════════════════════\n`;
        REF_LEVELS.forEach((lvl, idx) => {
            const badge = BADGES[idx] || '🔹';
            msg += `${badge} <b>Level ${lvl.level}</b> | MinRefs: <b>${lvl.minRefs}</b> | Commission: <b>$${lvl.commission.toFixed(4)}</b>/OTP\n`;
        });
        msg += `══════════════════════\n`;
        msg += `💡 নিচ থেকে যেকোনো Level এডিট করুন বা নতুন Level যোগ করুন।`;
        const keyboard = [];
        REF_LEVELS.forEach((lvl, idx) => {
            keyboard.push([
                { text: `L${lvl.level} Commission এডিট`, callback_data: `bonus_edit_comm:${idx}`, style: 'primary' },
                { text: `L${lvl.level} MinRefs এডিট`, callback_data: `bonus_edit_minrefs:${idx}`, style: 'primary' },
            ]);
        });
        keyboard.push([{ text: 'নতুন Level যোগ করুন', callback_data: 'bonus_add_level', style: 'success' }]);
        keyboard.push([{ text: 'শেষ Level মুছুন', callback_data: 'bonus_del_last', style: 'danger' }]);
        return bot.sendMessage(chatId, msg, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        });
    }


    if (data === 'cfg_method_start' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        user_states[userId] = 'AWAITING_METHOD_COUNTRY';
        await safeEditMessage(chatId, msgId,
            `🔗 <b>Select Method</b>\n\nযে দেশের জন্য মেথড লিংক সেট করতে চান, তার নাম / শর্ট নাম / কান্ট্রি কোড লিখুন:\n(যেমন: <code>Bangladesh</code> অথবা <code>BD</code>)`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[mkInlineBtn('❌ Cancel', 'cfg_back', 'danger')]] } }
        );
        bot.sendMessage(userId, `✏️ দেশের নাম লিখুন:`, { reply_markup: getAdminMenuKeyboard(true) });
        return;
    }

    // 🔗 METHOD LINK: লিস্ট দেখানো
    if (data === 'cfg_method_list' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const methods = await CountryMethodModel.find({}).sort({ country: 1 });
        if (methods.length === 0) {
            await safeEditMessage(chatId, msgId,
                `📜 <b>Method List</b>\n\n❌ এখনো কোনো দেশের মেথড লিংক সেট করা হয়নি।`,
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[mkInlineBtn('🔙 Back', 'cfg_back', 'primary')]] } }
            );
            return;
        }
        const rows = methods.map(m => [
            mkInlineBtn(`${m.flag || '🌍'} ${m.country}`, `method_edit:${m._id}`, 'primary'),
            mkInlineBtn('🗑 Delete', `method_delete:${m._id}`, 'danger')
        ]);
        rows.push([mkInlineBtn('🔙 Back', 'cfg_back', 'primary')]);
        await safeEditMessage(chatId, msgId,
            `📜 <b>Method List</b>\n\nএডিট করতে দেশের নামে চাপ দিন, ডিলিট করতে 🗑 Delete চাপ দিন:`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
        );
        return;
    }

    // 🔗 METHOD LINK: ডিলিট কনফার্মেশন
    if (data.startsWith('method_delete:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const methodId = data.split(':')[1];
        const entry = await CountryMethodModel.findById(methodId);
        if (!entry) {
            await safeEditMessage(chatId, msgId, `❌ এই এন্ট্রি খুঁজে পাওয়া যায়নি।`, {
                reply_markup: { inline_keyboard: [[mkInlineBtn('🔙 Back', 'cfg_method_list', 'primary')]] }
            });
            return;
        }
        await safeEditMessage(chatId, msgId,
            `🗑 <b>Method Delete করবেন?</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `${entry.flag || '🌍'} Country: <b>${entry.country}</b>\n` +
            `🔗 Link: <code>${entry.link}</code>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `নিশ্চিত করুন:`,
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        mkInlineBtn('✅ Yes, Delete', `method_delete_confirm:${entry._id}`, 'danger'),
                        mkInlineBtn('❌ Cancel', 'cfg_method_list', 'primary')
                    ]]
                }
            }
        );
        return;
    }

    // 🔗 METHOD LINK: ডিলিট কনফার্ম হলে আসলে রিমুভ করা
    if (data.startsWith('method_delete_confirm:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const methodId = data.split(':')[1];
        const entry = await CountryMethodModel.findByIdAndDelete(methodId);
        if (!entry) {
            await safeEditMessage(chatId, msgId, `❌ এই এন্ট্রি খুঁজে পাওয়া যায়নি (হয়তো আগেই ডিলিট হয়ে গেছে)।`, {
                reply_markup: { inline_keyboard: [[mkInlineBtn('🔙 Back', 'cfg_method_list', 'primary')]] }
            });
            return;
        }
        await safeEditMessage(chatId, msgId,
            `✅ <b>${entry.country}</b> এর মেথড লিংক ডিলিট করা হয়েছে।`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[mkInlineBtn('🔙 Back to List', 'cfg_method_list', 'primary')]] } }
        );
        return;
    }

    // 🔗 METHOD LINK: এডিট শুরু
    if (data.startsWith('method_edit:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const methodId = data.split(':')[1];
        const entry = await CountryMethodModel.findById(methodId);
        if (!entry) {
            await safeEditMessage(chatId, msgId, `❌ এই এন্ট্রি খুঁজে পাওয়া যায়নি।`, {
                reply_markup: { inline_keyboard: [[mkInlineBtn('🔙 Back', 'cfg_method_list', 'primary')]] }
            });
            return;
        }
        user_states[userId] = `AWAITING_METHOD_LINK_EDIT:${entry._id}`;
        await safeEditMessage(chatId, msgId,
            `✏️ <b>Method এডিট করুন</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `${entry.flag || '🌍'} Country: <b>${entry.country}</b>\n` +
            `🔗 Current Link: <code>${entry.link}</code>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `নতুন লিংক দিন:`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[mkInlineBtn('❌ Cancel', 'cfg_method_list', 'danger')]] } }
        );
        bot.sendMessage(userId, `✏️ ${entry.country} এর নতুন লিংক দিন:`, { reply_markup: getAdminMenuKeyboard(true) });
        return;
    }

    // ─────────────────────────────────────────────────────────────────────

    // ─── FIND USER — পেজ নেভিগেশন ──────────────────────────────────────
    if (data.startsWith('fu_page:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const page = parseInt(data.replace('fu_page:', '')) || 0;
        await sendFindUserList(chatId, userId, page, msgId);
        return;
    }

    // ─── FIND USER — back to list (same page) ────────────────────────
    if (data.startsWith('fu_back') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const parts = data.split(':');
        const page = parseInt(parts[1]) || 0;
        await sendFindUserList(chatId, userId, page, msgId);
        return;
    }

    // ─── FIND USER — search prompt ───────────────────────────────────
    if (data === 'fu_search' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        user_states[userId] = 'FIND_USER_SEARCH';
        bot.sendMessage(chatId, '🔍 ইউজারের UID বা Username লিখুন:', { reply_markup: getAdminMenuKeyboard(true) });
        return;
    }

    // ─── FIND USER — view single user (edit same msg) ────────────────
    if (data.startsWith('fu_view:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const parts = data.split(':');
        const targetId = Number(parts[1]);
        const fromPage = parseInt(parts[2]) || 0;
        await sendUserDetailCard(chatId, userId, targetId, msgId, fromPage);
        return;
    }

    // ─── FIND USER — add balance prompt ──────────────────────────────
    if (data.startsWith('fu_add:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const parts = data.split(':');
        const targetId = parts[1];
        const fromPage = parts[2] || '0';
        user_states[userId] = `ADMIN_ADD_BAL:${targetId}:${fromPage}`;
        bot.sendMessage(chatId, `➕ কত ব্যালেন্স যোগ করবেন?\n(যেমন: <code>0.5</code> বা <code>1.0</code>)\n\nUID: <code>${targetId}</code>`, { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard(true) });
        return;
    }

    // ─── FIND USER — remove balance prompt ───────────────────────────
    if (data.startsWith('fu_rem:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const parts = data.split(':');
        const targetId = parts[1];
        const fromPage = parts[2] || '0';
        user_states[userId] = `ADMIN_REM_BAL:${targetId}:${fromPage}`;
        bot.sendMessage(chatId, `➖ কত ব্যালেন্স কাটবেন?\n(যেমন: <code>0.5</code> বা <code>1.0</code>)\n\nUID: <code>${targetId}</code>`, { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard(true) });
        return;
    }

    // ─── BACK TO ADMIN MENU (from inline) ────────────────────────────────
    if (data === 'back_admin_menu' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        return safeEditMessage(chatId, msgId, "Admin Panel", { reply_markup: { inline_keyboard: [] } });
    }

    // ─── NUM INFO: Pending Schedule ───────────────────────────────────────
    if (data === 'ni_pending' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        return sendNumInfoPanel(chatId, msgId);
    }

    if (data === 'ni_back' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const rows = [
            [{ text: '⏳ Pending Schedule', callback_data: 'ni_pending', style: 'primary' }],
            [{ text: '🔢 All Number', callback_data: 'an_back', style: 'primary' }],
            [{ text: '🔙 Back', callback_data: 'ni_back', icon_custom_emoji_id: _BTN_EM.back_admin.id, style: 'primary' }]
        ];
        return safeEditMessage(chatId, msgId,
            `📋 <b>Num Info</b>\n━━━━━━━━━━━━━━━━━━━━━━━\nকী দেখতে চান?`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
        );
    }

    // Pending scheduled add ডিলিট
    if (data.startsWith('ni_del:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const targetUid = data.split(':')[1];
        if (scheduled_add_timers[targetUid]) {
            clearTimeout(scheduled_add_timers[targetUid].timer);
            const info = scheduled_add_timers[targetUid];
            delete scheduled_add_timers[targetUid];
            try {
                await bot.sendMessage(Number(targetUid),
                    `❌ <b>আপনার Scheduled Add Cancel করা হয়েছে।</b>\n🌍 দেশ: ${info.countryName} | ⏰ সময়: ${info.timeLabel}`,
                    { parse_mode: 'HTML' }
                );
            } catch(e) {}
        }
        return sendNumInfoPanel(chatId, msgId);
    }

    // ─── ALL NUMBER: Platform list (back) ────────────────────────────────
    if (data === 'an_back' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        return safeEditMessage(chatId, msgId,
            `🔢 <b>All Number Control</b>\n━━━━━━━━━━━━━━━━━━━━━━━\nপ্ল্যাটফর্ম সিলেক্ট করুন বা All Country দেখুন:`,
            { parse_mode: 'HTML', reply_markup: await getAllNumberSectorKeyboard() }
        );
    }

    if (data === 'an_back_main' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        return safeEditMessage(chatId, msgId,
            `🔢 <b>All Number Control</b>\n━━━━━━━━━━━━━━━━━━━━━━━\nপ্ল্যাটফর্ম সিলেক্ট করুন বা All Country দেখুন:`,
            { parse_mode: 'HTML', reply_markup: await getAllNumberSectorKeyboard() }
        );
    }

    // ALL NUMBER: প্ল্যাটফর্ম ক্লিক → সেই প্ল্যাটফর্মের দেশের অন/অফ লিস্ট
    if (data.startsWith('an_sector:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const sectorId = data.split(':')[1];
        const sectorInfo = SECTORS.find(s => s.id === sectorId);
        const kb = await getAllNumberCountryInSectorKeyboard(sectorId);
        return safeEditMessage(chatId, msgId,
            `${getSectorEmoji(sectorInfo)} <b>${sectorInfo ? sectorInfo.label : sectorId}</b> — দেশ অন/অফ করুন:`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    }

    // ALL NUMBER: সিঙ্গেল দেশ toggle (প্ল্যাটফর্মের ভেতর থেকে)
    // ── PLATFORM-SPECIFIC: একটা প্ল্যাটফর্মের একটা দেশ toggle (শুধু ঐ sector-এ) ──
    if (data.startsWith('an_tog:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const parts = data.split(':');
        const sectorId = parts[1];
        const countryName = parts.slice(2).join(':');

        // Per-sector toggle — শুধু এই sectorId এর জন্য
        if (!disabledCountriesBySector[sectorId]) disabledCountriesBySector[sectorId] = [];
        const arr = disabledCountriesBySector[sectorId];
        if (arr.includes(countryName)) {
            disabledCountriesBySector[sectorId] = arr.filter(c => c !== countryName);
        } else {
            arr.push(countryName);
        }
        await saveDisabledCountriesBySector();

        const sectorInfo = SECTORS.find(s => s.id === sectorId);
        const kb = await getAllNumberCountryInSectorKeyboard(sectorId);
        return safeEditMessage(chatId, msgId,
            `${getSectorEmoji(sectorInfo)} <b>${sectorInfo ? sectorInfo.label : sectorId}</b> — দেশ অন/অফ করুন:\n<i>⚠️ এখানে OFF করলে শুধু এই প্ল্যাটফর্মে বন্ধ হবে</i>`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    }

    // ── PLATFORM-SPECIFIC: একটা সেক্টরের সব দেশ OFF (শুধু ঐ sector-এ) ──
    if (data.startsWith('an_sec_all_off:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const sectorId = data.split(':')[1];
        const countries = await NumberModel.aggregate([
            { $match: { sector: sectorId } },
            { $group: { _id: '$country' } }
        ]);
        const names = countries.map(c => c._id);
        if (!disabledCountriesBySector[sectorId]) disabledCountriesBySector[sectorId] = [];
        disabledCountriesBySector[sectorId] = [...new Set([...disabledCountriesBySector[sectorId], ...names])];
        await saveDisabledCountriesBySector();

        const sectorInfo = SECTORS.find(s => s.id === sectorId);
        const kb = await getAllNumberCountryInSectorKeyboard(sectorId);
        return safeEditMessage(chatId, msgId,
            `${getSectorEmoji(sectorInfo)} <b>${sectorInfo ? sectorInfo.label : sectorId}</b> — সব দেশ 🔴 OFF:\n<i>⚠️ শুধু এই প্ল্যাটফর্মে বন্ধ হয়েছে</i>`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    }

    // ── PLATFORM-SPECIFIC: একটা সেক্টরের সব দেশ ON (শুধু ঐ sector-এ) ──
    if (data.startsWith('an_sec_all_on:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const sectorId = data.split(':')[1];
        const countries = await NumberModel.aggregate([
            { $match: { sector: sectorId } },
            { $group: { _id: '$country' } }
        ]);
        const names = countries.map(c => c._id);
        if (disabledCountriesBySector[sectorId]) {
            disabledCountriesBySector[sectorId] = disabledCountriesBySector[sectorId].filter(c => !names.includes(c));
        }
        await saveDisabledCountriesBySector();

        const sectorInfo = SECTORS.find(s => s.id === sectorId);
        const kb = await getAllNumberCountryInSectorKeyboard(sectorId);
        return safeEditMessage(chatId, msgId,
            `${getSectorEmoji(sectorInfo)} <b>${sectorInfo ? sectorInfo.label : sectorId}</b> — সব দেশ 🟢 ON:\n<i>✅ এই প্ল্যাটফর্মে সব দেশ চালু হয়েছে</i>`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    }

    // ── GLOBAL: All Country panel (সব প্ল্যাটফর্মের দেশ একসাথে) ──
    if (data === 'an_all_country' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const kb = await getAllCountryToggleKeyboard();
        return safeEditMessage(chatId, msgId,
            `🌍 <b>All Country ON/OFF</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n⚠️ এখানে OFF করলে <b>সব প্ল্যাটফর্মে</b> বন্ধ হবে:`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    }

    // ── GLOBAL: একটি দেশ সব প্ল্যাটফর্মে toggle ──
    if (data.startsWith('an_tog_global:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const countryName = data.split(':').slice(1).join(':');
        if (disabledCountriesGlobal.includes(countryName)) {
            disabledCountriesGlobal = disabledCountriesGlobal.filter(c => c !== countryName);
        } else {
            disabledCountriesGlobal.push(countryName);
        }
        await saveDisabledCountriesGlobal();

        const kb = await getAllCountryToggleKeyboard();
        return safeEditMessage(chatId, msgId,
            `🌍 <b>All Country ON/OFF</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n⚠️ এখানে OFF করলে <b>সব প্ল্যাটফর্মে</b> বন্ধ হবে:`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    }

    // ── GLOBAL: সব দেশ সব প্ল্যাটফর্মে OFF ──
    if (data === 'an_global_all_off' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const all = await NumberModel.aggregate([{ $group: { _id: '$country' } }]);
        const names = all.map(c => c._id);
        disabledCountriesGlobal = [...new Set([...disabledCountriesGlobal, ...names])];
        await saveDisabledCountriesGlobal();

        const kb = await getAllCountryToggleKeyboard();
        return safeEditMessage(chatId, msgId,
            `🌍 <b>All Country ON/OFF</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n🔴 সব দেশ সব প্ল্যাটফর্মে OFF করা হয়েছে:`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    }

    // ── GLOBAL: সব দেশ সব প্ল্যাটফর্মে ON ──
    if (data === 'an_global_all_on' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        disabledCountriesGlobal = [];
        disabledCountriesBySector = {}; // per-sector গুলোও ক্লিয়ার
        await saveDisabledCountriesGlobal();
        await saveDisabledCountriesBySector();

        const kb = await getAllCountryToggleKeyboard();
        return safeEditMessage(chatId, msgId,
            `🌍 <b>All Country ON/OFF</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n🟢 সব দেশ সব প্ল্যাটফর্মে ON করা হয়েছে:`,
            { parse_mode: 'HTML', reply_markup: kb }
        );
    }

    // ─── SECTOR PICK (user getting number) ───────────────────────────────
if (data.startsWith('sector_pick:')) {
    await safeAnswerCallback(call.id);
    const sectorId = data.split(':')[1];
    const sectorInfo = SECTORS.find(s => s.id === sectorId);
    if (!sectorInfo) return;

    await rebuildCountryCache();

    const availInSectorAll = await NumberModel.aggregate([
        { $match: { status: 'Available', sector: sectorId } },
        { $group: { _id: '$country', flag: { $first: '$flag' }, count: { $sum: 1 }, price: { $first: '$price' } } },
        { $sort: { _id: 1 } }
    ]);
    // Admin-এর disabled countries ইউজারকে দেখাবে না
    // per-sector + global উভয়ই চেক — শুধু ঐ sectorId এর disable অন্য sector-এ প্রভাব ফেলবে না
    const availInSector = availInSectorAll.filter(c => !isCountryDisabled(c._id, sectorId));

    if (availInSector.length === 0) {
        await safeEditMessage(chatId, msgId, 
            `❌ ${sectorInfo.label} এ কোন নাম্বার নেই।`,
            { reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: 'back_to_sector_menu', style: 'primary' }]] } }
        );
        return;
    }

    // no_limit batch আছে কোন কোন country-তে (sector_pick)
    const noLimitCountriesSP = new Set();
    try {
        const batchesSP = await NoLimitBatch.find({}, { country: 1 }).lean();
        batchesSP.forEach(b => noLimitCountriesSP.add(b.country));
    } catch(e) {}

    const buttons = [];
    for (let i = 0; i < availInSector.length; i += 2) {
        const row = [];
        const c1 = availInSector[i];
        const c1PriceStr = (c1.price != null && c1.price > 0) ? ` ${c1.price}$` : '';
        const c1NlTag = noLimitCountriesSP.has(c1._id) ? ' ♾️' : '';
        const c1CountStr = ` (${c1.count})${c1NlTag}`;
        row.push(makeCountryButton(c1._id, c1.flag, c1CountStr, `assign_sector:${sectorId}:${countryToIndex[c1._id] ?? 0}:${c1._id}`, userId, c1PriceStr));

        if (availInSector[i + 1]) {
            const c2 = availInSector[i + 1];
            const c2PriceStr = (c2.price != null && c2.price > 0) ? ` ${c2.price}$` : '';
            const c2NlTag = noLimitCountriesSP.has(c2._id) ? ' ♾️' : '';
            const c2CountStr = ` (${c2.count})${c2NlTag}`;
            row.push(makeCountryButton(c2._id, c2.flag, c2CountStr, `assign_sector:${sectorId}:${countryToIndex[c2._id] ?? 0}:${c2._id}`, userId, c2PriceStr));
        }
        buttons.push(row);
    }

    buttons.push([{ text: "Back", callback_data: 'back_to_sector_menu', icon_custom_emoji_id: _BTN_EM.back.id, style: 'primary' }]);

    await safeEditMessage(chatId, msgId, 
        `${getSectorEmoji(sectorInfo)} <b>${sectorInfo.label}</b> - দেশ সিলেক্ট করুন:`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }
    );
    return;
}

    // ─── ADMIN: দেশের প্রাইস এডিট (পেন্সিল বাটন) ──────────────────────────
    if (data.startsWith('editprice:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const parts = data.split(':');
        const sectorId = parts[1];
        const countryName = parts.slice(2).join(':');
        const sectorInfo = SECTORS.find(s => s.id === sectorId);

        const existing = await NumberModel.findOne({ sector: sectorId, country: countryName }).sort({ createdAt: -1 });
        const currentPriceText = (existing && existing.price != null) ? `$${existing.price}` : 'সেট নেই';
        const pFlagEdit = getPremiumFlag(countryName, existing ? existing.flag : null);

        user_states[userId] = `WAIT_EDIT_PRICE:${sectorId}:${countryName}`;

        await bot.sendMessage(chatId,
            `✏️ <b>Price আপডেট করুন</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📱 Platform: <b>${sectorInfo ? sectorInfo.label : sectorId}</b>\n` +
            `${pFlagEdit} Country: <b>${cleanCountryName(countryName)}</b>\n` +
            `💵 Current Price: <b>${currentPriceText}</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `নতুন Price লিখুন (যেমন: <code>0.5</code> বা <code>1.25</code>):`,
            {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: `cfg_price_sector:${sectorId}`, style: 'danger' }]] }
            }
        );
        bot.sendMessage(userId, `✏️ ${cleanCountryName(countryName)} এর নতুন price লিখুন:`, { reply_markup: getAdminMenuKeyboard(true) });
        return;
    }

    if (data === 'back_to_sector_menu') {
        await safeAnswerCallback(call.id);
        await safeEditMessage(chatId, msgId, E('📱 কোন প্ল্যাটফর্মের জন্য নাম্বার নিবেন?'), {
            parse_mode: 'HTML',
            reply_markup: await getGetNumberSectorKeyboard()
        });
        return;
    }

    // assign_sector:sectorId:countryIdx:countryName
    if (data.startsWith('assign_sector:')) {
        await safeAnswerCallback(call.id);
        const parts = data.split(':');
        const sectorId = parts[1];
        const countryName = parts.slice(3).join(':');

        if (!isNumberDBReady) {
            try { await bot.answerCallbackQuery(call.id, { text: `⚠️ Database busy.`, show_alert: true }); } catch(e) {}
            return;
        }

        await safeEditMessage(chatId, msgId, "⏳ নাম্বার দেওয়া হচ্ছে...", { parse_mode: 'Markdown' });

        if (!country_assignment_locks[countryName]) country_assignment_locks[countryName] = new Set();
        if (country_assignment_locks[countryName].has(userId)) return;
        country_assignment_locks[countryName].add(userId);

        try {
            await NumberModel.updateMany(
                { assigned_to: userId, status: 'Used' }, 
                { $set: { status: 'Used_History', assigned_to: null, assigned_at: null } }
            );

            const numLimit = await getNumberLimit(countryName);
            const available = await NumberModel.aggregate([
                { $match: { country: countryName, sector: sectorId, status: 'Available' } },
                { $sample: { size: numLimit } }
            ]);

            if (available.length > 0) {
                const sectorInfo = SECTORS.find(s => s.id === sectorId);
                const assigned = await Promise.all(available.map(n =>
                    NumberModel.findByIdAndUpdate(
                        n._id,
                        { $set: { status: 'Used', assigned_to: userId, assigned_at: new Date() } },
                        { returnDocument: 'after' }
                    )
                ));
                const first = assigned[0];
                const allDisplayNums = assigned.map(n => n.number.startsWith('+') ? n.number : '+' + n.number);
                const [primaryNum, ...extraNums] = allDisplayNums;
                const msgText = ASSIGNMENT_MESSAGE_TEMPLATE(first.flag, cleanCountryName(first.country), allDisplayNums.join('\n'), `Assigned`, `${getSectorEmoji(sectorInfo)} ${sectorInfo.label}`);
                await safeEditMessage(chatId, msgId, msgText,
                    { parse_mode: 'HTML', reply_markup: await getSectorNumberControlKeyboard(sectorId, primaryNum, extraNums, first.country, userId) }
                );
            } else {
                await safeEditMessage(chatId, msgId, `❌ ${countryName} এ ${sectorId} নাম্বার শেষ।`, {
                    reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: 'back_to_sector_menu', style: 'primary' }]] }
                });
            }
        } finally {
            country_assignment_locks[countryName].delete(userId);
        }
        return;
    }

    // ─── ADMIN: TOGGLE SECTOR (for ADD) ──────────────────────────────────
    if (data.startsWith('toggle_sector:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const sectorId = data.split(':')[1];
        if (!admin_file_buffer[userId]) admin_file_buffer[userId] = { selected_sectors: [] };
        const sel = admin_file_buffer[userId].selected_sectors || [];
        const idx = sel.indexOf(sectorId);
        if (idx === -1) sel.push(sectorId);
        else sel.splice(idx, 1);
        admin_file_buffer[userId].selected_sectors = sel;
        const _opts1 = { noLimit: !!(admin_file_buffer[userId].no_limit), scheduleTime: admin_file_buffer[userId].schedule_time || null };

        await safeEditMessage(chatId, msgId,
            buildSectorSelectionText(admin_file_buffer[userId]),
            { parse_mode: 'HTML', reply_markup: getSectorSelectionKeyboard(sel, _opts1) }
        );
        return;
    }

    // ⬜/✅ NO LIMIT toggle
    if (data === 'toggle_no_limit' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        if (!admin_file_buffer[userId]) return;
        admin_file_buffer[userId].no_limit = !admin_file_buffer[userId].no_limit;
        const buf_nl = admin_file_buffer[userId];
        const sel_nl = buf_nl.selected_sectors || [];
        const opts_nl = { noLimit: buf_nl.no_limit, scheduleTime: buf_nl.schedule_time || null };
        await safeEditMessage(chatId, msgId,
            buildSectorSelectionText(buf_nl),
            { parse_mode: 'HTML', reply_markup: getSectorSelectionKeyboard(sel_nl, opts_nl) }
        );
        return;
    }

    // ⬜/✅ SET TIME toggle — চাপলে time ইনপুট চাওয়া হবে; আবার চাপলে cancel
    if (data === 'toggle_set_time' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        if (!admin_file_buffer[userId]) return;
        const buf_st = admin_file_buffer[userId];
        if (buf_st.schedule_time) {
            // আগে সেট ছিল — cancel করো
            buf_st.schedule_time = null;
            const sel_st = buf_st.selected_sectors || [];
            const opts_st = { noLimit: buf_st.no_limit || false, scheduleTime: null };
            await safeEditMessage(chatId, msgId,
                buildSectorSelectionText(buf_st),
                { parse_mode: 'HTML', reply_markup: getSectorSelectionKeyboard(sel_st, opts_st) }
            );
        } else {
            // time এখনো সেট হয়নি — input চাও
            user_states[userId] = 'AWAITING_SCHEDULE_TIME';
            await safeEditMessage(chatId, msgId,
                `⏰ <b>Schedule Time দিন</b>
` +
                `━━━━━━━━━━━━━━━━━━━━━━━
` +
                `📝 Format: <code>6:00 AM</code> বা <code>14:30</code>
` +
                `📌 Bangladesh Time (UTC+6) হিসেবে নেওয়া হবে

` +
                `উদাহরণ: <code>6:00 AM</code>, <code>11:30 PM</code>, <code>18:00</code>`,
                { parse_mode: 'HTML' }
            );
            bot.sendMessage(userId, `⏰ কোন সময়ে নাম্বার ADD হবে? লিখুন (যেমন: <code>6:00 AM</code> বা <code>14:30</code>):`, { parse_mode: 'HTML' });
        }
        return;
    }

    // ✅ CONFIRM & ADD — no_limit + schedule_time কম্বিনেশন সাপোর্ট
    if (data === 'confirm_sector_add' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const buf = admin_file_buffer[userId];
        if (!buf || !buf.file_id) {
            await safeEditMessage(chatId, msgId, "❌ ডেটা পাওয়া যায়নি। আবার ADD চেষ্টা করুন।");
            return;
        }
        const selectedSectors = buf.selected_sectors || [];
        if (selectedSectors.length === 0) {
            try { await bot.answerCallbackQuery(call.id, { text: "কমপক্ষে একটি সেক্টর সিলেক্ট করুন!", show_alert: true }); } catch(e) {}
            return;
        }

        const fileId      = buf.file_id;
        const countryName = buf.country || 'Unknown';
        const flag        = buf.flag    || '🌍';
        const numbers     = buf.numbers || null;
        const totalNums   = numbers ? numbers.length : '?';
        const price       = buf.price != null ? buf.price : null;
        const noLimit     = buf.no_limit || false;
        const schedTime   = buf.schedule_time || null;

        // ── CASE 1: Schedule Time সেট আছে (± no_limit) ──────────────────
        if (schedTime) {
            // schedule time parse করো
            function parseBDTimeFinal(input) {
                const s = input.trim().toUpperCase();
                const m12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
                if (m12) {
                    let h = parseInt(m12[1]);
                    const min = m12[2] ? parseInt(m12[2]) : 0;
                    const meridiem = m12[3];
                    if (h < 1 || h > 12 || min > 59) return null;
                    if (meridiem === 'AM' && h === 12) h = 0;
                    if (meridiem === 'PM' && h !== 12) h += 12;
                    return { h, min };
                }
                const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
                if (m24) {
                    const h = parseInt(m24[1]);
                    const min = parseInt(m24[2]);
                    if (h > 23 || min > 59) return null;
                    return { h, min };
                }
                return null;
            }
            const parsed = parseBDTimeFinal(schedTime);
            if (!parsed) {
                try { await bot.answerCallbackQuery(call.id, { text: "সময়ের ফরম্যাট ভুল! আবার সেট করুন।", show_alert: true }); } catch(e) {}
                return;
            }
            function msUntilBDTimeFinal(h, min) {
                const bdNow = new Date(Date.now() + 6 * 60 * 60 * 1000);
                const target = new Date(bdNow);
                target.setHours(h, min, 0, 0);
                if (target <= bdNow) target.setDate(target.getDate() + 1);
                return target - bdNow;
            }
            const delayMs = msUntilBDTimeFinal(parsed.h, parsed.min);
            const delayMin = Math.round(delayMs / 60000);
            const delayH   = Math.floor(delayMin / 60);
            const delayM   = delayMin % 60;

            delete user_states[userId];
            delete admin_file_buffer[userId];

            const noLimitNote = noLimit ? '\n♾️ No Limit mode চালু থাকবে' : '';
            if (scheduled_add_timers[userId]) {
                clearTimeout(scheduled_add_timers[userId].timer);
                delete scheduled_add_timers[userId];
            }
            const timer = setTimeout(async () => {
                delete scheduled_add_timers[userId];
                bot.sendMessage(userId,
                    `⏰ <b>Scheduled ADD শুরু হচ্ছে!</b>
` +
                    `━━━━━━━━━━━━━━━━━━━━━━━
` +
                    `🌍 দেশ: <b>${countryName}</b>
` +
                    `📊 নাম্বার: <b>${totalNums} টি</b>
` +
                    `📱 Sectors: <b>${selectedSectors.length} টি</b>` +
                    (noLimit ? '\n♾️ No Limit mode' : ''),
                    { parse_mode: 'HTML' }
                ).catch(() => {});

                if (noLimit) {
                    try {
                        await NoLimitBatch.findOneAndUpdate(
                            { country: countryName, sectors: { $all: selectedSectors, $size: selectedSectors.length } },
                            { country: countryName, flag, sectors: selectedSectors, price, file_id: fileId, numbers: numbers || [], createdAt: new Date() },
                            { upsert: true }
                        );
                    } catch(e) { console.error('[no-limit] batch save error:', e.message); }
                }
                processUploadedFileMultiSector(userId, fileId, countryName, flag, selectedSectors, numbers, price, noLimit);
            }, delayMs);

            scheduled_add_timers[userId] = { timer, timeLabel: schedTime, totalNums, countryName };

            await safeEditMessage(chatId, msgId,
                `✅ <b>Scheduled হয়েছে!</b>
` +
                `━━━━━━━━━━━━━━━━━━━━━━━
` +
                `⏰ সময়: <b>${schedTime}</b>
` +
                `🌍 দেশ: <b>${countryName}</b>
` +
                `📊 নাম্বার: <b>${totalNums} টি</b>
` +
                `⏳ বাকি: <b>${delayH > 0 ? delayH+'h ' : ''}${delayM}m পরে ADD হবে</b>` +
                noLimitNote,
                { parse_mode: 'HTML' }
            );
            return;
        }

        // ── CASE 2: No Limit only ────────────────────────────────────────
        if (noLimit) {
            delete user_states[userId];
            delete admin_file_buffer[userId];

            await safeEditMessage(chatId, msgId, `⏳ ♾️ NO LIMIT — ${selectedSectors.length}টি সেক্টরে ${totalNums} নাম্বার এড হচ্ছে...`);
            try {
                await NoLimitBatch.findOneAndUpdate(
                    { country: countryName, sectors: { $all: selectedSectors, $size: selectedSectors.length } },
                    { country: countryName, flag, sectors: selectedSectors, price, file_id: fileId, numbers: numbers || [], createdAt: new Date() },
                    { upsert: true }
                );
            } catch(e) { console.error('[no-limit] batch save error:', e.message); }
            processUploadedFileMultiSector(userId, fileId, countryName, flag, selectedSectors, numbers, price, true);
            return;
        }

        // ── CASE 3: Normal immediate add ────────────────────────────────
        delete user_states[userId];
        delete admin_file_buffer[userId];

        await safeEditMessage(chatId, msgId, `⏳ ${selectedSectors.length}টি সেক্টরে ${totalNums} নাম্বার এড হচ্ছে...`);
        processUploadedFileMultiSector(userId, fileId, countryName, flag, selectedSectors, numbers, price);
        return;
    }

    // ⏭️ SKIP PRICE
    if (data === 'skip_price' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const buf = admin_file_buffer[userId];
        if (!buf) { await safeEditMessage(chatId, msgId, "❌ ডেটা পাওয়া যায়নি।"); return; }
        admin_file_buffer[userId].price = null;
        admin_file_buffer[userId].selected_sectors = admin_file_buffer[userId].selected_sectors || [];
        user_states[userId] = 'ADDING_NUMBER_STEP_3';
        const pFlagSkip = getPremiumFlag(buf.country, buf.flag);
        await safeEditMessage(chatId, msgId,
            buildSectorSelectionText(admin_file_buffer[userId]),
            { parse_mode: 'HTML', reply_markup: getSectorSelectionKeyboard([], {}) }
        );
        return;
    }

    if (data === 'cancel_add' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        delete user_states[userId];
        delete admin_file_buffer[userId];
        await safeEditMessage(chatId, msgId, "✅ বাতিল করা হয়েছে।");
        bot.sendMessage(userId, "Menu:", { reply_markup: getAdminMenuKeyboard() });
        return;
    }

    // Auto detected country — confirm করলে price step এ যাও
    if (data === 'confirm_country_auto' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const buf = admin_file_buffer[userId];
        if (!buf || !buf.numbers) {
            await safeEditMessage(chatId, msgId, "❌ ডেটা পাওয়া যায়নি। আবার চেষ্টা করুন।");
            return;
        }
        admin_file_buffer[userId].selected_sectors = [];
        user_states[userId] = 'AWAITING_PRICE_INPUT';
        const pFlag = getPremiumFlag(buf.country, buf.flag);
        await safeEditMessage(chatId, msgId,
            `✅ দেশ: <b>${pFlag} ${buf.country}</b>\n📊 নাম্বার: <b>${buf.numbers.length} টি</b>\n\n💵 <b>Number Price দিন</b>\nযেমন: <code>1</code>, <code>0.002</code>, <code>0.003</code>\n\nঅথবা Skip করুন:`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "Skip (Price ছাড়া)", callback_data: 'skip_price', style: 'primary' }], [{ text: "Cancel", callback_data: 'cancel_add', style: 'danger' }]] } }
        );
        bot.sendMessage(userId, `💵 Price লিখুন (যেমন: <code>0.002</code>) অথবা /skip টাইপ করুন:`, { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard(true) });
        return;
    }

    // Edit Name — টাইপ করতে বলো
    if (data === 'edit_country_name' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        user_states[userId] = 'ADDING_NUMBER_STEP_2';
        const bufCountry = admin_file_buffer[userId]?.country || "";
        await safeEditMessage(chatId, msgId, `✏️ Suffix লিখুন — দেশের নামের পরে যোগ হবে

যেমন: <b>${bufCountry} Ws</b> বা <b>${bufCountry} NEW</b>`, { parse_mode: "HTML" });
        bot.sendMessage(userId, `দেশের নাম: <b>${bufCountry}</b>

যা suffix দিতে চান তা লিখুন (যেমন: Ws, NEW, VIP):`, { parse_mode: "HTML", reply_markup: getAdminMenuKeyboard(true) });
        return;
    }



    // ─── ADMIN: DELETE BY SECTOR ─────────────────────────────────────────
    if (data.startsWith('del_sector:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const sectorId = data.split(':')[1];
        const sectorInfo = SECTORS.find(s => s.id === sectorId);

        // Show countries inside this sector
        const countriesInSector = await NumberModel.aggregate([
            { $match: { sector: sectorId, status: 'Available' } },
            { $group: { _id: '$country', flag: { $first: '$flag' }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]);

        if (countriesInSector.length === 0) {
            await safeEditMessage(chatId, msgId,
                `❌ ${getSectorEmoji(sectorInfo)}${sectorInfo.label} এ কোন নাম্বার নেই।`,
                { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: 'del_back', style: 'primary' }]] } }
            );
            return;
        }

        // no_limit batch আছে কোন কোন country-তে (del_sector)
        const noLimitCountriesDS = new Set();
        try {
            const batchesDS = await NoLimitBatch.find({}, { country: 1 }).lean();
            batchesDS.forEach(b => noLimitCountriesDS.add(b.country));
        } catch(e) {}

        const rows = countriesInSector.map(c => {
            const nlTagDS = noLimitCountriesDS.has(c._id) ? ' ♾️' : '';
            return [makeCountryButton(c._id, c.flag, ` (${c.count})${nlTagDS} ❌`, `del_sc:${sectorId}:${c._id}`)];
        });
        // Delete all in sector button
        const delAllBtn = { text: `${sectorInfo.label} সব ডিলিট (${countriesInSector.reduce((a,c)=>a+c.count,0)})`, callback_data: `del_sector_all:${sectorId}`, style: 'danger' };
        if (sectorInfo.icon_custom_emoji_id) delAllBtn.icon_custom_emoji_id = sectorInfo.icon_custom_emoji_id;
        rows.push([delAllBtn]);
        rows.push([{ text: "Back", callback_data: 'del_back', style: 'primary' }]);

        await safeEditMessage(chatId, msgId,
            `${getSectorEmoji(sectorInfo)} <b>${sectorInfo.label}</b> — দেশ সিলেক্ট করুন:`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
        );
        return;
    }

    // Back to delete sector menu
    if (data === 'del_back' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        await safeEditMessage(chatId, msgId, "🗑️ কোন সেক্টর থেকে ডিলিট করবেন?", { reply_markup: await getDeleteSectorKeyboard() });
        return;
    }

    // Delete specific country inside a sector: del_sc:sectorId:countryName
    if (data.startsWith('del_sc:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const parts = data.split(':');
        const sectorId = parts[1];
        const countryName = parts.slice(2).join(':');
        const sectorInfo = SECTORS.find(s => s.id === sectorId);

        const markup = {
            inline_keyboard: [
                [{ text: `CONFIRM DELETE`, callback_data: `cdc_sc:${sectorId}:${countryName}`, style: 'danger' }],
                [{ text: "Back", callback_data: `del_sector:${sectorId}`, style: 'primary' }]
            ]
        };
        await safeEditMessage(chatId, msgId,
            `⚠️ নিশ্চিত করুন:\n\n${getSectorEmoji(sectorInfo)} <b>${sectorInfo.label}</b> → <b>${countryName}</b>\nএর সব Fresh নাম্বার ডিলিট করবেন?`,
            { parse_mode: 'HTML', reply_markup: markup }
        );
        return;
    }

    // Confirm delete sector+country
    if (data.startsWith('cdc_sc:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const parts = data.split(':');
        const sectorId = parts[1];
        const countryName = parts.slice(2).join(':');
        const sectorInfo = SECTORS.find(s => s.id === sectorId);
        try { await bot.deleteMessage(chatId, msgId); } catch(e) {}

        bot.sendMessage(userId, `⏳ ${getSectorEmoji(sectorInfo)} ${sectorInfo.label} → ${countryName} backup ও ডিলিট হচ্ছে...`, { parse_mode: 'HTML' });
        try {
            const freshNumbers = await NumberModel.find({ sector: sectorId, country: countryName, status: 'Available' });
            if (freshNumbers.length > 0) {
                const fileContent = freshNumbers.map(n => n.number).join('\n');
                const fileBuffer = Buffer.from(fileContent, 'utf8');
                const fileName = `${sectorInfo.label}_${countryName.replace(/\s/g,'_')}_Backup.txt`;
                for (const adminId of ADMIN_IDS) {
                    try {
                        await bot.sendDocument(adminId, fileBuffer,
                            { caption: `🗑️ Deleted: ${getSectorEmoji(sectorInfo)} ${sectorInfo.label} → ${countryName}\n👤 By: ${userId}\n📂 ${freshNumbers.length} numbers`, parse_mode: 'HTML' },
                            { filename: fileName, contentType: 'text/plain' }
                        );
                    } catch(e) {}
                }
            }
            const result = await NumberModel.deleteMany({ sector: sectorId, country: countryName });
            await rebuildCountryCache();
            bot.sendMessage(userId,
                `✅ ডিলিট সম্পন্ন!\n${getSectorEmoji(sectorInfo)} ${sectorInfo.label} → ${countryName}\n🗑️ ${result.deletedCount} টি নাম্বার ডিলিট।`,
                { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() }
            );
        } catch(error) {
            bot.sendMessage(userId, "❌ ডিলিটে সমস্যা।", { reply_markup: getAdminMenuKeyboard() });
        }
        return;
    }

    // Delete ALL numbers in a sector
    if (data.startsWith('del_sector_all:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const sectorId = data.split(':')[1];
        const sectorInfo = SECTORS.find(s => s.id === sectorId);
        const markup = {
            inline_keyboard: [
                [{ text: `CONFIRM — সব ডিলিট`, callback_data: `cds:${sectorId}`, style: 'danger' }],
                [{ text: "Back", callback_data: `del_sector:${sectorId}`, style: 'primary' }]
            ]
        };
        await safeEditMessage(chatId, msgId,
            `⚠️ ${getSectorEmoji(sectorInfo)} <b>${sectorInfo.label}</b> এর সব নাম্বার ডিলিট করবেন?`,
            { parse_mode: 'HTML', reply_markup: markup }
        );
        return;
    }



    if (data.startsWith('cds:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const sectorId = data.split(':')[1];
        const sectorInfo = SECTORS.find(s => s.id === sectorId);
        try { await bot.deleteMessage(chatId, msgId); } catch(e) {}

        bot.sendMessage(userId, `⏳ ${getSectorEmoji(sectorInfo)} ${sectorInfo.label} backup ও ডিলিট হচ্ছে...`, { parse_mode: 'HTML' });

        try {
            const freshNumbers = await NumberModel.find({ sector: sectorId, status: 'Available' });
            if (freshNumbers.length > 0) {
                let fileContent = freshNumbers.map(item => item.number).join('\n');
                const fileBuffer = Buffer.from(fileContent, 'utf8');
                const fileName = `${sectorInfo.label}_Fresh_Backup.txt`;
                for (const adminId of ADMIN_IDS) {
                    try {
                        await bot.sendDocument(adminId, fileBuffer, {
                            caption: `🗑️ Sector Deleted: ${getSectorEmoji(sectorInfo)} ${sectorInfo.label}\n👤 Action by: ${userId}\n📂 Backup: ${freshNumbers.length} numbers`,
                            parse_mode: 'HTML'
                        }, { filename: fileName, contentType: 'text/plain' });
                    } catch(err) {}
                }
            }
            const result = await NumberModel.deleteMany({ sector: sectorId });
            await rebuildCountryCache();
            bot.sendMessage(userId, `✅ ডিলিট সম্পন্ন!\n${getSectorEmoji(sectorInfo)} ${sectorInfo.label}: ${result.deletedCount}টি নাম্বার ডিলিট হয়েছে।`, { parse_mode: 'HTML', reply_markup: getAdminMenuKeyboard() });
        } catch(error) {
            console.error("Sector Delete Error:", error);
            bot.sendMessage(userId, "❌ ডিলিটে সমস্যা হয়েছে।", { reply_markup: getAdminMenuKeyboard() });
        }
        return;
    }

    if (data === 'del_by_country' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        await rebuildCountryCache();
        const allCountries = getAllCountryList();
        if (Object.keys(allCountries).length === 0) {
            await safeEditMessage(chatId, msgId, "❌ DB খালি।");
            return;
        }
        await safeEditMessage(chatId, msgId, "🌍 দেশ সিলেক্ট করুন:", { reply_markup: await getDeleteCountryKeyboard() });
        return;
    }


    if (data === 'cancel_delete' && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        await safeEditMessage(chatId, msgId, "✅ Cancelled.");
        bot.sendMessage(userId, "Menu:", { reply_markup: getAdminMenuKeyboard() });
        return;
    }

    if (data.startsWith('sdc:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const countryIdx = parseInt(data.split(':')[1]);
        const country = indexToCountry[countryIdx];

        if (!country || !country_data_cache[country]) {
             await safeEditMessage(chatId, msgId, "⚠️ Data mismatched! Please click 'Delete' menu again to refresh.");
             return;
        }

        admin_country_temp_data[userId] = country;
        const count = country_data_cache[country].available; 

        const markup = {
            inline_keyboard: [

                [{ text: `CONFIRM DELETE (${count})`, callback_data: `cdc:${countryIdx}`, style: 'danger' }],
                [{ text: "❌ CANCEL", callback_data: 'cancel_delete', style: 'primary' }]
            ]
        };
        await safeEditMessage(chatId, msgId, `⚠️ Are you sure you want to delete all **Fresh** numbers for:\n\n🌍 **${country}**?`, { parse_mode: 'Markdown', reply_markup: markup });
        return;
    }

    if (data.startsWith('cdc:') && isAdmin(userId)) {
        await safeAnswerCallback(call.id);
        const countryIdx = parseInt(data.split(':')[1]);
        const country = indexToCountry[countryIdx];
        if (admin_country_temp_data[userId] !== country) return;

        try {
            await bot.deleteMessage(chatId, msgId);
        } catch (e) {
            console.log("Message delete failed or already deleted");
        }

        bot.sendMessage(userId, "⏳ Backing up FRESH numbers & Deleting...");

        try {
            const freshNumbers = await NumberModel.find({ country: country, status: 'Available' });

            if (freshNumbers.length > 0) {
                let fileContent = "";
                freshNumbers.forEach(item => {
                    fileContent += `${item.number}\n`;
                });

                const fileBuffer = Buffer.from(fileContent, 'utf8');
                const fileName = `${country.replace(/\s/g, '_')}_Fresh_Backup.txt`;

                for (const adminId of ADMIN_IDS) {
                    try {
                        await bot.sendDocument(adminId, fileBuffer, {
                            caption: `🗑️ Country Deleted: ${country}\n👤 Action by: ${userId}\n📂 Backup of Fresh Numbers: ${freshNumbers.length}\n(Used numbers are ignored)`
                        }, {
                            filename: fileName,
                            contentType: 'text/plain'
                        });
                    } catch (err) {
                        console.log(`Failed to send backup to admin ${adminId}:`, err.message);
                    }
                }
            } else {
                bot.sendMessage(userId, "⚠️ No fresh numbers found to backup (All used or empty).");
            }

            const result = await NumberModel.deleteMany({ country: country });
            await rebuildCountryCache();

            bot.sendMessage(userId, `✅ Success!\nDeleted Total: ${result.deletedCount} numbers from DB.`, { reply_markup: getAdminMenuKeyboard() });

        } catch (error) {
            console.error("Delete Error:", error);
            bot.sendMessage(userId, "❌ Error during process.", { reply_markup: getAdminMenuKeyboard() });
        }
        return;
    }

    if (!isAdmin(userId) && !(await isUserMember(userId))) return;

    // Check Action Allowance
    const { allowed, remaining } = isUserAllowedAction(userId);
    if (!allowed) { 
        try {
            await bot.answerCallbackQuery(call.id, { text: `Wait ${remaining}s`, show_alert: true });
        } catch(e) {}
        return; 
    }

    // Check DB status before actions
    if (!isNumberDBReady) {
        try { await bot.answerCallbackQuery(call.id, { text: `⚠️ Database busy. Try again.`, show_alert: true }); } catch(e) {}
        return;
    }

    // 🔥 ASSIGN NUMBER
    if (data.startsWith('assign_number:')) {
        await safeAnswerCallback(call.id);
        const countryIdx = parseInt(data.split(':')[1]);
        const country = indexToCountry[countryIdx];

        await safeEditMessage(chatId, msgId, "⏳ Assigning number...", { parse_mode: 'Markdown' });

        if (!country_assignment_locks[country]) {
            country_assignment_locks[country] = new Set();
        }

        if (country_assignment_locks[country].has(userId)) {
            return;
        }

        country_assignment_locks[country].add(userId);

        try {
            await NumberModel.updateMany(
                { assigned_to: userId, status: 'Used' }, 
                { $set: { status: 'Used_History', assigned_to: null, assigned_at: null } }
            );

            const numLimit = await getNumberLimit(country);
            const availableNumbers = await NumberModel.aggregate([
                { $match: { country: country, status: 'Available' } },
                { $sample: { size: numLimit } }
            ]);

            if (availableNumbers.length > 0) {
                const assigned = await Promise.all(availableNumbers.map(n =>
                    NumberModel.findByIdAndUpdate(
                        n._id,
                        { $set: { status: 'Used', assigned_to: userId, assigned_at: new Date() } },
                        { returnDocument: 'after' }
                    )
                ));
                const first = assigned[0];
                const allDisplayNums = assigned.map(n => n.number.startsWith('+') ? n.number : '+' + n.number);
                const [primaryNum, ...extraNums] = allDisplayNums;
                // সব নাম্বারের জন্য একই ASSIGNMENT_MESSAGE_TEMPLATE format — শুধু নাম্বার গুলো সব দেখাবে
                const msgText = ASSIGNMENT_MESSAGE_TEMPLATE(first.flag, first.country, allDisplayNums.join('\n'), "Assigned", NEW_FOOTER_QUOTE);
                await safeEditMessage(chatId, msgId, msgText,
                    { parse_mode: 'HTML', reply_markup: await getNumberControlKeyboard(primaryNum, extraNums, first.country, userId) }
                );
                // ♾️ No Limit check — silently re-add if needed
                checkNoLimitReAdd(first.country, first.sector || 'facebook').catch(() => {});
            } else {
                await rebuildCountryCache();
                await safeEditMessage(chatId, msgId, `❌ Sold Out.`);
            }
        } finally {
            country_assignment_locks[country].delete(userId);
        }
    }

    // 🔥 CHANGE NUMBER (SECTOR-AWARE)
    else if (data.startsWith('change_sector_num:')) {
        const sectorId = data.split(':')[1];
        const currentTime = Date.now() / 1000;
        const lastTime = last_change_time[userId] || 0;
        const timeDiff = currentTime - lastTime;
        const cooldownTime = 3;

        if (timeDiff < cooldownTime) {
            const remainingAlert = Math.ceil(cooldownTime - timeDiff);
            try { await bot.answerCallbackQuery(call.id, { text: `⏳ Wait ${remainingAlert}s!`, show_alert: true }); } catch(e) {}
            return;
        }

        await safeAnswerCallback(call.id);
        last_change_time[userId] = currentTime;

        try { await safeEditMessage(chatId, msgId, "🔄 <b>Changing Number...</b>\n⬇️ Finding fresh line...", { parse_mode: 'HTML' }); } catch(e) {}

        const currentFirst = await NumberModel.findOne({ assigned_to: userId, status: 'Used', sector: sectorId });

        if (currentFirst) {
            const country = currentFirst.country;
            if (!country_assignment_locks[country]) country_assignment_locks[country] = new Set();
            if (country_assignment_locks[country].has(userId)) return;
            country_assignment_locks[country].add(userId);

            try {
                const numLimit = await getNumberLimit(country);
                // সব current number clear
                await NumberModel.updateMany(
                    { assigned_to: userId, status: 'Used', sector: sectorId },
                    { $set: { status: 'Used_History', assigned_to: null, assigned_at: null } }
                );
                const availableNumbers = await NumberModel.aggregate([
                    { $match: { country: country, sector: sectorId, status: 'Available' } },
                    { $sample: { size: numLimit } }
                ]);

                if (availableNumbers.length > 0) {
                    const sectorInfo = SECTORS.find(s => s.id === sectorId);
                    const assigned = await Promise.all(availableNumbers.map(n =>
                        NumberModel.findByIdAndUpdate(
                            n._id,
                            { $set: { status: 'Used', assigned_to: userId, assigned_at: new Date() } },
                            { returnDocument: 'after' }
                        )
                    ));
                    const first = assigned[0];
                    const allNums = assigned.map(n => n.number.startsWith('+') ? n.number : '+' + n.number);
                    const [primary, ...extra] = allNums;
                    await safeEditMessage(chatId, msgId,
                        ASSIGNMENT_MESSAGE_TEMPLATE(first.flag, first.country, allNums.join('\n'), `Changed`, `${getSectorEmoji(sectorInfo)} ${sectorInfo.label}`),
                        { parse_mode: 'HTML', reply_markup: await getSectorNumberControlKeyboard(sectorId, primary, extra, first.country, userId) }
                    );
                    // ♾️ No Limit check
                    checkNoLimitReAdd(first.country, sectorId).catch(() => {});
                } else {
                    await safeEditMessage(chatId, msgId, `❌ ${country} তে আর নাম্বার নেই।`, {
                        reply_markup: { inline_keyboard: [[{ text: "Change Platform", callback_data: 'back_to_sector_menu', style: 'primary' }]] }
                    });
                }
            } catch(e) { console.error(e); }
            finally { country_assignment_locks[country].delete(userId); }
        } else {
            await safeEditMessage(chatId, msgId, "❌ কোন active নাম্বার নেই।");
        }
    }

    // 🔥 CHANGE NUMBER WITH COOLDOWN
    // ── Remove CC Toggle ────────────────────────────────────────────────
    else if (data.startsWith('toggle_remove_cc:')) {
        // data format: toggle_remove_cc:normal:countryName  OR  toggle_remove_cc:sector:sectorId:countryName
        const parts = data.split(':');
        const mode = parts[1]; // 'normal' বা 'sector'

        // বর্তমান সেটিং টগল করো
        const currentOn = await isRemoveCCOn(userId);
        const newVal = currentOn ? '0' : '1';
        await ConfigModel.findOneAndUpdate(
            { key: `remove_cc:${userId}` },
            { $set: { value: newVal } },
            { upsert: true }
        );

        // editMessageText ব্যবহার — forToggle=false তাই copy_text সহ keyboard, নাম্বার কপি করা যাবে
        try { await bot.answerCallbackQuery(call.id, { cache_time: 0 }); } catch(e) {}

        if (mode === 'sector') {
            const sectorId = parts[2];
            const countryName = parts.slice(3).join(':');
            const assigned = await NumberModel.find({ assigned_to: userId, status: 'Used', sector: sectorId }).lean();
            if (assigned.length > 0) {
                const first = assigned[0];
                const allNums = assigned.map(n => n.number.startsWith('+') ? n.number : '+' + n.number);
                const [primary, ...extra] = allNums;
                const sectorInfo = SECTORS.find(s => s.id === sectorId) || SECTORS[0];
                const msgText = ASSIGNMENT_MESSAGE_TEMPLATE(first.flag, cleanCountryName(first.country), allNums.join('\n'), `Assigned`, `${getSectorEmoji(sectorInfo)} ${sectorInfo.label}`);
                const kb = await getSectorNumberControlKeyboard(sectorId, primary, extra, countryName, userId, false);
                try { await safeEditMessage(chatId, msgId, msgText, { parse_mode: 'HTML', reply_markup: kb }); } catch(e) {}
            }
        } else {
            const countryName = parts.slice(2).join(':');
            const assigned = await NumberModel.find({ assigned_to: userId, status: 'Used' }).lean();
            if (assigned.length > 0) {
                const first = assigned[0];
                const allNums = assigned.map(n => n.number.startsWith('+') ? n.number : '+' + n.number);
                const [primary, ...extra] = allNums;
                const msgText = ASSIGNMENT_MESSAGE_TEMPLATE(first.flag, first.country, allNums.join('\n'), "Assigned", NEW_FOOTER_QUOTE);
                const kb = await getNumberControlKeyboard(primary, extra, countryName, userId, false);
                try { await safeEditMessage(chatId, msgId, msgText, { parse_mode: 'HTML', reply_markup: kb }); } catch(e) {}
            }
        }
        return;
    }

    // 🔄 CHANGE NUMBER WITH COOLDOWN
    else if (data === 'change_number_req') {
        const currentTime = Date.now() / 1000;
        const lastTime = last_change_time[userId] || 0;
        const timeDiff = currentTime - lastTime;
        const cooldownTime = 3;

        if (timeDiff < cooldownTime) {
            const remainingAlert = Math.ceil(cooldownTime - timeDiff);
            try {
                await bot.answerCallbackQuery(call.id, { 
                    text: `⏳ Wait ${remainingAlert} second${remainingAlert > 1 ? 's' : ''}!`, 
                    show_alert: true 
                });
            } catch (e) {}
            return;
        }

        await safeAnswerCallback(call.id);
        last_change_time[userId] = currentTime;

        try {
            await safeEditMessage(chatId, msgId, "🔄 <b>Changing Number...</b>\n┏━━━━━━━━━━━━┓\n⬇️ Finding fresh line...", { parse_mode: 'HTML' });
        } catch(e) {}

        const currentFirst = await NumberModel.findOne({ assigned_to: userId, status: 'Used' });

        if (currentFirst) {
            const country = currentFirst.country;

            if (!country_assignment_locks[country]) {
                country_assignment_locks[country] = new Set();
            }

            if (country_assignment_locks[country].has(userId)) {
                return;
            }

            country_assignment_locks[country].add(userId);

            try {
                const numLimit = await getNumberLimit(country);
                // সব current number clear
                await NumberModel.updateMany(
                    { assigned_to: userId, status: 'Used' },
                    { $set: { status: 'Used_History', assigned_to: null, assigned_at: null } }
                );
                const availableNumbers = await NumberModel.aggregate([
                    { $match: { country: country, status: 'Available' } },
                    { $sample: { size: numLimit } }
                ]);

                if (availableNumbers.length > 0) {
                    const assigned = await Promise.all(availableNumbers.map(n =>
                        NumberModel.findByIdAndUpdate(
                            n._id,
                            { $set: { status: 'Used', assigned_to: userId, assigned_at: new Date() } },
                            { returnDocument: 'after' }
                        )
                    ));
                    const first = assigned[0];
                    const allNums = assigned.map(n => n.number.startsWith('+') ? n.number : '+' + n.number);
                    const [primary, ...extra] = allNums;
                    await safeEditMessage(chatId, msgId,
                        ASSIGNMENT_MESSAGE_TEMPLATE(first.flag, first.country, allNums.join('\n'), "Changed", NEW_FOOTER_QUOTE),
                        { parse_mode: 'HTML', reply_markup: await getNumberControlKeyboard(primary, extra, first.country, userId) }
                    );
                } else {
                    await safeEditMessage(chatId, msgId, `❌ No numbers left in ${country}.`, {
                        reply_markup: { inline_keyboard: [[{ text: "Change Country", callback_data: 'change_country_start', style: 'success' }]] }
                    });
                }
            } catch (e) {
                console.error(e);
            } finally {
                country_assignment_locks[country].delete(userId);
            }
        } else {
            await safeEditMessage(chatId, msgId, "❌ No active number.");
        }
    }

    else if (data === 'change_country_start') {
        await safeAnswerCallback(call.id);
        await NumberModel.updateMany(
            { assigned_to: userId, status: 'Used' }, 
            { $set: { status: 'Used_History', assigned_to: null, assigned_at: null } }
        );
        await rebuildCountryCache();
        const availData = getAvailableCountriesData();
        const buttons = [];        // no_limit batch আছে কোন কোন country-তে (change_country)
        const noLimitCountriesCC = new Set();
        try {
            const batchesCC = await NoLimitBatch.find({}, { country: 1 }).lean();
            batchesCC.forEach(b => noLimitCountriesCC.add(b.country));
        } catch(e) {}

        Object.keys(availData).sort().forEach(c => {
            const nlTagCC = noLimitCountriesCC.has(c) ? ' ♾️' : '';
            // শেষে userId যোগ করা হয়েছে
            buttons.push([makeCountryButton(c, availData[c].flag, ` (${availData[c].count})${nlTagCC}`, `assign_number:${countryToIndex[c]}`, userId)]);
        });

        await safeEditMessage(chatId, msgId, "🌍 Select New Country:", { 
            parse_mode: 'Markdown', 
            reply_markup: { inline_keyboard: buttons } 
        }); // Menu (Admin) ─────────────────────────────
    }
});

// ── Leaderboard Admin Panel (bonus on/off + lb on/off + reset) ────────
async function sendLbPanel(chatId, msgId) {
    const text =
        `🏆 <b>Leaderboard Panel</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `লিডারবোর্ড সংক্রান্ত সব সেটিংস এখানে পাবেন।\n\n` +
        `📌 <b>Leaderboard:</b> ${isLeaderboardEnabled ? '🟢 ON' : '🔴 OFF'}\n` +
        `🎁 <b>Daily Bonus:</b> 🥇$${LB_BONUS.first.toFixed(4)} / 🥈$${LB_BONUS.second.toFixed(4)} / 🥉$${LB_BONUS.third.toFixed(4)}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `নিচের বাটন থেকে সেটিংস পরিবর্তন করুন:`;
    const markup = {
        inline_keyboard: [
            [
                mkInlineBtn(
                    isLeaderboardEnabled ? '🟢 LB ON — বন্ধ করুন' : '🔴 LB OFF — চালু করুন',
                    'cfg_lb_toggle',
                    isLeaderboardEnabled ? 'danger' : 'success'
                )
            ],
            [
                mkInlineBtn('🎁 LB Bonus সেটিংস', 'cfg_lb_bonus', 'success')
            ],
            [
                mkInlineBtn('🔄 Leaderboard Reset', 'cfg_lb_reset', 'danger')
            ],
            [
                mkInlineBtn('🔙 Back', 'sa_list_back', 'primary')
            ]
        ]
    };
    if (msgId) {
        await safeEditMessage(chatId, msgId, text, { parse_mode: 'HTML', reply_markup: markup });
    } else {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: markup });
    }
}

async function sendLbBonusMenu(chatId, msgId) {
    const text =
        `🏆 <b>লিডারবোর্ড ডেইলি বোনাস সেটিংস</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `প্রতিদিন সকাল <b>৬:০০ AM</b> রিসেটের সময়\n` +
        `Top 3 ইউজারের একাউন্টে বোনাস যোগ হবে।\n\n` +
        `🥇 <b>১ম স্থান:</b> $${LB_BONUS.first.toFixed(4)}\n` +
        `🥈 <b>২য় স্থান:</b> $${LB_BONUS.second.toFixed(4)}\n` +
        `🥉 <b>৩য় স্থান:</b> $${LB_BONUS.third.toFixed(4)}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `নিচের বাটন থেকে বোনাস পরিমাণ পরিবর্তন করুন:`;
    const markup = {
        inline_keyboard: [
            [
                { text: '🥇 ১ম বোনাস বাড়ান/কমান', callback_data: 'lb_bonus_set_first',  style: 'success' }
            ],
            [
                { text: '🥈 ২য় বোনাস বাড়ান/কমান', callback_data: 'lb_bonus_set_second', style: 'primary' }
            ],
            [
                { text: '🥉 ৩য় বোনাস বাড়ান/কমান', callback_data: 'lb_bonus_set_third',  style: 'primary' }
            ],
            [
                { text: '🔙 Back', callback_data: 'cfg_lb_panel', style: 'primary' }
            ]
        ]
    };
    if (msgId) {
        await safeEditMessage(chatId, msgId, text, { parse_mode: 'HTML', reply_markup: markup });
    } else {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: markup });
    }
}

// ── Leaderboard shared constants & builder ────────────────────────────
const LB_BADGE_IDS = [
    { id: '5294205834144795719', em: '🥇' },
    { id: '6206222099132978580', em: '🥈' },
    { id: '5453902265922376865', em: '🥉' },
    { id: '5776138956173217748', em: '4️⃣'  },
    { id: '5447616284931933807', em: '5️⃣'  },
    { id: '5776195198769959978', em: '6️⃣'  },
    { id: '5773726138035606252', em: '7️⃣'  },
    { id: '5447218643974767663', em: '8️⃣'  },
    { id: '6156849452905664577', em: '9️⃣'  },
    { id: '5336794055542058388', em: '🔟'  },
];
const LB_STYLE_IDS = [
    { id: '5253589999168810882', em: '🔥' },
    { id: '5251560184739818113', em: '⭐' },
    { id: '5348181392528253881', em: '💫' },
    { id: '6080005839370853664', em: '✨' },
    { id: '6080005839370853664', em: '✨' },
    { id: '6080005839370853664', em: '✨' },
    { id: '6080005839370853664', em: '✨' },
    { id: '6080005839370853664', em: '✨' },
    { id: '6080005839370853664', em: '✨' },
    { id: '6080005839370853664', em: '✨' },
];
const lbPe = (id, em) => `<tg-emoji emoji-id="${id}">${em}</tg-emoji>`;

// ── Leaderboard keyboard builder ─────────────────────────────────────
function buildLeaderboardKb(page, totalPages) {
    const hasPrev = page > 0;
    const hasNext = page < totalPages - 1;
    const refreshBtn = { text: 'Refresh', callback_data: `leaderboard_r${page}`, icon_custom_emoji_id: _BTN_EM.restart.id };

    // Single page: শুধু Refresh
    if (!hasPrev && !hasNext) {
        return { inline_keyboard: [[ refreshBtn ]] };
    }

    // ৩টা বাটন (Back + Next + Refresh): Back ও Next উপরে, Refresh নিচে
    if (hasPrev && hasNext) {
        return {
            inline_keyboard: [
                [
                    { text: '⬅️ Back', callback_data: `leaderboard_p${page - 1}`, icon_custom_emoji_id: _BTN_EM.back.id },
                    { text: 'Next ➡️', callback_data: `leaderboard_p${page + 1}`, icon_custom_emoji_id: _BTN_EM.main_menu.id }
                ],
                [ refreshBtn ]
            ]
        };
    }

    // লাস্ট পেজ: শুধু Back + Refresh (Next নেই)
    if (hasPrev && !hasNext) {
        return {
            inline_keyboard: [
                [
                    { text: '⬅️ Back', callback_data: `leaderboard_p${page - 1}`, icon_custom_emoji_id: _BTN_EM.back.id },
                    refreshBtn
                ]
            ]
        };
    }

    // ফার্স্ট পেজ (page=0) + একাধিক পেজ আছে: শুধু Next + Refresh (Back নেই)
    return {
        inline_keyboard: [
            [
                refreshBtn,
                { text: 'Next ➡️', callback_data: `leaderboard_p${page + 1}`, icon_custom_emoji_id: _BTN_EM.main_menu.id }
            ]
        ]
    };
}

async function buildLeaderboardMsg(viewerUserId, page = 0) {
    const PER_PAGE = 5;

    // মোট active user count (সব fetch না করে শুধু count)
    const totalToday = await UserOtpStat.countDocuments({ dailyOtpCount: { $gt: 0 } });
    const totalPages = Math.max(1, Math.ceil(totalToday / PER_PAGE));
    const safePage   = Math.min(Math.max(page, 0), totalPages - 1);

    // শুধু এই page-এর users fetch করো (skip + limit)
    const pageUsers = await UserOtpStat.find({ dailyOtpCount: { $gt: 0 } })
        .sort({ dailyOtpCount: -1 })
        .skip(safePage * PER_PAGE)
        .limit(PER_PAGE)
        .lean();

    // প্রতিটা user-এর dailyEarning সরাসরি UserOtpStat থেকে পাওয়া যাবে
    // (walletMap এর দরকার নেই — balance না দেখিয়ে আজকের earning দেখাবো)

    const now = new Date();
    const bdNow = new Date(now.getTime() + (6*60 - now.getTimezoneOffset()) * 60000);
    const nextReset = new Date(bdNow);
    nextReset.setHours(6, 0, 0, 0);
    if (bdNow.getHours() >= 6) nextReset.setDate(nextReset.getDate() + 1);
    const diffMs = nextReset - bdNow;
    const diffH  = Math.floor(diffMs / 3600000);
    const diffM  = Math.floor((diffMs % 3600000) / 60000);

    const pageLabel = totalPages > 1 ? ` — পেজ ${safePage + 1}/${totalPages}` : '';

    // Top-3 bonus map (global rank 0,1,2 → bonus amount)
    const rankBonusMap = [LB_BONUS.first, LB_BONUS.second, LB_BONUS.third];

    let msg = `${lbPe('5188344996356448758','🏆')} <b>ᴛᴏᴅᴀʏ'ꜱ ʟᴇᴀᴅᴇʀʙᴏᴀʀᴅ</b>${pageLabel}\n` +
              `━━━━━━━━━━━━━━━━━━━━━━━\n` +
              `<blockquote>${lbPe('5413879192267805083','📅')}প্রতিদিন সকাল <b>৬:০০ AM</b> এ রিসেট হয় এবং আপনার বোনাস এড হয়ে যাবে</blockquote>\n` +
              `<blockquote>${lbPe('6215133834149629990','⏳')} পরের রিসেট: <b>${diffH}h ${diffM}m</b> পরে</blockquote>\n` +
              `━━━━━━━━━━━━━━━━━━━━━━━\n` +
              ``;

    if (totalToday === 0) {
        msg += `${lbPe('5938368980568773431','😴')} আজকে এখনো কোনো OTP পাঠানো হয়নি!\n\n` +
               `${lbPe('6235302918967269680','🚀')} OTP পাঠিয়ে লিডারবোর্ডে টপে থাকুন!`;
    } else {
        pageUsers.forEach((u, i) => {
            const globalRank = safePage * PER_PAGE + i;   // 0-based global index
            // প্রথম ১০ জনের জন্য badge/style, তারপর plain number
            const badgeObj = LB_BADGE_IDS[globalRank] || null;
            const styleObj = LB_STYLE_IDS[globalRank] || null;
            const rankLabel = badgeObj
                ? `${lbPe(badgeObj.id, badgeObj.em)} ${lbPe(styleObj.id, styleObj.em)}`
                : `<b>#${globalRank + 1}</b>`;
            const rawUid    = String(u.userId || '');
            const maskedUid = rawUid.length > 6
                ? rawUid.slice(0, 4) + '•••' + rawUid.slice(-4)
                : rawUid;
            const firstName    = escapeHtml(u.firstName || '');
            const dailyEarning = (u.dailyEarning || 0).toFixed(4);
            const isMe         = u.userId === viewerUserId
                ? ` ${lbPe('5269720500468201056','👈')} <b>আপনি</b>` : '';
            const uidLine   = `<code>${maskedUid}</code>`;
            const nameLine  = firstName ? `${uidLine}\n   ${lbPe('5798505243180273024','👤')} <b>${firstName}</b>` : uidLine;

            // Top-3 এর জন্য reward line
            const bonusAmount = rankBonusMap[globalRank] || 0;
            const rankRewardLabels = ['🥇 বোনাস', '🥈 বোনাস', '🥉 বোনাস'];
            const bonusLine = (globalRank < 3 && bonusAmount > 0)
                ? `\n   ${lbPe('6156923364997862692','🎁')} ${rankRewardLabels[globalRank]}: <b>$${bonusAmount.toFixed(4)}</b>`
                : '';

            msg += `<blockquote>${rankLabel} ${nameLine}${isMe}\n` +
                   `   ${lbPe('6275857834127134596','📲')} <b>${u.dailyOtpCount}</b> OTP  ${lbPe('5409048419211682843','💵')} <b>$${dailyEarning}</b>${bonusLine}</blockquote>\n`;
        });

        // ── footer — সব পেজেই একই থাকবে ────────────────────────────
        const myDoc        = await UserOtpStat.findOne({ userId: viewerUserId }).lean();
        const myDailyCount = myDoc ? (myDoc.dailyOtpCount || 0) : 0;
        // rank = কতজনের dailyOtpCount আমার চেয়ে বেশি + 1
        const myPos = myDoc && myDailyCount > 0
            ? (await UserOtpStat.countDocuments({ dailyOtpCount: { $gt: myDailyCount } })) + 1
            : null;

        const myDailyEarning = myDoc ? ((myDoc.dailyEarning || 0).toFixed(4)) : '0.0000';
        msg += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
        if (myPos) {
            msg += `${lbPe(_BTN_EM.refer.id,'👤')} আপনার র‍্যাংক: <b>#${myPos}</b> | ` +
                   `${lbPe('6275857834127134596','📲')} <b>${myDailyCount}</b> OTP | ` +
                   `${lbPe('5409048419211682843','💵')} <b>$${myDailyEarning}</b>\n`;
        }
        msg += `${lbPe(_BTN_EM.refer.id,'👥')} আজকে মোট কাজ করছে: <b>${totalToday}</b> জন`;
    }
    return { msg, page: safePage, totalPages };
}

async function sendUpdateNotification(newItems) {
    const currentTime = Date.now();

    // ৫ মিনিটের সেশন চেক (নতুন করে অ্যাড করলে আগের মেসেজ ইডিট হবে)
    if (currentTime - activeNotification.lastUpdate > 5 * 60 * 1000) {
        activeNotification.data = [];
        activeNotification.msgIds = {};
    }

    // ডাটা যোগ করা
    newItems.forEach(item => {
        const exists = activeNotification.data.find(x => x.country === item.country && x.sector === item.sector);
        if (!exists) activeNotification.data.push(item);
    });

    activeNotification.lastUpdate = currentTime;

    // প্রিমিয়াম টেক্সট ফরম্যাট
    let notifyText = `<tg-emoji emoji-id="${_BTN_EM.notif_check.id}">✅</tg-emoji> <b>𝐀𝐃𝐃 𝐍𝐄𝐖 𝐍𝐔𝐌𝐁𝐄𝐑</b> <tg-emoji emoji-id="${_BTN_EM.notif_rocket.id}">🚀</tg-emoji> \n\n`;
    const grouped = {};
    activeNotification.data.forEach(item => {
        if (!grouped[item.country]) grouped[item.country] = { flag: item.flag, sectors: [] };
        if (!grouped[item.country].sectors.includes(item.sector)) grouped[item.country].sectors.push(item.sector);
    });

    for (const country in grouped) {
        // ১. প্রিমিয়াম ফ্ল্যাগ
        const pFlag = getPremiumFlag(country, grouped[country].flag);
        notifyText += `${pFlag} <b>${country}</b>\n`;

        grouped[country].sectors.forEach(secName => {
            // ২. প্রিমিয়াম সেক্টর ইমোজি
            const sectorObj = SECTORS.find(s => s.label === secName);
            const sEmoji = getSectorEmoji(sectorObj);
            notifyText += `${sEmoji} <b>${secName}</b> ➤ New ${E('✅')} \n`;
        });
        notifyText += `\n`;
    }

    notifyText += `<tg-emoji emoji-id="${_BTN_EM.notif_traffic.id}">🚀</tg-emoji> <b>𝐓𝐫𝐚𝐟𝐟𝐢𝐜:</b> High ${E('🤖')}`;
    // বটের ইউজারনেমে প্রিমিয়াম বট ইমোজি যোগ করা হয়েছে


    const markup = {
        inline_keyboard: [
            [
                { 
                    text: "𝐎𝐩𝐞𝐧 𝐁𝐨𝐭", 
                    url: `https://t.me/${bot_username}?start=start`,
                    icon_custom_emoji_id: _BTN_EM.open_bot.id,
                    style: 'primary' 
                }
            ]
        ]
    };

    // সব চ্যানেলে মেসেজ পাঠানো বা এডিট করা
    for (const channel of REQUIRED_CHANNELS) {
        const cid = channel.id;
        try {
            if (activeNotification.msgIds[cid]) {
                await bot.editMessageText(notifyText, { 
                    chat_id: cid, 
                    message_id: activeNotification.msgIds[cid], 
                    parse_mode: 'HTML', 
                    reply_markup: markup 
                });
            } else {
                const sent = await bot.sendMessage(cid, notifyText, { 
                    parse_mode: 'HTML', 
                    reply_markup: markup 
                });
                activeNotification.msgIds[cid] = sent.message_id;
            }
        } catch (e) { console.log("Notify Error:", e.message); }
    }

    // ১ ঘণ্টা পর ডিলিট করার টাইমার সেট
    if (activeNotification.timer) clearTimeout(activeNotification.timer);
    activeNotification.timer = setTimeout(async () => {
        for (const cid in activeNotification.msgIds) {
            try { await bot.deleteMessage(cid, activeNotification.msgIds[cid]); } catch (e) {}
        }
        activeNotification.msgIds = {};
        activeNotification.data = [];
    }, NOTIFICATION_DELETE_TIME);
}


setInterval(() => {
    const oneHourAgo = Date.now() - 3600000;
    let cleaned = 0;

    Object.keys(user_details_cache).forEach(key => {
        if (user_details_cache[key]?.timestamp < oneHourAgo) {
            delete user_details_cache[key];
            cleaned++;
        }
    });

    Object.keys(country_assignment_locks).forEach(country => {
        if (country_assignment_locks[country].size === 0) {
            delete country_assignment_locks[country];
        }
    });

    if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} cache entries`);
}, 30 * 60 * 1000);

// ===============================================
// 📴 GRACEFUL SHUTDOWN
// ===============================================
process.on('SIGTERM', async () => {
    console.log('📴 Shutting down...');
    bot.stopPolling();
    await numberConn.close();
    await userConn.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('📴 SIGINT received...');
    bot.stopPolling();
    await numberConn.close();
    await userConn.close();
    process.exit(0);
});

// Start Sync
try {
    if (fs.existsSync(USER_LIST_FILE)) {
        bot_users = new Set(JSON.parse(fs.readFileSync(USER_LIST_FILE)));
    }
} catch (e) {}
