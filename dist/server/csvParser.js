// Copyright (C) Agilysys, Inc. All rights reserved.
// CSV Parser using xlsx library
import XLSX from "xlsx";
const REQUIRED_COLUMNS = ["totalAmount", "type"];
/**
 * Derive lineItemNo from transactionId by extracting the first 10 numeric digits.
 * If fewer than 10 digits exist, pad with leading zeros to reach 10 digits.
 */
function deriveLineItemNo(transactionId) {
    const digits = transactionId.replace(/\D/g, "");
    const first10 = digits.slice(0, 10);
    return first10.padStart(10, "0");
}
/**
 * Parse a CSV/XLSX file buffer into typed JSON rows.
 * If `lineItemNo` column is missing, it is derived from `transactionId`
 * by extracting the first 10 numeric digits.
 */
export function parseCsvBuffer(buffer, filename) {
    const errors = [];
    try {
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) {
            return { rows: [], errors: ["No sheets found in file"] };
        }
        const sheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(sheet);
        if (jsonData.length === 0) {
            return { rows: [], errors: ["File contains no data rows"] };
        }
        // Validate required columns
        const firstRow = jsonData[0];
        const hasLineItemNo = "lineItemNo" in firstRow;
        const hasTransactionId = "transactionId" in firstRow;
        if (!hasLineItemNo && !hasTransactionId) {
            errors.push("Missing required column: need either 'lineItemNo' or 'transactionId'");
        }
        for (const col of REQUIRED_COLUMNS) {
            if (!(col in firstRow)) {
                errors.push(`Missing required column: ${col}`);
            }
        }
        if (errors.length > 0) {
            return { rows: [], errors };
        }
        const rows = jsonData.map((item) => {
            let lineItemNo;
            if (item.lineItemNo != null && String(item.lineItemNo).trim() !== "") {
                lineItemNo = String(item.lineItemNo).padStart(10, "0");
            }
            else if (item.transactionId != null) {
                lineItemNo = deriveLineItemNo(String(item.transactionId));
            }
            else {
                lineItemNo = "0000000000";
            }
            return {
                lineItemNo,
                amount: Number(item.amount ?? 0),
                totalAmount: Number(item.totalAmount ?? 0),
                type: String(item.type ?? ""),
                originalType: item.originalType ? String(item.originalType) : undefined,
                sourceAccountType: item.sourceAccountType ? String(item.sourceAccountType) : undefined,
                destinationAccountType: item.destinationAccountType ? String(item.destinationAccountType) : undefined,
                ...item,
            };
        });
        return { rows, errors: [] };
    }
    catch (err) {
        return { rows: [], errors: [`Failed to parse file: ${err.message}`] };
    }
}
