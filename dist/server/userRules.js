// Copyright (C) Agilysys, Inc. All rights reserved.
// User Rules File Reader/Writer (Priority 2)
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = path.resolve(__dirname, "../rules/rules.txt");
/**
 * Read rules text from rules.txt
 */
export function getRules() {
    try {
        return fs.readFileSync(RULES_FILE, "utf-8");
    }
    catch {
        return "";
    }
}
/**
 * Save rules text to rules.txt
 */
export function saveRules(text) {
    fs.mkdirSync(path.dirname(RULES_FILE), { recursive: true });
    fs.writeFileSync(RULES_FILE, text, "utf-8");
}
/**
 * Parse rules from IF...THEN format
 */
export function parseRules(text) {
    const rules = [];
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const line of lines) {
        const match = line.match(/^IF\s+(.+?)\s+THEN\s+(.+)$/i);
        if (!match)
            continue;
        const conditionStr = match[1];
        const actionStr = match[2];
        const conditions = conditionStr.split(/\s+AND\s+/i).map((c) => {
            const [field, value] = c.split("=");
            return { field: field.trim(), value: value.trim() };
        });
        const actions = actionStr.split(/\s+AND\s+/i).map((a) => {
            const [field, value] = a.split("=");
            return { field: field.trim(), value: value.trim() };
        });
        rules.push({ conditions, actions, raw: line });
    }
    return rules;
}
/**
 * Check if a transaction matches all conditions of a rule
 */
function matchesConditions(transaction, conditions) {
    return conditions.every(({ field, value }) => {
        const actual = String(transaction[field] ?? "");
        return actual === value;
    });
}
/**
 * Apply user rules to a transaction. Returns modified transaction + log.
 */
export function applyUserRules(transaction) {
    const rulesText = getRules();
    const rules = parseRules(rulesText);
    const result = { ...transaction };
    const log = [];
    rules.forEach((rule, index) => {
        const matched = matchesConditions(result, rule.conditions);
        const changes = [];
        if (matched) {
            for (const action of rule.actions) {
                const before = result[action.field];
                if (action.value === "NEGATE" && action.field === "amount") {
                    result.transactionAmt = {
                        ...result.transactionAmt,
                        value: -Math.abs(result.transactionAmt?.value ?? 0),
                    };
                    changes.push({ field: "transactionAmt.value", before: result.transactionAmt?.value, after: -Math.abs(result.transactionAmt?.value ?? 0) });
                }
                else {
                    result[action.field] = action.value;
                    changes.push({ field: action.field, before, after: action.value });
                }
            }
        }
        log.push({ ruleIndex: index, rule: rule.raw, matched, changes });
    });
    return { result, log };
}
