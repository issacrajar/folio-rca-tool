// Copyright (C) Agilysys, Inc. All rights reserved.

/**
 * Transfer Reference Data Model (Phase 10, Task 10.1)
 * 
 * Defines the structure and types for transfer reference matching.
 * Used to validate folioTransferDetails.trnsfrFromLineItemNo against
 * multiple reference field types.
 */

/**
 * Enum of all possible reference field types in a folio line
 */
export enum ReferenceFieldType {
  ADJUSTMENT = "adjustmentReferenceId",
  REFUND = "refundReferenceId",
  SOURCE_FOLIO_LINE = "sourceFolioLineItemId",
  CORRECTION = "correctionReferenceId",
  TRANSFER = "transferReferenceId",
  TAX = "taxReferenceId",
}

/**
 * Represents a single reference field extracted from a folio line
 */
export interface TransferReference {
  /** The _id of the folio line containing this reference */
  folioLineId: string;

  /** The type of reference field (adjustmentReferenceId, refundReferenceId, etc.) */
  referenceType: ReferenceFieldType;

  /** The actual reference ID value */
  referenceValue: string;

  /** The itemId from the folio line (for matching) */
  itemId: string;

  /** The trnsfrFromLineItemNo from folioTransferDetails (the value being matched against) */
  trnsfrFromLineItemNo: string;
}

/**
 * Represents the result of validating a single transfer reference
 */
export interface TransferValidationResult {
  /** Whether the transfer reference is valid */
  isValid: boolean;

  /** Whether a match was found (true for both Case 1 and Case 2) */
  matched: boolean;

  /** Which reference type was matched (null if unmatched) */
  matchedReferenceType: ReferenceFieldType | null;

  /** The matched folio line object (null if unmatched) */
  matchedFolioLine: Record<string, any> | null;

  /** Trace of validation steps taken (for debugging) */
  validationPath: string[];

  /** Any errors encountered during validation */
  errors: string[];

  /** Which case matched (null, "SIMPLE", or "TAX_BASED") */
  matchedCase: "SIMPLE" | "TAX_BASED" | null;

  /** Time taken for validation in ms */
  validationTime?: number;
}

/**
 * Represents the result of validating all transfers in a payload
 */
export interface BatchValidationResult {
  /** Summary statistics */
  summary: {
    /** Total number of transfers validated */
    total: number;

    /** Number of transfers with successful validation */
    successful: number;

    /** Number of transfers with failed validation */
    failed: number;

    /** Number of transfers that matched neither case (unmatched) */
    unmatched: number;

    /** Success rate as a percentage (0-1) */
    successRate: number;

    /** Total validation time in ms */
    totalTime: number;

    /** Average time per transfer in ms */
    avgTimePerTransfer: number;
  };

  /** Array of successfully validated transfers */
  successful: Array<{
    folioLineId: string;
    trnsfrFromLineItemNo: string;
    matchedReferenceType: ReferenceFieldType;
    matchedCase: "SIMPLE" | "TAX_BASED";
    validationTime: number;
  }>;

  /** Array of failed transfer validations */
  failed: Array<{
    folioLineId: string;
    trnsfrFromLineItemNo: string;
    error: string;
    validationPath: string[];
    validationTime: number;
  }>;

  /** Array of unmatched transfers (no errors, but no match found) */
  unmatched: Array<{
    folioLineId: string;
    trnsfrFromLineItemNo: string;
    availableReferences: string[];
    validationPath: string[];
    validationTime: number;
  }>;

  /** Breakdown of failure reasons */
  failureReasons: Record<string, number>;
}

/**
 * Metadata for a folio line with all necessary information for validation
 */
export interface FolioLineMetadata {
  /** The _id of the folio line */
  _id: string;

  /** The itemId of the folio line */
  itemId: string;

  /** Reference fields present in this folio line */
  adjustmentReferenceId?: string;
  refundReferenceId?: string;
  sourceFolioLineItemId?: string;
  correctionReferenceId?: string;
  transferReferenceId?: string;
  taxReferenceId?: string;

  /** The folio transfer details (if present) */
  folioTransferDetails?: FolioTransferDetails[];

  /** Nested ledger transactions (for Case 2 lookups) */
  ledgerTransactions?: Record<string, any>[];

  /** Full folio line object (for returning matched lines) */
  fullObject?: Record<string, any>;
}

/**
 * Represents folioTransferDetails structure
 */
export interface FolioTransferDetails {
  /** Line item number being transferred from */
  trnsfrFromLineItemNo: string;

  /** Folio window ID (optional) */
  folioWindowId?: string;

  /** Transfer reference ID (optional) */
  transferReferenceId?: string;

  /** Type of folio (CHARGE, PAYMENT, etc.) */
  folioType?: string;
}

/**
 * Represents a folio line with transfer details (extended structure)
 */
export interface FolioLineWithTransfers extends FolioLineMetadata {
  folioTransferDetails: FolioTransferDetails[];
  folioLines?: FolioLineMetadata[];
  ledgerTransactions?: Record<string, any>[];
}

