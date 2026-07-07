// Copyright (C) Agilysys, Inc. All rights reserved.
/**
 * Flatten all folioTransactionDetails across folios into a single array.
 * Indexes by lineItemNo for O(1) lookup.
 */
export function flattenTransactions(folios) {
    const transactions = [];
    const byLineItemNo = new Map();
    const perWindowSummary = [];
    for (const folio of folios) {
        let newTotal = 0;
        let setTotal = 0;
        const details = folio.folioTransactionDetails ?? [];
        for (const txn of details) {
            transactions.push(txn);
            const paddedLineItemNo = String(txn.lineItemNo).padStart(10, "0");
            byLineItemNo.set(paddedLineItemNo, txn);
            if (txn.transType === "NEW") {
                newTotal += txn.transactionAmt.value;
            }
            else if (txn.transType === "SET") {
                setTotal += txn.transactionAmt.value;
            }
        }
        perWindowSummary.push({
            folioId: folio.folioId,
            windowId: folio.folioWindowId,
            newTotal,
            setTotal,
            // Balanced when:
            //  (a) newTotal + setTotal ≈ 0 (charges and payments cancel — SET stored as negative), OR
            //  (b) newTotal === setTotal   (charges equal payments — both stored as positive values)
            isBalanced: Math.abs(newTotal + setTotal) < 1 || Math.abs(newTotal - setTotal) < 1,
        });
    }
    return { transactions, byLineItemNo, perWindowSummary };
}
