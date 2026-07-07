interface TenantInfo {
    tenantId: string;
    propertyId: string;
    propertyCode: string;
    tenantCode: string;
    region: string;
    propertyName: string;
}
/**
 * Load tenantList.xlsx at startup and build the PropertyCode lookup map.
 */
export declare function loadTenantList(): void;
/**
 * Extract PropertyCode and chargePostingSequenceNumber from a folioId string.
 * Format: "JAXFW_Stay PMS_1000345_01_2026-04-04T10:17:10.904Z"
 *          ^^^^^                ^^^^^^^
 *     PropertyCode     chargePostingSeqNum
 */
export declare function parseFolioId(folioId: string): {
    propertyCode: string;
    chargePostingSequenceNumber: string;
};
/**
 * Look up tenant info from PropertyCode.
 */
export declare function lookupTenant(propertyCode: string): TenantInfo | undefined;
/**
 * Get all loaded tenants (for the UI dropdown).
 */
export declare function getAllTenants(): TenantInfo[];
/**
 * Generate the MongoDB aggregation query to extract ledger transactions for a folio.
 * This replaces the need for a manually-exported CSV/Excel.
 */
export declare function generateMongoQuery(tenantId: string, propertyId: string, accountId: string): {
    queryString: string;
    queryObject: any[];
};
/**
 * Generate the account lookup query.
 */
export declare function generateAccountLookupQuery(tenantId: string, chargePostingSequenceNumber: string): string;
/**
 * All-in-one: from folioTransactions JSON, generate both the account lookup query
 * and the full aggregation query template (with accountId placeholder).
 */
export declare function autoGenerateQueries(folioTransactions: any[]): {
    propertyCode: string;
    chargePostingSequenceNumber: string;
    tenant: TenantInfo | null;
    accountLookupQuery: string;
    mongoAggregationQuery: string;
    mongoAggregationQueryWithPlaceholder: string;
    folioNumber: string;
};
export {};
