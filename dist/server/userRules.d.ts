export interface UserRule {
    conditions: {
        field: string;
        value: string;
    }[];
    actions: {
        field: string;
        value: string;
    }[];
    raw: string;
}
export interface RuleApplicationLog {
    ruleIndex: number;
    rule: string;
    matched: boolean;
    changes: {
        field: string;
        before: any;
        after: any;
    }[];
}
/**
 * Read rules text from rules.txt
 */
export declare function getRules(): string;
/**
 * Save rules text to rules.txt
 */
export declare function saveRules(text: string): void;
/**
 * Parse rules from IF...THEN format
 */
export declare function parseRules(text: string): UserRule[];
/**
 * Apply user rules to a transaction. Returns modified transaction + log.
 */
export declare function applyUserRules(transaction: Record<string, any>): {
    result: Record<string, any>;
    log: RuleApplicationLog[];
};
