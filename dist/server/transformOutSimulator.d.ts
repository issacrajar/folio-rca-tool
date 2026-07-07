export interface TraceEntry {
    transactionId: string;
    type: string;
    action: "included" | "excluded" | "merged";
    reason: string;
    step: string;
}
export interface TransformOutResult {
    survivingTransactions: any[];
    trace: TraceEntry[];
    emptyFolios: string[];
}
/**
 * Simulate FolioResendHandler.transformOut() pipeline.
 * Accepts raw graph response and returns surviving transactions + trace.
 */
export declare function simulateTransformOut(graphResponse: any, accountType: string): TransformOutResult;
/**
 * Simulate FolioOutHandler.transform() for a single ledger transaction.
 * Returns a simplified FolioNotification-like structure.
 */
export declare function simulateFolioOutTransform(transaction: any): any;
