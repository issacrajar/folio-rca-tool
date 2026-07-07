/**
 * Check if Ollama is running
 */
export declare function isOllamaAvailable(): Promise<boolean>;
/**
 * Build LLM context from source code and transaction data
 */
export declare function buildLlmContext(transactionData: any, codePathTrace: any): string;
/**
 * Call Ollama API for analysis
 */
export declare function analyzeWithLlm(transactionData: any, codePathTrace: any, model?: string): Promise<string>;
