// Copyright (C) Agilysys, Inc. All rights reserved.

// Built-in rules extracted from findMissingLines.js (Priority 1 - Highest)
// These are immutable and always take highest priority

export interface CodeTrace {
  file: string;
  method: string;
  line: string;
  explanation: string;
  category: "transType" | "amount" | "both";
}

export interface BuiltInRuleResult {
  isCorrect: boolean;
  expected: { transType: string; amount: number };
  actual: { transType: string; amount: number };
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
  transactionAmt: { value: number; currencyCode?: string; numberOfDecimals?: number; guestViewable?: boolean };
  transLinkId?: string;
  [key: string]: any;
}

interface BuiltInRule {
  name: string;
  condition: (csvRow: CsvRow) => boolean;
  expectedTransType: string;
  amountTransform: (totalAmount: number) => number;
}

// Rules from findMissingLines.js - these are ground truth
const builtInRules: BuiltInRule[] = [
  {
    name: "Rule 1: PAYMENT → SET, negate amount",
    condition: (row) => row.type === "PAYMENT",
    expectedTransType: "SET",
    amountTransform: (totalAmount) => -totalAmount,
  },
  {
    name: "Rule 2: REFUND → SET, negate amount",
    condition: (row) => row.type === "REFUND",
    expectedTransType: "SET",
    amountTransform: (totalAmount) => -totalAmount,
  },
  {
    name: "Rule 3: sourceAccountType!=null AND destinationAccountType=COMPANY → SET, negate amount",
    condition: (row) => row.sourceAccountType != null && row.destinationAccountType === "COMPANY",
    expectedTransType: "SET",
    amountTransform: (totalAmount) => -totalAmount,
  },
  {
    name: "Rule 4: TRANSFER with originalType=PAYMENT → SET, negate amount",
    condition: (row) => row.type === "TRANSFER" && row.originalType === "PAYMENT",
    expectedTransType: "SET",
    amountTransform: (totalAmount) => -totalAmount,
  },
];

const defaultRule: Omit<BuiltInRule, "condition"> = {
  name: "Rule 5: Default → NEW, keep amount",
  expectedTransType: "NEW",
  amountTransform: (totalAmount) => totalAmount,
};

/**
 * Apply built-in rules (Priority 1) to determine expected transType and amount.
 * Returns correctness check result.
 */
/**
 * Trace which FolioOutHandler code path is responsible for a mismatch.
 * Uses the CSV row (ledger data) and actual transaction to pinpoint the code.
 */
function traceCodePath(csvRow: CsvRow, transaction: Transaction, expected: { transType: string; amount: number }, actual: { transType: string; amount: number }): CodeTrace[] {
  const traces: CodeTrace[] = [];
  const FILE = "folioOutHandler.ts";
  const transTypeMismatch = expected.transType !== actual.transType;
  const amountMismatch = expected.amount !== actual.amount;

  // --- transType tracing ---
  if (transTypeMismatch) {
    // getTransactionType determines transType
    if (csvRow.type === "TRANSFER" && (csvRow.originalType === "PAYMENT" || csvRow.gatewayType === "PAYMENT")) {
      traces.push({
        file: FILE, method: "getTransactionType", line: "929-934",
        explanation: `TRANSFER with originalType/type=PAYMENT should return SET, but got "${actual.transType}". Check: folioType===TRANSFER && (type===PAYMENT || originalFolioLineType===PAYMENT) → SET`,
        category: "transType"
      });
    } else if (["PAYMENT", "REFUND"].includes(csvRow.type)) {
      traces.push({
        file: FILE, method: "getTransactionType", line: "943",
        explanation: `${csvRow.type} maps to SET via transTypes map. Actual="${actual.transType}". Check: SET: [PAYMENT, REFUND]`,
        category: "transType"
      });
    } else if (["CHARGE", "CREDIT", "TRANSFER", "ADJUSTMENT", "CORRECTION"].includes(csvRow.type)) {
      traces.push({
        file: FILE, method: "getTransactionType", line: "936-942",
        explanation: `${csvRow.type} maps to NEW via transTypes map. Actual="${actual.transType}". Check: NEW: [CHARGE, CREDIT, TRANSFER, ADJUSTMENT, CORRECTION]`,
        category: "transType"
      });
    }

    // Check if routing overrode transType
    if (csvRow.sourceAccountType || csvRow.destinationAccountType) {
      traces.push({
        file: FILE, method: "checkRoutingTransactions", line: "477-578",
        explanation: `Routing may override transType. sourceAccountType="${csvRow.sourceAccountType}", destinationAccountType="${csvRow.destinationAccountType}". If routed, transType can be changed to SET at line 571.`,
        category: "transType"
      });
    }

    // processTransactions can override transType per-transaction
    traces.push({
      file: FILE, method: "processTransactions", line: "630-635",
      explanation: `processTransactions calls getTransactionType per child transaction (line 630). If children have different types, transTypeByTransactionId map (line 636) overrides per-transaction transType at line 975.`,
      category: "transType"
    });
  }

  // --- amount tracing ---
  if (amountMismatch) {
    const absExpected = Math.abs(expected.amount);
    const absActual = Math.abs(actual.amount);
    const signFlipped = absExpected === absActual && expected.amount !== actual.amount;

    if (csvRow.type === "PAYMENT" || csvRow.originalType === "PAYMENT") {
      traces.push({
        file: FILE, method: "getFolioAmount", line: "1161-1166",
        explanation: `PAYMENT: uses Math.abs(amount) * quantity (line 1166).${signFlipped ? " Sign is flipped — check isRouted (line 1174-1176): if PAYMENT && isRouted → negate." : ` Expected=${expected.amount}, Actual=${actual.amount}.`}`,
        category: "amount"
      });
      if (csvRow.type === "TRANSFER") {
        traces.push({
          file: FILE, method: "getFolioAmount", line: "1177-1184",
          explanation: `TRANSFER+SET with transferReferenceId and no arNumber → negate via -Math.abs (line 1183). Check if transferReferenceId is present.`,
          category: "amount"
        });
      }
    } else if (csvRow.type === "REFUND") {
      traces.push({
        file: FILE, method: "getFolioAmount", line: "1167-1168",
        explanation: `REFUND: uses -Math.abs(amount) (line 1168). Expected=${expected.amount}, Actual=${actual.amount}.`,
        category: "amount"
      });
    } else {
      // Default path: amount * quantity, or reverseTaxTotalChargeAmount if reverseTax
      traces.push({
        file: FILE, method: "getFolioAmount", line: "1170-1173",
        explanation: `Default: if reverseTax → reverseTaxTotalChargeAmount, else amount*quantity (line 1172). Expected=${expected.amount}, Actual=${actual.amount}.`,
        category: "amount"
      });
    }

    // AR settlement special cases
    if (csvRow.destinationAccountType === "COMPANY" || csvRow.sourceAccountType === "COMPANY") {
      traces.push({
        file: FILE, method: "getFolioAmount", line: "1185-1193",
        explanation: `AR settlement (COMPANY account): originalFolioLineType=PAYMENT && TRANSFER+SET && arNumber → amount*quantity then negate (lines 1186-1193).`,
        category: "amount"
      });
      traces.push({
        file: FILE, method: "getFolioAmount", line: "1196-1202",
        explanation: `AR TRANSFER with CREDIT line type: arNumber && TRANSFER && originalFolioLineType=CREDIT → -Math.abs (line 1201).`,
        category: "amount"
      });
    }

    // formatFolioAmount rounding
    if (Math.abs(expected.amount - actual.amount) < 2) {
      traces.push({
        file: FILE, method: "formatFolioAmount (adapterUtils)", line: "N/A",
        explanation: `Small difference (${Math.abs(expected.amount - actual.amount)}) may be due to formatFolioAmount rounding: Math.round(parseFloat(amount) * 100).`,
        category: "amount"
      });
    }
  }

  return traces;
}

export function applyBuiltInRules(csvRow: CsvRow, transaction: Transaction): BuiltInRuleResult {
  let matched: BuiltInRule | undefined;

  for (const rule of builtInRules) {
    if (rule.condition(csvRow)) {
      matched = rule;
      break;
    }
  }

  const appliedRule = matched || { ...defaultRule, condition: () => true };
  const expectedTransType = appliedRule.expectedTransType;
  const expectedAmount = appliedRule.amountTransform(csvRow.totalAmount);

  const isCorrect =
    transaction.transType === expectedTransType &&
    transaction.transactionAmt.value === expectedAmount;

  const expected = { transType: expectedTransType, amount: expectedAmount };
  const actual = { transType: transaction.transType, amount: transaction.transactionAmt.value };

  return {
    isCorrect,
    expected,
    actual,
    rule: appliedRule.name,
    codeTraces: isCorrect ? undefined : traceCodePath(csvRow, transaction, expected, actual),
  };
}

/**
 * Validate PKG transaction (Rule 6).
 * PKG amount should equal sum(linked transactions by transLinkId) / 2.
 */
export function validatePkgTransaction(
  pkgTransaction: Transaction,
  allTransactions: Transaction[]
): { isCorrect: boolean; expected: number; actual: number; linkedCount: number } {
  const linkedTransactions = allTransactions.filter(
    (t) => t.transLinkId === pkgTransaction.lineItemNo
  );
  const linkedSum = linkedTransactions.reduce((sum, t) => sum + t.transactionAmt.value, 0);
  const expectedAmount = linkedSum / 2;

  return {
    isCorrect: pkgTransaction.transactionAmt.value === expectedAmount,
    expected: expectedAmount,
    actual: pkgTransaction.transactionAmt.value,
    linkedCount: linkedTransactions.length,
  };
}

/**
 * Get all built-in rules as descriptive objects (for UI display).
 */
export function getBuiltInRulesDescription() {
  return [
    ...builtInRules.map((r) => ({ name: r.name, expectedTransType: r.expectedTransType })),
    { name: defaultRule.name, expectedTransType: defaultRule.expectedTransType },
    { name: "Rule 6 (PKG): PKG amount = sum(linked by transLinkId) / 2", expectedTransType: "PKG" },
    { name: "Rule 7 (Extra): Transactions in payload but not in CSV (non-PKG) are extra", expectedTransType: "N/A" },
  ];
}

