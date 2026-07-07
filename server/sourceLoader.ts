// Copyright (C) Agilysys, Inc. All rights reserved.

// Source File Loader (Priority 3 — Code Logic)
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Base path to the adapter source (src/)
const SRC_BASE = path.resolve(__dirname, "../../marriott-adapter-hint/src/");

const SOURCE_FILES = [
  "folio/folioResend/folioResendHandler.ts",
  "folio/folioResend/folioResendGraph.ts",
  "folio/folioResend/folioResendModel.ts",
  "folio/folioResend/folioResendConstants.ts",
  "folio/folioOutHandler.ts",
  "folio/folioOutModels.ts",
  "folio/folioGraph.ts",
  "helpers/adapterUtils.ts",
  "helpers/globals.ts",
  "folio/closeFolio/closeFolioOutHandler.ts",
  "folio/closeFolio/closeFolioModel.ts",
  "folio/profileFolio/profileFolioOutConstants.ts",
];

// In-memory cache of source file contents
const sourceCache = new Map<string, string>();

/**
 * Load all source files into memory cache
 */
export function loadSourceFiles(): void {
  sourceCache.clear();
  for (const relPath of SOURCE_FILES) {
    const fullPath = path.join(SRC_BASE, relPath);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      sourceCache.set(relPath, content);
      console.log(`[sourceLoader] Loaded: ${relPath} (${content.length} chars)`);
    } catch (err: any) {
      console.warn(`[sourceLoader] Could not load: ${relPath} — ${err.message}`);
    }
  }
}

/**
 * Get cached source file content
 */
export function getSourceFile(relPath: string): string | undefined {
  return sourceCache.get(relPath);
}

/**
 * Get all cached source files
 */
export function getAllSourceFiles(): Map<string, string> {
  return sourceCache;
}

/**
 * Get source file list
 */
export function getSourceFileList(): string[] {
  return SOURCE_FILES;
}

