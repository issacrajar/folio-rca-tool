import { CsvRow, Transaction, BuiltInRuleResult } from "./builtInRules.js";
import { FolioInput, WindowSummary } from "./transactionFlattener.js";
export interface MissingLine {
    lineItemNo: string;
    csvRow: CsvRow;
}
export interface ExtraLine {
    lineItemNo: string;
    transaction: Transaction;
}
export interface MismatchLine {
    lineItemNo: string;
    csvRow: CsvRow;
    transaction: Transaction;
    ruleResult: BuiltInRuleResult;
}
export interface PkgValidationResult {
    lineItemNo: string;
    isCorrect: boolean;
    expectedAmount: number;
    actualAmount: number;
    linkedCount: number;
}
export interface TransferValidationInfo {
    hasTransfers: boolean;
    transferCount: number;
    transfers: Array<{
        folioType: string;
        folioWindowId: string;
        trnsfrFromLineItemNo: string;
        validated: boolean;
        warnings: string[];
        taxReferenceId?: string;
        hasTaxReference?: boolean;
    }>;
    warnings: string[];
}
export interface ComparisonResult {
    missing: MissingLine[];
    extra: ExtraLine[];
    mismatches: MismatchLine[];
    matched: number;
    pkgValidations: PkgValidationResult[];
    balanceSummary: WindowSummary[];
    totalCsvRows: number;
    totalTransactions: number;
    transferInfo?: TransferValidationInfo;
}
/**
 * Run full comparison between CSV data and folio transactions.
 */
export declare function compareTransactions(csvRows: CsvRow[], folios: FolioInput[]): ComparisonResult;
