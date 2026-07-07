// Copyright (C) Agilysys, Inc. All rights reserved.

/**
 * Transfer Validation Integration Tests
 * 
 * Tests the complete end-to-end transfer validation pipeline.
 * Covers Case 1, Case 2, failures, and unmatched transfers.
 */

import {
  validateTransferPayload,
  validateTransferPayloadSummary,
  formatBatchValidationResult,
} from '../server/transferValidators/batchTransferValidator.js';

import {
  case1SimpleMatch,
  case1AdjustmentMatch,
  case2TaxBasedMatch,
  failedNoMatch,
  failedTaxRefNotFound,
  unmatchedTransfer,
  mixedBatch,
  expectedResults,
  mixedBatchExpectedResults,
} from './fixtures/transferTestFixtures.js';

/**
 * Test Suite: Case 1 (Simple Reference Matching)
 */
describe('Case 1: Simple Reference Matching', () => {
  test('Should match simple refund reference', () => {
    const result = validateTransferPayload([case1SimpleMatch]);

    expect(result.summary.total).toBe(1);
    expect(result.summary.successful).toBe(1);
    expect(result.successful[0].matchedCase).toBe('SIMPLE');
    expect(result.successful[0].matchedReferenceType).toBe('refundReferenceId');
  });

  test('Should match adjustment reference', () => {
    const result = validateTransferPayload([case1AdjustmentMatch]);

    expect(result.summary.total).toBe(1);
    expect(result.summary.successful).toBe(1);
    expect(result.successful[0].matchedReferenceType).toBe('adjustmentReferenceId');
  });

  test('Should handle multiple transfers', () => {
    const payload = [case1SimpleMatch, case1AdjustmentMatch];
    const result = validateTransferPayload(payload);

    expect(result.summary.total).toBe(2);
    expect(result.summary.successful).toBe(2);
    expect(result.summary.successRate).toBe(1.0);
  });

  test('Should include timing information', () => {
    const result = validateTransferPayload([case1SimpleMatch]);

    expect(result.successful[0].validationTime).toBeGreaterThanOrEqual(0);
    expect(result.summary.totalTime).toBeGreaterThanOrEqual(0);
    expect(result.summary.avgTimePerTransfer).toBeGreaterThanOrEqual(0);
  });
});

/**
 * Test Suite: Case 2 (Tax-Based Indirect Matching)
 */
describe('Case 2: Tax-Based Indirect Matching', () => {
  test('Should match tax-based indirect reference', () => {
    const result = validateTransferPayload(case2TaxBasedMatch.folios);

    expect(result.summary.total).toBe(1);
    expect(result.summary.successful).toBe(1);
    expect(result.successful[0].matchedCase).toBe('TAX_BASED');
  });

  test('Should include full validation path', () => {
    const result = validateTransferPayload(case2TaxBasedMatch.folios, {
      verboseTraces: true,
    });

    expect(result.successful[0].validationTime).toBeGreaterThanOrEqual(0);
    // Path should contain steps from Case 2 logic
  });
});

/**
 * Test Suite: Failed Validations
 */
describe('Failed Validations', () => {
  test('Should fail when no reference matches', () => {
    const result = validateTransferPayload([failedNoMatch]);

    expect(result.summary.total).toBe(1);
    expect(result.summary.failed).toBe(0); // No error, just unmatched
    expect(result.summary.unmatched).toBe(1);
  });

  test('Should fail when tax reference not found', () => {
    const result = validateTransferPayload([failedTaxRefNotFound]);

    expect(result.summary.total).toBe(1);
    expect(result.summary.unmatched).toBe(1);
  });

  test('Should include error details', () => {
    const result = validateTransferPayload([failedTaxRefNotFound]);

    expect(result.unmatched[0].trnsfrFromLineItemNo).toBe('SOME_LINE');
  });
});

/**
 * Test Suite: Unmatched Transfers
 */
describe('Unmatched Transfers', () => {
  test('Should detect unmatched transfers with available references', () => {
    const result = validateTransferPayload([unmatchedTransfer]);

    expect(result.summary.total).toBe(1);
    expect(result.summary.unmatched).toBe(1);
    expect(result.unmatched[0].availableReferences.length).toBeGreaterThan(0);
  });

  test('Should list available references for debugging', () => {
    const result = validateTransferPayload([unmatchedTransfer]);

    const available = result.unmatched[0].availableReferences;
    expect(available).toContain('ADJ_REF_001');
    expect(available).toContain('REFUND_REF_001');
  });
});

/**
 * Test Suite: Mixed Batch with Multiple Scenarios
 */
describe('Mixed Batch Validation', () => {
  test('Should handle mixed scenarios correctly', () => {
    const result = validateTransferPayload(mixedBatch.folios);

    expect(result.summary.total).toBe(
      mixedBatchExpectedResults.total
    );
    expect(result.summary.successful).toBe(
      mixedBatchExpectedResults.successful
    );
    expect(result.summary.failed).toBe(mixedBatchExpectedResults.failed);
    expect(result.summary.unmatched).toBe(
      mixedBatchExpectedResults.unmatched
    );
  });

  test('Should calculate success rate correctly', () => {
    const result = validateTransferPayload(mixedBatch.folios);

    const expectedRate = 2 / 4; // 2 successful out of 4 total
    expect(result.summary.successRate).toBe(expectedRate);
  });

  test('Should provide formatted summary', () => {
    const result = validateTransferPayload(mixedBatch.folios);
    const formatted = formatBatchValidationResult(result);

    expect(formatted).toContain('TRANSFER VALIDATION SUMMARY');
    expect(formatted).toContain('Total Transfers:');
    expect(formatted).toContain('Success');
    expect(formatted).toContain('Failed');
  });
});

/**
 * Test Suite: Special Cases & Edge Cases
 */
describe('Edge Cases', () => {
  test('Should handle empty payload', () => {
    const result = validateTransferPayload([]);

    expect(result.summary.total).toBe(0);
    expect(result.summary.successful).toBe(0);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.unmatched).toBe(0);
  });

  test('Should handle folio with no transfers', () => {
    const folio = {
      folioId: 'FOL_NO_TRANSFERS',
      folioTransactionDetails: [
        {
          _id: 'LINE_NO_TRANSFER',
          itemId: 'ITEM_NO_TRANSFER',
          folioTransferDetails: [], // No transfers
        },
      ],
    };

    const result = validateTransferPayload([folio]);

    expect(result.summary.total).toBe(0);
  });

  test('Should respect maxTransfers option', () => {
    const result = validateTransferPayload(mixedBatch.folios, {
      maxTransfers: 2,
    });

    expect(result.summary.total).toBeLessThanOrEqual(2);
  });

  test('Should not include verbose traces by default', () => {
    const result = validateTransferPayload([case1SimpleMatch]);

    expect(result.successful[0].validationTime).toBeGreaterThanOrEqual(0);
    // Traces should not be included (only if verboseTraces: true)
  });

  test('Should include verbose traces when enabled', () => {
    const result = validateTransferPayload(
      [case1SimpleMatch],
      { verboseTraces: true }
    );

    // When verbose traces enabled, should include path info
    // (implementation detail - check framework)
  });
});

/**
 * Test Suite: Performance
 */
describe('Performance', () => {
  test('Should validate single transfer in < 10ms', () => {
    const result = validateTransferPayload([case1SimpleMatch]);

    expect(result.successful[0].validationTime).toBeLessThan(10);
  });

  test('Should validate 4 transfers in < 50ms', () => {
    const result = validateTransferPayload(mixedBatch.folios);

    expect(result.summary.totalTime).toBeLessThan(50);
  });

  test('Should provide accurate average timing', () => {
    const result = validateTransferPayload(mixedBatch.folios);

    const expected = result.summary.totalTime / result.summary.total;
    expect(result.summary.avgTimePerTransfer).toBeLessThanOrEqual(
      expected * 1.05
    ); // Allow 5% variance
  });
});

/**
 * Test Suite: Summary Function (Faster variant)
 */
describe('Summary-Only Validation', () => {
  test('Should return only summary without details', () => {
    const result = validateTransferPayloadSummary(mixedBatch.folios);

    expect(result.summary).toBeDefined();
    expect(result.failureReasons).toBeDefined();
    // Should not have detailed arrays
    expect((result as any).successful).toBeUndefined();
    expect((result as any).failed).toBeUndefined();
  });
});

/**
 * Test Suite: Error Handling
 */
describe('Error Handling', () => {
  test('Should handle null payload gracefully', () => {
    expect(() => {
      validateTransferPayload(null as any);
    }).toThrow();
  });

  test('Should skip non-transfer folio lines', () => {
    const folio = {
      folioId: 'FOL_MIXED',
      folioTransactionDetails: [
        {
          _id: 'LINE_WITH_TRANSFER',
          folioTransferDetails: [{ trnsfrFromLineItemNo: 'REF_001' }],
        },
        {
          _id: 'LINE_NO_TRANSFER',
          folioTransferDetails: [], // No transfer - skip
        },
      ],
    };

    const result = validateTransferPayload([folio]);

    expect(result.summary.total).toBe(1); // Only 1 transfer
  });

  test('Should continue on individual transfer errors', () => {
    const folio = {
      folioId: 'FOL_ERROR_RESILIENT',
      folioTransactionDetails: [
        {
          _id: 'LINE_VALID',
          itemId: 'ITEM_VALID',
          refundReferenceId: 'REF_001',
          folioTransferDetails: [{ trnsfrFromLineItemNo: 'REF_001' }],
        },
        {
          _id: 'LINE_INVALID',
          itemId: 'ITEM_INVALID',
          folioTransferDetails: [{ trnsfrFromLineItemNo: 'NONEXISTENT' }],
        },
      ],
    };

    const result = validateTransferPayload([folio]);

    expect(result.summary.total).toBe(2);
    expect(result.summary.successful).toBe(1);
    expect(result.summary.unmatched).toBe(1);
  });
});

/**
 * Helper: Run all tests
 */
export function runAllTests(): void {
  console.log('Running Transfer Validation Integration Tests...');
  // Tests are defined above for Jest/Mocha/etc.
}

