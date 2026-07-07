// Copyright (C) Agilysys, Inc. All rights reserved.

/**
 * Transfer Validation Test Fixtures
 * 
 * Sample data for testing all scenarios:
 * - Case 1 (simple matches)
 * - Case 2 (tax-based indirect matches)
 * - Failed validations
 * - Unmatched transfers
 * - Edge cases
 */

/**
 * Case 1 Success: Simple refund reference match
 */
export const case1SimpleMatch = {
  folioId: 'FOL100',
  folioTransactionDetails: [
    {
      _id: 'LINE_001',
      itemId: 'ITEM_001',
      type: 'REFUND',
      adjustmentReferenceId: null,
      refundReferenceId: null,
      sourceFolioLineItemId: null,
      correctionReferenceId: null,
      transferReferenceId: null,
      taxReferenceId: null,
      folioTransferDetails: [
        {
          trnsfrFromLineItemNo: 'REFUND_SOURCE',
          folioWindowId: 'WIN_001',
          transferReferenceId: null,
          folioType: 'REFUND',
        },
      ],
    },
    {
      _id: 'REFUND_SOURCE',
      itemId: 'ITEM_REF',
      type: 'CHARGE',
      adjustmentReferenceId: null,
      refundReferenceId: null,
      sourceFolioLineItemId: null,
      correctionReferenceId: null,
      transferReferenceId: null,
      taxReferenceId: null,
      folioTransferDetails: [],
    },
  ],
};

/**
 * Case 1 Success: Adjustment reference match
 */
export const case1AdjustmentMatch = {
  folioId: 'FOL101',
  folioTransactionDetails: [
    {
      _id: 'LINE_ADJ_001',
      itemId: 'ITEM_ADJ_001',
      type: 'ADJUSTMENT',
      adjustmentReferenceId: 'ORIG_CHARGE_ID',
      refundReferenceId: null,
      sourceFolioLineItemId: null,
      correctionReferenceId: null,
      transferReferenceId: null,
      taxReferenceId: null,
      folioTransferDetails: [
        {
          trnsfrFromLineItemNo: 'ORIG_CHARGE_ID',
          folioWindowId: 'WIN_002',
        },
      ],
    },
  ],
};

/**
 * Case 2 Success: Tax-based indirect match
 * 6-step process:
 * 1. Start with TAX_LINE (has taxReferenceId: SOURCE_LINE)
 * 2. Find SOURCE_LINE (_id matches taxReferenceId)
 * 3. SOURCE_LINE has refundReferenceId: REF_001
 * 4. Find ledger transaction with REF_001
 * 5. Find folio line in ledger with itemId matching TAX_LINE's itemId
 * 6. Verify that line's _id equals trnsfrFromLineItemNo
 */
export const case2TaxBasedMatch = {
  folios: [
    {
      folioId: 'FOL200',
      folioTransactionDetails: [
        {
          _id: 'TAX_LINE',
          itemId: 'ITEM_TAX',
          type: 'TAX',
          adjustmentReferenceId: null,
          refundReferenceId: null,
          sourceFolioLineItemId: null,
          correctionReferenceId: null,
          transferReferenceId: null,
          taxReferenceId: 'SOURCE_LINE', // Points to another line
          folioTransferDetails: [
            {
              trnsfrFromLineItemNo: 'TARGET_LINE_ID', // Will be found in ledger
              folioWindowId: 'WIN_003',
            },
          ],
        },
        {
          _id: 'SOURCE_LINE', // Referenced by taxReferenceId
          itemId: 'ITEM_SOURCE',
          type: 'CHARGE',
          adjustmentReferenceId: null,
          refundReferenceId: 'REF_001', // Has reference for ledger lookup
          sourceFolioLineItemId: null,
          correctionReferenceId: null,
          transferReferenceId: null,
          taxReferenceId: null,
          folioTransferDetails: [],
          ledgerTransactions: [
            {
              _id: 'LEDGER_TXN_001',
              folioLines: [
                {
                  _id: 'TARGET_LINE_ID', // Must match trnsfrFromLineItemNo
                  itemId: 'ITEM_TAX', // Must match TAX_LINE's itemId
                  refundReferenceId: 'REF_001',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/**
 * Failed Validation: No matching reference
 */
export const failedNoMatch = {
  folioId: 'FOL300',
  folioTransactionDetails: [
    {
      _id: 'FAIL_LINE_001',
      itemId: 'ITEM_FAIL_001',
      type: 'TRANSFER',
      adjustmentReferenceId: null, // All null
      refundReferenceId: null,
      sourceFolioLineItemId: null,
      correctionReferenceId: null,
      transferReferenceId: null,
      taxReferenceId: null,
      folioTransferDetails: [
        {
          trnsfrFromLineItemNo: 'NONEXISTENT_REF', // Won't match anything
        },
      ],
    },
  ],
};

/**
 * Failed Validation: Tax reference not found
 */
export const failedTaxRefNotFound = {
  folioId: 'FOL301',
  folioTransactionDetails: [
    {
      _id: 'FAIL_TAX_LINE',
      itemId: 'ITEM_FAIL_TAX',
      type: 'TAX',
      adjustmentReferenceId: null,
      refundReferenceId: null,
      sourceFolioLineItemId: null,
      correctionReferenceId: null,
      transferReferenceId: null,
      taxReferenceId: 'NONEXISTENT_TAX_REF', // Not found in any folio
      folioTransferDetails: [
        {
          trnsfrFromLineItemNo: 'SOME_LINE',
        },
      ],
    },
  ],
};

/**
 * Unmatched Transfer: Has references but doesn't match trnsfrFromLineItemNo
 */
export const unmatchedTransfer = {
  folioId: 'FOL302',
  folioTransactionDetails: [
    {
      _id: 'UNMATCH_LINE',
      itemId: 'ITEM_UNMATCH',
      type: 'CHARGE',
      adjustmentReferenceId: 'ADJ_REF_001',
      refundReferenceId: 'REFUND_REF_001',
      sourceFolioLineItemId: null,
      correctionReferenceId: null,
      transferReferenceId: null,
      taxReferenceId: null,
      folioTransferDetails: [
        {
          trnsfrFromLineItemNo: 'LOOKING_FOR_THIS', // Doesn't match adj or refund refs
        },
      ],
    },
  ],
};

/**
 * Complete batch with mixed scenarios
 */
export const mixedBatch = {
  folios: [
    // Case 1 Success
    {
      folioId: 'FOL_BATCH_001',
      folioTransactionDetails: [
        {
          _id: 'CASE1_LINE_001',
          itemId: 'ITEM_CASE1_001',
          type: 'REFUND',
          adjustmentReferenceId: null,
          refundReferenceId: 'SOURCE_001',
          sourceFolioLineItemId: null,
          correctionReferenceId: null,
          transferReferenceId: null,
          taxReferenceId: null,
          folioTransferDetails: [
            {
              trnsfrFromLineItemNo: 'SOURCE_001',
            },
          ],
        },
      ],
    },
    // Case 1 Success (different ref type)
    {
      folioId: 'FOL_BATCH_002',
      folioTransactionDetails: [
        {
          _id: 'CASE1_LINE_002',
          itemId: 'ITEM_CASE1_002',
          type: 'ADJUSTMENT',
          adjustmentReferenceId: 'ORIGINAL_CHARGE',
          refundReferenceId: null,
          sourceFolioLineItemId: null,
          correctionReferenceId: null,
          transferReferenceId: null,
          taxReferenceId: null,
          folioTransferDetails: [
            {
              trnsfrFromLineItemNo: 'ORIGINAL_CHARGE',
            },
          ],
        },
      ],
    },
    // Failed: No match
    {
      folioId: 'FOL_BATCH_003',
      folioTransactionDetails: [
        {
          _id: 'FAIL_LINE_001',
          itemId: 'ITEM_FAIL_001',
          type: 'TRANSFER',
          adjustmentReferenceId: null,
          refundReferenceId: null,
          sourceFolioLineItemId: null,
          correctionReferenceId: null,
          transferReferenceId: null,
          taxReferenceId: null,
          folioTransferDetails: [
            {
              trnsfrFromLineItemNo: 'NONEXISTENT',
            },
          ],
        },
      ],
    },
    // Unmatched: Has refs but no match
    {
      folioId: 'FOL_BATCH_004',
      folioTransactionDetails: [
        {
          _id: 'UNMATCH_LINE_001',
          itemId: 'ITEM_UNMATCH_001',
          type: 'CHARGE',
          adjustmentReferenceId: 'ADJ_123',
          refundReferenceId: 'REF_456',
          sourceFolioLineItemId: null,
          correctionReferenceId: null,
          transferReferenceId: null,
          taxReferenceId: null,
          folioTransferDetails: [
            {
              trnsfrFromLineItemNo: 'LOOKING_FOR_THIS',
            },
          ],
        },
      ],
    },
  ],
};

/**
 * Edge Case: Whitespace handling
 * Should match despite whitespace (trimmed)
 */
export const edgeCaseWhitespace = {
  folioId: 'FOL_EDGE_WS',
  folioTransactionDetails: [
    {
      _id: 'EDGE_WS_LINE',
      itemId: 'ITEM_WS',
      type: 'CHARGE',
      adjustmentReferenceId: 'REF_WITH_SPACES',
      refundReferenceId: null,
      sourceFolioLineItemId: null,
      correctionReferenceId: null,
      transferReferenceId: null,
      taxReferenceId: null,
      folioTransferDetails: [
        {
          // Has leading/trailing spaces - should still match
          trnsfrFromLineItemNo: '  REF_WITH_SPACES  ',
        },
      ],
    },
  ],
};

/**
 * Edge Case: Multiple references present
 * Should match on first one found
 */
export const edgeCaseMultipleRefs = {
  folioId: 'FOL_EDGE_MULTI',
  folioTransactionDetails: [
    {
      _id: 'EDGE_MULTI_LINE',
      itemId: 'ITEM_MULTI',
      type: 'CHARGE',
      adjustmentReferenceId: 'ADJ_REF',
      refundReferenceId: 'REFUND_REF',
      sourceFolioLineItemId: 'SOURCE_REF',
      correctionReferenceId: null,
      transferReferenceId: null,
      taxReferenceId: null,
      folioTransferDetails: [
        {
          // Matches adjustmentReferenceId (first in priority order)
          trnsfrFromLineItemNo: 'ADJ_REF',
        },
      ],
    },
  ],
};

/**
 * Expected validation results for all test cases
 */
export const expectedResults = {
  case1SimpleMatch: {
    matched: true,
    matchedCase: 'SIMPLE',
    isValid: true,
    matchedReferenceType: 'refundReferenceId',
  },
  case1AdjustmentMatch: {
    matched: true,
    matchedCase: 'SIMPLE',
    isValid: true,
    matchedReferenceType: 'adjustmentReferenceId',
  },
  case2TaxBasedMatch: {
    matched: true,
    matchedCase: 'TAX_BASED',
    isValid: true,
    matchedReferenceType: 'refundReferenceId',
  },
  failedNoMatch: {
    matched: false,
    matchedCase: null,
    isValid: false,
    errors: ['No matching references found'],
  },
  failedTaxRefNotFound: {
    matched: false,
    matchedCase: null,
    isValid: false,
    errors: ['Tax reference not found'],
  },
  unmatchedTransfer: {
    matched: false,
    matchedCase: null,
    isValid: false,
    availableReferences: ['ADJ_REF_001', 'REFUND_REF_001'],
  },
  edgeCaseWhitespace: {
    matched: true,
    matchedCase: 'SIMPLE',
    isValid: true,
    matchedReferenceType: 'adjustmentReferenceId',
    note: 'Whitespace trimmed successfully',
  },
  edgeCaseMultipleRefs: {
    matched: true,
    matchedCase: 'SIMPLE',
    isValid: true,
    matchedReferenceType: 'adjustmentReferenceId',
    note: 'Matched on first reference in priority order',
  },
};

/**
 * Batch validation expected results
 */
export const mixedBatchExpectedResults = {
  total: 4,
  successful: 2,
  failed: 1,
  unmatched: 1,
  successRate: 0.5,
  failureReasons: {
    'No matching reference found': 1,
    'References present but no match': 1,
  },
};

/**
 * Helper function to get all test data
 */
export function getAllTestFixtures(): Record<string, any> {
  return {
    case1SimpleMatch,
    case1AdjustmentMatch,
    case2TaxBasedMatch,
    failedNoMatch,
    failedTaxRefNotFound,
    unmatchedTransfer,
    edgeCaseWhitespace,
    edgeCaseMultipleRefs,
    mixedBatch,
  };
}

/**
 * Helper to get expected results
 */
export function getExpectedResults(): Record<string, any> {
  return expectedResults;
}

/**
 * Helper to validate test results against expectations
 */
export function validateTestResult(
  testName: string,
  actualResult: Record<string, any>,
  expectedResult: Record<string, any>
): { passed: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const [key, expectedValue] of Object.entries(expectedResult)) {
    const actualValue = actualResult[key];

    if (typeof expectedValue === 'object' && expectedValue !== null) {
      if (typeof actualValue !== 'object') {
        errors.push(`${key}: expected object, got ${typeof actualValue}`);
      }
    } else if (actualValue !== expectedValue) {
      errors.push(
        `${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`
      );
    }
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}

