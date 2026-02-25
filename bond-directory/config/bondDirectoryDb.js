/**
 * Bond Directory — MongoDB Connection Manager
 *
 * Manages the connection to the `bondsdirectory` database.
 * Uses the native MongoDB driver (not Mongoose) for maximum flexibility
 * with a single-collection architecture.
 */

'use strict';

const { MongoClient } = require('mongodb');

const BOND_MONGO_URI = process.env.BOND_MONGO_URI;
const BOND_COLLECTION_NAME = process.env.BOND_COLLECTION_NAME || 'bondsdirectory';

if (!BOND_MONGO_URI) {
    console.warn('[BondDB] BOND_MONGO_URI not set — Bond Directory endpoints will not work');
}

const client = BOND_MONGO_URI
    ? new MongoClient(BOND_MONGO_URI, {
        maxPoolSize: 10,
        minPoolSize: 2,
        connectTimeoutMS: 10000,
        serverSelectionTimeoutMS: 10000,
    })
    : null;

let db = null;
let collection = null;
let connected = false;

/**
 * Connect to Bond Directory MongoDB.
 * Call once at server startup.
 */
async function connectBondDb() {
    if (!client) {
        console.warn('[BondDB] Skipping connection — no BOND_MONGO_URI configured');
        return null;
    }

    try {
        await client.connect();
        db = client.db(); // Uses database name from URI
        collection = db.collection(BOND_COLLECTION_NAME);
        connected = true;

        const count = await collection.countDocuments();
        console.log(`[BondDB] Connected to '${db.databaseName}'. Collection '${BOND_COLLECTION_NAME}' has ${count} documents.`);

        return db;
    } catch (error) {
        console.error('[BondDB] Connection failed:', error.message);
        throw error;
    }
}

/**
 * Get the bonds collection.
 * @returns {import('mongodb').Collection}
 */
function getBondCollection() {
    if (!collection) {
        throw new Error('[BondDB] Not connected. Call connectBondDb() first.');
    }
    return collection;
}

/**
 * Check if the Bond DB is connected.
 * @returns {{ connected: boolean, latencyMs?: number }}
 */
async function healthCheck() {
    if (!client || !connected) {
        return { connected: false };
    }
    try {
        const start = Date.now();
        await db.command({ ping: 1 });
        return { connected: true, latencyMs: Date.now() - start };
    } catch {
        return { connected: false };
    }
}

/**
 * Gracefully close the Bond DB connection.
 */
async function closeBondDb() {
    if (client && connected) {
        await client.close();
        connected = false;
        console.log('[BondDB] Connection closed.');
    }
}

module.exports = {
    connectBondDb,
    getBondCollection,
    closeBondDb,
    healthCheck,
};
