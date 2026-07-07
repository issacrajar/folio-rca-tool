# Folio Transaction Debugger Tool - Features

## Overview
A local web-based tool for debugging, analyzing, and correcting folio transaction mismatches between expected (CSV) and actual (JSON payload) data, powered by a local LLM for code logic analysis.

---

## Source Code References (Auto-Discovery)

The tool reads the following source files to understand the resend pipeline end-to-end:

| File | Purpose |
|---|---|
| `folio/folioResend/folioResendRoute.ts` | Route definition — wires `align → filter → unpack → process → transformOut → package → onDelivery` |
| `folio/folioResend/folioResendHandler.ts` | Entry point — `process()` fetches graph data (Guest/Group/House), `transformOut()` builds `FolioNotification[]`, `package()` chunks & publishes |
| `folio/folioResend/folioResendGraph.ts` | GraphQL queries — `getReservationDetails`, `getGroupDetails`, `getHouseAccountDetails`; uses `nodes` template with `commonTransactionFields`, `commonFields`, `wholeReferenceTransaction`, `ledgerTransactionPlayerDetail` |
| `folio/folioResend/folioResendModel.ts` | TypeScript types for `FolioResendInput`, `FolioResendGraphInput`, `FolioResendGraphResponse` |
| `folio/folioResend/folioResendConstants.ts` | Constants — `CRS_CONFIRMATION_NUMBER`, `FOLIO_NUMBER`, `HOUSE_ACCOUNT_NUMBER`, `MAX_SIZE_IN_BYTES` |
| `folio/folioOutHandler.ts` | Core transform logic — `FolioOutHandler.transform()` builds each `FolioNotification` from a `LedgerTransaction` |
| `folio/folioOutModels.ts` | Output models — `FolioNotification`, `FolioTransPaymentDetail`, `AccountType`, `FolioAccountTypeCode`, `FolioTypeDesc`, `ResStateType` |
| `folio/folioGraph.ts` | Shared GraphQL fragments — exports `commonTransactionFields`, `commonFields`, `wholeReferenceTransaction`, `ledgerTransactionPlayerDetail`, `queryGroupTransaction` |
| `helpers/adapterUtils.ts` | Utilities — `collectLedgerTransactions`, `formatDateTimeByType`, `formatFolioAmount`, `chunkArray`, `filterInboundMessage` |
| `helpers/globals.ts` | Global constants — `CLOSE`, `OPEN`, `COMPANY`, `CRS_TYPE`, `PMS_TYPE`, `nonGuestViewableFolioTypes`, `NO_OF_DECIMALS` |
| `folio/closeFolio/closeFolioOutHandler.ts` | `AccountTypes` union type used for Guest/Group/House branching |
| `folio/closeFolio/closeFolioModel.ts` | `GroupAccountById`, `ReservationsByAccountId` types |
| `folio/profileFolio/profileFolioOutConstants.ts` | `PROFILE_TYPE` map used in `generateWindowProfileId` |

The tool **automatically reads and parses** these files at startup to:
1. Extract all GraphQL query templates and resolve all embedded constants (`${commonTransactionFields}`, `${commonFields}`, etc.) into fully expanded queries.
2. Understand the `transformOut()` pipeline: parent/child merging, GROUP filtering (pantry, autoRecurring, addOn), missing-parent queries, and deduplication.
3. Map the `FolioOutHandler.transform()` code paths that determine `transType` (NEW/SET/PKG), amount sign, and payment details.

---

## ⚠️ Priority Order (Payload Correctness)

| Priority | Source | Description |
|----------|--------|-------------|
| **1 (Highest)** | `findMissingLines.js` rules | Hardcoded comparison logic (PAYMENT→SET, REFUND→SET, COMPANY dest→SET, etc.). Ground truth. Immutable. |
| **2** | `rules.txt` (user-editable) | User-defined rules in the UI. Override code logic. Overridden by Priority 1 on conflict. |
| **3 (Lowest)** | Code logic (`folioOutHandler.ts`) | Adapter code simulation. Used for payload construction & explanation. Corrected by layers above. |

---

## Features

### 1. Input Management
- **CSV Upload**: Upload a CSV file containing expected ledger transactions (e.g., `folio_1000345.csv`).
- **Folio Transactions Input**: Paste or upload the `folioTransactions` JSON array (resend result).
- **Account Type Selection**: UI prompt to choose account type — `Guest`, `Group`, or `House Account` — to tailor the resend query generation.

### 2. Transaction Comparison Engine
- Compare each CSV row against `folioTransactions` by `lineItemNo`.
- Detect **missing transactions** (present in CSV but absent in payload).
- Detect **extra transactions** (present in payload but absent in CSV).
- Detect **amount/type mismatches** (value or `transType` discrepancy based on folio line type).
- Display full details of each missing/mismatched line from the CSV.

### 3. Graph Resend Query Generator
- Read `folioResendGraph.ts` to extract the raw query templates (`getReservationDetails`, `getGroupDetails`, `getHouseAccountDetails`).
- Read `folioGraph.ts` to resolve all fragment constants:
  - `commonTransactionFields` (line ~537 in folioGraph.ts)
  - `commonFields` (line ~906)
  - `wholeReferenceTransaction` (line ~959)
  - `ledgerTransactionPlayerDetail` (line ~870)
- Recursively replace all `${...}` references to produce a fully expanded, copy-ready GraphQL query.
- Select the correct query based on chosen account type:
  - **Guest** → `getReservationDetails` query
  - **Group** → `getGroupDetails` query
  - **House Account** → `getHouseAccountDetails` query
- Output includes the `variables` JSON block pre-filled with user-provided values (confirmationNumber, folioNumber, propertyId, houseAccountNumber).

### 4. Payload Construction from Graph Response
- Accept a raw GraphQL response as input.
- Simulate the `FolioResendHandler.transformOut()` pipeline:
  1. Extract `allLedgerTransactions` from folios (Guest/Group/House branch).
  2. Detect missing parent IDs and flag them (tool cannot query graph, but highlights which parents would be fetched).
  3. Sort GROUP transactions first.
  4. Apply GROUP filtering logic: remove pantry parents (`pantryReceiptNumber`), `autoRecurringCharge` children, `isPantryItem`, `isAddOn` (non-PACKAGE), addOn wholeReference without parentId.
  5. Merge child transactions into parent when `parentId` exists in result set.
  6. Filter transactions with `parentId` whose parent was already added.
  7. For each remaining transaction, call simulated `FolioOutHandler.transform()` to build `FolioNotification`.
  8. Merge notifications by `folioWindowId`.
- **Highlight which code branch/condition** caused a transaction to be excluded from the payload (e.g., "Removed: pantry parent GROUP", "Merged into parent: {parentId}").
- Display the constructed payload as formatted JSON.

### 5. Local LLM Integration
- Install and run a local LLM via **Ollama** (e.g., CodeLlama or Mistral).
- Feed the actual source code of `folioResendHandler.ts`, `folioOutHandler.ts`, and related files as context to the LLM.
- Use the LLM to:
  - Explain why a specific transaction was included/excluded from the payload.
  - Trace the code path for a given transaction type (CHARGE, TRANSFER, PAYMENT, etc.).
  - Suggest potential causes when a mismatch is detected.
- Provide natural-language explanations in the UI alongside each transaction result.

### 6. Mismatch Auto-Correction
- When a mismatch is detected (wrong amount, wrong `transType`), automatically produce a corrected payload.
- Apply the sign/amount logic from `FolioOutHandler.getFolioAmount()` based on `folioType`, `transType`, `isRouted`, `arNumber`, `originalFolioLineType`.
- Apply the `transType` determination logic (NEW for charges/credits/adjustments/corrections, SET for payments/refunds and transfers-as-payments).
- Correction is applied **without requiring a new graph response**.
- Show a diff between original and corrected payload.

### 7. Rules Engine
- **Rules File UI**: Display the rules text file (`rules.txt`) in an editable text area within the UI.
- **Editable Rules**: Users can add, modify, or remove rules at runtime.
- **Rule Persistence**: Save updated rules to disk (`folioRCATool/rules.txt`) for future sessions.
- **Rule Override**: If the `FolioOutHandler` code logic conflicts with a rule, the rule takes precedence and the payload is adjusted accordingly.
- **Rule Application Log**: Show which rules were applied and what they changed in the payload.
- **Rule Format**: Each rule is a line in the format:
  ```
  IF <condition> THEN <action>
  ```
  Example:
  ```
  IF transType=TRANSFER AND originalType=PAYMENT THEN transType=SET AND amount=NEGATE
  IF folioType=COMPANY THEN guestViewable=false
  ```

### 8. Web UI
- Local web application (Node.js + Express + HTML/CSS/JS frontend).
- Sections:
  - **Inputs**: CSV upload, JSON paste, account type selector, graph response paste.
  - **Results**: Missing lines table (full CSV row details), mismatch details (expected vs actual), extra lines.
  - **Resend Query**: Fully expanded GraphQL query with copy button, variables block.
  - **Payload Viewer**: Constructed/corrected payload with JSON formatting and diff view.
  - **Code Path Trace**: Per-transaction log of which `transformOut` / `FolioOutHandler` branches were hit.
  - **Rules Editor**: Editable text area for validation rules with save button.
  - **LLM Analysis**: Natural-language code path explanations per transaction.

---

## Tech Stack
| Component | Technology |
|---|---|
| Backend | Node.js + Express |
| Frontend | HTML/CSS/JS |
| Local LLM | Ollama (CodeLlama / Mistral) |
| CSV Parsing | `xlsx` or `csv-parse` |
| Rules Storage | Local `rules.txt` file |
| Code Parsing | TypeScript AST (`ts-morph`) or raw file reading + regex for fragment resolution |

---

## Workflow
1. **Startup**: Tool reads all source files listed in Source Code References table. Parses and caches GraphQL fragments and code logic.
2. Upload CSV and paste `folioTransactions` JSON.
3. Select account type (Guest / Group / House Account).
4. Tool compares and displays missing/mismatched/extra transactions with full CSV row details.
5. For missing lines → generates fully expanded resend GraphQL query (correct query per account type, all `${...}` resolved).
6. Paste graph response → tool simulates `transformOut()` pipeline, constructs payload, and shows code path trace per transaction.
7. LLM explains any exclusions using actual source code as context.
8. For mismatches → tool auto-corrects payload using `getFolioAmount` and `transType` logic.
9. Rules from `rules.txt` override code logic where applicable; rule application log shown.
10. Export final corrected payload.

