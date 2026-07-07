# Folio RCA Tool

A local web-based tool for debugging, analyzing, and correcting folio transaction mismatches between expected (CSV) and actual (JSON payload) data.

## Prerequisites

- **Node.js** ≥ 18
- **Ollama** (optional, for LLM analysis): `brew install ollama`

## Quick Start

```bash
cd apps/marriott-adapter-hint/src/folio/folioRCATool
npm install
npm run rca-tool
```

Open [http://localhost:3999](http://localhost:3999) in your browser.

## Optional: LLM Setup

```bash
# Install Ollama
brew install ollama

# Start Ollama server
ollama serve

# Pull a code-capable model
ollama pull codellama
```

## Features

### 1. Transaction Comparison
Upload a CSV file with expected ledger transactions and paste the resend result JSON. The tool compares each row by `lineItemNo` and detects:
- **Missing** — in CSV but not in payload
- **Extra** — in payload but not in CSV
- **Mismatches** — wrong `transType` or `amount` per built-in rules
- **PKG validation** — PKG amounts must equal sum(linked) / 2
- **Balance reconciliation** — per-window NEW + SET totals

### 2. Resend Query Generator
Generates fully expanded GraphQL queries with all fragment references resolved. Select account type (Guest/Group/House) and fill in parameters.

### 3. Payload Construction
Paste a raw GraphQL response to simulate `FolioResendHandler.transformOut()` + `FolioOutHandler.transform()`. See a step-by-step trace of which transactions were included, excluded, or merged.

### 4. Auto-Correction
Applies the 3-layer priority system to auto-correct mismatches:
- **Priority 1**: Built-in rules from `findMissingLines.js` (immutable)
- **Priority 2**: User rules from `rules.txt` (editable)
- **Priority 3**: Code logic simulation

### 5. Rules Editor
Edit user rules in `IF <condition> THEN <action>` format. Rules are saved to `rules/rules.txt`.

### 6. LLM Analysis
Uses a local Ollama model to explain transaction behavior by feeding actual source code as context.

## Writing Rules

```
# Comments start with #
IF type=PAYMENT THEN transType=SET AND amount=NEGATE
IF type=TRANSFER AND originalType=PAYMENT THEN transType=SET
IF destinationAccountType=COMPANY THEN transType=SET AND amount=NEGATE
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RCA_PORT` | `3999` | Server port |
