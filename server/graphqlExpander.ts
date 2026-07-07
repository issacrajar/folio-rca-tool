// Copyright (C) Agilysys, Inc. All rights reserved.

// GraphQL Fragment Extractor & Query Expander
import { getSourceFile } from "./sourceLoader.js";

const fragmentCache = new Map<string, string>();

// Fragment names we need to extract from folioGraph.ts
const FRAGMENT_NAMES = [
  "commonTransactionFields",
  "commonFields",
  "wholeReferenceTransaction",
  "ledgerTransactionPlayerDetail",
  "paymentSettings",
];

/**
 * Extract exported const template literals from a TypeScript source file.
 * Handles backtick-delimited strings: export const name = `...`;
 */
function extractTemplateLiterals(source: string): Map<string, string> {
  const result = new Map<string, string>();
  // Match: export const <name> = `<content>`;
  const regex = /export\s+const\s+(\w+)\s*=\s*`([\s\S]*?)`;/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    result.set(match[1], match[2]);
  }
  return result;
}

/**
 * Load and parse GraphQL fragments from folioGraph.ts
 */
export function loadFragments(): void {
  fragmentCache.clear();
  const graphSource = getSourceFile("folio/folioGraph.ts");
  if (!graphSource) {
    console.warn("[fragmentExtractor] folioGraph.ts not loaded");
    return;
  }

  const literals = extractTemplateLiterals(graphSource);
  for (const name of FRAGMENT_NAMES) {
    const content = literals.get(name);
    if (content) {
      fragmentCache.set(name, content);
      console.log(`[fragmentExtractor] Extracted fragment: ${name} (${content.length} chars)`);
    } else {
      console.warn(`[fragmentExtractor] Fragment not found: ${name}`);
    }
  }

  // Resolve nested references within fragments
  resolveNestedReferences();
}

/**
 * Recursively resolve ${fragmentName} references within fragments
 */
function resolveNestedReferences(): void {
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 10) {
    changed = false;
    iterations++;
    for (const [name, content] of fragmentCache) {
      const resolved = content.replace(/\$\{(\w+)\}/g, (_match, ref) => {
        const refContent = fragmentCache.get(ref);
        if (refContent && refContent !== content) {
          changed = true;
          return refContent;
        }
        return _match;
      });
      fragmentCache.set(name, resolved);
    }
  }
}

/**
 * Get a resolved fragment by name
 */
export function getFragment(name: string): string | undefined {
  return fragmentCache.get(name);
}

/**
 * Get all fragments
 */
export function getAllFragments(): Map<string, string> {
  return fragmentCache;
}

// Query names from folioResendGraph.ts
interface ExpandedQueries {
  guest: string;
  group: string;
  house: string;
}

const expandedQueries: ExpandedQueries = { guest: "", group: "", house: "" };

/**
 * Extract a named gql query from source: `export const <name> = gql\`...\`;`
 * Handles nested backticks by counting ${} interpolations and matching the final closing backtick + ;
 */
function extractNamedGqlQuery(source: string, varName: string): string | null {
  const marker = `export const ${varName} = gql\``;
  const startIdx = source.indexOf(marker);
  if (startIdx === -1) return null;

  const contentStart = startIdx + marker.length;
  // Find the closing backtick: scan forward, handling ${...} interpolations
  let i = contentStart;
  while (i < source.length) {
    if (source[i] === '`') {
      // Found closing backtick
      return source.slice(contentStart, i);
    }
    if (source[i] === '$' && source[i + 1] === '{') {
      // Skip the interpolation — find matching }
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return null;
}

/**
 * Resolve all ${ref} placeholders in a string using local literals + fragmentCache
 */
function resolveAllRefs(content: string, localLiterals: Map<string, string>, depth = 0): string {
  if (depth > 10) return content;
  return content.replace(/\$\{(\w+)\}/g, (_match, ref) => {
    const replacement = localLiterals.get(ref) ?? fragmentCache.get(ref);
    if (replacement) {
      // Recursively resolve in case the replacement itself has refs
      return resolveAllRefs(replacement, localLiterals, depth + 1);
    }
    return `/* UNRESOLVED: ${ref} */`;
  });
}

/**
 * Extract and expand GraphQL queries from folioResendGraph.ts
 */
export function expandQueries(): void {
  const resendGraphSource = getSourceFile("folio/folioResend/folioResendGraph.ts");
  if (!resendGraphSource) {
    console.warn("[queryExpander] folioResendGraph.ts not loaded");
    return;
  }

  // Extract all local template literals (nodes, propertyQuery, etc.)
  const localLiterals = extractTemplateLiterals(resendGraphSource);
  console.log(`[queryExpander] Found ${localLiterals.size} local template literals: ${[...localLiterals.keys()].join(", ")}`);

  // Extract the three named gql queries
  const queryMap: { key: keyof ExpandedQueries; varName: string }[] = [
    { key: "guest", varName: "resendGuestFolioQuery" },
    { key: "group", varName: "resendGroupFolioQuery" },
    { key: "house", varName: "resendHouseAccountQuery" },
  ];

  for (const { key, varName } of queryMap) {
    const raw = extractNamedGqlQuery(resendGraphSource, varName);
    if (raw) {
      expandedQueries[key] = resolveAllRefs(raw, localLiterals);
      console.log(`[queryExpander] Expanded ${key} (${varName}): ${expandedQueries[key].length} chars`);
    } else {
      console.warn(`[queryExpander] Could not extract: ${varName}`);
    }
  }
}

/**
 * Get expanded query by account type
 */
export function getExpandedQuery(accountType: "guest" | "group" | "house"): string {
  return expandedQueries[accountType] || "";
}

/**
 * Build query variables template for account type
 */
export function buildVariablesTemplate(
  accountType: "guest" | "group" | "house",
  params: {
    confirmationNumber?: string;
    folioNumber?: string;
    houseAccountNumber?: string;
    propertyId?: string;
  }
): Record<string, any> {
  if (accountType === "house") {
    return {
      number: [params.houseAccountNumber ?? ""],
      propertyByIdId: params.propertyId ?? "",
    };
  }

  // Guest and Group use the same structure
  return {
    thirdPartyConfirmationInput: {
      confirmationName: "ACRS",
      confirmationNumber: params.confirmationNumber ?? "",
    },
    accountIdentity: {
      chargePostingSequenceNumber: params.folioNumber
        ? Number(params.folioNumber + "01")
        : 0,
    },
    propertyByIdId: params.propertyId ?? "",
  };
}

