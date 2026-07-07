export type StepType = "internal" | "graph_query" | "mongo_query" | "user_input" | "decision";
export type StepStatus = "pending" | "awaiting_approval" | "approved" | "rejected" | "modified" | "executed" | "failed" | "skipped";
export interface OrchestratorStep {
    id: string;
    type: StepType;
    title: string;
    description: string;
    status: StepStatus;
    query?: string;
    variables?: any;
    intent?: string;
    result?: any;
    error?: string;
    modifiedQuery?: string;
    ruleOverrides?: string[];
    createdAt: number;
    executedAt?: number;
}
export interface OrchestratorSession {
    id: string;
    request: string;
    context: Record<string, any>;
    steps: OrchestratorStep[];
    status: "active" | "completed" | "aborted";
    createdAt: number;
    updatedAt: number;
}
export interface PlannerDecision {
    action: "graph_query" | "mongo_query" | "internal" | "complete" | "user_input";
    title: string;
    description: string;
    intent: string;
    queryType?: string;
    params?: Record<string, any>;
}
export interface Rule {
    id: string;
    condition: string;
    action: "force_approve" | "force_reject" | "modify_query" | "skip" | "require_approval" | "inject_condition";
    modification?: string;
    priority: number;
}
export declare function loadRuleSheet(rules: Rule[]): void;
export declare function getSessionRules(): Rule[];
/**
 * Create a new orchestrator session from a user request.
 */
export declare function createSession(request: string, context: Record<string, any>): OrchestratorSession;
/**
 * Get next step requiring user interaction (or execute internal steps automatically).
 * Returns the next step awaiting approval, or null if complete.
 */
export declare function advanceSession(sessionId: string): Promise<{
    session: OrchestratorSession;
    pendingStep?: OrchestratorStep;
}>;
/**
 * User approves/modifies/rejects a pending step.
 */
export declare function respondToStep(sessionId: string, stepId: string, action: "approve" | "modify" | "reject", modification?: string, responseData?: any): Promise<{
    session: OrchestratorSession;
    pendingStep?: OrchestratorStep;
}>;
/**
 * Get a session by ID.
 */
export declare function getSession(sessionId: string): OrchestratorSession | undefined;
