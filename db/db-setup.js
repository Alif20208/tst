/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║          DB SETUP — nexo-bot (3 DB + Failover Integration)         ║
 * ║                                                                    ║
 * ║  এই ফাইলটি number-bot.js এর সাথে ব্যবহার করতে হবে।             ║
 * ║  local mongoose connections এর পাশাপাশি Atlas sync চলবে।         ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * ব্যবহার:
 *   const dbSetup = require('./db/db-setup');
 *   const { numberConn, userConn, statusConn, sync } = await dbSetup.init(config);
 */

'use strict';

const failoverSystem = require('./failover-manager');

// Set LOCAL_MONGODB_ENABLED=true only when a local mongod server is available.
// Replit uses Atlas as the primary database because mongod is not available.
const LOCAL_MONGODB_ENABLED = process.env.LOCAL_MONGODB_ENABLED === 'true';

// Local MongoDB URIs — .env বা hardcode (নিচে পরিবর্তন করুন)
const LOCAL_URIS = {
    number : process.env.LOCAL_NUMBER_DB  || 'mongodb://127.0.0.1:27017/nexo_number',
    user   : process.env.LOCAL_USER_DB    || 'mongodb://127.0.0.1:27017/nexo_user',
    status : process.env.LOCAL_STATUS_DB  || 'mongodb://127.0.0.1:27017/nexo_status',
};

/**
 * Mongoose connection options (same as number-bot.js এর dbOptions)
 * Local-এ TLS বন্ধ, Atlas-এ চালু — handler নিজেই ম্যানেজ করে
 */
const BASE_OPTS = {
    family       : 4,
    maxPoolSize  : 20,
    minPoolSize  : 2,
    maxIdleTimeMS: 60000,
    autoIndex    : false,
};

// ══════════════════════════════════════════════════════════════════════════
// 🏗️ INIT — call this once at startup
// ══════════════════════════════════════════════════════════════════════════
/**
 * Initialize all 3 DB connections with Local+Atlas failover.
 *
 * @param {{ NUMBER_DB_URI, USER_DB_URI, USER_STATUS_DB }} atlasUris
 * @returns {{ numberConn, userConn, statusConn, sync, failoverSystem }}
 */
async function init(atlasUris = {}) {
    const {
        NUMBER_DB_URI  : atlasNumber,
        USER_DB_URI    : atlasUser,
        USER_STATUS_DB : atlasStatus,
    } = atlasUris;

    // ── Register all 3 DBs ─────────────────────────────────────────────
    const numberHandler = failoverSystem.addDB(
        'number',
        LOCAL_MONGODB_ENABLED ? LOCAL_URIS.number : null,
        atlasNumber,
        { ...BASE_OPTS }
    );

    const userHandler = failoverSystem.addDB(
        'user',
        LOCAL_MONGODB_ENABLED ? LOCAL_URIS.user : null,
        atlasUser,
        { ...BASE_OPTS }
    );

    // STATUS_DB: Atlas URI না থাকলে user DB reuse করো (original bot logic)
    const statusAtlasUri = atlasStatus || atlasUser;
    const statusHandler = failoverSystem.addDB(
        'status',
        LOCAL_MONGODB_ENABLED
            ? (atlasStatus ? LOCAL_URIS.status : LOCAL_URIS.user)
            : null,
        statusAtlasUri,
        { ...BASE_OPTS }
    );

    // ── Start all (local optional, Atlas always available as primary/fallback) ─
    await failoverSystem.start();

    const primaryConnection = (handler) =>
        LOCAL_MONGODB_ENABLED ? handler.localConn : handler.atlasConn;

    // ══════════════════════════════════════════════════════════════════
    // 📊 Status logging
    // ══════════════════════════════════════════════════════════════════
    failoverSystem.on('sync:done', ({ dbKey, synced, failed }) => {
        console.log(
            `[FailoverSync] ✅ ${DB_LABELS[dbKey] || dbKey}: ${synced} synced, ${failed} failed/re-queued`
        );
    });

    failoverSystem.on('sync:start', ({ dbKey, pending }) => {
        console.log(
            `[FailoverSync] 🔄 ${DB_LABELS[dbKey] || dbKey}: draining ${pending} pending ops...`
        );
    });

    // ── Return the connections (same interface as before) ──────────────
    return {
        numberConn     : primaryConnection(numberHandler),
        userConn       : primaryConnection(userHandler),
        statusConn     : primaryConnection(statusHandler),
        atlasNumberConn: numberHandler.atlasConn,
        atlasUserConn  : userHandler.atlasConn,
        atlasStatusConn: statusHandler.atlasConn,

        /** Write to Atlas (queue if down) */
        sync           : new SyncHelper(failoverSystem),

        /** Full failover system (for advanced use) */
        failoverSystem,
        usingLocal     : LOCAL_MONGODB_ENABLED,
    };
}

const DB_LABELS = {
    number : 'NUMBER_DB',
    user   : 'USER_DB',
    status : 'STATUS_DB',
};

// ══════════════════════════════════════════════════════════════════════════
// 🔄 SYNC HELPER — সহজ API for number-bot.js এর বিভিন্ন জায়গায় ব্যবহারের জন্য
// ══════════════════════════════════════════════════════════════════════════
class SyncHelper {
    constructor(fs) {
        this._fs = fs;
    }

    // ── NUMBER DB syncs ──────────────────────────────────────────────────

    /**
     * নতুন নাম্বার add/upsert করার পর Atlas-এ sync করো
     */
    numberUpsert(doc) {
        if (!doc) return;
        const _syncId = doc._id ? doc._id.toString() : `${doc.number}|${doc.sector}`;
        return this._fs.syncWrite('number', {
            collection : 'Number',
            op         : 'upsert',
            filter     : { number: doc.number, sector: doc.sector },
            data       : {
                number      : doc.number,
                country     : doc.country,
                flag        : doc.flag,
                sector      : doc.sector,
                status      : doc.status,
                assigned_to : doc.assigned_to,
                assigned_at : doc.assigned_at,
                price       : doc.price,
                no_limit    : doc.no_limit,
                created_at  : doc.created_at,
            },
            _syncId,
        });
    }

    /**
     * NumberModel.bulkWrite-এর পর Atlas-এ বড় batch sync করো
     * @param {Array}  numbers  array of number strings
     * @param {string} country
     * @param {string} flag
     * @param {string} sector
     * @param {number|null} price
     * @param {boolean} no_limit
     */
    numberBulkUpsert({ numbers, country, flag, sector, price = null, no_limit = false }) {
        if (!numbers || numbers.length === 0) return;
        // Break into 200-op chunks to avoid overwhelming Atlas
        const CHUNK = 200;
        for (let i = 0; i < numbers.length; i += CHUNK) {
            const chunk  = numbers.slice(i, i + CHUNK);
            const bulkOps = chunk.map(num => ({
                updateOne: {
                    filter : { number: num, sector },
                    update : {
                        $set      : { status: 'Available', country, flag, assigned_to: null, assigned_at: null, no_limit, ...(price !== null ? { price } : {}) },
                        $setOnInsert : { number: num, sector, created_at: new Date() },
                    },
                    upsert : true,
                },
            }));
            this._fs.syncWrite('number', {
                collection : 'Number',
                op         : 'bulkWrite',
                filter     : {},
                data       : bulkOps,
                _syncId    : `bulk:${sector}:${country}:${i}:${Date.now()}`,
            });
        }
    }

    /**
     * নাম্বার assigned হলে (status=Used) Atlas sync
     */
    numberAssign({ number, sector, assigned_to, assigned_at }) {
        return this._fs.syncWrite('number', {
            collection : 'Number',
            op         : 'update',
            filter     : { number, sector },
            data       : { status: 'Used', assigned_to, assigned_at },
            _syncId    : `assign:${number}:${sector}`,
        });
    }

    /**
     * নাম্বার delete হলে Atlas sync
     */
    numberDelete({ filter, _syncId }) {
        return this._fs.syncWrite('number', {
            collection : 'Number',
            op         : 'delete',
            filter,
            data       : null,
            _syncId    : _syncId || `del:${Date.now()}`,
        });
    }

    // ── USER DB syncs ────────────────────────────────────────────────────

    /**
     * নতুন user add/upsert করার পর Atlas sync
     */
    userUpsert(doc) {
        if (!doc) return;
        const _syncId = doc._id ? doc._id.toString() : `user:${doc.userId || doc.telegramId}`;
        return this._fs.syncWrite('user', {
            collection : 'User',
            op         : 'upsert',
            filter     : { userId: doc.userId },
            data       : { userId: doc.userId, joined_at: doc.joined_at },
            _syncId,
        });
    }

    /**
     * WalletUser upsert → Atlas sync
     */
    walletUpsert(doc) {
        if (!doc) return;
        const _syncId = doc._id ? doc._id.toString() : `wallet:${doc.telegramId}`;
        return this._fs.syncWrite('user', {
            collection : 'WalletUser',
            op         : 'upsert',
            filter     : { telegramId: doc.telegramId },
            data       : {
                telegramId      : doc.telegramId,
                username        : doc.username,
                firstName       : doc.firstName,
                balance         : doc.balance,
                withdrawn       : doc.withdrawn,
                referredBy      : doc.referredBy,
                referCount      : doc.referCount,
                walletMethod    : doc.walletMethod,
                walletAddress   : doc.walletAddress,
                commissionNotif : doc.commissionNotif,
                joinedAt        : doc.joinedAt,
            },
            _syncId,
        });
    }

    /**
     * Config (key-value) upsert → Atlas sync
     */
    configUpsert({ key, value }) {
        return this._fs.syncWrite('user', {
            collection : 'Config',
            op         : 'upsert',
            filter     : { key },
            data       : { key, value },
            _syncId    : `config:${key}`,
        });
    }

    /**
     * WithdrawRequest upsert → Atlas sync
     */
    withdrawUpsert(doc) {
        if (!doc) return;
        const _syncId = doc._id ? doc._id.toString() : `wd:${doc.userId}:${Date.now()}`;
        return this._fs.syncWrite('user', {
            collection : 'WithdrawRequest',
            op         : 'upsert',
            filter     : { _id: doc._id },
            data       : { ...doc },
            _syncId,
        });
    }

    // ── STATUS DB syncs ──────────────────────────────────────────────────

    /**
     * BotStat (global OTP count) update → Atlas sync
     */
    botStatUpdate({ totalOtp }) {
        return this._fs.syncWrite('status', {
            collection : 'BotStat',
            op         : 'upsert',
            filter     : { _id: 'global' },
            data       : { totalOtp, updatedAt: new Date() },
            _syncId    : 'global:botstat',
        });
    }

    /**
     * UserOtpStat upsert → Atlas sync
     */
    userOtpStatUpsert(doc) {
        if (!doc) return;
        const _syncId = `otpstat:${doc.userId}`;
        return this._fs.syncWrite('status', {
            collection : 'UserOtpStat',
            op         : 'upsert',
            filter     : { userId: doc.userId },
            data       : {
                userId        : doc.userId,
                username      : doc.username,
                firstName     : doc.firstName,
                otpCount      : doc.otpCount,
                dailyOtpCount : doc.dailyOtpCount,
                dailyEarning  : doc.dailyEarning,
                lastOtpAt     : doc.lastOtpAt,
            },
            _syncId,
        });
    }

    // ── Manual force drain ───────────────────────────────────────────────

    /**
     * Admin command থেকে manual sync trigger করতে পারবে
     */
    forceDrainAll() {
        return this._fs.forceDrain();
    }

    forceDrain(dbKey) {
        return this._fs.forceDrain(dbKey);
    }

    /** Queue size info */
    queueStatus() {
        const { queueSize } = require('./failover-manager');
        return {
            number : queueSize('number'),
            user   : queueSize('user'),
            status : queueSize('status'),
        };
    }

    /** Full system status */
    systemStatus() {
        return this._fs.getStatus();
    }
}

module.exports = { init, SyncHelper, LOCAL_URIS };
