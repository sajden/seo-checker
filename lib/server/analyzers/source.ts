import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readGitHubTextFiles, type SourceFileRecord } from "@/lib/server/github-source";
import type { SourceFinding, SourceReport } from "@/lib/types";

type FileRecord = SourceFileRecord;

const PAGE_FILE_PATTERN = /(^|\/)app\/(?!api\/)(?:.+\/)?page\.(ts|tsx|js|jsx|mdx)$/;

export async function analyzeSourceRepo(repoPath: string): Promise<SourceReport> {
  const resolvedRepoPath = path.resolve(repoPath);
  const files = await readTextFiles(resolvedRepoPath);
  return analyzeSourceFiles(files, resolvedRepoPath, "local");
}

export async function analyzeGitHubSourceRepo(input: { repoFullName: string; branch?: string }): Promise<SourceReport> {
  const source = await readGitHubTextFiles(input);
  return analyzeSourceFiles(source.files, source.targetLabel, "github");
}

function analyzeSourceFiles(
  files: FileRecord[],
  targetLabel: string,
  targetType: "local" | "github"
): SourceReport {
  const findings: SourceFinding[] = [];

  const hasAppSitemap = files.some((file) => /(^|\/)app\/sitemap\.(ts|js)$/.test(file.relativePath));
  const hasRobots =
    files.some((file) => /(^|\/)app\/robots\.(ts|js)$/.test(file.relativePath)) ||
    files.some((file) => file.relativePath === "public/robots.txt");

  if (!hasAppSitemap) {
    findings.push({
      id: "missing-sitemap",
      severity: "warning",
      category: "indexing",
      title: "Saknar sitemap-definition",
      summary:
        "Jag hittar varken `app/sitemap.ts` eller annan tydlig sitemap-generering. Det gör det svårare att verifiera att alla viktiga URL:er exponeras konsekvent.",
      evidence: ["Ingen sitemap-fil hittades i app-lagret."],
      filePaths: []
    });
  }

  if (!hasRobots) {
    findings.push({
      id: "missing-robots",
      severity: "warning",
      category: "indexing",
      title: "Saknar robots-konfiguration",
      summary:
        "Jag hittar varken `app/robots.ts` eller `public/robots.txt`. Det betyder inte automatiskt att indexeringen är fel, men det saknas ett explicit lager för crawl-direktiv.",
      evidence: ["Ingen robots-fil hittades i repo:t."],
      filePaths: []
    });
  }

  const layoutFiles = files.filter((file) => /(^|\/)app\/layout\.(ts|tsx|js|jsx)$/.test(file.relativePath));
  const hasMetadataBase = layoutFiles.some((file) => file.content.includes("metadataBase"));

  if (!hasMetadataBase) {
    findings.push({
      id: "missing-metadata-base",
      severity: "warning",
      category: "metadata",
      title: "Saknar metadataBase",
      summary:
        "Jag hittar ingen `metadataBase` i layout-metadata. Det gör canonical-, OG- och alternates-byggandet mer sårbart, särskilt när appen körs i flera miljöer.",
      evidence: layoutFiles.length
        ? layoutFiles.map((file) => `${file.relativePath} saknar metadataBase.`)
        : ["Ingen layoutfil med metadata hittades."],
      filePaths: layoutFiles.map((file) => file.absolutePath)
    });
  }

  const publicPages = files.filter((file) => PAGE_FILE_PATTERN.test(file.relativePath));
  const metadatalessPages = publicPages.filter(
    (file) => !file.content.includes("export const metadata") && !file.content.includes("generateMetadata")
  );

  if (metadatalessPages.length > 0) {
    findings.push({
      id: "page-metadata-gaps",
      severity: "info",
      category: "metadata",
      title: "Publika sidor utan egen metadata",
      summary:
        "Vissa publika sidor saknar egen `metadata` eller `generateMetadata`. Det är ofta acceptabelt för enklare sidor, men kommersiella landningssidor tappar tydlighet i title/description när de bara faller tillbaka till globala defaults.",
      evidence: metadatalessPages.map((file) => `${file.relativePath} saknar page-level metadata.`),
      filePaths: metadatalessPages.map((file) => file.absolutePath)
    });
  }

  const reexportPages = publicPages.filter((file) => /export\s*\{[^}]*default[^}]*\}\s*from\s*["'][^"']+["']/.test(file.content));

  if (reexportPages.length > 0) {
    findings.push({
      id: "reexport-route-aliases",
      severity: "critical",
      category: "routing",
      title: "Alias-routes som återanvänder samma sida",
      summary:
        "Minst en route ser ut att återexportera en annan page-komponent. Det är ofta ett tecken på att samma innehåll ligger på flera URL:er utan redirect eller canonical-strategi.",
      evidence: reexportPages.map((file) => `${file.relativePath} återexporterar en annan page.`),
      filePaths: reexportPages.map((file) => file.absolutePath)
    });
  }

  const dynamicPages = publicPages.filter((file) => file.content.includes('export const dynamic = "force-dynamic"'));

  if (dynamicPages.length > 0) {
    findings.push({
      id: "force-dynamic-pages",
      severity: "warning",
      category: "rendering",
      title: "Publika sidor körs som force-dynamic",
      summary:
        "Jag hittar publika sidor som tvingas till `force-dynamic`. Det kan vara rätt i vissa fall, men bör granskas eftersom det ofta försämrar caching och gör outputen mindre förutsägbar.",
      evidence: dynamicPages.map((file) => `${file.relativePath} använder force-dynamic.`),
      filePaths: dynamicPages.map((file) => file.absolutePath)
    });
  }

  const noSsrFindings = findNoSsrShellRisks(files, publicPages);
  findings.push(...noSsrFindings);

  const suspiciousTransliterations = files.filter((file) => {
    if (!/(content\/pages\/|app\/).+\.(md|mdx|ts|tsx)$/.test(file.relativePath)) {
      return false;
    }

    const patterns = ["Tjanster", "hjalper", "Arbetssatt", "Nasta steg", "losningar", "behover"];
    return patterns.some((pattern) => file.content.includes(pattern));
  });

  if (suspiciousTransliterations.length > 0) {
    findings.push({
      id: "suspicious-transliterations",
      severity: "info",
      category: "content",
      title: "Möjliga språk- eller teckenkvalitetsproblem i innehåll",
      summary:
        "Jag hittar flera ord som ser ASCII-translittererade ut. Det är inte ett tekniskt SEO-fel, men på publika sidor drar det ned kvalitetsintrycket och kan vara värt att fånga automatiskt.",
      evidence: suspiciousTransliterations.map((file) => `${file.relativePath} innehåller text som ser translittererad ut.`),
      filePaths: suspiciousTransliterations.map((file) => file.absolutePath)
    });
  }

  return {
    repoPath: targetLabel,
    targetType,
    findings,
    checkedAt: new Date().toISOString()
  };
}

function findNoSsrShellRisks(files: FileRecord[], publicPages: FileRecord[]) {
  const findings: SourceFinding[] = [];
  const componentsByImport = new Map<string, FileRecord>();

  for (const file of files) {
    const normalized = file.relativePath.replace(/\.(ts|tsx|js|jsx|mdx)$/, "");
    if (normalized.startsWith("src/")) {
      componentsByImport.set(`@/${normalized.slice(4)}`, file);
    }

    componentsByImport.set(`./${normalized}`, file);
  }

  for (const page of publicPages) {
    const imports = [...page.content.matchAll(/import\s+\{?\s*[\w,\s]*\}?\s+from\s+["']([^"']+)["']/g)];
    const hasServerRenderedH1 = /<h1[\s>]/.test(page.content);

    for (const match of imports) {
      const importPath = match[1];
      if (!importPath.startsWith("@/")) {
        continue;
      }

      const importedFile = componentsByImport.get(importPath);
      if (!importedFile) {
        continue;
      }

      const hasNoSsrDynamic =
        importedFile.content.includes("dynamic(") &&
        importedFile.content.includes("ssr: false");

      if (!hasNoSsrDynamic) {
        continue;
      }

      if (hasServerRenderedH1) {
        continue;
      }

      findings.push({
        id: `no-ssr-shell-${page.relativePath}`,
        severity: "critical",
        category: "rendering",
        title: "Primärt sidinnehåll laddas utan SSR",
        summary:
          "En publik page importerar en komponent som använder `dynamic(..., { ssr: false })`. Om den komponenten bär huvudrubrik eller primärt innehåll kan server-renderad HTML bli tunn för sökmotorer.",
        evidence: [
          `${page.relativePath} importerar ${importPath}.`,
          `${importedFile.relativePath} använder dynamic() med ssr: false.`
        ],
        filePaths: [page.absolutePath, importedFile.absolutePath]
      });
    }
  }

  return findings;
}

async function readTextFiles(rootPath: string) {
  await access(rootPath);

  const files: FileRecord[] = [];
  await walk(rootPath, rootPath, files);
  return files;
}

async function walk(rootPath: string, currentPath: string, files: FileRecord[]) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".git") || entry.name === "node_modules" || entry.name === ".next") {
      continue;
    }

    const absolutePath = path.join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await walk(rootPath, absolutePath, files);
      continue;
    }

    if (!/\.(ts|tsx|js|jsx|md|mdx|txt)$/.test(entry.name)) {
      continue;
    }

    const content = await readFile(absolutePath, "utf8");
    files.push({
      absolutePath,
      relativePath: path.relative(rootPath, absolutePath).replaceAll("\\", "/"),
      content
    });
  }
}
