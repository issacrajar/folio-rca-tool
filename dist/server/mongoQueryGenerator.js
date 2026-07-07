// Copyright (C) Agilysys, Inc. All rights reserved.
// Auto-generates the MongoDB aggregation query from folioTransactions JSON
// so the user doesn't need to manually provide the Excel/CSV.
import XLSX from "xlsx";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// PropertyCode → TenantInfo lookup
const tenantLookup = new Map();
/**
 * Load tenantList.xlsx at startup and build the PropertyCode lookup map.
 */
export function loadTenantList() {
    const filePath = path.resolve(__dirname, "../tenantList.xlsx");
    try {
        const wb = XLSX.readFile(filePath);
        // Find the sheet that has PropertyCode data — prefer "PropertyList", fallback to first sheet with "PropertyCode"
        let sheetName = "";
        if (wb.SheetNames.includes("PropertyList")) {
            sheetName = "PropertyList";
        }
        else {
            for (const name of wb.SheetNames) {
                const raw = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 });
                if (raw.some((row) => Array.isArray(row) && row.includes("PropertyCode"))) {
                    sheetName = name;
                    break;
                }
            }
        }
        if (!sheetName) {
            console.warn("[mongoQueryGen] No sheet with 'PropertyCode' column found in tenantList.xlsx");
            return;
        }
        const sheet = wb.Sheets[sheetName];
        const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        // Find the header row (the one that contains "PropertyCode")
        let headerIdx = -1;
        for (let i = 0; i < rawRows.length; i++) {
            if (rawRows[i]?.includes("PropertyCode")) {
                headerIdx = i;
                break;
            }
        }
        if (headerIdx < 0) {
            console.warn("[mongoQueryGen] Could not find header row with 'PropertyCode' in tenantList.xlsx");
            return;
        }
        const headers = rawRows[headerIdx];
        const colIdx = {
            propertyCode: headers.indexOf("PropertyCode"),
            tenantId: headers.indexOf("TenantId"),
            propertyId: headers.indexOf("PropertyId"),
            tenantCode: headers.indexOf("TenantCode"),
            region: headers.indexOf("Region"),
            propertyName: headers.indexOf("Property Name"),
        };
        for (let i = headerIdx + 1; i < rawRows.length; i++) {
            const row = rawRows[i];
            if (!row || !row[colIdx.propertyCode])
                continue;
            const code = String(row[colIdx.propertyCode]).trim();
            tenantLookup.set(code, {
                propertyCode: code,
                tenantId: String(row[colIdx.tenantId] ?? "").trim(),
                propertyId: String(row[colIdx.propertyId] ?? "").trim(),
                tenantCode: String(row[colIdx.tenantCode] ?? "").trim(),
                region: String(row[colIdx.region] ?? "").trim(),
                propertyName: String(row[colIdx.propertyName] ?? "").trim(),
            });
        }
        console.log(`[mongoQueryGen] Loaded ${tenantLookup.size} properties from tenantList.xlsx`);
    }
    catch (err) {
        console.warn(`[mongoQueryGen] Failed to load tenantList.xlsx: ${err.message}`);
    }
}
/**
 * Extract PropertyCode and chargePostingSequenceNumber from a folioId string.
 * Format: "JAXFW_Stay PMS_1000345_01_2026-04-04T10:17:10.904Z"
 *          ^^^^^                ^^^^^^^
 *     PropertyCode     chargePostingSeqNum
 */
export function parseFolioId(folioId) {
    const parts = folioId.split("_");
    const propertyCode = parts[0] || "";
    // chargePostingSequenceNumber is the 3rd segment (index 2)
    // "JAXFW" _ "Stay PMS" _ "1000345" _ "01" _ timestamp
    // But "Stay PMS" has a space, not underscore — let's handle it by finding the numeric part
    let chargePostingSequenceNumber = "";
    for (let i = 1; i < parts.length; i++) {
        if (/^\d+$/.test(parts[i])) {
            chargePostingSequenceNumber = parts[i];
            break;
        }
    }
    return { propertyCode, chargePostingSequenceNumber };
}
/**
 * Look up tenant info from PropertyCode.
 */
export function lookupTenant(propertyCode) {
    return tenantLookup.get(propertyCode);
}
/**
 * Get all loaded tenants (for the UI dropdown).
 */
export function getAllTenants() {
    return Array.from(tenantLookup.values());
}
/**
 * Generate the MongoDB aggregation query to extract ledger transactions for a folio.
 * This replaces the need for a manually-exported CSV/Excel.
 */
export function generateMongoQuery(tenantId, propertyId, accountId) {
    const pipeline = [
        {
            $match: {
                tenantId,
                propertyId,
                "folioLines.accountId": accountId,
            },
        },
        {
            $unwind: "$folioLines",
        },
        {
            $match: {
                "folioLines.accountId": accountId,
            },
        },
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
        {
            $unwind: { path: "$destinationAccountDetails", preserveNullAndEmptyArrays: true },
        },
        {
            $unwind: { path: "$sourceAccountDetails", preserveNullAndEmptyArrays: true },
        },
        {
            $project: {
                _id: 1,
                folioId: "$folioLines.folioId",
                accountId: "$folioLines.accountId",
                transactionId: "$folioLines._id",
                description: "$folioLines.description",
                amount: "$folioLines.amount",
                quantity: "$folioLines.quantity",
                gatewayType: "$folioLines.gatewayType",
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
    const queryString = `// Run on ledgerTransactions collection\ndb.ledgerTransactions.aggregate(${JSON.stringify(pipeline, null, 2)})`;
    return { queryString, queryObject: pipeline };
}
/**
 * Generate the account lookup query.
 */
export function generateAccountLookupQuery(tenantId, chargePostingSequenceNumber) {
    return `db.accounts.find({tenantId: "${tenantId}", chargePostingSequenceNumber: ${chargePostingSequenceNumber}})`;
}
/**
 * All-in-one: from folioTransactions JSON, generate both the account lookup query
 * and the full aggregation query template (with accountId placeholder).
 */
export function autoGenerateQueries(folioTransactions) {
    if (!folioTransactions?.length) {
        throw new Error("folioTransactions array is empty");
    }
    const folioId = folioTransactions[0].folioId || "";
    const { propertyCode, chargePostingSequenceNumber } = parseFolioId(folioId);
    if (!propertyCode)
        throw new Error(`Could not extract PropertyCode from folioId: ${folioId}`);
    if (!chargePostingSequenceNumber)
        throw new Error(`Could not extract chargePostingSequenceNumber from folioId: ${folioId}`);
    const tenant = lookupTenant(propertyCode) || null;
    const tenantId = tenant?.tenantId || "<TENANT_ID>";
    const propertyId = tenant?.propertyId || "<PROPERTY_ID>";
    const accountLookupQuery = generateAccountLookupQuery(tenantId, chargePostingSequenceNumber);
    const { queryString: mongoWithPlaceholder } = generateMongoQuery(tenantId, propertyId, "<ACCOUNT_ID>");
    const { queryString: mongoAggregationQuery } = generateMongoQuery(tenantId, propertyId, "<ACCOUNT_ID>");
    // Also extract folioNumber from the folio
    const folioNumber = folioTransactions[0].folioNumber || chargePostingSequenceNumber;
    return {
        propertyCode,
        chargePostingSequenceNumber,
        tenant,
        accountLookupQuery,
        mongoAggregationQuery,
        mongoAggregationQueryWithPlaceholder: mongoWithPlaceholder,
        folioNumber,
    };
}
