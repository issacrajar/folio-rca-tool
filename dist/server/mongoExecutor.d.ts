export interface QueryLogEntry {
    id: number;
    label: string;
    collection: string;
    operation: string;
    params: string;
    query?: string;
    startedAt: string;
    durationMs: number | null;
    status: "running" | "success" | "error";
    error?: string;
    rowCount?: number;
}
/** Returns a shallow copy of the log (newest first). */
export declare function getQueryLog(): QueryLogEntry[];
/** Clears the query log. */
export declare function clearQueryLog(): void;
/**
 * Switch to a custom MongoDB URI (for non-production environments).
 * Pass null to revert to the default production OIDC connection.
 */
export declare function setCustomMongoUri(uri: string | null, dbName?: string): void;
/**
 * Find the accountId by tenantId + chargePostingSequenceNumber.
 */
export declare function findAccountId(tenantId: string, chargePostingSequenceNumber: number): Promise<{
    accountId: string;
    accountType: string;
} | null>;
/**
 * Execute the ledgerTransactions aggregation pipeline and return the rows.
 */
export declare function executeLedgerQuery(tenantId: string, propertyId: string, accountId: string): Promise<any[]>;
/**
 * Execute the ledgerTransactionHistory source query — fetches
 * ledgerTransactionHistory.sourceFolioLineItemId (top-level field, outside folioLines)
 * for the given transactionIds (matched via folioLines._id).
 */
export declare function executeHistorySourceQuery(tenantId: string, propertyId: string, transactionIds: string[]): Promise<any[]>;
/**
 * Close all MongoDB connections (for cleanup).
 */
export declare function closeMongoConnection(): Promise<void>;
/**
 * Given a folioLines._id (anchorId), fetch the ledgerTransactions document
 * that contains it and return ALL folioLines from that document.
 *
 * This is used when we need to "group taxes in that document" — find the
 * folio line with the matching itemId inside the same document.
 */
export declare function executeFolioLinesByDocumentQuery(tenantId: string, propertyId: string, anchorFolioLineId: string): Promise<any[]>;
/**
 * Execute the transfer reference query — fetches ledger transactions whose
 * folioLines._id matches any of the provided reference IDs.
 */
export declare function executeTransferQuery(tenantId: string, propertyId: string, folioLineIds: string[]): Promise<any[]>;
