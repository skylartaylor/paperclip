import { z } from "zod";
import { task, requestId, pathId, object, pick, type Capability } from "./contracts.js";
import { mcpReviewDecisionSchema } from "./workflow.js";

const bridge = "/plugins/paperclip-github-plugin/bridge";
const linkFields = ["kind", "paperclipIssueId", "repositoryUrl", "githubIssueNumber", "githubIssueUrl", "githubPullRequestNumber", "githubPullRequestUrl", "githubPullRequestState", "githubIssueState", "source", "syncedAt"];
const githubUrl = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" && !url.username && !url.password && !url.search && !url.hash &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/[1-9][0-9]*$/.test(url.pathname);
  } catch { return false; }
}, "Use a full GitHub issue or pull request URL without credentials, query or fragment");

export const workflowMcpCapabilities: Capability[] = [
  {
    name: "paperclip_get_task_workflow",
    description: "Read a task's native review stages, current participant, bounded decision history, active runs, pending interactions and tool-action execution statuses. Returns a version required for explicit review decisions. Tool arguments, secrets and raw run output are omitted. This read never starts agents or approves actions.",
    schema: z.object(task).strict(),
    run: async (p, a, api, origin) => ({
      ...object(await api(p, "GET", `/issues/${pathId(a.taskId)}/workflow`)),
      taskUrl: origin + "/" + pathId(p.company.issuePrefix) + "/issues/" + pathId(a.taskId),
      externalActionApproval: "Tool-action approval and execution remain in Paperclip. A task review decision does not approve a tool action.",
    }),
  },
  {
    name: "paperclip_get_task_github_link",
    description: "Read the task's GitHub Sync link. Requires the installed GitHub Sync plugin and normal task access. Does not expose its token or make GitHub changes.",
    schema: z.object(task).strict(),
    run: async (p, a, api) => {
      await api(p, "GET", `/issues/${pathId(a.taskId)}/workflow`);
      const response = object(await api(p, "POST", bridge + "/data", { companyId: a.companyId, key: "issue.githubDetails", params: { companyId: a.companyId, issueId: a.taskId } }));
      return { link: response.data ? pick(response.data, linkFields) : null };
    },
  },
  {
    name: "paperclip_link_task_github_item", write: true,
    description: "Link a task to one existing GitHub issue or pull request using the installed GitHub Sync plugin and its existing project/repository mapping. Saves a local link and reads GitHub metadata; does not post, push, change GitHub, assign agents or approve actions. Existing links cannot be replaced. Reuse requestId after an uncertain result, then read the link.",
    schema: z.object({ ...task, requestId, githubUrl }).strict(),
    run: async (p, a, api) => {
      await api(p, "GET", `/issues/${pathId(a.taskId)}/workflow`);
      const kind = new URL(String(a.githubUrl)).pathname.split("/")[3] === "pull" ? "pull_request" : "issue";
      const response = object(await api(p, "POST", bridge + "/action", { companyId: a.companyId, key: "issue.linkGitHubItem", params: { companyId: a.companyId, issueId: a.taskId, kind, reference: a.githubUrl } }));
      return { link: pick(response.data, linkFields) };
    },
  },
  {
    name: "paperclip_decide_task_review", write: true, destructive: true,
    description: "Approve or request changes on the current native review stage as the connected person, only when that person is the assigned human participant. First read paperclip_get_task_workflow and supply its version. Requires explicit user authorization for this specific decision. A note is mandatory. Normal review transitions, attribution, scheduling and budgets apply; requesting changes or advancing stages may wake agents. Stale state and active runs are rejected. This cannot approve or execute a pending GitHub/tool action.",
    schema: z.object({ ...task, requestId, ...mcpReviewDecisionSchema.shape, note: z.string().trim().min(1).max(50000) }).strict(),
    run: async (p, a, api) => {
      const result = await api(p, "PATCH", `/issues/${pathId(a.taskId)}`, {
        status: a.decision === "approve" ? "done" : "in_progress", comment: a.note,
        mcpReviewDecision: { decision: a.decision, expectedVersion: a.expectedVersion },
      });
      return { task: pick(result, ["id", "companyId", "identifier", "status", "assigneeAgentId", "assigneeUserId", "executionState", "updatedAt"]), decision: a.decision, externalActionApproved: false };
    },
  },
];
