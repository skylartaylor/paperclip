import { createHash } from "node:crypto";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type Db, heartbeatRuns, issueExecutionDecisions, issueThreadInteractions, toolActionRequests, toolInvocations } from "@paperclipai/db";
import { conflict, forbidden } from "../../errors.js";
import { object, pick, rows, stable } from "./contracts.js";

export const mcpReviewDecisionSchema = z.object({
  decision: z.enum(["approve", "request_changes"]),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Bind a decision to the task and policy the person actually inspected. */
export function mcpWorkflowVersion(issue: unknown): string {
  const value = object(issue);
  return createHash("sha256").update(stable({
    ...pick(value, ["id", "companyId", "status", "assigneeAgentId", "assigneeUserId", "executionPolicy", "executionState", "reviewPolicy", "responsibleUserId"]),
    updatedAt: value.updatedAt instanceof Date ? value.updatedAt.toISOString() : value.updatedAt,
  })).digest("hex");
}

export function assertMcpReviewDecision(issue: unknown, review: z.infer<typeof mcpReviewDecisionSchema>, userId?: string) {
  const value = object(issue), state = object(value.executionState), participant = object(state.currentParticipant);
  if (mcpWorkflowVersion(issue) !== review.expectedVersion) {
    throw conflict("The workflow changed. Read it again before deciding.", { code: "MCP_REVIEW_STALE" });
  }
  if (!rows(object(value.executionPolicy).stages).some(stage =>
      object(stage).id === state.currentStageId && object(stage).type === state.currentStageType)) {
    throw conflict("This review stage is unavailable. Read the workflow and resolve its configuration in Paperclip.", { code: "MCP_REVIEW_UNAVAILABLE" });
  }
  if (value.status !== "in_review" || state.status !== "pending" || !state.currentStageId ||
      !userId || participant.type !== "user" || participant.userId !== userId ||
      value.assigneeUserId !== userId || value.assigneeAgentId != null) {
    throw forbidden("Only the current human review participant can decide this stage.", { code: "MCP_REVIEW_NOT_ASSIGNED" });
  }
}

export function mcpWorkflowTask(issue: unknown) {
  const value = object(issue), policy = object(value.executionPolicy), state = object(value.executionState);
  const principal = (v: unknown) => pick(v, ["type", "agentId", "userId"]);
  return {
    ...pick(value, ["id", "companyId", "identifier", "title", "status", "projectId", "assigneeAgentId", "assigneeUserId", "updatedAt"]),
    version: mcpWorkflowVersion(issue),
    policy: Object.keys(policy).length ? {
      ...pick(policy, ["mode", "commentRequired", "maxReviewRounds"]),
      stagesTruncated: rows(policy.stages).length > 30,
      stages: rows(policy.stages).slice(0, 30).map(v => ({ ...pick(v, ["id", "type", "approvalsNeeded"]), participants: rows(object(v).participants).slice(0, 30).map(principal), participantsTruncated: rows(object(v).participants).length > 30 })),
    } : null,
    state: Object.keys(state).length ? {
      ...pick(state, ["status", "currentStageId", "currentStageIndex", "currentStageType", "lastDecisionId", "lastDecisionOutcome", "changesRequestedCount"]),
      completedStageIds: rows(state.completedStageIds).slice(0, 30),
      completedStageIdsTruncated: rows(state.completedStageIds).length > 30,
      currentParticipant: state.currentParticipant ? principal(state.currentParticipant) : null,
      returnAssignee: state.returnAssignee ? principal(state.returnAssignee) : null,
    } : null,
  };
}

/** Indexed, task-scoped reads; never fetch arguments, credentials or run output. */
export async function readMcpWorkflow(db: Db, issue: { id: string; companyId: string }) {
  const scope = and(eq(toolActionRequests.companyId, issue.companyId), eq(toolActionRequests.issueId, issue.id));
  const [decisions, interactions, actions, activeRuns] = await Promise.all([
    db.select({ id: issueExecutionDecisions.id, stageId: issueExecutionDecisions.stageId, stageType: issueExecutionDecisions.stageType, outcome: issueExecutionDecisions.outcome, actorAgentId: issueExecutionDecisions.actorAgentId, actorUserId: issueExecutionDecisions.actorUserId, createdAt: issueExecutionDecisions.createdAt })
      .from(issueExecutionDecisions).where(and(eq(issueExecutionDecisions.companyId, issue.companyId), eq(issueExecutionDecisions.issueId, issue.id))).orderBy(desc(issueExecutionDecisions.createdAt), desc(issueExecutionDecisions.id)).limit(31),
    db.select({ id: issueThreadInteractions.id, kind: issueThreadInteractions.kind, status: issueThreadInteractions.status, resolverPolicy: issueThreadInteractions.effectiveResolverPolicy, createdAt: issueThreadInteractions.createdAt })
      .from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, issue.companyId), eq(issueThreadInteractions.issueId, issue.id), eq(issueThreadInteractions.status, "pending"))).orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id)).limit(31),
    db.select({ id: toolActionRequests.id, interactionId: toolActionRequests.interactionId, status: toolActionRequests.status, expiresAt: toolActionRequests.expiresAt, createdAt: toolActionRequests.createdAt, toolName: toolInvocations.toolName, riskLevel: toolInvocations.riskLevel, executionStatus: toolInvocations.status, completedAt: toolInvocations.completedAt })
      .from(toolActionRequests).innerJoin(toolInvocations, and(eq(toolInvocations.id, toolActionRequests.invocationId), eq(toolInvocations.companyId, issue.companyId)))
      .where(scope).orderBy(desc(toolActionRequests.createdAt), desc(toolActionRequests.id)).limit(31),
    db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, issue.companyId), sql`(${heartbeatRuns.nativeIssueId} = ${issue.id}::uuid or ${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id} or ${heartbeatRuns.id} = ${object(issue).checkoutRunId ?? null}::uuid or ${heartbeatRuns.id} = ${object(issue).executionRunId ?? null}::uuid)`, inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]))).limit(31),
  ]);
  return { task: mcpWorkflowTask(issue), decisions: decisions.slice(0, 30), pendingInteractions: interactions.slice(0, 30), toolActions: actions.slice(0, 30), activeRuns: activeRuns.slice(0, 30),
    truncated: { decisions: decisions.length > 30, pendingInteractions: interactions.length > 30, toolActions: actions.length > 30, activeRuns: activeRuns.length > 30 } };
}

export async function assertNoPendingMcpToolAction(db: Db, issue: { id: string; companyId: string }) {
  const [pending] = await db.select({ id: toolActionRequests.id }).from(toolActionRequests)
    .innerJoin(toolInvocations, and(eq(toolInvocations.id, toolActionRequests.invocationId), eq(toolInvocations.companyId, issue.companyId)))
    .where(and(eq(toolActionRequests.companyId, issue.companyId), eq(toolActionRequests.issueId, issue.id),
      inArray(toolActionRequests.status, ["pending", "approved", "executing"]),
      inArray(toolInvocations.status, ["pending", "authorized", "awaiting_approval", "executing"]))).limit(1);
  if (pending) throw conflict("Resolve the task's tool action in Paperclip before deciding the task review.", { code: "MCP_TOOL_ACTION_PENDING" });
}
