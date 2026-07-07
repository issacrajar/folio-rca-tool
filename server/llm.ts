// Copyright (C) Agilysys, Inc. All rights reserved.

// LLM Integration — Ollama wrapper
import { getSourceFile } from "./sourceLoader.js";
import { getExpandedQuery } from "./graphqlExpander.js";

const OLLAMA_URL = "http://localhost:11434";

/**
 * Check if Ollama is running
 */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Build LLM context from source code and transaction data
 */
export function buildLlmContext(transactionData: any, codePathTrace: any): string {
  const resendHandler = getSourceFile("folio/folioResend/folioResendHandler.ts") ?? "";
  const outHandler = getSourceFile("folio/folioOutHandler.ts") ?? "";

  // Extract key methods (truncate to fit context)
  const transformOutSection = extractMethod(resendHandler, "transformOut");
  const transformSection = extractMethod(outHandler, "static async transform");

  return `You are analyzing a Marriott folio transaction processing pipeline.

## Source Code: FolioResendHandler.transformOut()
\`\`\`typescript
${transformOutSection.slice(0, 3000)}
\`\`\`

## Source Code: FolioOutHandler.transform()
\`\`\`typescript
${transformSection.slice(0, 3000)}
\`\`\`

## Transaction Data
\`\`\`json
${JSON.stringify(transactionData, null, 2).slice(0, 2000)}
\`\`\`

## Code Path Trace
\`\`\`json
${JSON.stringify(codePathTrace, null, 2).slice(0, 1000)}
\`\`\`

Based on the source code and the transaction data above, explain:
1. Why this transaction was included/excluded from the payload
2. What code path it took through transformOut() and transform()
3. What transType and amount values should be expected
4. If there is a mismatch, what might have caused it`;
}

function extractMethod(source: string, methodName: string): string {
  const idx = source.indexOf(methodName);
  if (idx === -1) return `[Method ${methodName} not found]`;
  return source.slice(Math.max(0, idx - 100), idx + 4000);
}

/**
 * Call Ollama API for analysis
 */
export async function analyzeWithLlm(
  transactionData: any,
  codePathTrace: any,
  model = "llama3.2"
): Promise<string> {
  const available = await isOllamaAvailable();
  if (!available) {
    return "Ollama is not running. Please start Ollama with `ollama serve` and pull a model with `ollama pull codellama`.";
  }

  const prompt = buildLlmContext(transactionData, codePathTrace);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
      }),
    });

    if (!res.ok) {
      return `Ollama API error: ${res.status} ${res.statusText}`;
    }

    const data = (await res.json()) as any;
    return data.response ?? "No response from LLM";
  } catch (err: any) {
    return `LLM call failed: ${err.message}`;
  }
}

