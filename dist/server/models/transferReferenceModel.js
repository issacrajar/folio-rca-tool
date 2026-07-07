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
export var ReferenceFieldType;
(function (ReferenceFieldType) {
    ReferenceFieldType["ADJUSTMENT"] = "adjustmentReferenceId";
    ReferenceFieldType["REFUND"] = "refundReferenceId";
    ReferenceFieldType["SOURCE_FOLIO_LINE"] = "sourceFolioLineItemId";
    ReferenceFieldType["CORRECTION"] = "correctionReferenceId";
    ReferenceFieldType["TRANSFER"] = "transferReferenceId";
    ReferenceFieldType["TAX"] = "taxReferenceId";
})(ReferenceFieldType || (ReferenceFieldType = {}));
