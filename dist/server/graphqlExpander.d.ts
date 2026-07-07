/**
 * Load and parse GraphQL fragments from folioGraph.ts
 */
export declare function loadFragments(): void;
/**
 * Get a resolved fragment by name
 */
export declare function getFragment(name: string): string | undefined;
/**
 * Get all fragments
 */
export declare function getAllFragments(): Map<string, string>;
/**
 * Extract and expand GraphQL queries from folioResendGraph.ts
 */
export declare function expandQueries(): void;
/**
 * Get expanded query by account type
 */
export declare function getExpandedQuery(accountType: "guest" | "group" | "house"): string;
/**
 * Build query variables template for account type
 */
export declare function buildVariablesTemplate(accountType: "guest" | "group" | "house", params: {
    confirmationNumber?: string;
    folioNumber?: string;
    houseAccountNumber?: string;
    propertyId?: string;
}): Record<string, any>;
