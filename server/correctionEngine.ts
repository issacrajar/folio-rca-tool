// Copyright (C) Agilysys, Inc. All rights reserved.

// Correction Engine — applies Priority 3 → 2 → 1 corrections
import { applyBuiltInRules, CsvRow, Transaction } from "./builtInRules.js";
import { applyUserRules } from "./userRules.js";

export interface CorrectionTrace {
  lineItemNo: string;
  layers: {
    layer: "code" | "userRule" | "builtIn";
    field: string;
    before: any;
    after: any;
  }[];
}

export interface Diff {
  lineItemNo: string;
  field: string;
  original: any;
  corrected: any;
}

export interface CorrectionResult {
  correctedPayload: any[];
  diffs: Diff[];
  traces: CorrectionTrace[];
}

/**
 * Apply corrections in priority order:
 * 1. Start with code logic (as-is payload) — Priority 3
 * 2. Apply user rules — Priority 2
 * 3. Apply built-in rules — Priority 1 (final override)
 *
 * Accepts the original folio array to preserve structure in the corrected output.
 */
export function correctPayload(
  transactions: Transaction[],
  csvRows: CsvRow[],
  originalFolios?: any[]
): CorrectionResult {
  // Build lookup by padded lineItemNo (string)
  const csvByLineItemNo = new Map<string, CsvRow>();
  for (const row of csvRows) {
    csvByLineItemNo.set(String(row.lineItemNo).padStart(10, "0"), row);
  }

  const correctedByLineItemNo = new Map<string, Transaction>();
  const diffs: Diff[] = [];
  const traces: CorrectionTrace[] = [];

  for (const txn of transactions) {
    const original = JSON.parse(JSON.stringify(txn));
    let current = JSON.parse(JSON.stringify(txn));
    const trace: CorrectionTrace = { lineItemNo: txn.lineItemNo, layers: [] };

    // Priority 3: Code logic — payload as-is (no changes needed)

    // Priority 2: Apply user rules
    const userResult = applyUserRules(current);
    for (const change of userResult.log.filter((l) => l.matched)) {
      for (const c of change.changes) {
        trace.layers.push({ layer: "userRule", field: c.field, before: c.before, after: c.after });
      }
    }
    current = userResult.result;

    // Priority 1: Apply built-in rules (overrides everything)
    const paddedKey = String(txn.lineItemNo).padStart(10, "0");
    const csvRow = csvByLineItemNo.get(paddedKey);
    if (csvRow) {
      const ruleResult = applyBuiltInRules(csvRow, current as Transaction);
      if (!ruleResult.isCorrect) {
        // Override transType
        if (current.transType !== ruleResult.expected.transType) {
          trace.layers.push({
            layer: "builtIn",
            field: "transType",
            before: current.transType,
            after: ruleResult.expected.transType,
          });
          current.transType = ruleResult.expected.transType;
        }
        // Override amount
        if (current.transactionAmt?.value !== ruleResult.expected.amount) {
          trace.layers.push({
            layer: "builtIn",
            field: "transactionAmt.value",
            before: current.transactionAmt?.value,
            after: ruleResult.expected.amount,
          });
          current.transactionAmt = { ...current.transactionAmt, value: ruleResult.expected.amount };
        }
      }

      // Tax-exempt correction: if the ledger line has taxExemptDetail.taxExempted === true,
      // folioTransferDetails must not exist on this transaction (Rule: tax-exempt lines are
      // not eligible for transfer details).
      if (csvRow.taxExempted === true && current.folioTransferDetails !== undefined) {
        trace.layers.push({
          layer: "builtIn",
          field: "folioTransferDetails",
          before: current.folioTransferDetails,
          after: null,
        });
        delete current.folioTransferDetails;
      }
    }

    // Generate diffs
    if (original.transType !== current.transType) {
      diffs.push({ lineItemNo: txn.lineItemNo, field: "transType", original: original.transType, corrected: current.transType });
    }
    if (original.transactionAmt?.value !== current.transactionAmt?.value) {
      diffs.push({ lineItemNo: txn.lineItemNo, field: "transactionAmt.value", original: original.transactionAmt?.value, corrected: current.transactionAmt?.value });
    }
    // folioTransferDetails removed by tax-exempt rule
    if (original.folioTransferDetails !== undefined && current.folioTransferDetails === undefined) {
      diffs.push({ lineItemNo: txn.lineItemNo, field: "folioTransferDetails", original: original.folioTransferDetails, corrected: null });
    }

    traces.push(trace);
    correctedByLineItemNo.set(txn.lineItemNo, current as Transaction);
  }

  // Rebuild corrected payload in original folio structure
  let correctedPayload: any[];
  if (originalFolios) {
    correctedPayload = originalFolios.map((folio: any) => {
      const correctedDetails = (folio.folioTransactionDetails ?? []).map((txn: Transaction) => {
        return correctedByLineItemNo.get(txn.lineItemNo) ?? txn;
      });
      return { ...folio, folioTransactionDetails: correctedDetails };
    });
  } else {
    correctedPayload = Array.from(correctedByLineItemNo.values());
  }

  // ── PKG correction: recalculate PKG amounts based on transLinkId group sums ──
  for (const folio of correctedPayload) {
    const details: any[] = folio.folioTransactionDetails ?? [];
    // Group non-PKG, non-SET transactions by transLinkId
    const sumByTransLinkId = new Map<string, number>();
    for (const txn of details) {
      if (txn.transLinkId && txn.transType !== "PKG" && txn.transType !== "SET") {
        sumByTransLinkId.set(
          txn.transLinkId,
          (sumByTransLinkId.get(txn.transLinkId) ?? 0) + (txn.transactionAmt?.value ?? 0)
        );
      }
    }
    // Update PKG line items with the recalculated sum
    for (const txn of details) {
      if (txn.transType === "PKG" && txn.transLinkId && sumByTransLinkId.has(txn.transLinkId)) {
        const correctedSum = sumByTransLinkId.get(txn.transLinkId)!;
        const currentVal = txn.transactionAmt?.value;
        if (currentVal !== correctedSum) {
          diffs.push({
            lineItemNo: txn.lineItemNo,
            field: "transactionAmt.value (PKG recalc)",
            original: currentVal,
            corrected: correctedSum,
          });
          const existingTrace = traces.find(t => t.lineItemNo === txn.lineItemNo);
          if (existingTrace) {
            existingTrace.layers.push({
              layer: "builtIn",
              field: "transactionAmt.value (PKG sum by transLinkId)",
              before: currentVal,
              after: correctedSum,
            });
          }
          txn.transactionAmt = { ...txn.transactionAmt, value: correctedSum };
        }
      }
    }
  }

  return { correctedPayload, diffs, traces };
}

