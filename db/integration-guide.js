/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║        NUMBER-BOT.JS INTEGRATION — Step-by-step patch guide        ║
 * ║                                                                    ║
 * ║  এই ফাইলটি সরাসরি run করবেন না।                                  ║
 * ║  নিচের PATCH INSTRUCTIONS অনুযায়ী number-bot.js পরিবর্তন করুন।  ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * ════════════════════════════════════════════════════════════════════
 * PATCH 1 — number-bot.js এর TOP (imports section) এ যোগ করুন
 * ════════════════════════════════════════════════════════════════════
 *
 * // ── Failover DB System ──────────────────────────────────────────
 * const dbSetup = require('./db/db-setup');
 * let sync = null; // syncHelper — নিচে init এ set হবে
 *
 *
 * ════════════════════════════════════════════════════════════════════
 * PATCH 2 — DATABASE CONNECTION SETUP SECTION সম্পূর্ণ REPLACE করুন
 * (// =====================================
 *  // 🗄️ DATABASE CONNECTION SETUP
 *  // ===================================
 *  থেকে শুরু করে প্রথম model definition পর্যন্ত)
 * ════════════════════════════════════════════════════════════════════
 */

// ── পুরনো code সরিয়ে এটা দিন ─────────────────────────────────────────────

const FAILOVER_DB_INIT_CODE = `
// =====================================
// 🗄️ DATABASE CONNECTION SETUP (Local Primary + Atlas Failover)
// =====================================

// NOTE: এই section টি db/db-setup.js দ্বারা পরিচালিত হয়।
// Local MongoDB = Primary, Atlas = Background Sync
// Atlas down হলে queue-তে জমা হয়, পরে auto sync হয়।

const dbSetup = require('./db/db-setup');
let sync = null;

// Mongoose connection options
const dbOptions = {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 30000,
    family: 4,
    maxPoolSize: 50,
    minPoolSize: 5,
    connectTimeoutMS: 10000,
    maxIdleTimeMS: 60000,
    retryWrites: true,
    retryReads: true,
    bufferCommands: false,
    autoIndex: false
};

// ── Connections (set in startBot() below) ──────────────────────────────────
let numberConn = null;
let userConn   = null;
let statusConn = null;

let isNumberDBReady = false;
let isUserDBReady   = false;
let isStatusDBReady = false;

// ── DB init function (called once at startBot) ─────────────────────────────
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

    // ── Local event listeners ─────────────────────────────────────────────
    numberConn.on('connected', async () => {
        console.log("✅ Number DB (Local) Connected!");
        isNumberDBReady = true;
        await setupDatabaseIndexes();
        result.failoverSystem.registerAtlasSchemas && 
            result.failoverSystem.registerAtlasSchemas('number');
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
        console.log("✅ User & Config DB (Local) Connected!");
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
            console.log("✅ Status DB (Local) Connected!");
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
        userConn.on('connected', () => { isStatusDBReady = true; });
        userConn.on('disconnected', () => { isStatusDBReady = false; });
        userConn.on('error', () => { isStatusDBReady = false; });
    }

    // Atlas sync event logging
    result.failoverSystem.on('sync:done', ({ dbKey, synced, failed }) => {
        if (synced > 0) {
            console.log(\`[Atlas Sync] ✅ \${dbKey}: \${synced} synced, \${failed} re-queued\`);
        }
    });

    return result;
}
`;

/**
 * ════════════════════════════════════════════════════════════════════
 * PATCH 3 — startBot() function এর ভেতরে waitForDB() এর আগে
 *            initDBConnections() কল যোগ করুন
 * ════════════════════════════════════════════════════════════════════
 *
 * async function startBot() {
 *     try {
 *         await initDBConnections();   // ← এই লাইন যোগ করুন
 *         await waitForDB();
 *         ...
 */

/**
 * ════════════════════════════════════════════════════════════════════
 * PATCH 4 — KEY WRITE POINTS এ sync call যোগ করুন
 * ════════════════════════════════════════════════════════════════════
 *
 * (A) নাম্বার bulk add এর পরে (_insertMultiSector function)
 *     NumberModel.bulkWrite() call এর পরে:
 *
 *     const result = await NumberModel.bulkWrite(ops, { ordered: false });
 *     // ↓ এই লাইন যোগ করুন:
 *     if (sync) sync.numberBulkUpsert({ numbers: countryInfo.numbers, country: name, flag: countryInfo.flag, sector: sectorId, price, no_limit: noLimit });
 *
 *
 * (B) নাম্বার assign হলে (কোনো ইউজার নাম্বার নিলে)
 *     NumberModel.findOneAndUpdate({ status: 'Used' }) এর পরে:
 *
 *     if (sync) sync.numberAssign({ number: assignedNumber, sector: sectorId, assigned_to: userId, assigned_at: new Date() });
 *
 *
 * (C) WalletUser balance update হলে (payOtpCommission)
 *     WalletUser.findOneAndUpdate() এর পরে:
 *
 *     if (sync && seller) sync.walletUpsert(seller.toObject());
 *
 *
 * (D) Config save হলে (ConfigModel.findOneAndUpdate)
 *     await ConfigModel.findOneAndUpdate(...) এর পরে:
 *
 *     if (sync) sync.configUpsert({ key, value });
 *
 *
 * (E) WithdrawRequest create/update হলে
 *     পরে:
 *
 *     if (sync) sync.withdrawUpsert(wReq.toObject());
 *
 *
 * (F) OTP stat record হলে (recordOtp function)
 *     UserOtpStat.findOneAndUpdate এর পরে:
 *
 *     if (sync && updated) sync.userOtpStatUpsert(updated.toObject());
 */

/**
 * ════════════════════════════════════════════════════════════════════
 * PATCH 5 — Admin "Config" menu তে Sync Status যোগ করুন
 * ════════════════════════════════════════════════════════════════════
 *
 * sendSubAdminList() function এর text variable এ যোগ করুন:
 *
 *     // Sync status
 *     if (sync) {
 *         const qs = sync.queueStatus();
 *         const total = qs.number + qs.user + qs.status;
 *         text += `\n\n🔄 <b>Atlas Sync Queue:</b>\n`;
 *         text += `  📊 Number DB: ${qs.number} pending\n`;
 *         text += `  👤 User DB: ${qs.user} pending\n`;
 *         text += `  📲 Status DB: ${qs.status} pending\n`;
 *         if (total > 0) text += `  ⚠️ Total ${total} ops waiting for Atlas\n`;
 *         else text += `  ✅ All synced to Atlas\n`;
 *     }
 *
 * এবং markup এ একটি বাটন যোগ করুন:
 *
 *     [mkInlineBtn('🔄 Force Atlas Sync', 'cfg_force_sync', 'primary')]
 *
 * callback এ যোগ করুন:
 *
 *     if (data === 'cfg_force_sync' && isAdmin(userId)) {
 *         await safeAnswerCallback(call.id, { text: '🔄 Syncing...', show_alert: true });
 *         if (sync) await sync.forceDrainAll();
 *         const qs = sync ? sync.queueStatus() : { number: 0, user: 0, status: 0 };
 *         const total = qs.number + qs.user + qs.status;
 *         bot.sendMessage(chatId, total === 0
 *             ? '✅ Atlas Sync সম্পন্ন! সব data Atlas-এ আছে।'
 *             : `⚠️ Sync চলছে... ${total} ops এখনো pending।`,
 *             { reply_markup: getAdminMenuKeyboard() }
 *         );
 *         return;
 *     }
 */

module.exports = { FAILOVER_DB_INIT_CODE };
/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║        NUMBER-BOT.JS INTEGRATION — Step-by-step patch guide        ║
 * ║                                                                    ║
 * ║  এই ফাইলটি সরাসরি run করবেন না।                                  ║
 * ║  নিচের PATCH INSTRUCTIONS অনুযায়ী number-bot.js পরিবর্তন করুন।  ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * ════════════════════════════════════════════════════════════════════
 * PATCH 1 — number-bot.js এর TOP (imports section) এ যোগ করুন
 * ════════════════════════════════════════════════════════════════════
 *
 * // ── Failover DB System ──────────────────────────────────────────
 * const dbSetup = require('./db/db-setup');
 * let sync = null; // syncHelper — নিচে init এ set হবে
 *
 *
 * ════════════════════════════════════════════════════════════════════
 * PATCH 2 — DATABASE CONNECTION SETUP SECTION সম্পূর্ণ REPLACE করুন
 * (// =====================================
 *  // 🗄️ DATABASE CONNECTION SETUP
 *  // ===================================
 *  থেকে শুরু করে প্রথম model definition পর্যন্ত)
 * ════════════════════════════════════════════════════════════════════
 */

// ── পুরনো code সরিয়ে এটা দিন ─────────────────────────────────────────────

const FAILOVER_DB_INIT_CODE = `
// =====================================
// 🗄️ DATABASE CONNECTION SETUP (Local Primary + Atlas Failover)
// =====================================

// NOTE: এই section টি db/db-setup.js দ্বারা পরিচালিত হয়।
// Local MongoDB = Primary, Atlas = Background Sync
// Atlas down হলে queue-তে জমা হয়, পরে auto sync হয়।

const dbSetup = require('./db/db-setup');
let sync = null;

// Mongoose connection options
const dbOptions = {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 30000,
    family: 4,
    maxPoolSize: 50,
    minPoolSize: 5,
    connectTimeoutMS: 10000,
    maxIdleTimeMS: 60000,
    retryWrites: true,
    retryReads: true,
    bufferCommands: false,
    autoIndex: false
};

// ── Connections (set in startBot() below) ──────────────────────────────────
let numberConn = null;
let userConn   = null;
let statusConn = null;

let isNumberDBReady = false;
let isUserDBReady   = false;
let isStatusDBReady = false;

// ── DB init function (called once at startBot) ─────────────────────────────
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

    // ── Local event listeners ─────────────────────────────────────────────
    numberConn.on('connected', async () => {
        console.log("✅ Number DB (Local) Connected!");
        isNumberDBReady = true;
        await setupDatabaseIndexes();
        result.failoverSystem.registerAtlasSchemas && 
            result.failoverSystem.registerAtlasSchemas('number');
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
        console.log("✅ User & Config DB (Local) Connected!");
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
            console.log("✅ Status DB (Local) Connected!");
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
        userConn.on('connected', () => { isStatusDBReady = true; });
        userConn.on('disconnected', () => { isStatusDBReady = false; });
        userConn.on('error', () => { isStatusDBReady = false; });
    }

    // Atlas sync event logging
    result.failoverSystem.on('sync:done', ({ dbKey, synced, failed }) => {
        if (synced > 0) {
            console.log(\`[Atlas Sync] ✅ \${dbKey}: \${synced} synced, \${failed} re-queued\`);
        }
    });

    return result;
}
`;

/**
 * ════════════════════════════════════════════════════════════════════
 * PATCH 3 — startBot() function এর ভেতরে waitForDB() এর আগে
 *            initDBConnections() কল যোগ করুন
 * ════════════════════════════════════════════════════════════════════
 *
 * async function startBot() {
 *     try {
 *         await initDBConnections();   // ← এই লাইন যোগ করুন
 *         await waitForDB();
 *         ...
 */

/**
 * ════════════════════════════════════════════════════════════════════
 * PATCH 4 — KEY WRITE POINTS এ sync call যোগ করুন
 * ════════════════════════════════════════════════════════════════════
 *
 * (A) নাম্বার bulk add এর পরে (_insertMultiSector function)
 *     NumberModel.bulkWrite() call এর পরে:
 *
 *     const result = await NumberModel.bulkWrite(ops, { ordered: false });
 *     // ↓ এই লাইন যোগ করুন:
 *     if (sync) sync.numberBulkUpsert({ numbers: countryInfo.numbers, country: name, flag: countryInfo.flag, sector: sectorId, price, no_limit: noLimit });
 *
 *
 * (B) নাম্বার assign হলে (কোনো ইউজার নাম্বার নিলে)
 *     NumberModel.findOneAndUpdate({ status: 'Used' }) এর পরে:
 *
 *     if (sync) sync.numberAssign({ number: assignedNumber, sector: sectorId, assigned_to: userId, assigned_at: new Date() });
 *
 *
 * (C) WalletUser balance update হলে (payOtpCommission)
 *     WalletUser.findOneAndUpdate() এর পরে:
 *
 *     if (sync && seller) sync.walletUpsert(seller.toObject());
 *
 *
 * (D) Config save হলে (ConfigModel.findOneAndUpdate)
 *     await ConfigModel.findOneAndUpdate(...) এর পরে:
 *
 *     if (sync) sync.configUpsert({ key, value });
 *
 *
 * (E) WithdrawRequest create/update হলে
 *     পরে:
 *
 *     if (sync) sync.withdrawUpsert(wReq.toObject());
 *
 *
 * (F) OTP stat record হলে (recordOtp function)
 *     UserOtpStat.findOneAndUpdate এর পরে:
 *
 *     if (sync && updated) sync.userOtpStatUpsert(updated.toObject());
 */

/**
 * ════════════════════════════════════════════════════════════════════
 * PATCH 5 — Admin "Config" menu তে Sync Status যোগ করুন
 * ════════════════════════════════════════════════════════════════════
 *
 * sendSubAdminList() function এর text variable এ যোগ করুন:
 *
 *     // Sync status
 *     if (sync) {
 *         const qs = sync.queueStatus();
 *         const total = qs.number + qs.user + qs.status;
 *         text += `\n\n🔄 <b>Atlas Sync Queue:</b>\n`;
 *         text += `  📊 Number DB: ${qs.number} pending\n`;
 *         text += `  👤 User DB: ${qs.user} pending\n`;
 *         text += `  📲 Status DB: ${qs.status} pending\n`;
 *         if (total > 0) text += `  ⚠️ Total ${total} ops waiting for Atlas\n`;
 *         else text += `  ✅ All synced to Atlas\n`;
 *     }
 *
 * এবং markup এ একটি বাটন যোগ করুন:
 *
 *     [mkInlineBtn('🔄 Force Atlas Sync', 'cfg_force_sync', 'primary')]
 *
 * callback এ যোগ করুন:
 *
 *     if (data === 'cfg_force_sync' && isAdmin(userId)) {
 *         await safeAnswerCallback(call.id, { text: '🔄 Syncing...', show_alert: true });
 *         if (sync) await sync.forceDrainAll();
 *         const qs = sync ? sync.queueStatus() : { number: 0, user: 0, status: 0 };
 *         const total = qs.number + qs.user + qs.status;
 *         bot.sendMessage(chatId, total === 0
 *             ? '✅ Atlas Sync সম্পন্ন! সব data Atlas-এ আছে।'
 *             : `⚠️ Sync চলছে... ${total} ops এখনো pending।`,
 *             { reply_markup: getAdminMenuKeyboard() }
 *         );
 *         return;
 *     }
 */

module.exports = { FAILOVER_DB_INIT_CODE };
