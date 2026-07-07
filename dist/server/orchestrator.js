// Copyright (C) Agilysys, Inc. All rights reserved.
import { getExpandedQuery, buildVariablesTemplate } from "./graphqlExpander.js";
import { autoGenerateQueries } from "./mongoQueryGenerator.js";
import { findAccountId, executeLedgerQuery } from "./mongoExecutor.js";
let sessionRules = [];
export function loadRuleSheet(rules) {
    sessionRules = rules.sort((a, b) => b.priority - a.priority);
}
export function getSessionRules() {
    return sessionRules;
}
function applyRulesToStep(step) {
    const overrides = [];
    let finalAction;
    let modifiedQuery;
    for (const rule of sessionRules) {
        try {
            // Simple rule evaluation using step context
            const matches = evaluateRuleCondition(rule.condition, step);
            if (!matches)
                continue;
            overrides.push(`Rule[${rule.id}]: ${rule.action}`);
            switch (rule.action) {
                case "force_approve":
                    finalAction = "approve";
                    break;
                case "force_reject":
                    finalAction = "reject";
                    break;
                case "skip":
                    finalAction = "skip";
                    break;
                case "modify_query":
                    if (rule.modification)
                        modifiedQuery = rule.modification;
                    break;
                case "require_approval":
                    // Default behavior — just flag it
                    break;
            }
        }
        catch (e) {
            // Rule evaluation failed — skip silently
        }
    }
    return { overrides, action: finalAction, modifiedQuery };
}
function evaluateRuleCondition(condition, step) {
    try {
        const fn = new Function("step", `return (${condition})`);
        return !!fn(step);
    }
    catch {
        return false;
    }
}
// ─── Sessions Store ───────────────────────────────────────────
const sessions = new Map();
function genId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
// ─── Planner ──────────────────────────────────────────────────
function planNextStep(session) {
    const ctx = session.context;
    const completedSteps = session.steps.filter(s => s.status === "executed");
    // STEP 1: If we have folioTransactions but no CSV data → need mongo query
    if (ctx.folioTransactions && !ctx.csvData && !completedSteps.find(s => s.intent === "fetch_ledger_data")) {
        return {
            action: "mongo_query",
            title: "Fetch Ledger Transactions from MongoDB",
            description: "Query ledgerTransactions collection to get the expected transaction data for comparison.",
            intent: "fetch_ledger_data",
            params: { folioTransactions: ctx.folioTransactions },
        };
    }
    // STEP 2: If we have CSV data + payload → compare
    if (ctx.csvData && ctx.folioTransactions && !ctx.comparisonResult && !completedSteps.find(s => s.intent === "compare")) {
        return {
            action: "internal",
            title: "Compare Transactions",
            description: "Compare payload transactions against ledger data to find missing, extra, and mismatched transactions.",
            intent: "compare",
        };
    }
    // STEP 3: If comparison shows missing → need graph query to resolve
    if (ctx.comparisonResult?.missing?.length > 0 && !ctx.graphResponse && !completedSteps.find(s => s.intent === "fetch_graph_data")) {
        // Determine account type and generate graph query
        const accountType = ctx.accountType || detectAccountType(ctx.folioTransactions);
        const queryType = accountType === "group" ? "groupTransaction" : "ledgerTransactionById";
        return {
            action: "graph_query",
            title: "Fetch Missing Transactions via Graph",
            description: `${ctx.comparisonResult.missing.length} transactions are missing from the payload. Need to query the Graph to get the full transaction details and reconstruct them.`,
            intent: "fetch_graph_data",
            queryType,
            params: { accountType, missingCount: ctx.comparisonResult.missing.length },
        };
    }
    // STEP 4: If we have graph response → resolve missing
    if (ctx.graphResponse && ctx.comparisonResult?.missing?.length > 0 && !completedSteps.find(s => s.intent === "resolve_missing")) {
        return {
            action: "internal",
            title: "Resolve Missing Transactions",
            description: "Use graph response to construct the missing transactions and merge into the payload.",
            intent: "resolve_missing",
        };
    }
    // STEP 5: If mismatches exist → auto-correct
    if (ctx.comparisonResult?.mismatches?.length > 0 && !ctx.correctedPayload && !completedSteps.find(s => s.intent === "auto_correct")) {
        return {
            action: "internal",
            title: "Auto-Correct Payload",
            description: "Apply Priority 1 (built-in) + Priority 2 (user rules) corrections to fix mismatched fields.",
            intent: "auto_correct",
        };
    }
    // Done
    return null;
}
function detectAccountType(folioTransactions) {
    if (!folioTransactions?.length)
        return "guest";
    const type = folioTransactions[0]?.folioType?.folioTypeCode;
    if (type === "GS")
        return "guest";
    if (type === "GP")
        return "group";
    if (type === "HA")
        return "house";
    return "guest";
}
// ─── Public API ───────────────────────────────────────────────
/**
 * Create a new orchestrator session from a user request.
 */
export function createSession(request, context) {
    const session = {
        id: genId(),
        request,
        context,
        steps: [],
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    sessions.set(session.id, session);
    return session;
}
/**
 * Get next step requiring user interaction (or execute internal steps automatically).
 * Returns the next step awaiting approval, or null if complete.
 */
export async function advanceSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session)
        throw new Error(`Session ${sessionId} not found`);
    if (session.status !== "active")
        return { session };
    // Execute any ready internal steps
    while (true) {
        const decision = planNextStep(session);
        if (!decision) {
            session.status = "completed";
            session.updatedAt = Date.now();
            return { session };
        }
        const step = {
            id: genId(),
            type: decision.action === "graph_query" ? "graph_query" : decision.action === "mongo_query" ? "mongo_query" : "internal",
            title: decision.title,
            description: decision.description,
            status: "pending",
            intent: decision.intent,
            createdAt: Date.now(),
        };
        // Apply rule overrides
        const ruleResult = applyRulesToStep(step);
        step.ruleOverrides = ruleResult.overrides;
        if (ruleResult.action === "skip") {
            step.status = "skipped";
            session.steps.push(step);
            continue;
        }
        // For graph/mongo queries — generate the query and pause for approval
        if (step.type === "graph_query") {
            const accountType = session.context.accountType || detectAccountType(session.context.folioTransactions);
            step.query = getExpandedQuery(accountType);
            const params = extractQueryParams(session.context);
            step.variables = buildVariablesTemplate(accountType, params);
            if (ruleResult.modifiedQuery) {
                step.modifiedQuery = ruleResult.modifiedQuery;
                step.query = ruleResult.modifiedQuery;
            }
            if (ruleResult.action === "approve") {
                // Auto-approve via rule
                step.status = "approved";
                session.steps.push(step);
                // Execute will happen when user provides graph response
                step.status = "awaiting_approval"; // still need response data
                session.updatedAt = Date.now();
                return { session, pendingStep: step };
            }
            step.status = "awaiting_approval";
            session.steps.push(step);
            session.updatedAt = Date.now();
            return { session, pendingStep: step };
        }
        if (step.type === "mongo_query") {
            const queryInfo = autoGenerateQueries(session.context.folioTransactions);
            step.query = queryInfo.mongoAggregationQuery;
            // Use env overrides from session context if set (injected by /api/orchestrator/start for custom environments)
            step.variables = {
                tenantId: session.context.envTenantId || queryInfo.tenant?.tenantId,
                propertyId: session.context.envPropertyId || queryInfo.tenant?.propertyId,
                chargePostingSequenceNumber: queryInfo.chargePostingSequenceNumber,
            };
            if (ruleResult.modifiedQuery) {
                step.modifiedQuery = ruleResult.modifiedQuery;
            }
            if (ruleResult.action === "approve") {
                // Auto-execute
                step.status = "approved";
                session.steps.push(step);
                await executeMongoStep(session, step);
                continue;
            }
            step.status = "awaiting_approval";
            session.steps.push(step);
            session.updatedAt = Date.now();
            return { session, pendingStep: step };
        }
        // Internal step — execute immediately
        if (step.type === "internal") {
            step.status = "executed";
            step.executedAt = Date.now();
            session.steps.push(step);
            try {
                await executeInternalStep(session, step, decision);
            }
            catch (err) {
                step.status = "failed";
                step.error = err.message;
            }
            session.updatedAt = Date.now();
            continue;
        }
    }
}
/**
 * User approves/modifies/rejects a pending step.
 */
export async function respondToStep(sessionId, stepId, action, modification, responseData) {
    const session = sessions.get(sessionId);
    if (!session)
        throw new Error(`Session ${sessionId} not found`);
    const step = session.steps.find(s => s.id === stepId);
    if (!step)
        throw new Error(`Step ${stepId} not found`);
    if (action === "reject") {
        step.status = "rejected";
        session.updatedAt = Date.now();
        // Re-plan: the planner will skip this step next iteration
        return advanceSession(sessionId);
    }
    if (action === "modify") {
        step.modifiedQuery = modification || step.query;
        step.query = modification || step.query;
        step.status = "approved";
    }
    else {
        step.status = "approved";
    }
    // Execute the step
    if (step.type === "mongo_query") {
        await executeMongoStep(session, step);
    }
    else if (step.type === "graph_query") {
        // For graph queries, user must provide the response data
        if (responseData) {
            step.result = responseData;
            step.status = "executed";
            step.executedAt = Date.now();
            session.context.graphResponse = responseData;
        }
        else {
            // Step remains pending until response data is provided
            step.status = "awaiting_approval";
        }
    }
    session.updatedAt = Date.now();
    return advanceSession(sessionId);
}
/**
 * Get a session by ID.
 */
export function getSession(sessionId) {
    return sessions.get(sessionId);
}
// ─── Internal Helpers ─────────────────────────────────────────
async function executeMongoStep(session, step) {
    try {
        const vars = step.variables || {};
        // Prefer env overrides from session context (set for custom environments)
        const tenantId = session.context.envTenantId || vars.tenantId;
        const propertyId = session.context.envPropertyId || vars.propertyId;
        const chargePostingSeq = parseInt(vars.chargePostingSequenceNumber, 10);
        if (!tenantId || !propertyId) {
            throw new Error(`Property not found in tenantList.xlsx (and no custom environment tenantId/propertyId set)`);
        }
        const account = await findAccountId(tenantId, chargePostingSeq);
        if (!account) {
            throw new Error(`Account not found for tenantId=${tenantId}, chargePostingSeqNo=${chargePostingSeq}`);
        }
        const rows = await executeLedgerQuery(tenantId, propertyId, account.accountId);
        // Normalize rows
        const csvRows = rows.map((r) => {
            const transIdStr = r.transactionId ? String(r.transactionId) : "";
            const digits = transIdStr.replace(/\D/g, "");
            const lineItemNo = digits.slice(0, 10).padStart(10, "0");
            return { ...r, lineItemNo, totalAmount: Number(r.totalAmount ?? 0) };
        });
        step.result = { rows: csvRows, rowCount: csvRows.length, accountId: account.accountId, accountType: account.accountType };
        step.status = "executed";
        step.executedAt = Date.now();
        session.context.csvData = csvRows;
        session.context.accountId = account.accountId;
        session.context.accountType = account.accountType;
    }
    catch (err) {
        step.status = "failed";
        step.error = err.message;
    }
}
async function executeInternalStep(session, step, decision) {
    // Import dynamically to avoid circular deps
    const { compareTransactions } = await import("./comparisonEngine.js");
    const { flattenTransactions } = await import("./transactionFlattener.js");
    const { correctPayload } = await import("./correctionEngine.js");
    switch (decision.intent) {
        case "compare": {
            const result = compareTransactions(session.context.csvData, session.context.folioTransactions);
            session.context.comparisonResult = result;
            step.result = { matched: result.matched, missing: result.missing.length, extra: result.extra.length, mismatches: result.mismatches.length };
            break;
        }
        case "auto_correct": {
            const { transactions } = flattenTransactions(session.context.folioTransactions);
            const correction = correctPayload(transactions, session.context.csvData, session.context.folioTransactions);
            session.context.correctedPayload = correction.correctedPayload;
            session.context.diffs = correction.diffs;
            step.result = { diffsCount: correction.diffs?.length || 0 };
            break;
        }
        case "resolve_missing": {
            // This is handled by the resolve-missing endpoint logic
            step.result = { info: "Graph response needed — use respondToStep with responseData" };
            break;
        }
    }
}
function extractQueryParams(context) {
    const ft = context.folioTransactions;
    if (!ft?.length)
        return {};
    const fid = ft[0].folioId || "";
    const confIds = ft[0].confirmationIds || [];
    const acrsConf = confIds.find((c) => c.provider === "ACRS");
    return {
        confirmationNumber: acrsConf?.value || "",
        folioNumber: ft[0].folioNumber || "",
        houseAccountNumber: "",
        propertyId: fid.split("_")[0] || "",
    };
}
