import { Buffer } from "node:buffer";
import type { SourceTargetType } from "@/lib/types";

export type SourceFileRecord = {
  relativePath: string;
  absolutePath: string;
  content: string;
};

type RepoMetadata = {
  default_branch: string;
};

type BranchResponse = {
  commit: {
    commit: {
      tree: {
        sha: string;
      };
    };
  };
};

type TreeResponse = {
  tree?: Array<{
    path: string;
    type: string;
    sha: string;
  }>;
  truncated?: boolean;
};

type BlobResponse = {
  content: string;
  encoding: string;
};

const relevantExtensions = /\.(ts|tsx|js|jsx|md|mdx|txt)$/;

export async function readGitHubTextFiles(input: { repoFullName: string; branch?: string }) {
  const repoFullName = normalizeGitHubRepo(input.repoFullName);
  const repoMetadata = await githubRequest<RepoMetadata>(`/repos/${repoFullName}`);
  const branch = input.branch?.trim() || repoMetadata.default_branch;
  const branchResponse = await githubRequest<BranchResponse>(
    `/repos/${repoFullName}/branches/${encodeURIComponent(branch)}`
  );

  const treeSha = branchResponse.commit.commit.tree.sha;
  const treeResponse = await githubRequest<TreeResponse>(
    `/repos/${repoFullName}/git/trees/${treeSha}?recursive=1`
  );

  if (treeResponse.truncated) {
    throw new Error("GitHub tree response was truncated. Narrow the repo scope or branch.");
  }

  const blobEntries = (treeResponse.tree ?? [])
    .filter((entry) => entry.type === "blob")
    .filter((entry) => relevantExtensions.test(entry.path))
    .filter((entry) => !isIgnoredPath(entry.path))
    .slice(0, 500);

  const files = await Promise.all(
    blobEntries.map(async (entry) => {
      const blob = await githubRequest<BlobResponse>(`/repos/${repoFullName}/git/blobs/${entry.sha}`);
      const decodedContent =
        blob.encoding === "base64" ? Buffer.from(blob.content.replace(/\n/g, ""), "base64").toString("utf8") : blob.content;

      return {
        relativePath: entry.path,
        absolutePath: `github://${repoFullName}/${branch}/${entry.path}`,
        content: decodedContent
      } satisfies SourceFileRecord;
    })
  );

  return {
    targetType: "github" as SourceTargetType,
    targetLabel: `github:${repoFullName}#${branch}`,
    files
  };
}

export function normalizeGitHubRepo(value: string) {
  const trimmed = value.trim().replace(/\.git$/, "");

  if (trimmed.startsWith("https://github.com/")) {
    const path = trimmed.replace("https://github.com/", "");
    return path.split("/").slice(0, 2).join("/");
  }

  return trimmed;
}

async function githubRequest<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "seo-monitor/0.1"
  };

  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    let details = `${response.status} ${response.statusText}`;

    try {
      const payload = (await response.json()) as { message?: string };
      if (payload.message) {
        details = payload.message;
      }
    } catch {}

    throw new Error(
      `GitHub source fetch failed: ${details}. If the repo is private, set GITHUB_TOKEN in the app environment.`
    );
  }

  return (await response.json()) as T;
}

function isIgnoredPath(path: string) {
  return (
    path.startsWith("node_modules/") ||
    path.startsWith(".next/") ||
    path.startsWith("dist/") ||
    path.startsWith("coverage/") ||
    path.includes("/node_modules/") ||
    path.includes("/.next/")
  );
}
