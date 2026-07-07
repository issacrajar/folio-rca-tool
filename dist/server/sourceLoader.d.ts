/**
 * Load all source files into memory cache
 */
export declare function loadSourceFiles(): void;
/**
 * Get cached source file content
 */
export declare function getSourceFile(relPath: string): string | undefined;
/**
 * Get all cached source files
 */
export declare function getAllSourceFiles(): Map<string, string>;
/**
 * Get source file list
 */
export declare function getSourceFileList(): string[];
