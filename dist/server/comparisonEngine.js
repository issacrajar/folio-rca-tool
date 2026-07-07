// Copyright (C) Agilysys, Inc. All rights reserved.
// Comparison Engine — missing, extra, mismatch detection + PKG validation + balance reconciliation
import { applyBuiltInRules, validatePkgTransaction } from "./builtInRules.js";
import { flattenTransactions } from "./transactionFlattener.js";
/**
 * Run full comparison between CSV data and folio transactions.
 */
export function compareTransactions(csvRows, folios) {
    const { transactions, byLineItemNo, perWindowSummary } = flattenTransactions(folios);
    const missing = [];
    const mismatches = [];
    let matched = 0;
    // CSV line item numbers for extra detection
    const csvLineItemNos = new Set(csvRows.map((r) => String(r.lineItemNo).padStart(10, "0")));
    // Task 2.3 & 2.5: Check each CSV row against transactions
    for (const csvRow of csvRows) {
        const paddedLineItemNo = String(csvRow.lineItemNo).padStart(10, "0");
        const transaction = byLineItemNo.get(paddedLineItemNo);
        if (!transaction) {
            missing.push({ lineItemNo: csvRow.lineItemNo, csvRow });
            continue;
        }
        const ruleResult = applyBuiltInRules(csvRow, transaction);
        if (!ruleResult.isCorrect) {
            mismatches.push({ lineItemNo: csvRow.lineItemNo, csvRow, transaction, ruleResult });
        }
        else {
            matched++;
        }
    }
    // Task 2.4: Extra transaction detection
    const extra = [];
    for (const transaction of transactions) {
        if (transaction.transType === "PKG")
            continue; // PKGs are generated, not in CSV
        if (!csvLineItemNos.has(String(transaction.lineItemNo).padStart(10, "0"))) {
            extra.push({ lineItemNo: transaction.lineItemNo, transaction });
        }
    }
    // Task 2.6: PKG validation
    const pkgValidations = [];
    const pkgTransactions = transactions.filter((t) => t.transType === "PKG");
    for (const pkg of pkgTransactions) {
        const result = validatePkgTransaction(pkg, transactions);
        pkgValidations.push({
            lineItemNo: pkg.lineItemNo,
            isCorrect: result.isCorrect,
            expectedAmount: result.expected,
            actualAmount: result.actual,
            linkedCount: result.linkedCount,
        });
    }
    // NEW: Transfer Details Validation
    let transferInfo = {
        hasTransfers: false,
        transferCount: 0,
        transfers: [],
        warnings: [],
    };
    if (Array.isArray(folios)) {
        for (const folio of folios) {
            if (Array.isArray(folio.folioTransactionDetails)) {
                for (const txn of folio.folioTransactionDetails) {
                    if (Array.isArray(txn.folioTransferDetails) && txn.folioTransferDetails.length > 0) {
                        transferInfo.hasTransfers = true;
                        transferInfo.transferCount += txn.folioTransferDetails.length;
                        for (const transfer of txn.folioTransferDetails) {
                            const transferDetail = {
                                folioType: transfer.folioType || "UNKNOWN",
                                folioWindowId: transfer.folioWindowId || "N/A",
                                trnsfrFromLineItemNo: transfer.trnsfrFromLineItemNo || "MISSING",
                                validated: false,
                                warnings: [],
                            };
                            // Validate transfer reference
                            if (!transfer.trnsfrFromLineItemNo) {
                                transferDetail.warnings.push("⚠️ Missing trnsfrFromLineItemNo");
                                transferInfo.warnings.push(`Transfer missing source line reference in ${folio.folioId || "unknown folio"}`);
                            }
                            // Check for tax reference
                            if (transfer.taxReferenceId) {
                                transferDetail.hasTaxReference = true;
                                transferDetail.taxReferenceId = transfer.taxReferenceId;
                            }
                            else {
                                transferDetail.warnings.push("ℹ️ No tax reference configured");
                            }
                            // Validate transfer is properly linked
                            if (transfer.trnsfrFromLineItemNo && transfer.folioType && transfer.folioWindowId) {
                                transferDetail.validated = true;
                            }
                            transferInfo.transfers.push(transferDetail);
                        }
                    }
                }
            }
        }
    }
    return {
        missing,
        extra,
        mismatches,
        matched,
        pkgValidations,
        balanceSummary: perWindowSummary,
        totalCsvRows: csvRows.length,
        totalTransactions: transactions.length,
        transferInfo,
    };
}
