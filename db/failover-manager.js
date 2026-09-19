/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║        LOCAL MONGODB + ATLAS FAILOVER SYSTEM — nexo-bot            ║
 * ║                                                                    ║
 * ║  ✅ Local MongoDB = Primary (সবসময় এটা ব্যবহার হয়)               ║
 * ║  ✅ Atlas = Background Sync Target (failover backup)               ║
 * ║  ✅ Atlas down হলে queue-তে জমা, পরে auto sync                     ║
 * ║  ✅ Duplicate/conflict safe — _syncId + timestamp based            ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const mongoose  = require('mongoose');
const path      = require('path');
const { EventEmitter } = require('events');

// ── Queue file paths (disk-persisted) ─────────────────────────────────────
const QUEUE_DIR  = path.join(__dirname, '.sync_queues');
const QUEUE_FILES = {
    number : path.join(QUEUE_DIR, 'queue_number.json'),
    user   : path.join(QUEUE_DIR, 'queue_user.json'),
    status : path.join(QUEUE_DIR, 'queue_status.json'),
};

// ── DB names (for logging) ─────────────────────────────────────────────────
const DB_NAMES = {
    number : 'NUMBER_DB',
    user   : 'USER_DB',
    status : 'STATUS_DB',
};

// ══════════════════════════════════════════════════════════════════════════
// 📦 SYNC QUEUE — disk-persisted
// ══════════════════════════════════════════════════════════════════════════
function ensureQueueDir() {
    if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

function loadQueue(dbKey) {
    ensureQueueDir();
    try {
        const file = QUEUE_FILES[dbKey];
        if (fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            return Array.isArray(data) ? data : [];
        }
    } catch (e) {
        console.error(`[SyncQueue] Load error (${dbKey}):`, e.message);
    }
    return [];
}

function saveQueue(dbKey, queue) {
    ensureQueueDir();
    try {
        fs.writeFileSync(QUEUE_FILES[dbKey], JSON.stringify(queue, null, 2));
    } catch (e) {
        console.error(`[SyncQueue] Save error (${dbKey}):`, e.message);
    }
}

function enqueue(dbKey, op) {
    const queue = loadQueue(dbKey);
    // Duplicate check — same collection + _id + op already pending?
    const isDup = queue.some(
        q => q.collection === op.collection &&
             q._syncId    === op._syncId &&
             q.op         === op.op
    );
    if (isDup) return;
    queue.push(op);
    saveQueue(dbKey, queue);
}

function dequeue(dbKey) {
    const queue = loadQueue(dbKey);
    const item  = queue.shift();
    saveQueue(dbKey, queue);
    return item;
}

function peekQueue(dbKey) {
    return loadQueue(dbKey);
}

function clearQueue(dbKey) {
    saveQueue(dbKey, []);
}

function queueSize(dbKey) {
    return loadQueue(dbKey).length;
}

// ══════════════════════════════════════════════════════════════════════════
// 🔌 SINGLE DB FAILOVER HANDLER
// ══════════════════════════════════════════════════════════════════════════
class DBFailover extends EventEmitter {
    /**
     * @param {string}   dbKey        'number' | 'user' | 'status'
     * @param {string}   localUri     mongodb://localhost:27017/nexo_number
     * @param {string}   atlasUri     mongodb+srv://...
     * @param {object}   baseOptions  mongoose connection options
     */
    constructor(dbKey, localUri, atlasUri, baseOptions = {}) {
        super();
        this.dbKey      = dbKey;
        this.name       = DB_NAMES[dbKey] || dbKey.toUpperCase();
        this.localUri   = localUri || null;
        this.atlasUri   = atlasUri;
        this.baseOpts   = baseOptions;

        // Connections
        this.localConn  = null;
        this.atlasConn  = null;

        // State
        this.isLocalReady = false;
        this.isAtlasReady = false;
        this.isSyncing    = false;

        // Sync interval handle
        this._syncTimer   = null;
        this._atlasRetryTimer = null;

        // Atlas health check interval (5 min)
        this.ATLAS_RETRY_MS = 5 * 60 * 1000;
        // Sync interval when Atlas is online (30 sec)
        this.SYNC_INTERVAL_MS = 30 * 1000;
    }

    // ── Connect Local (Primary) ──────────────────────────────────────────
    async connectLocal() {
        if (!this.localUri) return null;

        const opts = {
            ...this.baseOpts,
            serverSelectionTimeoutMS : 5000,
            connectTimeoutMS         : 5000,
            socketTimeoutMS          : 10000,
            bufferCommands           : false,
        };

        this.localConn = mongoose.createConnection(this.localUri, opts);

        this.localConn.on('connected', () => {
            this.isLocalReady = true;
            this._log('✅ Local MongoDB Connected!', 'success');
            this.emit('local:connected', this.localConn);
        });

        this.localConn.on('error', (err) => {
            this.isLocalReady = false;
            this._log(`❌ Local MongoDB Error: ${err.message}`, 'error');
            this.emit('local:error', err);
        });

        this.localConn.on('disconnected', () => {
            this.isLocalReady = false;
            this._log('⚠️ Local MongoDB Disconnected!', 'warn');
            this.emit('local:disconnected');
        });

        this.localConn.on('reconnected', () => {
            this.isLocalReady = true;
            this._log('✅ Local MongoDB Reconnected!', 'success');
            this.emit('local:reconnected', this.localConn);
        });

        return this.localConn;
    }

    // ── Connect Atlas (Background Sync Target) ───────────────────────────
    async connectAtlas() {
        if (!this.atlasUri) {
            this._log('ℹ️ No Atlas URI — skipping Atlas connection', 'info');
            return null;
        }

        const opts = {
            ...this.baseOpts,
            serverSelectionTimeoutMS : 8000,
            connectTimeoutMS         : 8000,
            socketTimeoutMS          : 20000,
            bufferCommands           : false,
        };

        try {
            this.atlasConn = mongoose.createConnection(this.atlasUri, opts);

            this.atlasConn.on('connected', () => {
                this.isAtlasReady = true;
                this._log('✅ Atlas MongoDB Connected! (background sync active)', 'success');
                this.emit('atlas:connected', this.atlasConn);
                this._startSyncScheduler();
                // Immediately drain pending queue
                this._drainQueue().catch(() => {});
            });

            this.atlasConn.on('error', (err) => {
                this.isAtlasReady = false;
                this._log(`⚠️ Atlas Error: ${err.message} — queuing writes`, 'warn');
                this.emit('atlas:error', err);
                this._stopSyncScheduler();
                this._scheduleAtlasRetry();
            });

            this.atlasConn.on('disconnected', () => {
                this.isAtlasReady = false;
                this._log('⚠️ Atlas Disconnected — queuing writes until reconnect', 'warn');
                this.emit('atlas:disconnected');
                this._stopSyncScheduler();
                this._scheduleAtlasRetry();
            });

            this.atlasConn.on('reconnected', () => {
                this.isAtlasReady = true;
                this._log('✅ Atlas Reconnected! Draining queue...', 'success');
                this.emit('atlas:reconnected', this.atlasConn);
                clearTimeout(this._atlasRetryTimer);
                this._startSyncScheduler();
                this._drainQueue().catch(() => {});
            });

            return this.atlasConn;

        } catch (err) {
            this._log(`❌ Atlas Connection failed: ${err.message}`, 'error');
            this._scheduleAtlasRetry();
            return null;
        }
    }

    // ── Atlas Retry Scheduler ────────────────────────────────────────────
    _scheduleAtlasRetry() {
        clearTimeout(this._atlasRetryTimer);
        this._atlasRetryTimer = setTimeout(async () => {
            this._log(`🔄 Retrying Atlas connection...`, 'info');
            if (this.atlasConn) {
                try {
                    await this.atlasConn.close().catch(() => {});
                } catch (_) {}
            }
            await this.connectAtlas();
        }, this.ATLAS_RETRY_MS);
        this._log(`⏰ Atlas retry in ${this.ATLAS_RETRY_MS / 60000}min`, 'info');
    }

    // ── Sync Scheduler ───────────────────────────────────────────────────
    _startSyncScheduler() {
        if (this._syncTimer) return;
        this._syncTimer = setInterval(() => {
            if (this.isAtlasReady && queueSize(this.dbKey) > 0) {
                this._drainQueue().catch(() => {});
            }
        }, this.SYNC_INTERVAL_MS);
    }

    _stopSyncScheduler() {
        if (this._syncTimer) {
            clearInterval(this._syncTimer);
            this._syncTimer = null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 📝 WRITE — Local always + queue for Atlas
    // ══════════════════════════════════════════════════════════════════════
    /**
     * Write to Local first (always succeeds if local up).
     * Then try Atlas immediately; if Atlas down → enqueue.
     *
     * @param {string}  collection   Model name, e.g. 'Number'
     * @param {string}  op           'upsert' | 'update' | 'delete' | 'insert'
     * @param {object}  filter       MongoDB filter
     * @param {object}  data         Document data (for upsert/update)
     * @param {string}  _syncId      Unique id of this record (e.g. doc._id.toString())
     */
    async syncWrite({ collection, op, filter, data, _syncId }) {
        // Atlas is already the primary database when local MongoDB is disabled.
        if (!this.localUri) return;

        const queueItem = {
            collection,
            op,
            filter,
            data,
            _syncId,
            enqueuedAt: new Date().toISOString(),
        };

        if (!this.isAtlasReady) {
            // Atlas down — queue it
            enqueue(this.dbKey, queueItem);
            this._log(
                `📥 [QUEUE] ${op} → ${collection} | _syncId: ${_syncId} | pending: ${queueSize(this.dbKey)}`,
                'info'
            );
            return;
        }

        // Atlas up — try to sync immediately
        try {
            await this._applyToAtlas(queueItem);
        } catch (err) {
            this._log(`⚠️ Atlas write failed (${collection}/${_syncId}): ${err.message} — queued`, 'warn');
            enqueue(this.dbKey, queueItem);
        }
    }

    // ── Apply one operation to Atlas ─────────────────────────────────────
    async _applyToAtlas(item) {
        if (!this.isAtlasReady || !this.atlasConn) {
            throw new Error('Atlas not ready');
        }

        const { collection, op, filter, data } = item;

        // Get the model from Atlas connection
        // Atlas connection uses same schemas (registered via getAtlasModel)
        const Model = this._getAtlasModel(collection);
        if (!Model) throw new Error(`No Atlas model for: ${collection}`);

        switch (op) {
            case 'upsert':
                await Model.findOneAndUpdate(filter, { $set: data }, { upsert: true });
                break;
            case 'insert':
                await Model.findOneAndUpdate(filter, { $setOnInsert: data }, { upsert: true });
                break;
            case 'update':
                await Model.updateMany(filter, { $set: data });
                break;
            case 'delete':
                await Model.deleteMany(filter);
                break;
            case 'bulkWrite':
                // data should be an array of bulk ops
                if (Array.isArray(data)) {
                    await Model.bulkWrite(data, { ordered: false });
                }
                break;
            default:
                throw new Error(`Unknown op: ${op}`);
        }
    }

    // ── Drain pending queue to Atlas ─────────────────────────────────────
    async _drainQueue() {
        if (this.isSyncing) return;
        if (!this.isAtlasReady) return;

        const pending = queueSize(this.dbKey);
        if (pending === 0) return;

        this.isSyncing = true;
        this._log(`🔄 Draining queue: ${pending} ops → Atlas`, 'info');
        this.emit('sync:start', { dbKey: this.dbKey, pending });

        let synced = 0;
        let failed = 0;
        let failedItems = [];

        const queue = loadQueue(this.dbKey);
        clearQueue(this.dbKey); // optimistic clear; failures re-enqueued below

        for (const item of queue) {
            if (!this.isAtlasReady) {
                // Atlas went down mid-drain — re-queue remaining
                failedItems.push(item);
                this._log('⚠️ Atlas went down mid-drain, re-queuing remaining...', 'warn');
                break;
            }
            try {
                await this._applyToAtlas(item);
                synced++;
            } catch (err) {
                this._log(
                    `❌ Sync failed (${item.collection}/${item._syncId}): ${err.message}`,
                    'error'
                );
                failedItems.push(item);
                failed++;
            }
        }

        // Re-enqueue failures (dedup)
        const existingQueue = loadQueue(this.dbKey);
        const merged = [...failedItems, ...existingQueue];
        // Dedup by _syncId + op
        const seen = new Set();
        const deduped = merged.filter(item => {
            const key = `${item.collection}|${item._syncId}|${item.op}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        saveQueue(this.dbKey, deduped);

        this.isSyncing = false;
        this._log(`✅ Sync done: ${synced} synced, ${failed} failed/re-queued`, 'success');
        this.emit('sync:done', { dbKey: this.dbKey, synced, failed });
    }

    // ── Atlas model registry ─────────────────────────────────────────────
    _atlasModels = {};

    registerAtlasModel(name, schema) {
        if (!this.atlasConn) return null;
        if (this._atlasModels[name]) return this._atlasModels[name];
        try {
            this._atlasModels[name] = this.atlasConn.model(name, schema);
            return this._atlasModels[name];
        } catch (err) {
            // Model already registered on this connection
            try {
                this._atlasModels[name] = this.atlasConn.model(name);
                return this._atlasModels[name];
            } catch (_) {
                return null;
            }
        }
    }

    _getAtlasModel(name) {
        return this._atlasModels[name] || null;
    }

    // ── Status / Health ──────────────────────────────────────────────────
    getStatus() {
        return {
            dbKey       : this.dbKey,
            name        : this.name,
            localReady  : this.isLocalReady,
            atlasReady  : this.isAtlasReady,
            queueSize   : queueSize(this.dbKey),
            isSyncing   : this.isSyncing,
        };
    }

    _log(msg, level = 'info') {
        const icons = { success: '✅', error: '❌', warn: '⚠️', info: 'ℹ️' };
        const icon = icons[level] || '🔹';
        console.log(`${icon} [${this.name}] ${msg}`);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 🏗️ FAILOVER SYSTEM — manages all 3 DB connections
// ══════════════════════════════════════════════════════════════════════════
class FailoverSystem extends EventEmitter {
    constructor() {
        super();
        /** @type {Object.<string, DBFailover>} */
        this.handlers = {};
    }

    /**
     * Initialize one DB with Local + Atlas failover
     */
    addDB(dbKey, localUri, atlasUri, options = {}) {
        const handler = new DBFailover(dbKey, localUri, atlasUri, options);

        // Bubble up events
        handler.on('local:connected',    (conn) => this.emit(`${dbKey}:local:connected`, conn));
        handler.on('local:error',        (err)  => this.emit(`${dbKey}:local:error`, err));
        handler.on('local:disconnected', ()     => this.emit(`${dbKey}:local:disconnected`));
        handler.on('local:reconnected',  (conn) => this.emit(`${dbKey}:local:reconnected`, conn));
        handler.on('atlas:connected',    (conn) => this.emit(`${dbKey}:atlas:connected`, conn));
        handler.on('atlas:disconnected', ()     => this.emit(`${dbKey}:atlas:disconnected`));
        handler.on('atlas:error',        (err)  => this.emit(`${dbKey}:atlas:error`, err));
        handler.on('atlas:reconnected',  (conn) => this.emit(`${dbKey}:atlas:reconnected`, conn));
        handler.on('sync:start',         (info) => this.emit('sync:start', info));
        handler.on('sync:done',          (info) => this.emit('sync:done', info));

        this.handlers[dbKey] = handler;
        return handler;
    }

    /**
     * Start all connections: Local (await) then Atlas (background)
     */
    async start() {
        console.log('\n🚀 [FailoverSystem] Starting all DB connections...\n');

        for (const [key, handler] of Object.entries(this.handlers)) {
            // Local is optional in environments that use Atlas as the primary.
            if (handler.localUri) await handler.connectLocal();
            // Atlas: background (don't await, don't block bot startup)
            handler.connectAtlas().catch(() => {});
        }
    }

    /**
     * Get the LOCAL connection for a db key
     * @returns {mongoose.Connection}
     */
    getLocal(dbKey) {
        return this.handlers[dbKey]?.localConn || null;
    }

    /**
     * Get the ATLAS connection for a db key
     * @returns {mongoose.Connection|null}
     */
    getAtlas(dbKey) {
        return this.handlers[dbKey]?.atlasConn || null;
    }

    /**
     * Trigger a sync write (local already done, just sync to Atlas)
     */
    syncWrite(dbKey, op) {
        return this.handlers[dbKey]?.syncWrite(op);
    }

    /**
     * Register a schema on Atlas connection (must call after atlas connects)
     */
    registerAtlasModel(dbKey, modelName, schema) {
        return this.handlers[dbKey]?.registerAtlasModel(modelName, schema);
    }

    /**
     * Get full status report
     */
    getStatus() {
        const statuses = {};
        for (const [key, handler] of Object.entries(this.handlers)) {
            statuses[key] = handler.getStatus();
        }
        return statuses;
    }

    /**
     * Force immediate sync for one or all DBs
     */
    async forceDrain(dbKey = null) {
        if (dbKey) {
            return this.handlers[dbKey]?._drainQueue();
        }
        for (const handler of Object.values(this.handlers)) {
            await handler._drainQueue().catch(() => {});
        }
    }
}

// ── Singleton export ───────────────────────────────────────────────────────
module.exports = new FailoverSystem();
module.exports.FailoverSystem  = FailoverSystem;
module.exports.DBFailover      = DBFailover;
module.exports.queueSize       = queueSize;
module.exports.peekQueue       = peekQueue;
