# Folio RCA Tool - Tasks

> All tasks derived from `features.md`. Source files are auto-discovered from the codebase (see features.md § Source Code References).

## ⚠️ Priority Order (Payload Correctness)

The tool applies **three layers** of logic to determine the correct payload. Each layer overrides the one below it:

| Priority | Source | Description |
|----------|--------|-------------|
| **1 (Highest)** | `findMissingLines.js` | Hardcoded comparison rules extracted from the script (e.g., PAYMENT/REFUND → `transType=SET`, amount negated; TRANSFER with originalType=PAYMENT → SET; COMPANY destination → SET). These are treated as **ground truth**. |
| **2** | `rules.txt` (user-provided) | Editable rules file in the UI. User can add/modify rules at runtime. These override code logic but are overridden by `findMissingLines.js` rules if there is a conflict. |
| **3 (Lowest)** | Code logic (`folioOutHandler.ts`, `folioResendHandler.ts`) | The actual adapter code logic. Used to simulate payload construction and explain code paths, but its output is corrected by Priority 1 & 2 rules when they disagree. |

**Resolution flow**: Code logic builds the payload → `rules.txt` overrides any fields it targets → `findMissingLines.js` rules override everything for final correctness check.

---

## Phase 0: Project Setup

### Task 0.1: Scaffold Project
- [ ] Create `folioRCATool/` directory structure: `server/`, `client/`, `rules/`, `cache/`
- [ ] Initialize `package.json` with Express, `xlsx`/`csv-parse`, `ts-morph` (or regex parser)
- [ ] Add `tsconfig.json` for the tool
- [ ] Create `rules/rules.txt` with default empty rules file
- [ ] Add npm script: `npm run rca-tool` to start the server

### Task 0.2: Install & Configure Ollama (Local LLM)
- [ ] Document Ollama installation steps for macOS (`brew install ollama`)
- [ ] Pull a code-capable model (`ollama pull codellama` or `ollama pull mistral`)
- [ ] Create `server/llm.ts` — wrapper to call Ollama REST API (`POST http://localhost:11434/api/generate`)
- [ ] Add health check: verify Ollama is running before LLM features are enabled

---

## Phase 1: Rule Extraction & Source Code Indexing

### Task 1.1: Extract Built-in Rules from `findMissingLines.js` (Priority 1)
- [ ] Create `server/builtInRules.ts`
- [ ] Parse and codify all comparison logic from `findMissingLines.js` into structured rules:
  - **Rule 1**: If `type=PAYMENT` → `transType=SET`, `amount = -totalAmount`
  - **Rule 2**: If `type=REFUND` → `transType=SET`, `amount = -totalAmount`
  - **Rule 3**: If `sourceAccountType != null AND destinationAccountType=COMPANY` → `transType=SET`, `amount = -totalAmount`
  - **Rule 4**: If `type=TRANSFER AND originalType=PAYMENT` → `transType=SET`, `amount = -totalAmount`
  - **Rule 5**: All other types → `transType=NEW`, `amount = totalAmount`
  - **Rule 6 (PKG)**: PKG transaction amount must equal `sum(linked transactions by transLinkId) / 2`
  - **Rule 7 (Extra lines)**: Transactions in payload but not in CSV (and not PKG) are flagged as extra
- [ ] Store as an ordered array of `{ condition, expectedTransType, amountTransform }` objects
- [ ] These rules are **immutable** — they cannot be edited in the UI and always take highest priority
- [ ] Export `applyBuiltInRules(csvRow, transaction)` function that returns `{ isCorrect, expected, actual }`

### Task 1.2: User Rules File Reader/Writer (Priority 2)
- [ ] Create `server/userRules.ts`
- [ ] Read `folioRCATool/rules.txt` at startup
- [ ] Parse rules in format: `IF <condition> THEN <action>`
- [ ] Conditions: field comparisons (`transType=TRANSFER`, `originalType=PAYMENT`, `folioType=COMPANY`)
- [ ] Actions: field assignments (`transType=SET`, `amount=NEGATE`, `guestViewable=false`)
- [ ] Support AND for multiple conditions/actions
- [ ] Export `applyUserRules(transaction)` → returns modified transaction + application log
- [ ] User rules override code logic (Priority 3) but are overridden by built-in rules (Priority 1) on conflict

### Task 1.3: Source File Loader (Priority 3 — Code Logic)
- [ ] Create `server/sourceLoader.ts`
- [ ] Read the following files at startup (paths relative to `apps/marriott-adapter-hint/src/`):
  - `folio/folioResend/folioResendHandler.ts`
  - `folio/folioResend/folioResendGraph.ts`
  - `folio/folioResend/folioResendModel.ts`
  - `folio/folioResend/folioResendConstants.ts`
  - `folio/folioOutHandler.ts`
  - `folio/folioOutModels.ts`
  - `folio/folioGraph.ts`
  - `helpers/adapterUtils.ts`
  - `helpers/globals.ts`
  - `folio/closeFolio/closeFolioOutHandler.ts`
  - `folio/closeFolio/closeFolioModel.ts`
  - `folio/profileFolio/profileFolioOutConstants.ts`
- [ ] Cache file contents in memory as a `Map<filename, content>`
- [ ] Expose cached content to other modules (query expander, LLM context builder, payload simulator)

### Task 1.2: GraphQL Fragment Extractor
- [ ] Parse `folioGraph.ts` to extract exported `const` template literals:
  - `commonTransactionFields` (line ~537)
  - `commonFields` (line ~906)
  - `wholeReferenceTransaction` (line ~959)
  - `ledgerTransactionPlayerDetail` (line ~870)
- [ ] Store fragments in a `Map<fragmentName, resolvedString>`
- [ ] Handle nested references (e.g., `commonFields` may reference another fragment)

### Task 1.3: GraphQL Query Expander
- [ ] Parse `folioResendGraph.ts` to extract:
  - `getReservationDetails` query
  - `getGroupDetails` query
  - `getHouseAccountDetails` query
  - `nodes` template (the shared folio/ledgerTransactions fragment)
- [ ] Recursively replace all `${variableName}` with resolved fragment content from Task 1.2
- [ ] Produce three fully expanded, copy-ready GraphQL query strings (one per account type)
- [ ] Store expanded queries for serving to the UI

### Task 1.4: Query Variable Template Builder
- [ ] For each account type, build a `variables` JSON template:
  - **Guest**: `{ thirdPartyConfirmationInput: { confirmationName, confirmationNumber }, accountIdentity: { chargePostingSequenceNumber }, propertyByIdId }`
  - **Group**: same structure as Guest (uses `getGroupDetails`)
  - **House Account**: `{ number: [houseAccountNumber], propertyByIdId }`
- [ ] Pre-fill with user-provided values at runtime

---

## Phase 2: CSV Parsing & Comparison Engine

### Task 2.1: CSV Parser
- [ ] Create `server/csvParser.ts`
- [ ] Use `xlsx` library to read uploaded CSV file
- [ ] Convert to JSON array with typed fields: `lineItemNo`, `amount`, `totalAmount`, `type`, `originalType`, `sourceAccountType`, `destinationAccountType`, etc.
- [ ] Validate required columns exist; return error if missing

### Task 2.2: Transaction Flattener
- [ ] Create `server/transactionFlattener.ts`
- [ ] Accept `folioTransactions` JSON (array of folio objects with nested `folioTransactionDetails`)
- [ ] Flatten all `folioTransactionDetails` across all folios into a single array
- [ ] Index by `lineItemNo` for O(1) lookup

### Task 2.3: Missing Transaction Detector
- [ ] For each CSV row, look up `lineItemNo` in flattened transactions
- [ ] If not found → add to `missingLines[]` with full CSV row details
- [ ] Return `missingLines` array

### Task 2.4: Extra Transaction Detector
- [ ] For each flattened transaction, look up `lineItemNo` in CSV data
- [ ] Skip PKG transactions (these are generated, not in CSV)
- [ ] If not found → add to `extraLines[]`
- [ ] Return `extraLines` array

### Task 2.5: Mismatch Detector (Uses Priority 1 Rules)
- [ ] For each matched CSV row ↔ transaction pair, call `applyBuiltInRules(csvRow, transaction)` from Task 1.1
- [ ] Built-in rules from `findMissingLines.js` determine the **expected** `transType` and `amount`:
    - If `type=PAYMENT` or `type=REFUND` or `destinationAccountType=COMPANY` or (`type=TRANSFER` and `originalType=PAYMENT`) → expected: `transType=SET`, `amount=-totalAmount`
    - Else → expected: `transType=NEW`, `amount=totalAmount`
- [ ] Compare expected vs actual; if mismatch → add to `mismatches[]` with expected vs actual values
- [ ] Return `mismatches` array

### Task 2.6: PKG Validation
- [ ] Find all transactions with `transType=PKG`
- [ ] For each PKG transaction, find all transactions where `transLinkId === PKG.lineItemNo`
- [ ] Sum linked transaction amounts; verify PKG amount equals `sum / 2`
- [ ] Report orphaned PKGs or amount mismatches

### Task 2.7: Balance Reconciliation
- [ ] Per folio window: sum all NEW amounts, sum all SET amounts
- [ ] Report per-window totals
- [ ] Flag OOB (Out of Balance) if `NEW total + SET total ≠ 0`

---

## Phase 3: Resend Query Generation (UI Feature)

### Task 3.1: Account Type Selector API
- [ ] Create `POST /api/resend-query` endpoint
- [ ] Accept `{ accountType: "guest" | "group" | "house", confirmationNumber?, folioNumber?, houseAccountNumber?, propertyId? }`
- [ ] Return the fully expanded query string (from Task 1.3) + populated variables (from Task 1.4)

### Task 3.2: Resend Query UI Panel
- [ ] Add "Resend Query" section to UI
- [ ] Account type dropdown (Guest / Group / House Account)
- [ ] Input fields for confirmationNumber, folioNumber, houseAccountNumber, propertyId
- [ ] "Generate Query" button → calls API → displays expanded query in a code block
- [ ] "Copy Query" button
- [ ] "Copy Variables" button

---

## Phase 4: Payload Construction from Graph Response

### Task 4.1: TransformOut Simulator
- [ ] Create `server/transformOutSimulator.ts`
- [ ] Accept raw graph response JSON
- [ ] Replicate `FolioResendHandler.transformOut()` logic:
  1. Extract folios from response (Guest / Group / House branch)
  2. Flatten `allLedgerTransactions` with dedup via `addedTransactionIds` Set
  3. Detect missing parent IDs → log warning (cannot query, just flag)
  4. Sort: GROUP transactions first
  5. Apply GROUP filtering:
     - Remove if `pantryReceiptNumber` present
     - Remove if child has `autoRecurringCharge`
     - Remove if child `isPantryItem`
     - Remove if child `isAddOn` and `addOnType !== "PACKAGE"`
     - Remove if child's `wholeReferenceTransaction` has `isAddOn` and no `parentId`
     - On removal: delete `parentId` from child charges, push children back
  6. Merge children into parents when `parentId` exists in result set
  7. Filter remaining transactions with `parentId` whose parent was already added
- [ ] For each surviving transaction, log which step it passed through

### Task 4.2: FolioOutHandler.transform() Simulator
- [ ] Create `server/folioOutSimulator.ts`
- [ ] Simulate `FolioOutHandler.transform()` for a single `LedgerTransaction`:
  - Determine `folioType` from transaction type mapping
  - Determine `transType` (NEW / SET)
  - Calculate amount via `getFolioAmount()` sign logic
  - Build `folioTransferDetails` if applicable
  - Build `folioTransPaymentDetails` if applicable
  - Generate `lineItemNo` via `generateRandomNumbers`
  - Build `confirmationIds`, `folioId`, `windowProfileId`
- [ ] Return constructed `FolioNotification` fragment

### Task 4.3: Code Path Trace Logger
- [ ] Create `server/codePathTrace.ts`
- [ ] For each transaction processed in Tasks 4.1 & 4.2, record:
  - Transaction ID
  - Which `transformOut` branch it entered (included / excluded / merged)
  - If excluded: reason (e.g., "GROUP with pantryReceiptNumber", "parentId merged into {id}")
  - Which `FolioOutHandler` branches were hit (folioType, transType, amount sign path)
- [ ] Return trace log as structured JSON

### Task 4.4: Payload Construction API
- [ ] Create `POST /api/construct-payload` endpoint
- [ ] Accept `{ graphResponse: object, accountType: string }`
- [ ] Return `{ payload: FolioNotification[], codePathTrace: TraceEntry[] }`

### Task 4.5: Payload Viewer UI Panel
- [ ] Add "Payload Viewer" section to UI
- [ ] Textarea for pasting graph response JSON
- [ ] "Construct Payload" button → calls API
- [ ] Display constructed payload as formatted JSON
- [ ] Display code path trace as collapsible per-transaction log
- [ ] Highlight excluded transactions in red with reason

---

## Phase 5: LLM Integration

### Task 5.1: LLM Context Builder
- [ ] Create `server/llmContext.ts`
- [ ] Build LLM prompt from:
  - Source code of `folioResendHandler.ts` `transformOut()` method
  - Source code of `folioOutHandler.ts` `transform()` and key methods
  - The specific transaction data being analyzed
  - The code path trace from Task 4.3
- [ ] Truncate context to fit model's token limit (keep most relevant methods)

### Task 5.2: LLM Analysis Endpoint
- [ ] Create `POST /api/llm-analyze` endpoint
- [ ] Accept `{ transactionId: string, transactionData: object, codePathTrace: object }`
- [ ] Send prompt to Ollama API
- [ ] Return natural-language explanation

### Task 5.3: LLM Analysis UI Panel
- [ ] Add "LLM Analysis" section to UI (per-transaction expandable)
- [ ] "Explain" button next to each transaction in results
- [ ] Display LLM response in a text block
- [ ] Show loading spinner while waiting for Ollama response

---

## Phase 6: Mismatch Auto-Correction

### Task 6.1: Correction Engine (Priority Order Applied)
- [ ] Create `server/correctionEngine.ts`
- [ ] For each mismatch, apply corrections in priority order:
  1. **Priority 3 (Code Logic)**: Start with the payload as built by `FolioOutHandler` simulation (Task 4.2)
  2. **Priority 2 (User Rules)**: Call `applyUserRules(transaction)` from Task 1.2 — override any fields targeted by `rules.txt`
  3. **Priority 1 (Built-in Rules)**: Call `applyBuiltInRules(csvRow, transaction)` from Task 1.1 — final override using `findMissingLines.js` logic
- [ ] Log each priority layer's changes separately: `{ layer: "code" | "userRule" | "builtIn", field, before, after }`
- [ ] Return corrected payload with full correction trace

### Task 6.2: Diff Generator
- [ ] Create `server/diffGenerator.ts`
- [ ] Compare original `folioTransactions` vs corrected payload
- [ ] Produce field-level diff: `{ lineItemNo, field, original, corrected }[]`

### Task 6.3: Correction API
- [ ] Create `POST /api/correct-payload` endpoint
- [ ] Accept `{ folioTransactions: object[], csvData: object[] }`
- [ ] Return `{ correctedPayload: object[], diffs: Diff[] }`

### Task 6.4: Correction UI Panel
- [ ] Add "Auto-Correction" section to UI
- [ ] "Auto-Correct" button → calls API
- [ ] Display diff table: lineItemNo | field | original | corrected
- [ ] Display corrected payload as formatted JSON with copy button

---

## Phase 7: Rules Engine (Priority 2 — User Rules)

### Task 7.1: Rules File Reader/Writer
- [ ] Already implemented in Task 1.2 (`server/userRules.ts`)
- [ ] Ensure `getRules()`, `saveRules(text)`, `applyUserRules(payload)` are reusable

### Task 7.2: Rule Parser
- [ ] Already implemented in Task 1.2
- [ ] Parse conditions and actions from `IF <condition> THEN <action>` format

### Task 7.3: Rule Application Engine (with Priority Awareness)
- [ ] For each transaction in the payload, evaluate all user rules
- [ ] Apply matching rule actions (override field values)
- [ ] **Conflict check**: If a user rule changes a field that `findMissingLines.js` built-in rules also target, log a warning: `"User rule overridden by built-in rule for field: {field}"`
- [ ] Built-in rules (Priority 1) always win in conflict
- [ ] Log which user rules were applied and what changed

### Task 7.4: Rules API
- [ ] Create `GET /api/rules` → returns current rules text
- [ ] Create `PUT /api/rules` → saves new rules text to `rules.txt`
- [ ] Create `POST /api/apply-rules` → accepts payload, returns rule-adjusted payload + application log

### Task 7.5: Rules Editor UI Panel
- [ ] Add "Rules Editor" section to UI
- [ ] Editable textarea pre-filled with `rules.txt` content
- [ ] "Save Rules" button → calls `PUT /api/rules`
- [ ] Rule application log displayed after each comparison/correction run
- [ ] Syntax hint/help text showing rule format

---

## Phase 8: Web UI Assembly

### Task 8.1: Express Server
- [ ] Create `server/index.ts`
- [ ] Mount all API routes from Phases 2–7
- [ ] Serve static frontend from `client/`
- [ ] On startup: run source file loader (Task 1.1), fragment extractor (Task 1.2), query expander (Task 1.3)

### Task 8.2: Frontend Layout
- [ ] Create `client/index.html`
- [ ] Tabbed or sectioned layout:
  1. **Inputs** — CSV upload, JSON paste, account type selector
  2. **Comparison Results** — missing/extra/mismatch tables
  3. **Resend Query** — expanded query + variables
  4. **Payload Viewer** — constructed payload + code path trace
  5. **Auto-Correction** — diff view + corrected payload
  6. **Rules Editor** — editable text area
  7. **LLM Analysis** — per-transaction explanations

### Task 8.3: Frontend Logic
- [ ] Create `client/app.js`
- [ ] Wire all buttons to API calls
- [ ] Handle file upload (CSV)
- [ ] JSON syntax validation for pasted inputs
- [ ] Render tables, code blocks, diffs
- [ ] Collapsible sections for per-transaction details

### Task 8.4: Styling
- [ ] Clean, functional CSS (dark mode friendly)
- [ ] Syntax highlighting for JSON and GraphQL code blocks
- [ ] Color-coded diff view (green=added, red=removed)
- [ ] Responsive layout

---

## Phase 9: Testing & Documentation

### Task 9.1: Unit Tests
- [ ] Test CSV parser with sample `folio_1000345.csv`
- [ ] Test comparison engine (missing, extra, mismatch cases)
- [ ] Test GraphQL fragment expansion (verify all `${...}` are resolved)
- [ ] Test correction engine (sign logic, transType logic)
- [ ] Test rules parser and application

### Task 9.2: Integration Test
- [ ] End-to-end test: CSV + folioTransactions → comparison → query generation → payload construction → correction → rules
- [ ] Use `findMissingLines.js` test data as baseline

### Task 9.3: README
- [ ] Usage instructions
- [ ] Prerequisites (Node.js, Ollama)
- [ ] How to start the tool
- [ ] How to write rules
- [ ] Screenshots of UI sections

