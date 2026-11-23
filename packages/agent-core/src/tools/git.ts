/**
 * Git tools — git log and git blame via simple-git.
 */

import { type Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import simpleGit from "simple-git";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export async function gitLog(args: {
  repo_path: string;
  file_path?: string;
  max_commits?: number;
  branch?: string;
}): Promise<string> {
  const { repo_path, file_path, max_commits = 20, branch = "HEAD" } = args;
  const limit = Math.min(max_commits, 100);

  try {
    const git = simpleGit(repo_path);

    // Verify it's a valid repo
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return `'${repo_path}' is not a git repository.`;

    const logOptions: string[] = [`-${limit}`, branch];
    if (file_path) logOptions.push("--", file_path);

    const log = await git.log(logOptions);

    if (log.all.length === 0) return "No commits found.";

    const header =
      `Git log for ${basename(repo_path)}` + (file_path ? ` — ${file_path}` : "");

    const lines = log.all.map((c) => {
      const date = c.date.slice(0, 16).replace("T", " ");
      const msg = c.message.split("\n")[0].slice(0, 80);
      return `${c.hash.slice(0, 8)} ${date} ${c.author_name}: ${msg}`;
    });

    return header + "\n" + lines.join("\n");
  } catch (err) {
    return `Git error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function gitBlame(args: {
  repo_path: string;
  file_path: string;
  start_line?: number;
  end_line?: number;
}): Promise<string> {
  const { repo_path, file_path, start_line, end_line } = args;

  try {
    const git = simpleGit(repo_path);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return `'${repo_path}' is not a git repository.`;

    // Build blame args — -p gives porcelain format we can parse
    const blameArgs = ["blame", "--porcelain"];
    if (start_line !== undefined && end_line !== undefined) {
      blameArgs.push(`-L${start_line},${end_line}`);
    } else if (start_line !== undefined) {
      blameArgs.push(`-L${start_line},+50`);
    }
    blameArgs.push("HEAD", "--", file_path);

    const raw = await git.raw(blameArgs);
    const lines = raw.split("\n");

    // Porcelain format: commit hash lines followed by "filename ..." then "	<content>"
    const commitInfo: Record<string, { author: string; date: string }> = {};
    const blameLines: Array<{ hash: string; lineNum: number; content: string }> = [];

    let currentHash = "";
    let currentLineNum = 0;

    for (const line of lines) {
      // Line starting with 40-char hex = commit header
      const commitHeader = line.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)/);
      if (commitHeader) {
        currentHash = commitHeader[1];
        currentLineNum = parseInt(commitHeader[2], 10);
        continue;
      }
      if (line.startsWith("author ")) {
        if (!commitInfo[currentHash]) commitInfo[currentHash] = { author: "", date: "" };
        commitInfo[currentHash].author = line.slice(7);
        continue;
      }
      if (line.startsWith("author-time ")) {
        if (!commitInfo[currentHash]) commitInfo[currentHash] = { author: "", date: "" };
        const ts = parseInt(line.slice(12), 10);
        const d = new Date(ts * 1000);
        commitInfo[currentHash].date = d.toISOString().slice(0, 10);
        continue;
      }
      // Content line starts with a tab
      if (line.startsWith("\t") && currentHash) {
        blameLines.push({
          hash: currentHash,
          lineNum: currentLineNum,
          content: line.slice(1),
        });
      }
    }

    if (blameLines.length === 0) return `No blame data for ${file_path}`;

    const output = blameLines.map((bl) => {
      const info = commitInfo[bl.hash] ?? { author: "Unknown", date: "????-??-??" };
      const author = info.author.slice(0, 15).padEnd(15);
      return `${String(bl.lineNum).padStart(4)} | ${bl.hash.slice(0, 8)} ${info.date} ${author} | ${bl.content}`;
    });

    return `Blame: ${file_path}\n` + output.join("\n");
  } catch (err) {
    return `Git blame error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Tool definitions (pi-ai format)
// ---------------------------------------------------------------------------

export const gitTools: Tool[] = [
  {
    name: "git_log_tool",
    description:
      "Show git commit history for a repository or specific file. Useful for finding when a change was introduced and who made it.",
    parameters: Type.Object({
      repo_path: Type.String({ description: "Absolute path to the local git repository." }),
      file_path: Type.Optional(
        Type.String({ description: "File path relative to repo root (optional)." })
      ),
      max_commits: Type.Optional(
        Type.Integer({ description: "Maximum commits to return (max 100).", maximum: 100 })
      ),
      branch: Type.Optional(Type.String({ description: "Branch or ref to start from." })),
    }),
  },
  {
    name: "git_blame_tool",
    description:
      "Show git blame for a file, showing which commit last modified each line. Useful for identifying who introduced specific code.",
    parameters: Type.Object({
      repo_path: Type.String({ description: "Absolute path to the local git repository." }),
      file_path: Type.String({ description: "File path relative to the repo root." }),
      start_line: Type.Optional(Type.Integer({ description: "Start line number (optional)." })),
      end_line: Type.Optional(Type.Integer({ description: "End line number (optional)." })),
    }),
  },
];
