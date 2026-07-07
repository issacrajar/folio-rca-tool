// Copyright (C) Agilysys, Inc. All rights reserved.
/**
 * Simulate FolioResendHandler.transformOut() pipeline.
 * Accepts raw graph response and returns surviving transactions + trace.
 */
export function simulateTransformOut(graphResponse, accountType) {
    const trace = [];
    const emptyFolios = [];
    // Step 1: Extract folios based on account type
    let folios = [];
    if (accountType === "guest" && graphResponse.reservations?.manyByThirdPartyConfirmation) {
        folios = graphResponse.reservations.manyByThirdPartyConfirmation[0]?.account?.folios || [];
    }
    else if (accountType === "group" && graphResponse.groups?.oneByThirdPartyConfirmation) {
        folios = graphResponse.groups.oneByThirdPartyConfirmation?.account?.folios || [];
    }
    else if (accountType === "house" && graphResponse.houseAccounts?.manyByNumber) {
        folios = graphResponse.houseAccounts.manyByNumber[0]?.folios || [];
    }
    // Step 2: Flatten allLedgerTransactions with dedup
    let folioTransactions = [];
    const addedTransactionIds = new Set();
    for (const folio of folios) {
        if (!folio.allLedgerTransactions?.length) {
            emptyFolios.push(folio.id);
            continue;
        }
        for (const tx of folio.allLedgerTransactions) {
            if (!addedTransactionIds.has(tx.id)) {
                folioTransactions.push(tx);
                addedTransactionIds.add(tx.id);
                trace.push({
                    transactionId: tx.id,
                    type: tx.type,
                    action: "included",
                    reason: "Added from folio",
                    step: "flatten",
                });
            }
        }
    }
    // Step 3: Detect missing parent IDs
    const transactionIds = new Set(folioTransactions.map((ft) => ft.id));
    for (const tx of folioTransactions) {
        if (tx.parentId && !transactionIds.has(tx.parentId)) {
            trace.push({
                transactionId: tx.id,
                type: tx.type,
                action: "included",
                reason: `Missing parentId: ${tx.parentId} (would be queried in real flow)`,
                step: "missingParent",
            });
        }
    }
    // Step 4: Sort GROUP transactions first
    folioTransactions.sort((a, b) => (b.type === "GROUP" ? 1 : 0) - (a.type === "GROUP" ? 1 : 0));
    // Step 5: Apply GROUP filtering
    const needToRemoveIds = [];
    for (const ft of folioTransactions) {
        if (ft.type === "GROUP") {
            const child0 = ft.childTransactions?.[0];
            const child0Detail = child0?.transactionDetails?.[0];
            if (ft.pantryReceiptNumber) {
                needToRemoveIds.push(ft.id);
                trace.push({ transactionId: ft.id, type: ft.type, action: "excluded", reason: "GROUP with pantryReceiptNumber", step: "groupFilter" });
                removeParentFromChildren(folioTransactions, ft.id);
                continue;
            }
            if (child0?.autoRecurringCharge) {
                needToRemoveIds.push(ft.id);
                trace.push({ transactionId: ft.id, type: ft.type, action: "excluded", reason: "Child has autoRecurringCharge", step: "groupFilter" });
                removeParentFromChildren(folioTransactions, ft.id);
                continue;
            }
            if (child0Detail?.isPantryItem) {
                needToRemoveIds.push(ft.id);
                trace.push({ transactionId: ft.id, type: ft.type, action: "excluded", reason: "Child isPantryItem", step: "groupFilter" });
                removeParentFromChildren(folioTransactions, ft.id);
                continue;
            }
            if (child0Detail?.isAddOn && child0Detail?.addOnType !== "PACKAGE") {
                needToRemoveIds.push(ft.id);
                trace.push({ transactionId: ft.id, type: ft.type, action: "excluded", reason: "Child isAddOn (non-PACKAGE)", step: "groupFilter" });
                removeParentFromChildren(folioTransactions, ft.id);
                continue;
            }
            if (child0Detail?.wholeReferenceTransaction?.transactionDetails?.[0]?.isAddOn && !ft.parentId) {
                needToRemoveIds.push(ft.id);
                trace.push({ transactionId: ft.id, type: ft.type, action: "excluded", reason: "wholeReferenceTransaction isAddOn without parentId", step: "groupFilter" });
                removeParentFromChildren(folioTransactions, ft.id);
                continue;
            }
        }
        // Step 6: Merge children into parents
        if (ft.parentId && transactionIds.has(ft.parentId)) {
            needToRemoveIds.push(ft.id);
            const parent = folioTransactions.find((p) => p.id === ft.parentId);
            if (parent) {
                parent.childTransactions = [...(parent.childTransactions || []), ...(ft.childTransactions || [])];
            }
            trace.push({ transactionId: ft.id, type: ft.type, action: "merged", reason: `Merged into parent: ${ft.parentId}`, step: "parentMerge" });
        }
    }
    folioTransactions = folioTransactions.filter((ft) => !needToRemoveIds.includes(ft.id));
    // Step 7: Filter remaining with parentId whose parent was already added
    folioTransactions = folioTransactions.filter((ft) => {
        if (ft.parentId && addedTransactionIds.has(ft.parentId)) {
            trace.push({ transactionId: ft.id, type: ft.type, action: "excluded", reason: `Parent ${ft.parentId} already processed`, step: "finalFilter" });
            return false;
        }
        return true;
    });
    return { survivingTransactions: folioTransactions, trace, emptyFolios };
}
function removeParentFromChildren(transactions, parentId) {
    for (const tx of transactions) {
        if (tx.parentId === parentId) {
            delete tx.parentId;
        }
    }
}
/**
 * Simulate FolioOutHandler.transform() for a single ledger transaction.
 * Returns a simplified FolioNotification-like structure.
 */
export function simulateFolioOutTransform(transaction) {
    const type = transaction.type;
    const childType = transaction.childTransactions?.[0]?.type;
    const effectiveType = type === "GROUP" ? childType ?? type : type;
    // Determine transType
    let transType = "NEW";
    if (effectiveType === "PAYMENT" || effectiveType === "REFUND") {
        transType = "SET";
    }
    else if (effectiveType === "TRANSFER") {
        // Check if transfer acts as payment
        const lineType = transaction.lineType ?? transaction.childTransactions?.[0]?.lineType;
        if (lineType === "PAYMENT") {
            transType = "SET";
        }
    }
    // Determine amount sign
    const details = type === "GROUP" && transaction.childTransactions
        ? transaction.childTransactions.flatMap((c) => c.transactionDetails || [])
        : transaction.transactionDetails || [];
    const totalAmount = details.reduce((sum, d) => sum + Number(d.amount || 0), 0);
    let amount = totalAmount;
    if (transType === "SET") {
        amount = -Math.abs(totalAmount);
    }
    return {
        transactionId: transaction.id,
        type: effectiveType,
        transType,
        amount,
        detailCount: details.length,
        originalType: type,
        wasGroup: type === "GROUP",
    };
}
