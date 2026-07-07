import { Transaction } from "./builtInRules.js";
export interface FolioInput {
    folioId: string;
    folioWindowId: string;
    folioTransactionDetails?: Transaction[];
    [key: string]: any;
}
export interface FlattenResult {
    transactions: Transaction[];
    byLineItemNo: Map<string, Transaction>;
    perWindowSummary: WindowSummary[];
}
export interface WindowSummary {
    folioId: string;
    windowId: string;
    newTotal: number;
    setTotal: number;
    isBalanced: boolean;
}
/**
 * Flatten all folioTransactionDetails across folios into a single array.
 * Indexes by lineItemNo for O(1) lookup.
 */
export declare function flattenTransactions(folios: FolioInput[]): FlattenResult;
