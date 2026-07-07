export interface CodeTrace {
    file: string;
    method: string;
    line: string;
    explanation: string;
    category: "transType" | "amount" | "both";
}
export interface BuiltInRuleResult {
    isCorrect: boolean;
    expected: {
        transType: string;
        amount: number;
    };
    actual: {
        transType: string;
        amount: number;
    };
    rule: string;
    codeTraces?: CodeTrace[];
}
export interface CsvRow {
    lineItemNo: string;
    amount: number;
    totalAmount: number;
    type: string;
    originalType?: string;
    sourceAccountType?: string;
    destinationAccountType?: string;
    [key: string]: any;
}
export interface Transaction {
    lineItemNo: string;
    transType: string;
    transactionAmt: {
        value: number;
        currencyCode?: string;
        numberOfDecimals?: number;
        guestViewable?: boolean;
    };
    transLinkId?: string;
    [key: string]: any;
}
export declare function applyBuiltInRules(csvRow: CsvRow, transaction: Transaction): BuiltInRuleResult;
/**
 * Validate PKG transaction (Rule 6).
 * PKG amount should equal sum(linked transactions by transLinkId) / 2.
 */
export declare function validatePkgTransaction(pkgTransaction: Transaction, allTransactions: Transaction[]): {
    isCorrect: boolean;
    expected: number;
    actual: number;
    linkedCount: number;
};
/**
 * Get all built-in rules as descriptive objects (for UI display).
 */
export declare function getBuiltInRulesDescription(): {
    name: string;
    expectedTransType: string;
}[];
