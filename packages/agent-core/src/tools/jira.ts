/**
 * Jira tool — look up a Jira issue by key using the REST API v3.
 */

import { type Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getEffectiveSettings } from "../config.js";

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export async function jiraTicket(args: { issue_key: string, short_description?: boolean }): Promise<string> {
  const { issue_key, short_description = true } = args;

  const { url, email, api_token } = getEffectiveSettings().jira;
  if (!url || !email || !api_token) {
    return "Jira is not configured. Set jira.url, jira.email, and jira.api_token in config.toml.";
  }

  const auth = Buffer.from(`${email}:${api_token}`).toString("base64");
  const endpoint = `${url.replace(/\/$/, "")}/rest/api/3/issue/${encodeURIComponent(issue_key)}?fields=summary,status,assignee,description,comment,priority,labels`;

  try {
    const resp = await fetch(endpoint, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      if (resp.status === 404) return `Jira issue '${issue_key}' not found. Issue may not exist or you do not have permission to view it.`;
      return `Jira API error: ${resp.status} ${resp.statusText}`;
    }

    const issue = (await resp.json()) as Record<string, unknown>;
    const fields = (issue.fields ?? {}) as Record<string, unknown>;

    const summary = (fields.summary as string) ?? "(no summary)";
    const status = ((fields.status as Record<string, unknown>)?.name as string) ?? "Unknown";
    const priority = ((fields.priority as Record<string, unknown>)?.name as string) ?? "Unknown";
    const assignee =
      ((fields.assignee as Record<string, unknown>)?.displayName as string) ?? "Unassigned";
    const labels = ((fields.labels as string[]) ?? []).join(", ") || "none";

    // Description — Jira v3 returns Atlassian Document Format (ADF); extract plain text
    const descRaw = fields.description;
    let description = "(no description)";
    if (typeof descRaw === "string") {
      description = short_description ? descRaw.slice(0, 500) + (descRaw.length > 500 ? "..." : "") : descRaw;
    } else if (descRaw && typeof descRaw === "object") {
      description = short_description ? adfToText(descRaw as AdfNode).slice(0, 500) : adfToText(descRaw as AdfNode);
    }

    // Last 5 comments
    const commentList =
      ((fields.comment as Record<string, unknown>)?.comments as Record<string, unknown>[]) ?? [];
    const recent = commentList.slice(-5);
    let commentText = "";
    if (recent.length > 0) {
      const lines = recent.map((c) => {
        const author =
          ((c.author as Record<string, unknown>)?.displayName as string) ?? "Unknown";
        const bodyRaw = c.body;
        let body = "";
        if (typeof bodyRaw === "string") body = short_description ? bodyRaw.slice(0, 300) : bodyRaw;
        else if (bodyRaw && typeof bodyRaw === "object") body = short_description ? adfToText(bodyRaw as AdfNode).slice(0, 300) : adfToText(bodyRaw as AdfNode);
        return `  [${author}]: ${body}`;
      });
      commentText = "\nRecent comments:\n" + lines.join("\n");
    }

    return (
      `**${issue_key}: ${summary}**\n` +
      `Status: ${status}\n` +
      `Priority: ${priority}\n` +
      `Assignee: ${assignee}\n` +
      `Labels: ${labels}\n\n` +
      `Description:\n${description}` +
      commentText
    );
  } catch (err) {
    return `Jira error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// ADF (Atlassian Document Format) plain-text extractor
// ---------------------------------------------------------------------------

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

function adfToText(node: AdfNode): string {
  if (node.text) return node.text;
  if (!node.content) return "";
  return node.content
    .map((child) => adfToText(child))
    .join(node.type === "paragraph" ? "\n" : "");
}

// ---------------------------------------------------------------------------
// Tool definitions (pi-ai format)
// ---------------------------------------------------------------------------

export const jiraTools: Tool[] = [
  {
    name: "jira_ticket_tool",
    description:
      "Look up a Jira ticket by issue key. Returns the summary, status, assignee, description, and recent comments.",
    parameters: Type.Object({
      issue_key: Type.String({
        description: "Jira issue key (e.g. 'OPS-1234' or 'PROJ-567').",
      }),
      short_description: Type.Optional(
        Type.Boolean({
          description: "Whether to return a shortened version of the description and comments. Defaults to true.",
        })
      ),
    }),
  },
];
