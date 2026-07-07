import { CsvRow } from "./builtInRules.js";
/**
 * Parse a CSV/XLSX file buffer into typed JSON rows.
 * If `lineItemNo` column is missing, it is derived from `transactionId`
 * by extracting the first 10 numeric digits.
 */
export declare function parseCsvBuffer(buffer: Buffer, filename?: string): {
    rows: CsvRow[];
    errors: string[];
};
