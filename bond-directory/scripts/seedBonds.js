#!/usr/bin/env node
/**
 * Seed Bonds into MongoDB
 *
 * Reads `frontend_bonds_export.json` and bulk-inserts all bonds into
 * the `bondsdirectory` MongoDB collection.
 *
 * Features:
 *   - Pre-computes `normalizedRating` on each document
 *   - Uses `_id = isin` for natural unique key
 *   - Strips `apiResponseRaw` to save storage
 *   - Creates all required indexes
 *   - Idempotent: drops existing data before re-seeding
 *
 * Usage:
 *   node bond-directory/scripts/seedBonds.js
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const { normalizeRating } = require('../lib/ratingNormalizer');

const MONGO_URI = process.env.BOND_MONGO_URI;
const COLLECTION_NAME = process.env.BOND_COLLECTION_NAME || 'bondsdirectory';
const DATA_PATH = path.join(__dirname, '../../frontend_bonds_export.json');

if (!MONGO_URI) {
    console.error('BOND_MONGO_URI is not set in .env');
    process.exit(1);
}

async function seed() {
    const startTime = Date.now();
    console.log('[Seed] Starting bond data migration...');

    // 1. Read JSON data
    console.log('[Seed] Reading JSON file...');
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const data = JSON.parse(raw);
    console.log(`[Seed] Parsed ${data.bonds.length} bonds, ${data.issuers.length} issuers`);

    // 2. Connect to MongoDB
    const client = new MongoClient(MONGO_URI, {
        maxPoolSize: 5,
        connectTimeoutMS: 15000,
        serverSelectionTimeoutMS: 15000,
    });
    await client.connect();
    const db = client.db();
    const collection = db.collection(COLLECTION_NAME);
    console.log(`[Seed] Connected to '${db.databaseName}', collection '${COLLECTION_NAME}'`);

    // 3. Drop existing data
    const existingCount = await collection.countDocuments();
    if (existingCount > 0) {
        console.log(`[Seed] Dropping ${existingCount} existing documents...`);
        await collection.deleteMany({});
    }

    // 4. Build a lookup for issuer enrichment
    const issuerMap = new Map();
    for (const iss of data.issuers) {
        issuerMap.set(iss.id, iss);
    }

    // 5. Transform bonds for insertion
    console.log('[Seed] Transforming bonds...');
    const docs = data.bonds.map(bond => {
        // Pre-compute normalized rating
        const nr = normalizeRating(bond.creditRating);

        // Enrich issuer data from issuer list if available
        const issuerData = bond.issuer || {};
        const enriched = issuerMap.get(issuerData.id);

        const doc = {
            _id: bond.isin,
            isin: bond.isin,
            issuer: {
                id: issuerData.id || null,
                name: issuerData.name || null,
                sector: issuerData.sector || null,
                ownershipType: issuerData.ownershipType || 'unknown',
                issuerType: issuerData.issuerType || null,
                latestRating: issuerData.latestRating || null,
            },
            couponRate: bond.couponRate ?? null,
            couponType: bond.couponType || null,
            couponFrequency: bond.couponFrequency || null,
            maturityDate: bond.maturityDate ? new Date(bond.maturityDate) : null,
            issueDate: bond.issueDate ? new Date(bond.issueDate) : null,
            faceValue: bond.faceValue ?? null,
            minInvestment: bond.minInvestment ?? null,
            issueSize: bond.issueSize ?? null,
            creditRating: bond.creditRating || null,
            normalizedRating: nr || 'Unrated',
            ratingAgency: bond.ratingAgency || null,
            activeStatus: bond.activeStatus || 'Active',
            isRestructured: bond.isRestructured || false,
            bondsType: bond.bondsType || null,
            listingExchange: bond.listingExchange || null,
            secured: bond.secured ?? null,
            taxFree: bond.taxFree ?? false,
            dataSource: bond.dataSource || 'IndiaBondInfo-NSDL',
            lastSyncedAt: bond.lastSyncedAt ? new Date(bond.lastSyncedAt) : new Date(),
            // Intentionally omit apiResponseRaw to save space
        };

        return doc;
    });

    // 6. Bulk insert in batches of 5000
    const BATCH_SIZE = 5000;
    let inserted = 0;
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const batch = docs.slice(i, i + BATCH_SIZE);
        const result = await collection.insertMany(batch, { ordered: false });
        inserted += result.insertedCount;
        console.log(`[Seed] Inserted ${inserted}/${docs.length} documents...`);
    }

    // 7. Create indexes
    console.log('[Seed] Creating indexes...');

    await collection.createIndex({ isin: 1 }, { unique: true, name: 'idx_isin_unique' });
    await collection.createIndex({ activeStatus: 1 }, { name: 'idx_activeStatus' });
    await collection.createIndex({ 'issuer.id': 1 }, { name: 'idx_issuer_id' });
    await collection.createIndex({ normalizedRating: 1 }, { name: 'idx_normalizedRating' });
    await collection.createIndex({ bondsType: 1 }, { name: 'idx_bondsType' });
    await collection.createIndex({ isRestructured: 1 }, { name: 'idx_isRestructured' });
    await collection.createIndex({ maturityDate: 1 }, { name: 'idx_maturityDate' });
    await collection.createIndex({ couponRate: 1 }, { name: 'idx_couponRate' });

    // Compound indexes for common query patterns
    await collection.createIndex(
        { activeStatus: 1, normalizedRating: 1 },
        { name: 'idx_status_rating' }
    );
    await collection.createIndex(
        { activeStatus: 1, maturityDate: 1 },
        { name: 'idx_status_maturity' }
    );
    await collection.createIndex(
        { 'issuer.id': 1, activeStatus: 1, maturityDate: 1 },
        { name: 'idx_issuer_status_maturity' }
    );

    // Text search index
    await collection.createIndex(
        { isin: 'text', 'issuer.name': 'text' },
        { name: 'idx_text_search', weights: { isin: 10, 'issuer.name': 5 } }
    );

    // Issuer aggregation support
    await collection.createIndex(
        { 'issuer.id': 1, 'issuer.name': 1 },
        { name: 'idx_issuer_agg' }
    );

    console.log('[Seed] All indexes created.');

    // 8. Verify
    const finalCount = await collection.countDocuments();
    const sampleDoc = await collection.findOne({ isin: 'INE002A07809' });

    console.log('');
    console.log('=== SEED COMPLETE ===');
    console.log(`Documents: ${finalCount}`);
    console.log(`Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    console.log(`Sample (Reliance): ${sampleDoc ? sampleDoc.isin + ' — ' + sampleDoc.normalizedRating : 'NOT FOUND'}`);

    // Rating distribution check
    const ratingDist = await collection.aggregate([
        { $group: { _id: '$normalizedRating', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
    ]).toArray();
    console.log('\nTop 10 Rating Distribution:');
    ratingDist.forEach(r => console.log(`  ${(r._id || 'null').padEnd(12)} ${r.count}`));

    await client.close();
    console.log('\n[Seed] Done.');
}

seed().catch(err => {
    console.error('[Seed] FATAL:', err);
    process.exit(1);
});
