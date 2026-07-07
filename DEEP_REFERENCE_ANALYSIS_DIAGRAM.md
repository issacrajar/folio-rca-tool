# Deep Reference Analysis — How It Works

**Endpoint:** `POST /api/deep-reference-analysis`  
**Purpose:** Verifies `trnsfrFromLineItemNo` inside every `folioTransferDetails` of the payload by tracing reference chains against MongoDB ledger data.

---

## High-Level Flow

```mermaid
flowchart TD
    A([Start: POST /api/deep-reference-analysis]) --> B[/"Input:\nfolioTransactions + csvData"/]
    B --> C[Build lookup maps\ncsvByLineItemNo\ncsvByTransactionId]
    C --> D[Resolve tenantId / propertyId\nfrom folioTransactions]
    D --> E[Pre-fetch: Batch-query DB\nfor folioTransferDetails lineItemNos\nNOT in csvData]
    E --> F[For each folioTransactionDetail\nthat has folioTransferDetails...]
    F --> G{CSV row found\nfor lineItemNo?}

    G -- No --> H[status = csv_row_not_found\nCannot verify]
    G -- Yes --> I{taxExempted\n=== true?}
    I -- Yes --> J[status = tax_exempt_violation\nfolioTransferDetails must be removed]
    I -- No --> K[For each transferDetail\ninside the line...]

    K --> L{trnsfrFromLineItemNo\npresent?}
    L -- No --> M[status = not_applicable\nExpected behavior\nwhen sourceFolioLineItemId present]
    L -- Yes --> N{Direct reference IDs\non CSV row?}

    N -- Yes\nadjustment/refund/correction/transferReferenceId --> O["Case A:\nfirst10digits(refId)\n= correctTrnsfrFromLineItemNo"]
    O --> Z

    N -- No --> P{Has taxReferenceId?}
    P -- No --> Q["Case A2:\nFetch all folioLines\nfrom the document\n(by transactionId)\nFind line with same itemId\n+ transferReferenceId"]
    Q --> Z

    P -- Yes --> R["Case B:\nFind parent transaction\nby taxReferenceId\n(CSV or DB lookup)"]
    R --> S{Parent has\ndirect ref IDs?}

    S -- Yes --> T["Case B main:\nGroup rows where\ntaxReferenceId = parentRefId\nFind row with same itemId\nfirst10digits(transactionId)\n= correctTrnsfrFromLineItemNo"]
    T --> Z

    S -- No --> U["Case B-docMatch:\nFetch all folioLines\nfrom parent's document\nFind line with same itemId\n+ transferReferenceId"]
    U --> V{Found?}
    V -- Yes --> W[correctTrnsfrFromLineItemNo\nresolved]
    W --> Z
    V -- No --> X["Fallback:\nGroup by taxReferenceId + itemId\n(Case B fallback)"]
    X --> Y{Found?}
    Y -- Yes --> W
    Y -- No --> AA["Case B3:\nQuery parent ledgerTransactionHistory\n.sourceFolioLineItemId\nGroup by that ID, match itemId\n→ check refId or use transactionId"]
    AA --> AB{Found?}
    AB -- Yes --> W
    AB -- No --> AC["Case B3b:\nFetch all folioLines from\nthe document containing\nparentSourceId\nFind row with same itemId"]
    AC --> W

    Z{{"correctTrnsfrFromLineItemNo\nvs existing?"}}
    Z -- Match --> ZA[status = valid ✅]
    Z -- No Match --> ZB[status = mismatch ❌]
    Z -- Unresolved --> ZC[status = unresolved ⚠️]

    ZA & ZB & ZC --> DONE([Return:\ntransferVerifications\ntaxReferenceResults\nreferenceIdResults\nsummary])
```

---

## Reference Resolution Cases (Decision Tree)

```mermaid
flowchart TD
    START([For a given folioTransfer line]) --> A1{adjustmentReferenceId\nor refundReferenceId\nor correctionReferenceId\nor transferReferenceId?}

    A1 -- "Yes (any)" --> CASE_A["🅐 Case A — Direct Reference\nfirst10digits(refId) → correctTrnsfrFromLineItemNo"]

    A1 -- No --> A2{taxReferenceId\npresent?}

    A2 -- No --> CASE_A2["🅐₂ Case A2 — Document Lookup\nexecuteFolioLinesByDocumentQuery(transactionId)\nFind line where itemId matches + transferReferenceId exists\nfirst10digits(transferReferenceId) → correctTrnsfrFromLineItemNo"]

    A2 -- Yes --> STEP_B1["Find Parent Transaction\nby taxReferenceId\n(search csvData → then DB)"]

    STEP_B1 --> B_HAS_REF{Parent has\ndirect ref ID?}

    B_HAS_REF -- Yes --> CASE_B["🅑 Case B — Tax Chain\n1. Group rows where taxReferenceId = parentRefId\n2. Find row with same itemId (different transactionId)\n3. first10digits(transactionId) → correct"]

    B_HAS_REF -- No --> CASE_B_DOC["🅑 Case B-docMatch\nFetch parent's document folioLines\nFind line with same itemId + transferReferenceId\nfirst10digits(transferReferenceId) → correct"]

    CASE_B_DOC -- Not Found --> CASE_B_FB["🅑 Fallback\nGroup by taxReferenceId + itemId\nfirst10digits(transactionId) → correct"]

    CASE_B_FB -- Not Found --> CASE_B3["🅑₃ Case B3 — History Source\nQuery parent.ledgerTransactionHistory\n.sourceFolioLineItemId\nGroup by that ID, match itemId\n(check own refIds first)"]

    CASE_B3 -- Not Found --> CASE_B3B["🅑₃ᵦ Case B3b — Document of Source\nFetch all folioLines of the document\ncontaining parentSourceId\nMatch by itemId"]
```

---

## Data Sources Used

```mermaid
flowchart LR
    subgraph Inputs
        FT[folioTransactions\nPayload JSON]
        CSV[csvData\nLedger rows from MongoDB\nor uploaded CSV]
    end

    subgraph MongoDB["MongoDB Queries (on-demand)"]
        DB1["executeTransferQuery\n→ fetch rows by folioLines._id"]
        DB2["executeFolioLinesByDocumentQuery\n→ all folioLines in a document"]
        DB3["executeHistorySourceQuery\n→ ledgerTransactionHistory\n.sourceFolioLineItemId"]
    end

    subgraph Engine["Deep Reference Analysis Engine"]
        MAP1[csvByLineItemNo map]
        MAP2[csvByTransactionId map]
        MAP3[dbFetchedRows cache]
        LOGIC[Reference Chain\nResolution Logic\nCases A / A2 / B / B-docMatch\n/ B-fallback / B3 / B3b]
    end

    FT --> MAP1 & MAP2
    CSV --> MAP1 & MAP2
    DB1 & DB2 & DB3 --> MAP3
    MAP1 & MAP2 & MAP3 --> LOGIC

    subgraph Outputs
        OUT1[transferVerifications\n✅ valid / ❌ mismatch / ⚠️ unresolved\n+ debugSteps trace]
        OUT2[taxReferenceResults\nFull chain resolution log]
        OUT3[referenceIdResults\nAll direct ref IDs seen]
        OUT4[summary\ncounts + pass/fail status]
    end

    LOGIC --> OUT1 & OUT2 & OUT3 & OUT4
```

---

## Key Fields Explained

| Field | Source | Description |
|---|---|---|
| `lineItemNo` | Payload | First 10 numeric digits of `transactionId` — used as lookup key |
| `trnsfrFromLineItemNo` | Payload's `folioTransferDetails` | The value being verified |
| `correctTrnsfrFromLineItemNo` | Computed by engine | What the value **should** be, derived from the reference chain |
| `adjustmentReferenceId` | MongoDB `csvData` | Direct pointer → Case A |
| `refundReferenceId` | MongoDB `csvData` | Direct pointer → Case A |
| `correctionReferenceId` | MongoDB `csvData` | Direct pointer → Case A |
| `transferReferenceId` | MongoDB `csvData` | Direct pointer → Case A |
| `taxReferenceId` | MongoDB `csvData` | Pointer to parent transaction → Case B chain |
| `sourceFolioLineItemId` | `ledgerTransactionHistory` | Fallback when no direct refs exist → Cases B3/B3b |
| `itemId` | MongoDB `csvData` | Used to match sibling transactions across grouped rows |

---

## Status Outcomes

| Status | Meaning |
|---|---|
| `valid` ✅ | `trnsfrFromLineItemNo` matches the computed correct value |
| `mismatch` ❌ | `trnsfrFromLineItemNo` is wrong — shows correct value and resolution path |
| `unresolved` ⚠️ | Engine could not determine the correct value (missing data / DB unavailable) |
| `csv_row_not_found` | The payload line does not exist in csvData or DB pre-fetch |
| `tax_exempt_violation` | Line is tax-exempt — `folioTransferDetails` should not exist at all |
| `not_applicable` | `trnsfrFromLineItemNo` is absent — expected behavior when `sourceFolioLineItemId` is present |

