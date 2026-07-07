// Copyright (C) Agilysys, Inc. All rights reserved.

// Folio RCA Tool — Express Server (Phase 8)
import express from "express";
import cors from "cors";
import multer from "multer";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSourceFiles } from "./sourceLoader.js";
import { loadFragments, expandQueries, getExpandedQuery, buildVariablesTemplate, getAllFragments } from "./graphqlExpander.js";
import { parseCsvBuffer } from "./csvParser.js";
import { compareTransactions } from "./comparisonEngine.js";
import { simulateTransformOut, simulateFolioOutTransform } from "./transformOutSimulator.js";
import { correctPayload } from "./correctionEngine.js";
import { getRules, saveRules, applyUserRules } from "./userRules.js";
import { analyzeWithLlm, isOllamaAvailable } from "./llm.js";
import { getBuiltInRulesDescription } from "./builtInRules.js";
import { flattenTransactions } from "./transactionFlattener.js";
import { loadTenantList, autoGenerateQueries, generateMongoQuery } from "./mongoQueryGenerator.js";
import { findAccountId, executeLedgerQuery, executeTransferQuery, executeHistorySourceQuery, executeFolioLinesByDocumentQuery, setCustomMongoUri, getQueryLog, clearQueryLog } from "./mongoExecutor.js";

// ─── Server-side environment configuration ────────────────────────────────
interface EnvConfig {
  mode: "production" | "other";
  tenantId?: string;
  propertyId?: string;
  dbName?: string;
}
let envConfig: EnvConfig = { mode: "production" };

/** Resolve tenantId/propertyId: use envConfig overrides when mode=other, else fall back to extracted values. */
function resolveTenant(extracted: { tenantId?: string; propertyId?: string }): { tenantId: string | undefined; propertyId: string | undefined } {
  if (envConfig.mode === "other" && envConfig.tenantId && envConfig.propertyId) {
    return { tenantId: envConfig.tenantId, propertyId: envConfig.propertyId };
  }
  return { tenantId: extracted.tenantId, propertyId: extracted.propertyId };
}

// --- Replicated from adapterUtils.ts and folioOutModels.ts ---
// Cannot import directly because transitive deps pull in @agilysys-stay/accessors etc.

/** Replication of generateRandomNumbers from adapterUtils.ts line 314 */
function generateRandomNumbers(str: string): string {
  return str.replace(/\D/g, "").substring(0, 10);
}

/** Replication of formatFolioAmount from adapterUtils.ts line 65 */
function formatFolioAmount(num: string | number): number {
  if (!isNaN(+num)) {
    return Math.round(+num * 100);
  }
  throw new Error("Invalid number format");
}

// Enum values from folioOutModels.ts
const FolioTypeCode = {
  CHARGE: "CHARGE", CREDIT: "CREDIT", TRANSFER: "TRANSFER",
  ADJUSTMENT: "ADJUSTMENT", CORRECTION: "CORRECTION",
  PAYMENT: "PAYMENT", REFUND: "REFUND", GROUP: "GROUP",
} as const;
const TransTypes = { NEW: "NEW", SET: "SET", ADJ: "ADJ", PKG: "PKG" } as const;

// --- Replicated from FolioOutHandler (private static) since they can't be imported directly ---

/** Replication of FolioOutHandler.getTransactionType (private static, folioOutHandler.ts line ~924) */
function getTransactionType(
  folioType: string,
  type: string | undefined,
  originalFolioLineType: string | undefined
): string {
  if (
    folioType === FolioTypeCode.TRANSFER &&
    (type === FolioTypeCode.PAYMENT || originalFolioLineType === FolioTypeCode.PAYMENT)
  ) {
    return TransTypes.SET;
  }
  const transTypes: { [key: string]: string[] } = {
    NEW: [FolioTypeCode.CHARGE, FolioTypeCode.CREDIT, FolioTypeCode.TRANSFER, FolioTypeCode.ADJUSTMENT, FolioTypeCode.CORRECTION],
    SET: [FolioTypeCode.PAYMENT, FolioTypeCode.REFUND],
  };
  return Object.keys(transTypes).find((key) => transTypes[key].includes(folioType)) ?? "";
}

/** Replication of FolioOutHandler.getFolioAmount (private static, folioOutHandler.ts line ~1156) */
function getFolioAmount(state: {
  folioType: string; orginalFolioType: string; originalFolioLineType?: string;
  transType?: string; isRouted?: boolean; isSettlementRouting?: boolean; arNumber?: string;
  ledgerTypeByTransactionId?: Map<string, string>;
}, transaction: {
  id: string; amount: string | number; quantity?: string | number;
  reverseTax?: boolean; reverseTaxTotalChargeAmount?: string | number; transferReferenceId?: string;
}): number {
  let baseAmount: number;
  const ledgerType = state.ledgerTypeByTransactionId?.get(transaction.id);
  const doesChildrenHavePayment = ledgerType === FolioTypeCode.PAYMENT;
  if (
    state.orginalFolioType === FolioTypeCode.PAYMENT ||
    (state.folioType === FolioTypeCode.TRANSFER && state.transType == TransTypes.SET) ||
    (state.isSettlementRouting && state.arNumber) ||
    doesChildrenHavePayment
  ) {
    baseAmount = Math.abs(+transaction.amount) * +(transaction.quantity ?? 1);
  } else if (state.orginalFolioType === FolioTypeCode.REFUND) {
    baseAmount = -Math.abs(+transaction.amount);
  } else {
    baseAmount = transaction.reverseTax
      ? +(transaction.reverseTaxTotalChargeAmount ?? 0)
      : +transaction.amount * +(transaction.quantity ?? 1);
  }
  if (state.orginalFolioType === FolioTypeCode.PAYMENT && state.isRouted) {
    baseAmount = -Number(transaction.amount);
  }
  if (
    state.folioType === FolioTypeCode.TRANSFER &&
    state.transType === TransTypes.SET &&
    transaction.transferReferenceId &&
    !state.arNumber
  ) {
    baseAmount = -Math.abs(baseAmount);
  }
  if (
    state.originalFolioLineType === FolioTypeCode.PAYMENT &&
    state.orginalFolioType === FolioTypeCode.TRANSFER &&
    state.transType == TransTypes.SET &&
    state.arNumber
  ) {
    baseAmount = +transaction.amount * +(transaction.quantity ?? 1);
    baseAmount = -baseAmount;
  }
  if (
    state.arNumber &&
    state.orginalFolioType === FolioTypeCode.TRANSFER &&
    state.originalFolioLineType === FolioTypeCode.CREDIT
  ) {
    baseAmount = -Math.abs(baseAmount);
  }
  return formatFolioAmount(baseAmount.toString());
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.RCA_PORT || 3999;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.resolve(__dirname, "../client")));

// ——— Startup: load source files, fragments, expand queries ———
console.log("[RCA Tool] Starting up...");
loadSourceFiles();
loadFragments();
expandQueries();
loadTenantList();
console.log("[RCA Tool] Startup complete.");

// ============================================================
// Phase 2: Comparison API
// ============================================================
app.post("/api/compare", upload.single("csv"), (req, res) => {
  try {
    let csvRows: any[] = [];
    
    // Check for CSV file upload
    if (req.file) {
      const parsed = parseCsvBuffer(req.file.buffer, req.file.originalname);
      if (parsed.errors.length) {
        return res.status(400).json({ error: parsed.errors.join("; ") });
      }
      csvRows = parsed.rows;
    } 
    // Check for csvData in JSON body (when sent as application/json)
    else if (req.body && req.body.csvData) {
      csvRows = req.body.csvData;
      if (!Array.isArray(csvRows)) {
        return res.status(400).json({ error: "csvData must be an array" });
      }
    }
    // Check for csvData in parsed JSON body
    else if (req.body && typeof req.body === "string") {
      try {
        const parsed = JSON.parse(req.body);
        if (parsed.csvData && Array.isArray(parsed.csvData)) {
          csvRows = parsed.csvData;
        } else {
          return res.status(400).json({ error: "No CSV data provided" });
        }
      } catch {
        return res.status(400).json({ error: "No CSV data provided" });
      }
    }
    else {
      return res.status(400).json({ error: "No CSV data provided" });
    }

    let folioTransactions = req.body.folioTransactions;
    if (typeof folioTransactions === "string") {
      try { folioTransactions = JSON.parse(folioTransactions); } catch { return res.status(400).json({ error: "Invalid folioTransactions JSON" }); }
    }
    if (!folioTransactions) {
      return res.status(400).json({ error: "No folioTransactions provided" });
    }

    const result = compareTransactions(csvRows, folioTransactions);

    // Auto-correction inline — flatten transactions and correct
    const { transactions: allTransactions } = flattenTransactions(folioTransactions);
    const correction = correctPayload(allTransactions, csvRows, folioTransactions);

    res.json({ ...result, correction });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Phase 3: Resend Query Generation
// ============================================================
app.post("/api/resend-query", (req, res) => {
  try {
    const { accountType, confirmationNumber, folioNumber, houseAccountNumber, propertyId } = req.body;
    if (!accountType) return res.status(400).json({ error: "accountType required" });

    const query = getExpandedQuery(accountType);
    const variables = buildVariablesTemplate(accountType, { confirmationNumber, folioNumber, houseAccountNumber, propertyId });

    res.json({ query, variables });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Phase 4: Payload Construction
// ============================================================
app.post("/api/construct-payload", (req, res) => {
  try {
    const { graphResponse, accountType } = req.body;
    if (!graphResponse || !accountType) {
      return res.status(400).json({ error: "graphResponse and accountType required" });
    }

    const { survivingTransactions, trace, emptyFolios } = simulateTransformOut(graphResponse, accountType);

    // Simulate FolioOutHandler.transform() for each surviving transaction
    const payload = survivingTransactions.map((tx: any) => simulateFolioOutTransform(tx));

    res.json({ payload, codePathTrace: trace, emptyFolios });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Phase 5: LLM Analysis
// ============================================================
app.get("/api/llm-status", async (_req, res) => {
  const available = await isOllamaAvailable();
  res.json({ available });
});

app.post("/api/llm-analyze", async (req, res) => {
  try {
    const { transactionData, codePathTrace, model } = req.body;
    const explanation = await analyzeWithLlm(transactionData, codePathTrace, model);
    res.json({ explanation });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Phase 6: Auto-Correction
// ============================================================
app.post("/api/correct-payload", (req, res) => {
  try {
    const { folioTransactions, csvData } = req.body;
    if (!folioTransactions || !csvData) {
      return res.status(400).json({ error: "folioTransactions and csvData required" });
    }

    // Flatten transactions from folios
    const allTransactions: any[] = [];
    for (const folio of folioTransactions) {
      allTransactions.push(...(folio.folioTransactionDetails || []));
    }

    const result = correctPayload(allTransactions, csvData);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Phase 7: Rules API
// ============================================================
app.get("/api/rules", (_req, res) => {
  res.json({ rules: getRules() });
});

app.put("/api/rules", (req, res) => {
  try {
    const { rules } = req.body;
    if (typeof rules !== "string") return res.status(400).json({ error: "rules must be a string" });
    saveRules(rules);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/apply-rules", (req, res) => {
  try {
    const { transaction } = req.body;
    const result = applyUserRules(transaction);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/built-in-rules", (_req, res) => {
  res.json({ rules: getBuiltInRulesDescription() });
});

// ============================================================
// Mongo Query Generator (auto-extract from folioTransactions)
// ============================================================
app.post("/api/generate-mongo-query", (req, res) => {
  try {
    const { folioTransactions, accountId } = req.body;
    if (!folioTransactions) {
      return res.status(400).json({ error: "folioTransactions required" });
    }

    const result = autoGenerateQueries(folioTransactions);

    // If accountId provided, generate the final query with it filled in
    let finalQuery = result.mongoAggregationQuery;
    if (accountId) {
      const tenantId = result.tenant?.tenantId || "<TENANT_ID>";
      const propertyId = result.tenant?.propertyId || "<PROPERTY_ID>";
      const { queryString } = generateMongoQuery(tenantId, propertyId, accountId);
      finalQuery = queryString;
    }

    res.json({
      propertyCode: result.propertyCode,
      chargePostingSequenceNumber: result.chargePostingSequenceNumber,
      tenant: result.tenant,
      folioNumber: result.folioNumber,
      accountLookupQuery: result.accountLookupQuery,
      mongoAggregationQuery: finalQuery,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Verify Account Information (NEW - Initial Modal Check)
// ============================================================
// Extracts and verifies account info from folioTransactions without executing query
app.post("/api/verify-account", async (req, res) => {
  // Hard request timeout — 55s (5s buffer over the 50s mongo timeout)
  const reqTimeout = setTimeout(() => {
    if (!res.headersSent) res.status(504).json({ error: "verify-account timed out after 55s — MongoDB may be unreachable or OIDC auth is pending" });
  }, 55_000);

  try {
    const { folioTransactions } = req.body;

    if (!folioTransactions) return res.status(400).json({ error: "folioTransactions is missing" });
    if (!Array.isArray(folioTransactions)) return res.status(400).json({ error: "folioTransactions must be an array" });
    if (folioTransactions.length === 0) return res.status(400).json({ error: "folioTransactions array is empty" });

    // Extract property info from folios (envConfig overrides tenantId/propertyId when mode=other)
    const result = autoGenerateQueries(folioTransactions);
    const { tenantId, propertyId } = resolveTenant({ tenantId: result.tenant?.tenantId, propertyId: result.tenant?.propertyId });
    const chargePostingSeq = parseInt(result.chargePostingSequenceNumber, 10);

    console.log(`[verify-account] propertyCode=${result.propertyCode} chargePostingSeq=${chargePostingSeq} tenantId=${tenantId} env=${envConfig.mode}`);

    if (!tenantId || !propertyId) {
      return res.status(400).json({
        error: envConfig.mode === "other"
          ? `Custom environment: tenantId/propertyId not set. Please apply your environment first.`
          : `Property "${result.propertyCode}" not found in tenantList.xlsx`,
        propertyCode: result.propertyCode,
      });
    }

    const account = await findAccountId(tenantId, chargePostingSeq);
    if (!account) {
      return res.status(404).json({
        error: `Account not found for tenantId=${tenantId}, chargePostingSequenceNumber=${chargePostingSeq}`,
      });
    }

    console.log(`[verify-account] found accountId=${account.accountId} accountType=${account.accountType}`);
    res.json({
      propertyCode: result.propertyCode,
      chargePostingSequenceNumber: result.chargePostingSequenceNumber,
      folioNumber: result.folioNumber,
      tenantId,
      propertyId,
      accountId: account.accountId,
      accountType: account.accountType,
    });
  } catch (err: any) {
    console.error(`[verify-account] error:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    clearTimeout(reqTimeout);
  }
});

// Execute the mongo query directly against the DB and return CSV-equivalent data
app.post("/api/execute-mongo-query", async (req, res) => {
  // Hard request timeout — 55s
  const reqTimeout = setTimeout(() => {
    if (!res.headersSent) res.status(504).json({ error: "execute-mongo-query timed out after 55s — query may be too broad or MongoDB is unreachable" });
  }, 55_000);

  try {
    const { folioTransactions, customQuery } = req.body;
    
    // Better error validation
    if (!folioTransactions) {
      return res.status(400).json({ 
        error: "folioTransactions is missing",
        received: typeof folioTransactions,
        hint: "Please paste a valid folio transactions JSON array in the Inputs tab"
      });
    }
    
    if (!Array.isArray(folioTransactions)) {
      return res.status(400).json({ 
        error: "folioTransactions must be an array",
        received: typeof folioTransactions,
        hint: "Ensure your JSON starts with [ and ends with ]"
      });
    }
    
    if (folioTransactions.length === 0) {
      return res.status(400).json({ 
        error: "folioTransactions array is empty",
        hint: "Paste at least one folio transaction object"
      });
    }

    const result = autoGenerateQueries(folioTransactions);
    const { tenantId, propertyId } = resolveTenant({ tenantId: result.tenant?.tenantId, propertyId: result.tenant?.propertyId });
    const chargePostingSeq = parseInt(result.chargePostingSequenceNumber, 10);

    if (!tenantId || !propertyId) {
      return res.status(400).json({
        error: envConfig.mode === "other"
          ? `Custom environment: tenantId/propertyId not set. Please apply your environment first.`
          : `Property "${result.propertyCode}" not found in tenantList.xlsx. Cannot auto-execute.`,
        propertyCode: result.propertyCode,
      });
    }

    // Step 1: Find accountId
    const account = await findAccountId(tenantId, chargePostingSeq);
    if (!account) {
      return res.status(404).json({
        error: `Account not found for tenantId=${tenantId}, chargePostingSequenceNumber=${chargePostingSeq}`,
      });
    }

    // Step 2: Execute ledger aggregation
    // If customQuery provided, parse and use it; otherwise use default
    let rows: any[] = [];
    if (customQuery && typeof customQuery === 'string') {
      // User provided a custom/edited query - try to execute it
      try {
        // The customQuery is a MongoDB aggregation pipeline string
        // For safety, we'll still validate and use the account-based query
        // but in production you'd parse the custom query and execute it
        console.log("[RCA] Custom query provided, using default safe aggregation instead");
        rows = await executeLedgerQuery(tenantId, propertyId, account.accountId);
      } catch (e: any) {
        console.error("[RCA] Custom query execution failed, fallback:", e.message);
        rows = await executeLedgerQuery(tenantId, propertyId, account.accountId);
      }
    } else {
      rows = await executeLedgerQuery(tenantId, propertyId, account.accountId);
    }

    // Normalize rows to match CSV format the comparison engine expects
    const csvRows = rows.map((r: any) => {
      const transIdStr = r.transactionId ? String(r.transactionId) : "";
      // lineItemNo: use generateRandomNumbers from adapterUtils (same as FolioOutHandler)
      const lineItemNo = transIdStr ? generateRandomNumbers(transIdStr) : "";
      return {
        ...r,
        lineItemNo,
        totalAmount: typeof r.totalAmount === "object" && r.totalAmount !== null
          ? Number(r.totalAmount) : Number(r.totalAmount ?? 0),
      };
    });

    res.json({
      rows: csvRows,
      rowCount: csvRows.length,
      accountId: account.accountId,
      accountType: account.accountType,
      tenantId,
      propertyId,
      propertyCode: result.propertyCode,
      chargePostingSequenceNumber: result.chargePostingSequenceNumber,
      mongoQuery: generateMongoQuery(tenantId, propertyId, account.accountId).queryString,
    });
  } catch (err: any) {
    console.error(`[execute-mongo-query] error:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    clearTimeout(reqTimeout);
  }
});

// ============================================================
// Transfer Reference Query — fetches the "other side" of transfers
// Uses buildTransferMongoQuery logic from findMissingLines-Complete.js
// ============================================================
app.post("/api/execute-transfer-query", async (req, res) => {
  const reqTimeout = setTimeout(() => {
    if (!res.headersSent) res.status(504).json({ error: "execute-transfer-query timed out after 55s" });
  }, 55_000);

  try {
    const { folioLineIds, tenantId, propertyId } = req.body;

    if (!folioLineIds || !Array.isArray(folioLineIds) || folioLineIds.length === 0) {
      return res.status(400).json({ error: "folioLineIds must be a non-empty array" });
    }
    if (!tenantId || !propertyId) {
      return res.status(400).json({ error: "tenantId and propertyId are required" });
    }

    console.log(`[execute-transfer-query] tenantId=${tenantId} propertyId=${propertyId} ids=${folioLineIds.length}`);

    const rows = await executeTransferQuery(tenantId, propertyId, folioLineIds);

    console.log(`[execute-transfer-query] returned ${rows.length} rows`);
    res.json({ rows, rowCount: rows.length });
  } catch (err: any) {
    console.error(`[execute-transfer-query] error:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    clearTimeout(reqTimeout);
  }
});

// ============================================================
// Resolve Missing Transactions
// ============================================================
app.post("/api/resolve-missing", (req, res) => {
  try {
    const { graphResponse, accountType, folioTransactions, missingLineItemNos, csvRows } = req.body;
    if (!graphResponse || !accountType || !folioTransactions) {
      return res.status(400).json({ error: "graphResponse, accountType, and folioTransactions required" });
    }

    // generateRandomNumbers: same as adapterUtils.ts — strips non-digits, first 10 chars
    // Use generateRandomNumbers from adapterUtils (same as FolioOutHandler line 959)
    const genLineItemNo = (id: string): string => generateRandomNumbers(id || "");

    // Deep-extract ALL ledger transactions from every possible graph response structure
    const allGraphTransactions: any[] = [];
    const addedIds = new Set<string>();

    const addTx = (tx: any) => {
      if (tx?.id && !addedIds.has(tx.id)) {
        allGraphTransactions.push(tx);
        addedIds.add(tx.id);
      }
    };

    const extractFromFolios = (folios: any[]) => {
      if (!Array.isArray(folios)) return;
      for (const folio of folios) {
        const txns = folio?.allLedgerTransactions || folio?.ledgerTransactions || [];
        if (!Array.isArray(txns)) continue;
        for (const txn of txns) {
          addTx(txn);
          if (Array.isArray(txn?.childTransactions)) {
            for (const child of txn.childTransactions) {
              addTx(child);
            }
          }
        }
      }
    };

    const extractFromRoot = (root: any) => {
      if (!root) return;
      try {
        // Guest
        const resArr = root.reservations?.manyByThirdPartyConfirmation;
        if (resArr) {
          const list = Array.isArray(resArr) ? resArr : [resArr];
          for (const r of list) {
            extractFromFolios(r?.account?.folios || r?.folios || []);
          }
        }
        // Group
        const g = root.groups?.oneByThirdPartyConfirmation;
        if (g) {
          extractFromFolios(g?.account?.folios || g?.folios || []);
        }
        // House Account
        const haArr = root.houseAccounts?.manyByNumber;
        if (haArr) {
          const list = Array.isArray(haArr) ? haArr : [haArr];
          for (const ha of list) {
            extractFromFolios(ha?.folios || []);
          }
        }
      } catch (e) {
        // Ignore extraction errors, continue with what we have
      }
    };

    // Try direct response
    extractFromRoot(graphResponse);
    // Try under .data wrapper (common in raw GraphQL responses)
    if (graphResponse.data) {
      extractFromRoot(graphResponse.data);
    }

    // Fallback: recursively search for any object with "allLedgerTransactions" or "id" + "type" pattern
    if (allGraphTransactions.length === 0) {
      const deepSearch = (obj: any, depth: number) => {
        if (!obj || depth > 10 || typeof obj !== "object") return;
        if (Array.isArray(obj)) {
          for (const item of obj) deepSearch(item, depth + 1);
          return;
        }
        // If this object has id + type, it could be a ledger transaction
        if (obj.id && obj.type && (obj.transactionDetails || obj.childTransactions || obj.amount !== undefined)) {
          addTx(obj);
        }
        // If this object has allLedgerTransactions, extract them
        if (Array.isArray(obj.allLedgerTransactions)) {
          for (const txn of obj.allLedgerTransactions) {
            addTx(txn);
            if (Array.isArray(txn?.childTransactions)) {
              for (const child of txn.childTransactions) addTx(child);
            }
          }
        }
        if (Array.isArray(obj.ledgerTransactions)) {
          for (const txn of obj.ledgerTransactions) {
            addTx(txn);
          }
        }
        // Recurse into all values
        for (const val of Object.values(obj)) {
          deepSearch(val, depth + 1);
        }
      };
      deepSearch(graphResponse, 0);
    }

    // Debug: capture graph response structure
    const debugKeys = (obj: any, prefix: string, depth: number): string[] => {
      if (!obj || typeof obj !== "object" || depth > 3) return [];
      const keys: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        keys.push(`${path} (${Array.isArray(v) ? "array[" + (v as any[]).length + "]" : typeof v})`);
        if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          keys.push(...debugKeys(v, path, depth + 1));
        } else if (Array.isArray(v) && (v as any[]).length > 0) {
          keys.push(...debugKeys((v as any[])[0], `${path}[0]`, depth + 1));
        }
      }
      return keys;
    };
    const graphStructure = debugKeys(graphResponse, "", 0);

    // Build lineItemNo map from graph transactions
    // lineItemNo = generateRandomNumbers(transactionDetail.id) — from folioOutHandler.ts line 947
    // So we need to look at transactionDetails[].id AND childTransactions[].transactionDetails[].id
    const allLineItemNos: string[] = [];
    const graphTxByLineItemNo = new Map<string, any>();

    const indexTxDetails = (tx: any) => {
      // Index by top-level transaction id
      const topLin = genLineItemNo(tx.id);
      if (topLin) {
        allLineItemNos.push(topLin);
        graphTxByLineItemNo.set(topLin, tx);
      }

      // Index by transactionDetails[].id (this is what folioOutHandler uses for lineItemNo)
      if (Array.isArray(tx.transactionDetails)) {
        for (const detail of tx.transactionDetails) {
          if (detail?.id) {
            const detailLin = genLineItemNo(detail.id);
            if (detailLin) {
              allLineItemNos.push(detailLin);
              graphTxByLineItemNo.set(detailLin, { ...tx, _matchedDetail: detail });
            }
          }
        }
      }

      // Index by childTransactions[].transactionDetails[].id
      if (Array.isArray(tx.childTransactions)) {
        for (const child of tx.childTransactions) {
          if (child?.id) {
            const childLin = genLineItemNo(child.id);
            if (childLin) {
              allLineItemNos.push(childLin);
              graphTxByLineItemNo.set(childLin, { ...tx, _matchedChild: child });
            }
          }
          if (Array.isArray(child?.transactionDetails)) {
            for (const detail of child.transactionDetails) {
              if (detail?.id) {
                const detailLin = genLineItemNo(detail.id);
                if (detailLin) {
                  allLineItemNos.push(detailLin);
                  graphTxByLineItemNo.set(detailLin, { ...tx, _matchedDetail: detail, _matchedChild: child });
                }
              }
            }
          }
        }
      }
    };

    for (const tx of allGraphTransactions) {
      indexTxDetails(tx);
    }

    // Missing set
    const missingSet = new Set((missingLineItemNos || []).map((n: string) => String(n).padStart(10, "0")));

    // CSV lookup
    const csvByLineItemNo = new Map<string, any>();
    if (csvRows) {
      for (const row of csvRows) {
        csvByLineItemNo.set(String(row.lineItemNo).padStart(10, "0"), row);
      }
    }

    // Build resolved transaction details using existing payload entry as template
    const resolvedDetails: any[] = [];
    // Find a good template from existing transactions
    const templateTxn = folioTransactions[0]?.folioTransactionDetails?.[0];
    const folioId = folioTransactions[0]?.folioId || "";
    const folioMeta = {
      folioType: folioTransactions[0]?.folioType,
      confirmationIds: folioTransactions[0]?.confirmationIds || [],
      resState: folioTransactions[0]?.resState || "",
      resCloseDate: folioTransactions[0]?.resCloseDate || "",
      propertyCode: templateTxn?.propertyCode || folioId.split("_")[0] || "",
      ...(folioTransactions[0]?.groupCode != null ? { groupCode: folioTransactions[0].groupCode } : {}),
      ...(folioTransactions[0]?.groupCreateTS != null ? { groupCreateTS: folioTransactions[0].groupCreateTS } : {}),
    };

    for (const missingLin of missingSet) {
      const graphTx = graphTxByLineItemNo.get(missingLin as string);
      if (!graphTx) continue;

      const csvRow = csvByLineItemNo.get(missingLin as string);
      const ledgerType = csvRow?.type || graphTx.type || "";
      const originalLineType = csvRow?.originalType || graphTx.lineType || graphTx.originalFolioLineType || "";
      const childType = graphTx.childTransactions?.[0]?.type;

      // Use shared getTransactionType from folioTransformUtils (same as FolioOutHandler)
      const transType = getTransactionType(ledgerType, childType, originalLineType);

      // Build state and transaction objects matching the shared getFolioAmount interface
      const details = graphTx.transactionDetails || [];
      let rawAmount: number;
      if (csvRow) {
        rawAmount = Number(csvRow.totalAmount || 0);
      } else {
        rawAmount = details.reduce((s: number, d: any) => s + Number(d.amount || 0), 0);
      }

      // Derive arNumber from graph response (same as FolioOutHandler line ~594)
      // account.type === "COMPANY" → arNumber = account.number
      const accountType = details[0]?.account?.type || graphTx._matchedDetail?.account?.type || graphTx.account?.type || "";
      const arNumber = accountType === "COMPANY" ? (details[0]?.account?.number || graphTx._matchedDetail?.account?.number || graphTx.account?.number || "") : "";
      const isRouted = graphTx.isRouted ?? details.some((d: any) => d.isRouted) ?? false;
      const isSettlementType = ledgerType === "PAYMENT" || ledgerType === "CHARGE" || ledgerType === "CREDIT";
      const isSettlementRouting = isSettlementType && isRouted;

      // Use replicated getFolioAmount (same as FolioOutHandler)
      const amountState = {
        folioType: ledgerType,
        orginalFolioType: ledgerType,
        originalFolioLineType: originalLineType,
        transType,
        isRouted,
        isSettlementRouting,
        arNumber,
      };
      const amountTx = {
        id: details[0]?.id || graphTx.id,
        amount: String(rawAmount),
        quantity: details[0]?.quantity ?? "1",
        reverseTax: details[0]?.reverseTax ?? false,
        reverseTaxTotalChargeAmount: details[0]?.reverseTaxTotalChargeAmount,
        transferReferenceId: details[0]?.transferReferenceId,
      };
      const amountValue = getFolioAmount(amountState, amountTx);

      // transferFlag: exact logic from FolioOutHandler line ~993-995
      const isTransfer = ledgerType === "TRANSFER" && transType === "NEW" && !isRouted;
      const transferFlag = isTransfer || (isSettlementType && transType === "SET" && !arNumber);

      // Deep clone template and override with graph-derived values
      const entry = templateTxn ? JSON.parse(JSON.stringify(templateTxn)) : {};

      // Get the matched transactionDetail from graph for field extraction
      const detail = graphTx._matchedDetail || details[0] || {};
      const childTx = graphTx._matchedChild || graphTx.childTransactions?.[0] || {};

      // --- Fields derived from graph response (accurate) ---
      entry.folioId = folioId;
      entry.folioIdLineItemNo = `${folioId}_${missingLin}`;
      entry.lineItemNo = missingLin;
      entry.transType = transType;
      entry.transDesc = csvRow?.description || graphTx.description || detail.description || "";

      // chargeCode from graph: accountingItem.code || transferItem.code || paymentMethod.code
      // (FolioOutHandler.fetchChargeCode line ~1129)
      const chargeItem = detail.accountingItem || detail.transferItem || detail.paymentMethod;
      if (chargeItem?.code) {
        entry.chargeCode = (chargeItem.code === "BLTRSF" || chargeItem.code === "ALLOWANCE")
          ? chargeItem.code.substring(0, 5) : chargeItem.code;
      }

      // transactionTS from graph: postedPropertyDate (FolioOutHandler line ~977)
      if (graphTx.postedPropertyDate) entry.transactionTS = graphTx.postedPropertyDate;
      // businessTS from graph: postedDateTime (FolioOutHandler line ~982)
      if (graphTx.postedDateTime) entry.businessTS = graphTx.postedDateTime;

      // transactionAmt — graph derived via replicated getFolioAmount
      const guestViewable = accountType !== "HOUSE" && !["COMPANY_DIRECT_BILL", "COMPANY_AR"].includes(detail.folio?.type || "");
      entry.transactionAmt = {
        currencyCode: entry.transactionAmt?.currencyCode || "USD",
        value: amountValue,
        guestViewable,
        numberOfDecimals: entry.transactionAmt?.numberOfDecimals || 2,
      };

      // revenueType from graph: subcategory/category on accountingItem/transferItem/paymentMethod
      // (FolioOutHandler.addRevenueType line ~1207)
      const revenue = detail.transferItem || detail.accountingItem || detail.paymentMethod;
      if (revenue?.subcategory?.code && revenue?.category?.code) {
        entry.revenueType = {
          revenueTypeCode: revenue.subcategory.code,
          revenueTypeCodeDesc: revenue.subcategory.name || "",
          revenueTypeCodeParent: revenue.category.code,
        };
      } else if (chargeItem?.code === "BLTRSF") {
        entry.revenueType = { revenueTypeCode: "94444", revenueTypeCodeDesc: "Balance Transfer", revenueTypeCodeParent: "94444" };
      } else if (chargeItem?.code === "ALLOWANCE") {
        entry.revenueType = { revenueTypeCode: "94445", revenueTypeCodeDesc: "Allowance", revenueTypeCodeParent: "94445" };
      }

      // postedBy from graph: transaction.postedBy (FolioOutHandler line ~1003)
      if (detail.postedBy?.username) {
        entry.postedBy = {
          agentId: detail.postedBy.username,
          lastName: detail.postedBy.lastName ?? detail.postedBy.username,
        };
      } else if (graphTx.postedBy?.username) {
        entry.postedBy = {
          agentId: graphTx.postedBy.username,
          lastName: graphTx.postedBy.lastName ?? graphTx.postedBy.username,
        };
      }

      // roomNumber from graph: reservation.allocation.roomDailyAllocations (FolioOutHandler line ~961)
      const roomNum = detail.reservation?.allocation?.roomDailyAllocations?.[0]?.currentRoomAllocation?.room?.number;
      if (roomNum) entry.roomNumber = roomNum;
      else delete entry.roomNumber;  // don't inherit template's room

      // --- Fields from template/meta (shared across folio) ---
      entry.propertyCode = folioMeta.propertyCode;
      entry.folioType = folioMeta.folioType;
      entry.confirmationIds = folioMeta.confirmationIds;
      entry.resState = folioMeta.resState;
      if (folioMeta.resCloseDate) entry.resCloseDate = folioMeta.resCloseDate;
      if (folioMeta.groupCode != null) entry.groupCode = folioMeta.groupCode;
      if (folioMeta.groupCreateTS != null) entry.groupCreateTS = folioMeta.groupCreateTS;

      // --- Flags derived from graph ---
      // taxInclusive: only for non-PAYMENT/REFUND (FolioOutHandler line ~1031)
      if (ledgerType !== "PAYMENT" && ledgerType !== "REFUND") {
        entry.taxInclusive = detail.reverseTax ?? false;
      } else {
        delete entry.taxInclusive;
      }
      const isPOS = !!(detail.checkNumber || graphTx.checkNumber);
      entry.summarizeFlag = isPOS;
      entry.posFlag = isPOS;
      if (isPOS) entry.posChkRefNo = detail.checkNumber || graphTx.checkNumber;
      entry.suppressionFlag = !guestViewable;
      entry.transferFlag = transferFlag;
      entry.banquetChkFlag = false;

      // transPostingNotes from graph (FolioOutHandler.setTransPostingNotes line ~1142)
      if ((ledgerType === "REFUND" || ledgerType === "TRANSFER" || ledgerType === "CHARGE") && detail.reason) {
        entry.transPostingNotes = detail.reason;
      } else if (detail.commentReferenceDetail?.comment) {
        entry.transPostingNotes = detail.commentReferenceDetail.comment;
      } else {
        delete entry.transPostingNotes;
      }

      // referenceNumber (FolioOutHandler line ~317-318)
      const refNum = detail.commentReferenceDetail?.referenceNumber?.slice(-16);
      if (refNum) entry.transRefNo = refNum;
      else delete entry.transRefNo;

      // folioTransferDetails: exact condition from FolioOutHandler line ~1050-1058
      // Also excluded if the ledger line is tax-exempt (taxExemptDetail.taxExempted === true)
      const isTaxExempted = csvRow?.taxExempted === true;
      const needsTransferDetails =
        !isTaxExempted && (
          (ledgerType === "TRANSFER" && transType !== "SET") ||
          (ledgerType === "CREDIT" && detail.sourceFolioLineItemId) ||
          (isSettlementRouting && transType === "SET" && !arNumber) ||
          ledgerType === "ADJUSTMENT" ||
          (ledgerType === "CORRECTION" && detail.correctionReferenceId && rawAmount < 0)
        );
      if (!needsTransferDetails) {
        delete entry.folioTransferDetails;
      }

      // folioTransPaymentDetails: only for SET (PAYMENT/REFUND/TRANSFER+SET) (FolioOutHandler line ~1081-1095)
      if (!(ledgerType === "PAYMENT" || (ledgerType === "TRANSFER" && transType === "SET") ||
            ledgerType === "REFUND" || (isSettlementRouting && arNumber))) {
        delete entry.folioTransPaymentDetails;
      }

      // transLinkId for GROUP transactions (FolioOutHandler line ~1068-1077)
      if (graphTx.type === "GROUP" || graphTx._matchedChild) {
        entry.transLinkId = generateRandomNumbers(graphTx.id);
      } else if (ledgerType !== "GROUP" && !graphTx.parentId) {
        delete entry.transLinkId;
      }

      resolvedDetails.push(entry);
    }

    // Merge into original payload
    const mergedPayload = JSON.parse(JSON.stringify(folioTransactions));
    if (resolvedDetails.length > 0 && mergedPayload.length > 0) {
      mergedPayload[0].folioTransactionDetails = [
        ...(mergedPayload[0].folioTransactionDetails || []),
        ...resolvedDetails,
      ];
    }

    // Re-run correction
    let correction: ReturnType<typeof correctPayload> | null = null;
    if (csvRows) {
      const allTxns: any[] = [];
      for (const folio of mergedPayload) {
        allTxns.push(...(folio.folioTransactionDetails || []));
      }
      correction = correctPayload(allTxns, csvRows, mergedPayload);
    }

    // Fields that may be inaccurate — only fields that truly can't be derived from graph response
    const mockWarnings = [
      {
        field: "transactionTS / businessTS",
        reason: "Uses raw postedPropertyDate/postedDateTime from graph. The real handler formats these with property timezone " +
          "via formatDateTimeByType. If graph response has these fields, values are close but timezone formatting may differ.",
        source: "FolioOutHandler.addFolioTransactionDetails (line ~977-982)"
      },
      {
        field: "folioTransPaymentDetails",
        reason: "Kept from template if present for SET transactions. The real handler constructs payment details " +
          "(pmtInstType, cardAcctNo, expireDate, paymentAmt) from paymentSettings and may make additional graph queries for payment instruments.",
        source: "FolioOutHandler.folioTransPaymentDetails (line ~1230)"
      },
      {
        field: "folioTransferDetails",
        reason: "Kept from template if present. The real handler builds transfer details " +
          "with source/destination folio IDs, confirmation IDs, and line item references specific to each transaction.",
        source: "FolioOutHandler.folioTransferDetails (line ~1490)"
      },
      {
        field: "confirmationIds",
        reason: "Copied from existing payload. The real handler generates them from transaction.reservation.thirdPartyConfirmations " +
          "and account type. Should be correct if all transactions in the folio share the same reservation.",
        source: "FolioOutHandler.generateConfirmationIds (line ~745)"
      },
      {
        field: "windowProfileId / folioWindowId",
        reason: "Not set by the RCA tool (inherited from template). The real handler computes them from account type, profile ID, and payment settings.",
        source: "FolioOutHandler.generateWindowProfileId (line ~880)"
      },
    ];

    res.json({
      resolvedCount: resolvedDetails.length,
      resolvedTransactions: resolvedDetails,
      totalGraphTransactions: allGraphTransactions.length,
      allConstructedLineItemNos: allLineItemNos,
      missingLineItemNos: Array.from(missingSet),
      mergedPayload: correction ? correction.correctedPayload : mergedPayload,
      correction,
      graphStructure,
      mockWarnings,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Deep Reference Analysis (Transfer, Tax Reference, Reference ID Chain)
// Extra logic from findMissingLines-Complete.js — runs AFTER comparison
// ============================================================
app.post("/api/deep-reference-analysis", async (req, res) => {
  const reqTimeout = setTimeout(() => {
    if (!res.headersSent) res.status(504).json({ error: "deep-reference-analysis timed out after 5 minutes — too many sequential DB lookups; try a smaller dataset" });
  }, 300_000);

  try {
    const { folioTransactions, csvData } = req.body;
    if (!folioTransactions || !csvData) {
      return res.status(400).json({ error: "folioTransactions and csvData required" });
    }

    /** Extracts first 10 numeric characters from a string ID */
    const extractFirstTenDigits = (id: string): string | null => {
      if (!id) return null;
      const digits = String(id).replace(/\D/g, "");
      return digits.substring(0, 10) || null;
    };

    // Build lookup maps
    const csvByLineItemNo = new Map<string, any>();
    const csvByTransactionId = new Map<string, any>();
    for (const row of csvData) {
      const lin = String(row.lineItemNo).padStart(10, "0");
      csvByLineItemNo.set(lin, row);
      if (row.transactionId) csvByTransactionId.set(String(row.transactionId), row);
    }

    // Get tenantId/propertyId for optional DB calls when a referenced transaction is not in csvData
    let tenantId: string | undefined;
    let propertyId: string | undefined;
    try {
      const queryInfo = autoGenerateQueries(folioTransactions);
      const resolved = resolveTenant({ tenantId: queryInfo.tenant?.tenantId, propertyId: queryInfo.tenant?.propertyId });
      tenantId = resolved.tenantId;
      propertyId = resolved.propertyId;
    } catch { /* ignore — DB calls will be skipped if tenant info is unavailable */ }

    // Cache for rows fetched from DB (keyed by transactionId string)
    const dbFetchedRows = new Map<string, any>();

    /** Fetch rows from DB for the given transactionIds (skips already-known IDs). */
    const fetchFromDb = async (ids: string[]): Promise<void> => {
      if (!tenantId || !propertyId || !ids.length) return;
      const toFetch = ids.filter(id => !csvByTransactionId.has(id) && !dbFetchedRows.has(id));
      if (toFetch.length === 0) return;
      try {
        const rows = await executeTransferQuery(tenantId, propertyId, toFetch);
        for (const row of rows) {
          if (row.transactionId) dbFetchedRows.set(String(row.transactionId), row);
        }
      } catch (e: any) {
        console.warn("[deep-reference-analysis] DB fetch failed:", e.message);
      }
    };

    /** Look up a transaction by its ID from CSV data or DB cache. */
    const getRow = (transactionId: string): any =>
      csvByTransactionId.get(transactionId) || dbFetchedRows.get(transactionId);

    /** Return all rows from csvData + DB cache, deduplicated by transactionId. */
    const getAllRows = (): any[] => {
      const seen = new Set<string>();
      const rows: any[] = [];
      for (const row of [...(csvData as any[]), ...Array.from(dbFetchedRows.values())]) {
        const tid = String(row.transactionId);
        if (!seen.has(tid)) { seen.add(tid); rows.push(row); }
      }
      return rows;
    };

    const transferVerifications: any[] = [];
    const taxReferenceResults: any[] = [];
    const referenceIdResults: any[] = [];

    const REF_TYPES = [
      "adjustmentReferenceId",
      "refundReferenceId",
      // sourceFolioLineItemId is intentionally excluded: when transferDetails is present
      // and sourceFolioLineItemId is also present, trnsfrFromLineItemNo will not be sent —
      // this is expected behavior and should NOT be flagged as a mismatch.
      "correctionReferenceId",
      "transferReferenceId",
    ] as const;

    // ── Pre-fetch: batch-query the DB for any lineItemNos not present in csvData ──
    // lineItemNo IS the folioLines._id in this system (numeric string), so we can use
    // executeTransferQuery directly. One single query covers all missing lines.
    let preFetchedRowCount = 0;
    if (tenantId && propertyId) {
      const missingLineItemNos: string[] = [];
      for (const folio of (folioTransactions as any[])) {
        if (!Array.isArray(folio.folioTransactionDetails)) continue;
        for (const folioTran of folio.folioTransactionDetails) {
          if (!Array.isArray(folioTran.folioTransferDetails) || folioTran.folioTransferDetails.length === 0) continue;
          const lin = String(folioTran.lineItemNo).padStart(10, "0");
          if (!csvByLineItemNo.has(lin)) {
            missingLineItemNos.push(String(folioTran.lineItemNo));
          }
        }
      }
      if (missingLineItemNos.length > 0) {
        console.log(`[deep-reference-analysis] Pre-fetching ${missingLineItemNos.length} lineItemNo(s) not in csvData from DB`);
        try {
          const prefetchedRows = await executeTransferQuery(tenantId, propertyId, missingLineItemNos);
          for (const row of prefetchedRows) {
            if (!row.transactionId) continue;
            const transIdStr = String(row.transactionId);
            const rowLin = transIdStr.replace(/\D/g, "").substring(0, 10).padStart(10, "0");
            // Normalise totalAmount like the main execute-mongo-query endpoint does
            row.totalAmount = typeof row.totalAmount === "object" && row.totalAmount !== null
              ? Number(row.totalAmount) : Number(row.totalAmount ?? 0);
            row.lineItemNo = rowLin;
            csvByLineItemNo.set(rowLin, row);
            csvByTransactionId.set(transIdStr, row);
          }
          console.log(`[deep-reference-analysis] Pre-fetch returned ${prefetchedRows.length} row(s)`);
          preFetchedRowCount = prefetchedRows.length;
        } catch (e: any) {
          console.warn(`[deep-reference-analysis] Pre-fetch DB query failed: ${e.message}`);
        }
      }
    }

    for (const folio of (folioTransactions as any[])) {
      if (!Array.isArray(folio.folioTransactionDetails)) continue;
      for (const folioTran of folio.folioTransactionDetails) {
        if (!Array.isArray(folioTran.folioTransferDetails) || folioTran.folioTransferDetails.length === 0) continue;

        const lin = String(folioTran.lineItemNo).padStart(10, "0");
        const csvRow = csvByLineItemNo.get(lin);

        // ── build a step-by-step debug trace for this lineItemNo ──
        const debugSteps: string[] = [];
        debugSteps.push(`[1] Folio lineItemNo="${folioTran.lineItemNo}" → lookup key (padded)="${lin}"`);
        debugSteps.push(`[2] CSV rows loaded: ${csvByLineItemNo.size} | Looking for key "${lin}"`);

        if (!csvRow) {
          debugSteps.push(`[3] ❌ CSV row NOT found (also not found in pre-fetch DB query). Keys sample: [${[...csvByLineItemNo.keys()].slice(0, 5).join(", ")}]`);
          // Push one entry per transferDetail so the UI shows each existing trnsfrFromLineItemNo value
          for (const transferDetail of folioTran.folioTransferDetails) {
            const rawExisting = transferDetail.trnsfrFromLineItemNo;
            transferVerifications.push({
              lineItemNo: folioTran.lineItemNo,
              status: "csv_row_not_found",
              message: "Row not found in csvData or DB pre-fetch — trnsfrFromLineItemNo cannot be verified",
              existingTrnsfrFromLineItemNo: rawExisting != null ? String(rawExisting).trim() : null,
              correctTrnsfrFromLineItemNo: null,
              debugSteps,
            });
          }
          continue;
        }

        debugSteps.push(`[3] ✅ CSV row found. transactionId="${csvRow.transactionId}" type="${csvRow.type}" totalAmount=${csvRow.totalAmount}`);
        debugSteps.push(`[4] CSV row reference fields:`);
        for (const refType of REF_TYPES) {
          debugSteps.push(`    ${refType} = ${csvRow[refType] != null ? `"${csvRow[refType]}"` : "null/undefined"}`);
        }
        debugSteps.push(`    sourceFolioLineItemId = ${csvRow.sourceFolioLineItemId != null ? `"${csvRow.sourceFolioLineItemId}"` : "null/undefined"}`);
        debugSteps.push(`    taxReferenceId = ${csvRow.taxReferenceId != null ? `"${csvRow.taxReferenceId}"` : "null/undefined"}`);
        debugSteps.push(`    itemId = ${csvRow.itemId != null ? `"${csvRow.itemId}"` : "null/undefined"}`);
        debugSteps.push(`    taxExempted = ${csvRow.taxExempted != null ? String(csvRow.taxExempted) : "null/undefined"}`);

        // ── Tax-exempt check: if taxExempted === true, folioTransferDetails must NOT exist ──
        if (csvRow.taxExempted === true) {
          for (const transferDetail of folioTran.folioTransferDetails) {
            const rawExisting = transferDetail.trnsfrFromLineItemNo;
            transferVerifications.push({
              lineItemNo: folioTran.lineItemNo,
              status: "tax_exempt_violation",
              message: "Line is tax-exempt (taxExemptDetail.taxExempted=true) — folioTransferDetails should be removed entirely",
              existingTrnsfrFromLineItemNo: rawExisting != null ? String(rawExisting).trim() : null,
              correctTrnsfrFromLineItemNo: null,
              resolution: "Remove folioTransferDetails — tax-exempt lines do not qualify for transfer details",
              taxExempted: true,
              debugSteps: [
                ...debugSteps,
                `[5] ❌ TAX EXEMPT — folioTransferDetails present but must not exist when taxExemptDetail.taxExempted=true`,
              ],
            });
          }
          continue; // no further reference analysis needed for this line
        }

        for (const transferDetail of folioTran.folioTransferDetails) {
          const detailDebug = [...debugSteps];
          const rawExisting = transferDetail.trnsfrFromLineItemNo;
          const existingTrnsfrFrom = rawExisting != null ? String(rawExisting).trim() : null;

          detailDebug.push(`[5] Existing trnsfrFromLineItemNo (raw)=${JSON.stringify(rawExisting)} → normalised="${existingTrnsfrFrom}"`);
          detailDebug.push(`    trnsfrToFolioId="${transferDetail.trnsfrToFolioId || '-'}" trnsfrToLineItemNo="${transferDetail.trnsfrToLineItemNo || '-'}"`);

          // ── If trnsfrFromLineItemNo is absent, skip correction entirely ──
          // When sourceFolioLineItemId is present on the CSV row, trnsfrFromLineItemNo
          // will intentionally not be sent — this is expected behavior, not a mismatch.
          if (existingTrnsfrFrom === null) {
            detailDebug.push(`[5] ℹ️ trnsfrFromLineItemNo is absent — skipping correction (expected behavior)`);
            transferVerifications.push({
              lineItemNo: folioTran.lineItemNo,
              status: "not_applicable",
              message: "trnsfrFromLineItemNo is absent — no correction needed (expected behavior when sourceFolioLineItemId is present)",
              existingTrnsfrFromLineItemNo: null,
              correctTrnsfrFromLineItemNo: null,
              debugSteps: detailDebug,
            });
            continue;
          }
          let correctTrnsfrFromLineItemNo: string | null = null;
          let resolution = "";

          // ══════════════════════════════════════════════════════════════════════
          // Case A: CSV row has one of the 4 non-tax reference IDs
          //   → first 10 digits of that ID IS the correct trnsfrFromLineItemNo
          // ══════════════════════════════════════════════════════════════════════
          detailDebug.push(`[6] Case A — checking direct reference IDs (adjustmentReferenceId, refundReferenceId, correctionReferenceId, transferReferenceId):`);
          for (const refType of REF_TYPES) {
            const refId = csvRow[refType];
            if (!refId) {
              detailDebug.push(`    ${refType}: null/undefined → skip`);
              continue;
            }
            const rawStr = String(refId).trim();
            const computed = extractFirstTenDigits(rawStr);
            detailDebug.push(`    ${refType}: "${rawStr}" → first10digits="${computed}"`);
            referenceIdResults.push({
              lineItemNo: folioTran.lineItemNo,
              referenceType: refType,
              referenceId: refId,
              correctTrnsfrFromLineItemNo: computed,
            });
            if (computed && !correctTrnsfrFromLineItemNo) {
              // First non-null ref ID wins
              correctTrnsfrFromLineItemNo = computed;
              resolution = `${refType} → first10digits("${rawStr}") = "${computed}"`;
              detailDebug.push(`    ✅ correctTrnsfrFromLineItemNo = "${computed}" (via ${refType})`);
              // Don't break — still log all ref types for completeness
            }
          }

          // ══════════════════════════════════════════════════════════════════════
          // Case A1: CSV row has sourceFolioLineItemId (no other direct ref ID resolved).
          //   → first10digits(sourceFolioLineItemId) = correctTrnsfrFromLineItemNo
          // ══════════════════════════════════════════════════════════════════════
          if (!correctTrnsfrFromLineItemNo && csvRow.sourceFolioLineItemId) {
            const a1RawStr = String(csvRow.sourceFolioLineItemId).trim();
            const a1Computed = extractFirstTenDigits(a1RawStr);
            detailDebug.push(`[Case A1] sourceFolioLineItemId="${a1RawStr}" → first10digits="${a1Computed}"`);
            if (a1Computed) {
              correctTrnsfrFromLineItemNo = a1Computed;
              resolution = `sourceFolioLineItemId → first10digits("${a1RawStr}") = "${a1Computed}"`;
              detailDebug.push(`    ✅ correctTrnsfrFromLineItemNo = "${a1Computed}" (via sourceFolioLineItemId)`);
              referenceIdResults.push({
                lineItemNo: folioTran.lineItemNo,
                referenceType: "sourceFolioLineItemId",
                referenceId: a1RawStr,
                correctTrnsfrFromLineItemNo: a1Computed,
              });
            }
          }

          // ══════════════════════════════════════════════════════════════════════
          // Case A2: No direct ref IDs and no taxReferenceId on the CSV row.
          //   → Fetch the ledgerTransactions document that contains this folioLine
          //     and check if the FIRST folioLine of that document has a transferReferenceId.
          //   → If so, use first10digits(transferReferenceId) as correctTrnsfrFromLineItemNo.
          // ══════════════════════════════════════════════════════════════════════
          if (!correctTrnsfrFromLineItemNo && !csvRow.taxReferenceId && tenantId && propertyId && csvRow.transactionId) {
            detailDebug.push(`[Case A2] No direct refs / taxReferenceId — fetching all folioLines from document, matching by itemId for transferReferenceId`);
            try {
              const a2DocLines = await executeFolioLinesByDocumentQuery(tenantId, propertyId, String(csvRow.transactionId));
              if (a2DocLines.length > 0) {
                detailDebug.push(`[Case A2] Document folioLines count: ${a2DocLines.length}`);
                for (const dl of a2DocLines) {
                  detailDebug.push(`  transactionId="${dl.transactionId}" itemId="${dl.itemId ?? "null"}" sourceFolioLineItemId="${dl.sourceFolioLineItemId ?? "null"}" transferReferenceId="${dl.transferReferenceId ?? "null"}"`);
                }

                // ── Primary: find the folioLine that matches csvRow.itemId and has a sourceFolioLineItemId or transferReferenceId ──
                const a2ItemMatch = a2DocLines.find(
                  r => r.itemId === csvRow.itemId &&
                       String(r.transactionId) !== String(csvRow.transactionId) &&
                       (r.sourceFolioLineItemId || r.transferReferenceId)
                );

                if (a2ItemMatch) {
                  const a2RefField = a2ItemMatch.sourceFolioLineItemId ? "sourceFolioLineItemId" : "transferReferenceId";
                  const a2RefId = String(a2ItemMatch.sourceFolioLineItemId || a2ItemMatch.transferReferenceId).trim();
                  const a2Computed = extractFirstTenDigits(a2RefId);
                  if (a2Computed) {
                    correctTrnsfrFromLineItemNo = a2Computed;
                    resolution = `document folioLine itemId="${csvRow.itemId}" match → ${a2RefField}="${a2RefId}" → first10digits="${a2Computed}"`;
                    detailDebug.push(`[Case A2] ✅ itemId-matched folioLine: transactionId="${a2ItemMatch.transactionId}" ${a2RefField}="${a2RefId}" → correctTrnsfrFromLineItemNo="${a2Computed}"`);
                  }
                } else {
                  // ── Fallback: use the first folioLine's sourceFolioLineItemId / transferReferenceId ──
                  detailDebug.push(`[Case A2] No itemId-matched folioLine with sourceFolioLineItemId/transferReferenceId — falling back to first folioLine`);
                  const firstLine = a2DocLines[0];
                  const a2FbRefField = firstLine.sourceFolioLineItemId ? "sourceFolioLineItemId" : "transferReferenceId";
                  const a2FbRefRaw = firstLine.sourceFolioLineItemId || firstLine.transferReferenceId;
                  detailDebug.push(`[Case A2] First folioLine: transactionId="${firstLine.transactionId}" ${a2FbRefField}="${a2FbRefRaw ?? "null"}"`);
                  if (a2FbRefRaw) {
                    const a2RefId = String(a2FbRefRaw).trim();
                    const a2Computed = extractFirstTenDigits(a2RefId);
                    if (a2Computed) {
                      correctTrnsfrFromLineItemNo = a2Computed;
                      resolution = `document first folioLine ${a2FbRefField}="${a2RefId}" → first10digits="${a2Computed}"`;
                      detailDebug.push(`[Case A2] ✅ correctTrnsfrFromLineItemNo="${a2Computed}"`);
                    }
                  } else {
                    detailDebug.push(`[Case A2] First folioLine has no sourceFolioLineItemId or transferReferenceId`);
                  }
                }
              } else {
                detailDebug.push(`[Case A2] No folioLines found in document`);
              }
            } catch (e: any) {
              detailDebug.push(`[Case A2] DB fetch failed: ${e.message}`);
            }
          }

          // ══════════════════════════════════════════════════════════════════════
          // Case B: CSV row has taxReferenceId (no direct ref ID)
          //   1. Find parent transaction by taxReferenceId (CSV or DB)
          //   2. Check parent for any of the 5 ref IDs → call it parentRefId
          //   3. Group all rows where taxReferenceId === parentRefId
          //   4. Find the row whose itemId matches original csvRow.itemId
          //   5. first10digits(matchingRow.transactionId) = correctTrnsfrFromLineItemNo
          // ══════════════════════════════════════════════════════════════════════
          if (!correctTrnsfrFromLineItemNo && csvRow.taxReferenceId) {
            const taxRefId = String(csvRow.taxReferenceId).trim();
            detailDebug.push(`[7] Case B: taxReferenceId="${taxRefId}" — finding parent transaction`);

            // Step B1: Find parent transaction (from CSV or DB)
            let parentRow = getRow(taxRefId);
            if (!parentRow) {
              detailDebug.push(`    Parent not in CSV data — querying DB for transactionId="${taxRefId}"`);
              await fetchFromDb([taxRefId]);
              parentRow = getRow(taxRefId);
            }

            if (parentRow) {
              detailDebug.push(`    Parent found: transactionId="${parentRow.transactionId}" type="${parentRow.type}"`);
              detailDebug.push(`    Parent reference fields:`);
              for (const refType of REF_TYPES) {
                detailDebug.push(`      ${refType} = ${parentRow[refType] != null ? `"${parentRow[refType]}"` : "null/undefined"}`);
              }
              detailDebug.push(`      sourceFolioLineItemId = ${parentRow.sourceFolioLineItemId != null ? `"${parentRow.sourceFolioLineItemId}"` : "null/undefined"}`);

              // Step B2: Check parent for any of the REF_TYPES ref IDs
              let parentRefType: string | null = null;
              let parentRefId: string | null = null;
              for (const refType of REF_TYPES) {
                if (parentRow[refType]) {
                  parentRefType = refType;
                  parentRefId = String(parentRow[refType]).trim();
                  break;
                }
              }

              // Also check sourceFolioLineItemId on the parent row if no other ref was found
              if (!parentRefId && parentRow.sourceFolioLineItemId) {
                parentRefType = "sourceFolioLineItemId";
                parentRefId = String(parentRow.sourceFolioLineItemId).trim();
                detailDebug.push(`    Parent has sourceFolioLineItemId="${parentRefId}" — using as parentRefId`);
              }


              if (parentRefId && parentRefType) {
                detailDebug.push(`[8] Parent has ${parentRefType}="${parentRefId}" — grouping by taxReferenceId="${parentRefId}" + itemId match`);

                // Step B3: Ensure the referenced transaction object is loaded
                if (!getRow(parentRefId)) {
                  detailDebug.push(`    Referenced transaction "${parentRefId}" not found — querying DB`);
                  await fetchFromDb([parentRefId]);
                }

                // Group: all rows where taxReferenceId === parentRefId  (taxes of that transaction)
                // Also include the base transaction itself (transactionId === parentRefId) if available
                let groupedRows = getAllRows().filter(
                  r => r.taxReferenceId != null && String(r.taxReferenceId).trim() === parentRefId
                );
                const baseRow = getRow(parentRefId);
                if (baseRow) {
                  const baseTid = String(baseRow.transactionId);
                  if (!groupedRows.find(r => String(r.transactionId) === baseTid)) {
                    groupedRows = [baseRow, ...groupedRows];
                  }
                }

                detailDebug.push(`    Group (taxReferenceId="${parentRefId}") size: ${groupedRows.length}`);
                for (const gr of groupedRows) {
                  detailDebug.push(`      transactionId="${gr.transactionId}" itemId="${gr.itemId ?? "null"}"`);
                }

                // Step B4: Find itemId match (different transaction from the current one)
                const matchingRow = groupedRows.find(
                  r => r.itemId === csvRow.itemId && String(r.transactionId) !== String(csvRow.transactionId)
                );

                if (matchingRow) {
                  const computed = extractFirstTenDigits(String(matchingRow.transactionId));
                  correctTrnsfrFromLineItemNo = computed;
                  resolution = `taxReferenceId="${taxRefId}" → parent.${parentRefType}="${parentRefId}" → group by taxReferenceId="${parentRefId}" → itemId="${csvRow.itemId}" match → transactionId="${matchingRow.transactionId}"`;
                  detailDebug.push(`[9] ✅ itemId="${csvRow.itemId}" match: transactionId="${matchingRow.transactionId}" → correctTrnsfrFromLineItemNo="${computed}"`);
                  taxReferenceResults.push({
                    lineItemNo: folioTran.lineItemNo,
                    taxReferenceId: taxRefId,
                    parentRefType,
                    parentRefId,
                    matchedTransactionId: matchingRow.transactionId,
                    correctTrnsfrFromLineItemNo: computed,
                  });
                } else {
                  detailDebug.push(`[9] ❌ No row with itemId="${csvRow.itemId}" found in group`);
                  taxReferenceResults.push({
                    lineItemNo: folioTran.lineItemNo,
                    taxReferenceId: taxRefId,
                    parentRefType,
                    parentRefId,
                    correctTrnsfrFromLineItemNo: null,
                    status: "no_itemid_match",
                  });
                }
              } else {
                // Parent has no direct ref IDs
                detailDebug.push(`[8] Parent has no direct reference IDs — trying itemId-matched folioLine in parent's document first`);

                // ══════════════════════════════════════════════════════════════════════
                // Case B-docMatch: Fetch all folioLines from the parent's document,
                //   find the one whose itemId matches csvRow.itemId, and use its
                //   transferReferenceId → first10digits as correctTrnsfrFromLineItemNo.
                // ══════════════════════════════════════════════════════════════════════
                let bDocMatchFound = false;
                if (tenantId && propertyId && parentRow?.transactionId) {
                  try {
                    const bDocLines = await executeFolioLinesByDocumentQuery(tenantId, propertyId, String(parentRow.transactionId));
                    detailDebug.push(`[Case B-docMatch] Parent document folioLines count: ${bDocLines.length}`);
                    for (const dl of bDocLines) {
                      detailDebug.push(`  transactionId="${dl.transactionId}" itemId="${dl.itemId ?? "null"}" sourceFolioLineItemId="${dl.sourceFolioLineItemId ?? "null"}" transferReferenceId="${dl.transferReferenceId ?? "null"}"`);
                    }

                    // ── Primary: match by csvRow.itemId (tax line's item) ──
                    let bDocMatchedLine = bDocLines.find(
                      r => r.itemId === csvRow.itemId &&
                           String(r.transactionId) !== String(csvRow.transactionId) &&
                           (r.sourceFolioLineItemId || r.transferReferenceId)
                    );

                    // ── Secondary: if primary fails, check whether the parent's own itemId
                    //    appears in the same document with a reference (transferReferenceId /
                    //    sourceFolioLineItemId).  This covers the case where the csvRow is a tax
                    //    line whose itemId differs from the parent's itemId, but the parent's
                    //    sibling line carries the needed reference.
                    //    e.g. parent transactionId="d536e0e7" has itemId="b01ad9e8";
                    //         sibling "71187093" shares that itemId and has transferReferenceId.
                    let bDocMatchUsedParentItemId = false;
                    if (!bDocMatchedLine && parentRow?.itemId && parentRow.itemId !== csvRow.itemId) {
                      detailDebug.push(`[Case B-docMatch] No match by csvRow.itemId="${csvRow.itemId}" — checking parentRow.itemId="${parentRow.itemId}" in parent document`);
                      const bDocParentItemMatch = bDocLines.find(
                        r => r.itemId === parentRow.itemId &&
                             String(r.transactionId) !== String(parentRow.transactionId) &&
                             (r.sourceFolioLineItemId || r.transferReferenceId)
                      );
                      if (bDocParentItemMatch) {
                        detailDebug.push(`[Case B-docMatch] ✅ parentRow.itemId-matched folioLine: transactionId="${bDocParentItemMatch.transactionId}" sourceFolioLineItemId="${bDocParentItemMatch.sourceFolioLineItemId ?? "null"}" transferReferenceId="${bDocParentItemMatch.transferReferenceId ?? "null"}"`);
                        bDocMatchedLine = bDocParentItemMatch;
                        bDocMatchUsedParentItemId = true;
                      }
                    }

                    if (bDocMatchedLine) {
                      const bDocRefField = bDocMatchedLine.sourceFolioLineItemId ? "sourceFolioLineItemId" : "transferReferenceId";
                      const bDocRefId = String(bDocMatchedLine.sourceFolioLineItemId || bDocMatchedLine.transferReferenceId).trim();
                      const bDocMatchItemId = bDocMatchUsedParentItemId ? parentRow.itemId : csvRow.itemId;

                      // ── Use bDocRefId as the new parentRefId and apply the same
                      //    grouping+itemId-match logic as Case B's parentRefId branch:
                      //    1. Load the transaction bDocRefId (if not cached)
                      //    2. Group all rows whose taxReferenceId === bDocRefId (+ the base row)
                      //    3. Find the row with csvRow.itemId (different transactionId)
                      //    4. first10digits(matchingRow.transactionId) = correctTrnsfrFromLineItemNo
                      //    5. Fall back to first10digits(bDocRefId) only if grouping yields no match
                      detailDebug.push(`[Case B-docMatch] Found ${bDocRefField}="${bDocRefId}" — grouping by taxReferenceId="${bDocRefId}" + csvRow.itemId="${csvRow.itemId}" match`);

                      if (!getRow(bDocRefId)) {
                        detailDebug.push(`[Case B-docMatch] Referenced transaction "${bDocRefId}" not in cache — fetching from DB`);
                        await fetchFromDb([bDocRefId]);
                      }

                      let bDocGroupRows = getAllRows().filter(
                        r => r.taxReferenceId != null && String(r.taxReferenceId).trim() === bDocRefId
                      );
                      const bDocBaseRow = getRow(bDocRefId);
                      if (bDocBaseRow) {
                        const bDocBaseTid = String(bDocBaseRow.transactionId);
                        if (!bDocGroupRows.find(r => String(r.transactionId) === bDocBaseTid)) {
                          bDocGroupRows = [bDocBaseRow, ...bDocGroupRows];
                        }
                      }

                      detailDebug.push(`[Case B-docMatch] Group (taxReferenceId="${bDocRefId}") size: ${bDocGroupRows.length}`);
                      for (const gr of bDocGroupRows) {
                        detailDebug.push(`  transactionId="${gr.transactionId}" itemId="${gr.itemId ?? "null"}"`);
                      }

                      const bDocGroupMatch = bDocGroupRows.find(
                        r => r.itemId === csvRow.itemId && String(r.transactionId) !== String(csvRow.transactionId)
                      );

                      if (bDocGroupMatch) {
                        const bDocComputed = extractFirstTenDigits(String(bDocGroupMatch.transactionId));
                        if (bDocComputed) {
                          correctTrnsfrFromLineItemNo = bDocComputed;
                          resolution = `taxReferenceId="${taxRefId}" → parent document folioLine itemId="${bDocMatchItemId}" → ${bDocRefField}="${bDocRefId}" → group by taxReferenceId → itemId="${csvRow.itemId}" match → transactionId="${bDocGroupMatch.transactionId}" → first10digits="${bDocComputed}"`;
                          detailDebug.push(`[Case B-docMatch] ✅ itemId="${csvRow.itemId}" group match: transactionId="${bDocGroupMatch.transactionId}" → correctTrnsfrFromLineItemNo="${bDocComputed}"`);
                          bDocMatchFound = true;
                          taxReferenceResults.push({
                            lineItemNo: folioTran.lineItemNo,
                            taxReferenceId: taxRefId,
                            parentRefType: `document.folioLine.${bDocRefField}`,
                            parentRefId: bDocRefId,
                            matchedTransactionId: bDocGroupMatch.transactionId,
                            correctTrnsfrFromLineItemNo: bDocComputed,
                            source: bDocMatchUsedParentItemId ? "parentDocumentFolioLineByParentItemId" : "parentDocumentFolioLineByItemId",
                          });
                        }
                      } else {
                        // Fallback: group yielded no itemId match — use first10digits(bDocRefId)
                        detailDebug.push(`[Case B-docMatch] No itemId="${csvRow.itemId}" match in group — falling back to first10digits of ${bDocRefField}`);
                        const bDocComputed = extractFirstTenDigits(bDocRefId);
                        if (bDocComputed) {
                          correctTrnsfrFromLineItemNo = bDocComputed;
                          resolution = `taxReferenceId="${taxRefId}" → parent document folioLine itemId="${bDocMatchItemId}" match → ${bDocRefField}="${bDocRefId}" → first10digits="${bDocComputed}"`;
                          detailDebug.push(`[Case B-docMatch] ✅ itemId-matched folioLine: transactionId="${bDocMatchedLine.transactionId}" ${bDocRefField}="${bDocRefId}" → correctTrnsfrFromLineItemNo="${bDocComputed}"`);
                          bDocMatchFound = true;
                          taxReferenceResults.push({
                            lineItemNo: folioTran.lineItemNo,
                            taxReferenceId: taxRefId,
                            parentRefType: `document.folioLine.${bDocRefField}`,
                            parentRefId: bDocRefId,
                            matchedTransactionId: bDocMatchedLine.transactionId,
                            correctTrnsfrFromLineItemNo: bDocComputed,
                            source: bDocMatchUsedParentItemId ? "parentDocumentFolioLineByParentItemId" : "parentDocumentFolioLineByItemId",
                          });
                        }
                      }
                    } else {
                      // ── Before proceeding to fallback: check current csvRow's own document
                      //    for a parentTransactionReference (mirrors Case A2 logic, which is
                      //    skipped for taxReferenceId rows). Fetch all folioLines from this
                      //    document, find the one that shares csvRow.itemId and carries a
                      //    transferReferenceId / sourceFolioLineItemId, then derive
                      //    correctTrnsfrFromLineItemNo from its first-10-digits.
                      let bCurDocRefFound = false;
                      if (tenantId && propertyId && csvRow.transactionId) {
                        try {
                          detailDebug.push(`[Case B-docMatch] No itemId-matched folioLine in parent document — checking current csvRow document for parentTransactionReference`);
                          const bCurDocLines = await executeFolioLinesByDocumentQuery(tenantId, propertyId, String(csvRow.transactionId));
                          detailDebug.push(`[Case B-docMatch] Current document folioLines count: ${bCurDocLines.length}`);
                          for (const dl of bCurDocLines) {
                            detailDebug.push(`  transactionId="${dl.transactionId}" itemId="${dl.itemId ?? "null"}" sourceFolioLineItemId="${dl.sourceFolioLineItemId ?? "null"}" transferReferenceId="${dl.transferReferenceId ?? "null"}"`);
                          }

                          const bCurDocMatch = bCurDocLines.find(
                            r => r.itemId === csvRow.itemId &&
                                 String(r.transactionId) !== String(csvRow.transactionId) &&
                                 (r.sourceFolioLineItemId || r.transferReferenceId)
                          );

                          if (bCurDocMatch) {
                            const bCurRefField = bCurDocMatch.sourceFolioLineItemId ? "sourceFolioLineItemId" : "transferReferenceId";
                            const bCurRefId = String(bCurDocMatch.sourceFolioLineItemId || bCurDocMatch.transferReferenceId).trim();
                            const bCurComputed = extractFirstTenDigits(bCurRefId);
                            if (bCurComputed) {
                              correctTrnsfrFromLineItemNo = bCurComputed;
                              resolution = `taxReferenceId="${taxRefId}" → current document folioLine itemId="${csvRow.itemId}" match → ${bCurRefField}="${bCurRefId}" → first10digits="${bCurComputed}"`;
                              detailDebug.push(`[Case B-docMatch] ✅ itemId-matched folioLine: transactionId="${bCurDocMatch.transactionId}" ${bCurRefField}="${bCurRefId}" → correctTrnsfrFromLineItemNo="${bCurComputed}"`);
                              bDocMatchFound = true;
                              bCurDocRefFound = true;
                              taxReferenceResults.push({
                                lineItemNo: folioTran.lineItemNo,
                                taxReferenceId: taxRefId,
                                parentRefType: `currentDocument.folioLine.${bCurRefField}`,
                                parentRefId: bCurRefId,
                                matchedTransactionId: bCurDocMatch.transactionId,
                                correctTrnsfrFromLineItemNo: bCurComputed,
                                source: "currentDocumentFolioLineByItemId",
                              });
                            }
                          }
                        } catch (e: any) {
                          detailDebug.push(`[Case B-docMatch] Current document DB fetch failed: ${e.message}`);
                        }
                      }

                      if (!bCurDocRefFound) {
                        detailDebug.push(`[Case B-docMatch] No itemId-matched folioLine with sourceFolioLineItemId/transferReferenceId in parent document — proceeding to fallback`);
                      }
                    }
                  } catch (e: any) {
                    detailDebug.push(`[Case B-docMatch] DB fetch failed: ${e.message}`);
                  }
                }

                if (!bDocMatchFound) {
                // ── fallback: group by taxReferenceId + itemId ──
                detailDebug.push(`[8b] Fallback: group by taxReferenceId="${taxRefId}" + itemId match`);
                const fallbackRows = getAllRows().filter(
                  r => (r.taxReferenceId != null && String(r.taxReferenceId).trim() === taxRefId) ||
                       String(r.transactionId) === taxRefId
                );
                detailDebug.push(`    Fallback group size: ${fallbackRows.length}`);
                const matchingRow = fallbackRows.find(
                  r => r.itemId === csvRow.itemId && String(r.transactionId) !== String(csvRow.transactionId)
                );
                if (matchingRow) {
                  const computed = extractFirstTenDigits(String(matchingRow.transactionId));
                  correctTrnsfrFromLineItemNo = computed;
                  resolution = `taxReferenceId="${taxRefId}" → group by taxReferenceId + itemId="${csvRow.itemId}" match → transactionId="${matchingRow.transactionId}"`;
                  detailDebug.push(`[9] ✅ Fallback match: correctTrnsfrFromLineItemNo="${computed}"`);
                  taxReferenceResults.push({
                    lineItemNo: folioTran.lineItemNo,
                    taxReferenceId: taxRefId,
                    matchedTransactionId: matchingRow.transactionId,
                    correctTrnsfrFromLineItemNo: computed,
                  });
                } else {
                  detailDebug.push(`[9] ❌ No itemId="${csvRow.itemId}" match in fallback group`);
                  taxReferenceResults.push({
                    lineItemNo: folioTran.lineItemNo,
                    taxReferenceId: taxRefId,
                    correctTrnsfrFromLineItemNo: null,
                    status: "no_itemid_match_fallback",
                  });

                  // ── Case B3: parent has no direct ref IDs AND fallback failed ──
                  // Query the PARENT transaction's ledgerTransactionHistory.sourceFolioLineItemId,
                  // then group by taxReferenceId = that ID and match itemId.
                  if (!correctTrnsfrFromLineItemNo && tenantId && propertyId && parentRow?.transactionId) {
                    detailDebug.push(`[Case B3] Fallback failed — querying ledgerTransactionHistory.sourceFolioLineItemId for parent transactionId="${parentRow.transactionId}"`);
                    try {
                      const parentHistRows = await executeHistorySourceQuery(tenantId, propertyId, [String(parentRow.transactionId)]);
                      const parentHistRow = parentHistRows.find((r: any) => String(r.transactionId) === String(parentRow.transactionId));

                      let parentSourceId: string | null = null;
                      if (parentHistRow) {
                        // ledgerTransactionHistory is always an array — take the first entry
                        const lthArr = parentHistRow.ledgerTransactionHistory;
                        if (Array.isArray(lthArr) && lthArr.length > 0) {
                          const lastEntry = lthArr[0];
                          if (lastEntry?.sourceFolioLineItemId != null) {
                            parentSourceId = String(lastEntry.sourceFolioLineItemId).trim();
                          }
                        }
                      }

                      if (parentSourceId) {
                        detailDebug.push(`[Case B3] Found parent sourceFolioLineItemId="${parentSourceId}" — grouping by taxReferenceId="${parentSourceId}" + itemId match`);

                        // Ensure the referenced transaction is loaded
                        if (!getRow(parentSourceId)) {
                          await fetchFromDb([parentSourceId]);
                        }

                        // Group: all rows where taxReferenceId === parentSourceId (taxes of that transaction)
                        let b3GroupRows = getAllRows().filter(
                          r => r.taxReferenceId != null && String(r.taxReferenceId).trim() === parentSourceId
                        );
                        const b3BaseRow = getRow(parentSourceId);
                        if (b3BaseRow) {
                          const baseTid = String(b3BaseRow.transactionId);
                          if (!b3GroupRows.find(r => String(r.transactionId) === baseTid)) {
                            b3GroupRows = [b3BaseRow, ...b3GroupRows];
                          }
                        }

                        detailDebug.push(`[Case B3] Tax group (taxReferenceId="${parentSourceId}") size: ${b3GroupRows.length}`);
                        for (const gr of b3GroupRows) {
                          detailDebug.push(`  transactionId="${gr.transactionId}" itemId="${gr.itemId ?? "null"}"`);
                        }

                        const b3MatchingRow = b3GroupRows.find(
                          r => r.itemId === csvRow.itemId && String(r.transactionId) !== String(csvRow.transactionId)
                        );

                        if (b3MatchingRow) {
                          detailDebug.push(`[Case B3] ✅ itemId match: transactionId="${b3MatchingRow.transactionId}"`);

                          // Check if matched row has a direct reference ID (REF_TYPES)
                          let b3RefId: string | null = null;
                          for (const refType of REF_TYPES) {
                            if (b3MatchingRow[refType]) {
                              b3RefId = String(b3MatchingRow[refType]).trim();
                              detailDebug.push(`[Case B3] Matched row has ${refType}="${b3RefId}" — using as transferReferenceId`);
                              break;
                            }
                          }

                          // Check sourceFolioLineItemId directly on the matched folioLine (avoids extra DB call)
                          if (!b3RefId && b3MatchingRow.sourceFolioLineItemId) {
                            b3RefId = String(b3MatchingRow.sourceFolioLineItemId).trim();
                            detailDebug.push(`[Case B3] Matched row has sourceFolioLineItemId="${b3RefId}" — using directly`);
                          }

                          // If still no ref → query matched row's ledgerTransactionHistory.sourceFolioLineItemId
                          if (!b3RefId && tenantId && propertyId) {
                            detailDebug.push(`[Case B3] Matched row has no direct refs — querying ledgerTransactionHistory.sourceFolioLineItemId for transactionId="${b3MatchingRow.transactionId}"`);
                            try {
                              const b3HistRows = await executeHistorySourceQuery(tenantId, propertyId, [String(b3MatchingRow.transactionId)]);
                              const b3HistRow = b3HistRows.find((r: any) => String(r.transactionId) === String(b3MatchingRow.transactionId));
                              if (b3HistRow) {
                                const lthArr = b3HistRow.ledgerTransactionHistory;
                                if (Array.isArray(lthArr) && lthArr.length > 0 && lthArr[0]?.sourceFolioLineItemId != null) {
                                  b3RefId = String(lthArr[0].sourceFolioLineItemId).trim();
                                  detailDebug.push(`[Case B3] Found matched row sourceFolioLineItemId="${b3RefId}" — using as transferReferenceId`);
                                }
                              }
                            } catch (e: any) {
                              detailDebug.push(`[Case B3] DB fetch for matched row ledgerTransactionHistory failed: ${e.message}`);
                            }
                          }

                          const b3Computed = b3RefId
                            ? extractFirstTenDigits(b3RefId)
                            : extractFirstTenDigits(String(b3MatchingRow.transactionId));
                          correctTrnsfrFromLineItemNo = b3Computed;
                          resolution = `taxReferenceId="${taxRefId}" → parent.ledgerTransactionHistory.sourceFolioLineItemId="${parentSourceId}" → taxGroup itemId="${csvRow.itemId}" match → ${b3RefId ? `sourceFolioLineItemId="${b3RefId}"` : `transactionId="${b3MatchingRow.transactionId}"`} → correctTrnsfrFromLineItemNo="${b3Computed}"`;
                          detailDebug.push(`[Case B3] correctTrnsfrFromLineItemNo="${b3Computed}"`);
                          taxReferenceResults.push({
                            lineItemNo: folioTran.lineItemNo,
                            taxReferenceId: taxRefId,
                            parentRefType: "ledgerTransactionHistory.sourceFolioLineItemId",
                            parentRefId: parentSourceId,
                            matchedTransactionId: b3MatchingRow.transactionId,
                            correctTrnsfrFromLineItemNo: b3Computed,
                            source: "parentLedgerTransactionHistory",
                          });
                        } else {
                          detailDebug.push(`[Case B3] ❌ No itemId="${csvRow.itemId}" match in parent sourceFolioLineItemId tax group`);

                          // ── Case B3b: fetch ALL folioLines from the document that owns parentSourceId ──
                          // parentSourceId is a folioLines._id. Fetch the entire document it belongs to,
                          // unwind all its folioLines, and find the one with the matching itemId.
                          detailDebug.push(`[Case B3b] Fetching all folioLines from the document containing folioLines._id="${parentSourceId}"`);
                          try {
                            const docLines = await executeFolioLinesByDocumentQuery(tenantId, propertyId, parentSourceId);
                            detailDebug.push(`[Case B3b] Document folioLines count: ${docLines.length}`);
                            for (const dl of docLines) {
                              detailDebug.push(`  transactionId="${dl.transactionId}" itemId="${dl.itemId ?? "null"}"`);
                            }

                            const b3bMatchingRow = docLines.find(
                              r => r.itemId === csvRow.itemId && String(r.transactionId) !== String(csvRow.transactionId)
                            );

                            if (b3bMatchingRow) {
                              detailDebug.push(`[Case B3b] ✅ itemId match in document: transactionId="${b3bMatchingRow.transactionId}"`);

                              // Check if matched row has a direct reference ID (REF_TYPES)
                              let b3bRefId: string | null = null;
                              for (const refType of REF_TYPES) {
                                if (b3bMatchingRow[refType]) {
                                  b3bRefId = String(b3bMatchingRow[refType]).trim();
                                  detailDebug.push(`[Case B3b] Matched row has ${refType}="${b3bRefId}" — using as transferReferenceId`);
                                  break;
                                }
                              }

                              // Check sourceFolioLineItemId directly on the matched folioLine (avoids extra DB call)
                              if (!b3bRefId && b3bMatchingRow.sourceFolioLineItemId) {
                                b3bRefId = String(b3bMatchingRow.sourceFolioLineItemId).trim();
                                detailDebug.push(`[Case B3b] Matched row has sourceFolioLineItemId="${b3bRefId}" — using directly`);
                              }

                              // If still no ref → query matched row's ledgerTransactionHistory.sourceFolioLineItemId
                              if (!b3bRefId && tenantId && propertyId) {
                                detailDebug.push(`[Case B3b] Matched row has no direct refs — querying ledgerTransactionHistory.sourceFolioLineItemId for transactionId="${b3bMatchingRow.transactionId}"`);
                                try {
                                  const b3bHistRows = await executeHistorySourceQuery(tenantId, propertyId, [String(b3bMatchingRow.transactionId)]);
                                  const b3bHistRow = b3bHistRows.find((r: any) => String(r.transactionId) === String(b3bMatchingRow.transactionId));
                                  if (b3bHistRow) {
                                    const lthArr = b3bHistRow.ledgerTransactionHistory;
                                    if (Array.isArray(lthArr) && lthArr.length > 0 && lthArr[0]?.sourceFolioLineItemId != null) {
                                      b3bRefId = String(lthArr[0].sourceFolioLineItemId).trim();
                                      detailDebug.push(`[Case B3b] Found matched row sourceFolioLineItemId="${b3bRefId}" — using as transferReferenceId`);
                                    }
                                  }
                                } catch (e: any) {
                                  detailDebug.push(`[Case B3b] DB fetch for matched row ledgerTransactionHistory failed: ${e.message}`);
                                }
                              }

                              const b3bComputed = b3bRefId
                                ? extractFirstTenDigits(b3bRefId)
                                : extractFirstTenDigits(String(b3bMatchingRow.transactionId));
                              correctTrnsfrFromLineItemNo = b3bComputed;
                              resolution = `taxReferenceId="${taxRefId}" → parent.ledgerTransactionHistory.sourceFolioLineItemId="${parentSourceId}" → document folioLines itemId="${csvRow.itemId}" match → ${b3bRefId ? `sourceFolioLineItemId="${b3bRefId}"` : `transactionId="${b3bMatchingRow.transactionId}"`} → correctTrnsfrFromLineItemNo="${b3bComputed}"`;
                              detailDebug.push(`[Case B3b] correctTrnsfrFromLineItemNo="${b3bComputed}"`);
                              taxReferenceResults.push({
                                lineItemNo: folioTran.lineItemNo,
                                taxReferenceId: taxRefId,
                                parentRefType: "ledgerTransactionHistory.sourceFolioLineItemId",
                                parentRefId: parentSourceId,
                                matchedTransactionId: b3bMatchingRow.transactionId,
                                correctTrnsfrFromLineItemNo: b3bComputed,
                                source: "parentDocumentFolioLines",
                              });
                            } else {
                              detailDebug.push(`[Case B3b] ❌ No itemId="${csvRow.itemId}" match in document folioLines`);
                            }
                          } catch (e: any) {
                            detailDebug.push(`[Case B3b] DB fetch failed: ${e.message}`);
                          }
                        }
                      } else {
                        detailDebug.push(`[Case B3] ❌ No sourceFolioLineItemId found in parent ledgerTransactionHistory`);
                      }
                    } catch (e: any) {
                      detailDebug.push(`[Case B3] DB fetch failed: ${e.message}`);
                    }
                  }
                }
                } // closes if (!bDocMatchFound)
              }
            } else {
              detailDebug.push(`[8] ❌ Parent transaction for taxReferenceId="${taxRefId}" not found (DB unavailable or no matching record)`);
              taxReferenceResults.push({
                lineItemNo: folioTran.lineItemNo,
                taxReferenceId: taxRefId,
                correctTrnsfrFromLineItemNo: null,
                status: "parent_not_found",
              });
            }
          }


          // ── Build verification result ──
          const isCorrect = correctTrnsfrFromLineItemNo !== null && correctTrnsfrFromLineItemNo === existingTrnsfrFrom;
          const status = correctTrnsfrFromLineItemNo === null
            ? "unresolved"
            : isCorrect ? "valid" : "mismatch";

          detailDebug.push(`[10] Result: correctTrnsfrFromLineItemNo="${correctTrnsfrFromLineItemNo}" existing="${existingTrnsfrFrom}" → status="${status}"`);

          transferVerifications.push({
            lineItemNo: folioTran.lineItemNo,
            status,
            message: correctTrnsfrFromLineItemNo === null
              ? "Could not determine correct trnsfrFromLineItemNo"
              : isCorrect
                ? `trnsfrFromLineItemNo="${existingTrnsfrFrom}" is correct`
                : `trnsfrFromLineItemNo should be "${correctTrnsfrFromLineItemNo}" (currently "${existingTrnsfrFrom ?? "null"}")`,
            existingTrnsfrFromLineItemNo: existingTrnsfrFrom,
            correctTrnsfrFromLineItemNo: correctTrnsfrFromLineItemNo ?? null,
            resolution: resolution || undefined,
            trnsfrToFolioId: transferDetail.trnsfrToFolioId,
            trnsfrToLineItemNo: transferDetail.trnsfrToLineItemNo,
            debugSteps: detailDebug,
          });
        }
      }
    }

    // Summary counts
    const validCount = transferVerifications.filter(t => t.status === "valid").length;
    const mismatchCount = transferVerifications.filter(t => t.status === "mismatch").length;
    const unresolvedCount = transferVerifications.filter(t => t.status === "unresolved" || t.status === "csv_row_not_found").length;
    const taxExemptViolations = transferVerifications.filter(t => t.status === "tax_exempt_violation").length;
    const notApplicableCount = transferVerifications.filter(t => t.status === "not_applicable").length;

    res.json({
      summary: {
        totalTransfersChecked: transferVerifications.length,
        valid: validCount,
        mismatches: mismatchCount,
        unresolved: unresolvedCount,
        taxExemptViolations,
        notApplicable: notApplicableCount,
        taxReferenceChains: taxReferenceResults.length,
        referenceIdsChecked: referenceIdResults.length,
        dbRowsFetched: dbFetchedRows.size + preFetchedRowCount,
        preFetchedRows: preFetchedRowCount,
      },
      transferVerifications,
      taxReferenceResults,
      referenceIdResults,
      status: mismatchCount === 0 ? "PASS" : "FAIL",
    });
  } catch (err: any) {
    console.error("[deep-reference-analysis] error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    clearTimeout(reqTimeout);
  }
});

// ============================================================
// Mongo Query Log
// ============================================================
app.get("/api/mongo-logs", (_req, res) => {
  res.json({ logs: getQueryLog() });
});

app.delete("/api/mongo-logs", (_req, res) => {
  clearQueryLog();
  res.json({ success: true });
});

// ============================================================
// Misc
// ============================================================
app.get("/api/fragments", (_req, res) => {
  const fragments: Record<string, string> = {};
  for (const [k, v] of getAllFragments()) {
    fragments[k] = v;
  }
  res.json({ fragments });
});

// ============================================================
// Environment Configuration
// ============================================================

/**
 * GET /api/get-environment — return the current env config (never returns the URI).
 */
app.get("/api/get-environment", (_req, res) => {
  res.json({
    mode: envConfig.mode,
    tenantId: envConfig.tenantId,
    propertyId: envConfig.propertyId,
    dbName: envConfig.dbName,
  });
});

/**
 * POST /api/set-environment — switch between production and a custom environment.
 * Body (production):  { mode: "production" }
 * Body (other):       { mode: "other", uri: "mongodb+srv://...", tenantId: "...", propertyId: "...", dbName?: "..." }
 */
app.post("/api/set-environment", (req, res) => {
  const { mode, uri, tenantId, propertyId, dbName } = req.body;

  if (mode === "production") {
    envConfig = { mode: "production" };
    setCustomMongoUri(null);
    console.log("[RCA] Environment set to: production");
    return res.json({ success: true, mode: "production" });
  }

  if (mode === "other") {
    if (!uri || typeof uri !== "string") {
      return res.status(400).json({ error: "uri is required for custom environment" });
    }
    if (!tenantId || !propertyId) {
      return res.status(400).json({ error: "tenantId and propertyId are required for custom environment" });
    }
    envConfig = { mode: "other", tenantId, propertyId, dbName: dbName || undefined };
    setCustomMongoUri(uri, dbName || undefined);
    console.log(`[RCA] Environment set to: other (tenantId=${tenantId}, propertyId=${propertyId})`);
    return res.json({ success: true, mode: "other", tenantId, propertyId, dbName: dbName || undefined });
  }

  return res.status(400).json({ error: "mode must be 'production' or 'other'" });
});

// ============================================================
// Phase 9: Orchestrator — Human-in-the-Loop Execution
// ============================================================
import { createSession, advanceSession, respondToStep, getSession, loadRuleSheet, getSessionRules } from "./orchestrator.js";

// Start a new orchestrated session
app.post("/api/orchestrator/start", async (req, res) => {
  try {
    const { request, folioTransactions, csvData, rules } = req.body;
    if (!folioTransactions) return res.status(400).json({ error: "folioTransactions required" });

    // Load rule overrides if provided
    if (rules && Array.isArray(rules)) {
      loadRuleSheet(rules);
    }

    const context: Record<string, any> = { folioTransactions };
    if (csvData) context.csvData = csvData;
    // Inject custom env tenant overrides so the orchestrator's mongo step picks them up
    if (envConfig.mode === "other" && envConfig.tenantId && envConfig.propertyId) {
      context.envTenantId = envConfig.tenantId;
      context.envPropertyId = envConfig.propertyId;
    }

    const session = createSession(request || "Analyze and fix payload", context);
    const result = await advanceSession(session.id);

    res.json({
      sessionId: result.session.id,
      status: result.session.status,
      steps: result.session.steps,
      pendingStep: result.pendingStep || null,
      context: {
        hasCsvData: !!result.session.context.csvData,
        hasComparisonResult: !!result.session.context.comparisonResult,
        hasGraphResponse: !!result.session.context.graphResponse,
        hasCorrectedPayload: !!result.session.context.correctedPayload,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Advance session (auto-execute internal steps, return next pending)
app.post("/api/orchestrator/advance", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const result = await advanceSession(sessionId);
    res.json({
      sessionId: result.session.id,
      status: result.session.status,
      steps: result.session.steps,
      pendingStep: result.pendingStep || null,
      context: {
        hasCsvData: !!result.session.context.csvData,
        hasComparisonResult: !!result.session.context.comparisonResult,
        hasGraphResponse: !!result.session.context.graphResponse,
        hasCorrectedPayload: !!result.session.context.correctedPayload,
        comparisonSummary: result.session.context.comparisonResult ? {
          missing: result.session.context.comparisonResult.missing?.length || 0,
          mismatches: result.session.context.comparisonResult.mismatches?.length || 0,
          extra: result.session.context.comparisonResult.extra?.length || 0,
        } : null,
        diffs: result.session.context.diffs?.length || 0,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Respond to a pending step (approve/modify/reject)
app.post("/api/orchestrator/respond", async (req, res) => {
  try {
    const { sessionId, stepId, action, modification, responseData } = req.body;
    if (!sessionId || !stepId || !action) {
      return res.status(400).json({ error: "sessionId, stepId, and action required" });
    }

    const result = await respondToStep(sessionId, stepId, action, modification, responseData);
    res.json({
      sessionId: result.session.id,
      status: result.session.status,
      steps: result.session.steps,
      pendingStep: result.pendingStep || null,
      context: {
        hasCsvData: !!result.session.context.csvData,
        hasComparisonResult: !!result.session.context.comparisonResult,
        hasGraphResponse: !!result.session.context.graphResponse,
        hasCorrectedPayload: !!result.session.context.correctedPayload,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get session state
app.get("/api/orchestrator/session/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({
    ...session,
    context: {
      hasCsvData: !!session.context.csvData,
      hasComparisonResult: !!session.context.comparisonResult,
      hasGraphResponse: !!session.context.graphResponse,
      hasCorrectedPayload: !!session.context.correctedPayload,
      comparisonResult: session.context.comparisonResult,
      correctedPayload: session.context.correctedPayload,
      diffs: session.context.diffs,
    },
  });
});

// Get/set rule sheet
app.get("/api/orchestrator/rules", (_req, res) => {
  res.json({ rules: getSessionRules() });
});

app.put("/api/orchestrator/rules", (req, res) => {
  const { rules } = req.body;
  if (!Array.isArray(rules)) return res.status(400).json({ error: "rules must be an array" });
  loadRuleSheet(rules);
  res.json({ success: true, count: rules.length });
});


app.listen(PORT, () => {
   console.log(`[RCA Tool] Server running at http://localhost:${PORT}`);
});

