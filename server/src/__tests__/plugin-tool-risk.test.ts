import { describe, expect, it } from "vitest";
import { inferPluginToolRisk } from "../services/plugin-tool-risk.js";

describe("plugin tool mutation risk", () => {
  it.each([
    "update_issue", "assign_to_current_user", "add_issue_comment",
    "create_pull_request", "update_pull_request", "reply_to_review_thread",
    "resolve_review_thread", "unresolve_review_thread", "request_pull_request_reviewers",
    "add_pull_request_to_project", "upload_pull_request_asset", "merge_pull_request", "link_github_item",
  ])("classifies GitHub %s as a write", (action) => {
    expect(inferPluginToolRisk(`paperclip-github-plugin:${action}`)).toBe("write");
  });
  it.each([
    "get_issue", "list_issue_comments", "get_pull_request", "list_pull_requests",
    "search_repository_items", "get_current_user", "get_address", "list_assignees",
  ])("preserves read classification for %s", (action) => {
    expect(inferPluginToolRisk(`paperclip-github-plugin:${action}`)).toBe("read");
  });
  it.each(["delete_issue", "remove_label", "purge", "drop_table"])("preserves destructive classification for %s", (action) => {
    expect(inferPluginToolRisk(`plugin:${action}`)).toBe("destructive");
  });
  it("retains destructive precedence and case-insensitive separated verb matching", () => {
    expect(inferPluginToolRisk("PLUGIN:ADD-ISSUE-COMMENT")).toBe("write");
    expect(inferPluginToolRisk("plugin:create_then_delete")).toBe("destructive");
    expect(inferPluginToolRisk("plugin:get_additional_details")).toBe("read");
  });
});
