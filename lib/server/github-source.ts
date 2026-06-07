import { Buffer } from "node:buffer";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SourceTargetType } from "@/lib/types";

export type SourceFileRecord = {
  relativePath: string;
  absolutePath: string;
  content: string;
};

type RepoMetadata = {
  default_branch: string;
};

export type GitHubRepoOption = {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  updatedAt?: string | null;
};

export type GitHubBranchOption = {
  name: string;
  sha?: string | null;
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

export async function listGitHubRepos(): Promise<GitHubRepoOption[]> {
  const localRepos = await listLocalGitHubRepos();

  try {
    const repos = await githubRequestPages<{
      full_name: string;
      name: string;
      private: boolean;
      default_branch?: string;
      pushed_at?: string;
      updated_at?: string;
      owner?: { login?: string };
    }>("/user/repos?per_page=100&sort=full_name&direction=asc&visibility=all&affiliation=owner,collaborator,organization_member");

    return mergeRepoOptions([
      ...repos.map((repo) => ({
        fullName: repo.full_name,
        name: repo.name,
        owner: repo.owner?.login ?? repo.full_name.split("/")[0],
        private: Boolean(repo.private),
        defaultBranch: repo.default_branch ?? "main",
        updatedAt: repo.pushed_at ?? repo.updated_at ?? null
      })),
      ...localRepos
    ]);
  } catch (error) {
    if (localRepos.length > 0) return localRepos;
    throw error;
  }
}

export async function listGitHubBranches(repoFullName: string): Promise<GitHubBranchOption[]> {
  const normalized = normalizeGitHubRepo(repoFullName);
  const localBranches = await listLocalGitHubBranches(normalized);

  try {
    const branches = await githubRequestPages<{ name: string; commit?: { sha?: string } }>(
      `/repos/${normalized}/branches?per_page=100`
    );

    return branches.map((branch) => ({
      name: branch.name,
      sha: branch.commit?.sha ?? null
    }));
  } catch (error) {
    if (localBranches.length > 0) return localBranches;
    throw error;
  }
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

async function githubRequestPages<T>(path: string, maxPages = 100): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const payload = await githubRequest<T[]>(`${path}${separator}page=${page}`);
    if (!Array.isArray(payload) || payload.length === 0) break;
    items.push(...payload);
    if (payload.length < 100) break;
  }
  return items;
}

async function listLocalGitHubRepos(): Promise<GitHubRepoOption[]> {
  const repoPaths = await listLocalRepoPaths();
  const repos = (await Promise.all(repoPaths.map((repoPath) => localRepoOption(repoPath)))).filter(
    (repo): repo is GitHubRepoOption => Boolean(repo)
  );

  return mergeRepoOptions(repos);
}

async function listLocalGitHubBranches(repoFullName: string): Promise<GitHubBranchOption[]> {
  const repoPath = await findLocalRepoPath(repoFullName);
  if (!repoPath) return [];

  const branchNames = await readLocalBranches(repoPath);
  return branchNames.map((name) => ({ name, sha: null }));
}

async function findLocalRepoPath(repoFullName: string) {
  const repoPaths = await listLocalRepoPaths();
  for (const repoPath of repoPaths) {
    try {
      const config = await readFile(path.join(repoPath, ".git", "config"), "utf8");
      if (githubFullNameFromRemoteConfig(config)?.toLowerCase() === repoFullName.toLowerCase()) {
        return repoPath;
      }
    } catch {}
  }
  return null;
}

async function listLocalRepoPaths() {
  const workspaceRoots = uniqueStrings([
    process.env.WORKSPACE_ROOT?.trim(),
    process.cwd().includes(`${path.sep}github${path.sep}`)
      ? process.cwd().slice(0, process.cwd().indexOf(`${path.sep}github${path.sep}`) + "/github".length)
      : undefined
  ]);

  const repos = (
    await Promise.all(
      workspaceRoots.map(async (workspaceRoot) => {
        try {
          const entries = await readdir(workspaceRoot, { withFileTypes: true });
          return entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map((entry) => path.join(workspaceRoot, entry.name));
        } catch {
          return [];
        }
      })
    )
  ).flat();

  return repos;
}

async function localRepoOption(repoPath: string): Promise<GitHubRepoOption | null> {
  try {
    const config = await readFile(path.join(repoPath, ".git", "config"), "utf8");
    const fullName = githubFullNameFromRemoteConfig(config);
    if (!fullName) return null;

    const [owner, name] = fullName.split("/");
    return {
      fullName,
      name,
      owner,
      private: false,
      defaultBranch: await readLocalDefaultBranch(repoPath),
      updatedAt: null
    };
  } catch {
    return null;
  }
}

function githubFullNameFromRemoteConfig(config: string) {
  const urls = [...config.matchAll(/^\s*url\s*=\s*(.+)\s*$/gm)].map((match) => match[1].trim());
  for (const url of urls) {
    const match =
      url.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/) ??
      url.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

async function readLocalDefaultBranch(repoPath: string) {
  try {
    const head = await readFile(path.join(repoPath, ".git", "HEAD"), "utf8");
    return head.match(/^ref: refs\/heads\/(.+)$/)?.[1].trim() || "main";
  } catch {
    return "main";
  }
}

async function readLocalBranches(repoPath: string) {
  const refsRoot = path.join(repoPath, ".git", "refs", "heads");
  const branches = await readBranchRefs(refsRoot);
  const defaultBranch = await readLocalDefaultBranch(repoPath);
  return uniqueStrings([defaultBranch, ...branches]).sort((a, b) => a.localeCompare(b));
}

async function readBranchRefs(dir: string, prefix = ""): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const branches = await Promise.all(
      entries.map((entry) => {
        const branchName = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return readBranchRefs(path.join(dir, entry.name), branchName);
        if (entry.isFile()) return Promise.resolve([branchName]);
        return Promise.resolve([]);
      })
    );
    return branches.flat();
  } catch {
    return [];
  }
}

function mergeRepoOptions(repos: GitHubRepoOption[]) {
  const byFullName = new Map<string, GitHubRepoOption>();
  for (const repo of repos) {
    const key = repo.fullName.toLowerCase();
    if (!byFullName.has(key)) byFullName.set(key, repo);
  }
  return [...byFullName.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
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
