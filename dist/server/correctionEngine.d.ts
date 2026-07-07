import { CsvRow, Transaction } from "./builtInRules.js";
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
export declare function correctPayload(transactions: Transaction[], csvRows: CsvRow[], originalFolios?: any[]): CorrectionResult;
