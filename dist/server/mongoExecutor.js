// Copyright (C) Agilysys, Inc. All rights reserved.
// MongoDB query executor for the RCA tool.
// Uses OIDC auth via @mongodb-js/oidc-plugin (same as mongosh) for production.
// Supports a custom (non-OIDC) connection URI for other environments.
import { MongoClient } from "mongodb";
import { createMongoDBOIDCPlugin } from "@mongodb-js/oidc-plugin";
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "Stay-MI-Prod-01";
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://stay-mi-prod-01.9mq2r.mongodb.net/admin?loadBalanced=false&srvServiceName=mongodb&connectTimeoutMS=10000&readPreference=secondary&authSource=%24external&authMechanism=MONGODB-OIDC";
/** Hard kill threshold: any single query must complete within 50 seconds */
const QUERY_TIMEOUT_MS = 50_000;
let _logSeq = 0;
const _queryLog = [];
const MAX_LOG_ENTRIES = 500;
function logStart(label, collection, operation, params) {
    const entry = {
        id: ++_logSeq,
        label,
        collection,
        operation,
        params: JSON.stringify(params),
        startedAt: new Date().toISOString(),
        durationMs: null,
        status: "running",
    };
    _queryLog.unshift(entry); // newest first
    if (_queryLog.length > MAX_LOG_ENTRIES)
        _queryLog.splice(MAX_LOG_ENTRIES);
    return entry;
}
function logEnd(entry, startMs, rowCount, error) {
    entry.durationMs = Date.now() - startMs;
    if (error) {
        entry.status = "error";
        entry.error = error.message;
    }
    else {
        entry.status = "success";
        if (rowCount !== undefined)
            entry.rowCount = rowCount;
    }
}
/** Attach the full MongoDB query (filter or pipeline) to a log entry. */
function setEntryQuery(entry, query) {
    try {
        entry.query = JSON.stringify(query, null, 2);
    }
    catch { /* ignore serialisation errors */ }
}
/** Returns a shallow copy of the log (newest first). */
export function getQueryLog() {
    return [..._queryLog];
}
/** Clears the query log. */
export function clearQueryLog() {
    _queryLog.splice(0);
}
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`[mongoExecutor] ${label} exceeded ${ms / 1000}s timeout — query killed`)), ms)),
    ]);
}
// ─── Production OIDC client ────────────────────────────────────────────────
const oidcPlugin = createMongoDBOIDCPlugin();
let client = null;
let connecting = null;
async function getClient() {
    if (client) {
        try {
            await withTimeout(client.db("admin").command({ ping: 1 }), 5_000, "ping");
            return client;
        }
        catch {
            console.log(`[mongoExecutor] Stale connection, reconnecting...`);
            try {
                await client.close();
            }
            catch { }
            client = null;
            connecting = null;
        }
    }
    if (connecting)
        return connecting;
    console.log(`[mongoExecutor] Connecting to MongoDB via OIDC (timeout: ${QUERY_TIMEOUT_MS / 1000}s)...`);
    connecting = withTimeout((async () => {
        const c = new MongoClient(MONGO_URI, {
            maxPoolSize: 5,
            minPoolSize: 1,
            serverSelectionTimeoutMS: QUERY_TIMEOUT_MS,
            connectTimeoutMS: QUERY_TIMEOUT_MS,
            socketTimeoutMS: QUERY_TIMEOUT_MS,
            ...oidcPlugin.mongoClientOptions,
        });
        await c.connect();
        client = c;
        console.log(`[mongoExecutor] Connected to ${MONGO_DB_NAME} via OIDC`);
        connecting = null;
        return client;
    })(), QUERY_TIMEOUT_MS, "getClient (OIDC connect)").catch(err => {
        connecting = null;
        client = null;
        throw err;
    });
    return connecting;
}
// ─── Custom URI client (non-OIDC, credentials embedded in URI) ───────────
let customUriOverride = null;
let customDbNameOverride = null;
let customClient = null;
let customConnecting = null;
/**
 * Switch to a custom MongoDB URI (for non-production environments).
 * Pass null to revert to the default production OIDC connection.
 */
export function setCustomMongoUri(uri, dbName) {
    if (uri === customUriOverride)
        return; // no change
    // Close any existing custom client
    if (customClient) {
        customClient.close().catch(() => { });
        customClient = null;
        customConnecting = null;
    }
    customUriOverride = uri;
    customDbNameOverride = dbName || null;
    if (uri) {
        // Redact credentials for logging
        const display = uri.replace(/:\/\/[^@]+@/, "://<redacted>@");
        console.log(`[mongoExecutor] Custom URI set → ${display}`);
    }
    else {
        console.log(`[mongoExecutor] Reverted to production OIDC URI`);
    }
}
async function getCustomClient() {
    if (customClient) {
        try {
            await withTimeout(customClient.db("admin").command({ ping: 1 }), 5_000, "custom ping");
            return customClient;
        }
        catch {
            console.log(`[mongoExecutor] Stale custom connection, reconnecting...`);
            try {
                await customClient.close();
            }
            catch { }
            customClient = null;
            customConnecting = null;
        }
    }
    if (customConnecting)
        return customConnecting;
    if (!customUriOverride)
        throw new Error("[mongoExecutor] No custom URI set");
    console.log(`[mongoExecutor] Connecting to custom MongoDB...`);
    customConnecting = withTimeout((async () => {
        const c = new MongoClient(customUriOverride, {
            maxPoolSize: 5,
            serverSelectionTimeoutMS: QUERY_TIMEOUT_MS,
            connectTimeoutMS: QUERY_TIMEOUT_MS,
            socketTimeoutMS: QUERY_TIMEOUT_MS,
        });
        await c.connect();
        customClient = c;
        console.log(`[mongoExecutor] Connected to custom MongoDB`);
        customConnecting = null;
        return customClient;
    })(), QUERY_TIMEOUT_MS, "getCustomClient (connect)").catch(err => {
        customConnecting = null;
        customClient = null;
        throw err;
    });
    return customConnecting;
}
/** Returns the active client — custom URI if set, otherwise production OIDC. */
async function getActiveClient() {
    return customUriOverride ? getCustomClient() : getClient();
}
/** Returns the active DB name — custom if set, otherwise MONGO_DB_NAME. */
function getActiveDbName() {
    return (customUriOverride && customDbNameOverride) ? customDbNameOverride : MONGO_DB_NAME;
}
// ─── Exported query functions ─────────────────────────────────────────────
/**
 * Find the accountId by tenantId + chargePostingSequenceNumber.
 */
export async function findAccountId(tenantId, chargePostingSequenceNumber) {
    const entry = logStart("findAccountId", "accounts", "findOne", { tenantId, chargePostingSequenceNumber });
    const t0 = Date.now();
    try {
        const c = await getActiveClient();
        const db = c.db(getActiveDbName());
        const filter = { tenantId, chargePostingSequenceNumber };
        setEntryQuery(entry, { filter, projection: { _id: 1, accountType: 1 } });
        const account = await withTimeout(db.collection("accounts").findOne(filter, { projection: { _id: 1, accountType: 1 }, maxTimeMS: QUERY_TIMEOUT_MS }), QUERY_TIMEOUT_MS, "findAccountId");
        logEnd(entry, t0, account ? 1 : 0);
        if (!account)
            return null;
        return { accountId: String(account._id), accountType: account.accountType || "" };
    }
    catch (err) {
        logEnd(entry, t0, undefined, err);
        throw err;
    }
}
/**
 * Execute the ledgerTransactions aggregation pipeline and return the rows.
 */
export async function executeLedgerQuery(tenantId, propertyId, accountId) {
    const entry = logStart("executeLedgerQuery", "ledgerTransactions", "aggregate", { tenantId, propertyId, accountId });
    const t0 = Date.now();
    try {
        const c = await getActiveClient();
        const db = c.db(getActiveDbName());
        const pipeline = [
            { $match: { tenantId, propertyId, "folioLines.accountId": accountId } },
            { $unwind: "$folioLines" },
            { $match: { "folioLines.accountId": accountId } },
            {
                $addFields: {
                    destinationAccountIdObj: {
                        $convert: { input: "$destinationAccountId", to: "objectId", onError: null, onNull: null },
                    },
                },
            },
            {
                $addFields: {
                    sourceAccountIdObj: {
                        $convert: { input: "$sourceAccountId", to: "objectId", onError: null, onNull: null },
                    },
                },
            },
            {
                $lookup: {
                    from: "accounts",
                    localField: "destinationAccountIdObj",
                    foreignField: "_id",
                    as: "destinationAccountDetails",
                },
            },
            {
                $lookup: {
                    from: "accounts",
                    localField: "sourceAccountIdObj",
                    foreignField: "_id",
                    as: "sourceAccountDetails",
                },
            },
            { $unwind: { path: "$destinationAccountDetails", preserveNullAndEmptyArrays: true } },
            { $unwind: { path: "$sourceAccountDetails", preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    _id: 1,
                    folioId: "$folioLines.folioId",
                    accountId: "$folioLines.accountId",
                    transactionId: "$folioLines._id",
                    description: "$folioLines.description",
                    itemId: "$folioLines.itemId",
                    amount: "$folioLines.amount",
                    quantity: "$folioLines.quantity",
                    gatewayType: "$folioLines.gatewayType",
                    adjustmentReferenceId: "$folioLines.adjustmentReferenceId",
                    refundReferenceId: "$folioLines.refundReferenceId",
                    sourceFolioLineItemId: "$folioLines.sourceFolioLineItemId",
                    correctionReferenceId: "$folioLines.correctionReferenceId",
                    transferReferenceId: "$folioLines.transferReferenceId",
                    taxReferenceId: "$folioLines.taxReferenceId",
                    taxExempted: "$folioLines.taxExemptDetail.taxExempted",
                    type: "$type",
                    originalType: "$folioLineType",
                    totalAmount: {
                        $toLong: {
                            $multiply: [
                                { $toDecimal: "$folioLines.amount" },
                                { $toDecimal: "$folioLines.quantity" },
                                100,
                            ],
                        },
                    },
                    destinationAccountType: "$destinationAccountDetails.accountType",
                    sourceAccountType: "$sourceAccountDetails.accountType",
                },
            },
        ];
        setEntryQuery(entry, pipeline);
        const results = await withTimeout(db.collection("ledgerTransactions").aggregate(pipeline, { allowDiskUse: true, maxTimeMS: QUERY_TIMEOUT_MS }).toArray(), QUERY_TIMEOUT_MS, "executeLedgerQuery");
        logEnd(entry, t0, results.length);
        return results;
    }
    catch (err) {
        logEnd(entry, t0, undefined, err);
        throw err;
    }
}
/**
 * Execute the ledgerTransactionHistory source query — fetches
 * ledgerTransactionHistory.sourceFolioLineItemId (top-level field, outside folioLines)
 * for the given transactionIds (matched via folioLines._id).
 */
export async function executeHistorySourceQuery(tenantId, propertyId, transactionIds) {
    const ids = transactionIds.filter(Boolean);
    if (!ids.length)
        return [];
    const entry = logStart("executeHistorySourceQuery", "ledgerTransactions", "aggregate", { tenantId, propertyId, transactionIdCount: ids.length });
    const t0 = Date.now();
    try {
        const c = await getActiveClient();
        const db = c.db(getActiveDbName());
        const pipeline = [
            {
                $match: {
                    tenantId,
                    propertyId,
                    "folioLines._id": { $in: ids },
                },
            },
            { $unwind: "$folioLines" },
            {
                $match: {
                    "folioLines._id": { $in: ids },
                },
            },
            {
                $project: {
                    _id: 1,
                    transactionId: "$folioLines._id",
                    // ledgerTransactionHistory is taken from folioLines.ledgerTransactionHistory
                    sourceFolioLineItemId: "$folioLines.ledgerTransactionHistory.sourceFolioLineItemId",
                    ledgerTransactionHistory: "$folioLines.ledgerTransactionHistory",
                },
            },
        ];
        setEntryQuery(entry, pipeline);
        const results = await withTimeout(db.collection("ledgerTransactions").aggregate(pipeline, { allowDiskUse: true, maxTimeMS: QUERY_TIMEOUT_MS }).toArray(), QUERY_TIMEOUT_MS, "executeHistorySourceQuery");
        logEnd(entry, t0, results.length);
        return results;
    }
    catch (err) {
        logEnd(entry, t0, undefined, err);
        throw err;
    }
}
/**
 * Close all MongoDB connections (for cleanup).
 */
export async function closeMongoConnection() {
    if (client) {
        await client.close();
        client = null;
    }
    if (customClient) {
        await customClient.close();
        customClient = null;
    }
    console.log("[mongoExecutor] Connection(s) closed");
}
/**
 * Given a folioLines._id (anchorId), fetch the ledgerTransactions document
 * that contains it and return ALL folioLines from that document.
 *
 * This is used when we need to "group taxes in that document" — find the
 * folio line with the matching itemId inside the same document.
 */
export async function executeFolioLinesByDocumentQuery(tenantId, propertyId, anchorFolioLineId) {
    if (!anchorFolioLineId)
        return [];
    const entry = logStart("executeFolioLinesByDocumentQuery", "ledgerTransactions", "findOne+aggregate", { tenantId, propertyId, anchorFolioLineId });
    const t0 = Date.now();
    try {
        const c = await getActiveClient();
        const db = c.db(getActiveDbName());
        // Step 1: find the document _id that owns this folioLines._id
        const findOneFilter = { tenantId, propertyId, "folioLines._id": anchorFolioLineId };
        setEntryQuery(entry, { step1_findOne: { filter: findOneFilter, projection: { _id: 1 } } });
        const docMatch = await withTimeout(db.collection("ledgerTransactions").findOne(findOneFilter, { projection: { _id: 1 }, maxTimeMS: QUERY_TIMEOUT_MS }), QUERY_TIMEOUT_MS, "executeFolioLinesByDocumentQuery (findOne)");
        if (!docMatch) {
            logEnd(entry, t0, 0);
            return [];
        }
        // Step 2: unwind ALL folioLines from that document
        const pipeline = [
            { $match: { _id: docMatch._id } },
            { $unwind: "$folioLines" },
            {
                $project: {
                    _id: 1,
                    transactionId: "$folioLines._id",
                    itemId: "$folioLines.itemId",
                    taxReferenceId: "$folioLines.taxReferenceId",
                    adjustmentReferenceId: "$folioLines.adjustmentReferenceId",
                    refundReferenceId: "$folioLines.refundReferenceId",
                    sourceFolioLineItemId: "$folioLines.sourceFolioLineItemId",
                    correctionReferenceId: "$folioLines.correctionReferenceId",
                    transferReferenceId: "$folioLines.transferReferenceId",
                    taxExempted: "$folioLines.taxExemptDetail.taxExempted",
                    type: "$type",
                    amount: "$folioLines.amount",
                    quantity: "$folioLines.quantity",
                    totalAmount: {
                        $toLong: {
                            $multiply: [
                                { $toDecimal: "$folioLines.amount" },
                                { $toDecimal: "$folioLines.quantity" },
                                100,
                            ],
                        },
                    },
                },
            },
        ];
        setEntryQuery(entry, { step1_findOne: { filter: findOneFilter, projection: { _id: 1 } }, step2_aggregate: pipeline });
        const results = await withTimeout(db.collection("ledgerTransactions").aggregate(pipeline, { allowDiskUse: true, maxTimeMS: QUERY_TIMEOUT_MS }).toArray(), QUERY_TIMEOUT_MS, "executeFolioLinesByDocumentQuery (aggregate)");
        logEnd(entry, t0, results.length);
        return results;
    }
    catch (err) {
        logEnd(entry, t0, undefined, err);
        throw err;
    }
}
/**
 * Execute the transfer reference query — fetches ledger transactions whose
 * folioLines._id matches any of the provided reference IDs.
 */
export async function executeTransferQuery(tenantId, propertyId, folioLineIds) {
    const ids = folioLineIds.filter(Boolean);
    if (!ids.length)
        return [];
    const entry = logStart("executeTransferQuery", "ledgerTransactions", "aggregate", { tenantId, propertyId, folioLineIdCount: ids.length });
    const t0 = Date.now();
    try {
        const c = await getActiveClient();
        const db = c.db(getActiveDbName());
        const pipeline = [
            {
                $match: {
                    tenantId,
                    propertyId,
                    "folioLines._id": { $in: ids },
                },
            },
            { $unwind: "$folioLines" },
            {
                $match: {
                    "folioLines._id": { $in: ids },
                },
            },
            {
                $project: {
                    _id: 1,
                    folioId: "$folioLines.folioId",
                    accountId: "$folioLines.accountId",
                    transactionId: "$folioLines._id",
                    description: "$folioLines.description",
                    amount: "$folioLines.amount",
                    itemId: "$folioLines.itemId",
                    taxReferenceId: "$folioLines.taxReferenceId",
                    adjustmentReferenceId: "$folioLines.adjustmentReferenceId",
                    refundReferenceId: "$folioLines.refundReferenceId",
                    sourceFolioLineItemId: "$folioLines.sourceFolioLineItemId",
                    correctionReferenceId: "$folioLines.correctionReferenceId",
                    transferReferenceId: "$folioLines.transferReferenceId",
                    taxExempted: "$folioLines.taxExemptDetail.taxExempted",
                    type: "$type",
                    originalType: "$folioLineType",
                    quantity: "$folioLines.quantity",
                    totalAmount: {
                        $toLong: {
                            $multiply: [
                                { $toDecimal: "$folioLines.amount" },
                                { $toDecimal: "$folioLines.quantity" },
                                100,
                            ],
                        },
                    },
                },
            },
        ];
        setEntryQuery(entry, pipeline);
        const results = await withTimeout(db.collection("ledgerTransactions").aggregate(pipeline, { allowDiskUse: true, maxTimeMS: QUERY_TIMEOUT_MS }).toArray(), QUERY_TIMEOUT_MS, "executeTransferQuery");
        logEnd(entry, t0, results.length);
        return results;
    }
    catch (err) {
        logEnd(entry, t0, undefined, err);
        throw err;
    }
}
