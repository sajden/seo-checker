import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const runId = process.env.SEO_RUN_ID;
const batchId = process.env.SEO_BATCH_ID;
const profile = process.env.SEO_RUN_PROFILE || "full";
const dataDir = process.env.SEO_DATA_DIR || process.env.DATA_DIR || "/data";
const baseUrl = (process.env.SEO_BASE_URL || "http://127.0.0.1:3010").replace(/\/$/, "");
const storageFile = path.join(dataDir, "seo-runs.json");

if (!runId || !batchId) {
  process.exit(1);
}

await updateRun({ status: "running", updatedAt: new Date().toISOString() });

try {
  const response = await postJson(`${baseUrl}/api/batches/${encodeURIComponent(batchId)}/run?profile=${encodeURIComponent(profile)}`);
  const payload = response.body ? JSON.parse(response.body) : {};
  const finishedAt = new Date().toISOString();

  if (response.status < 200 || response.status >= 300) {
    await updateRun({
      status: "failed",
      updatedAt: finishedAt,
      completedAt: finishedAt,
      error: payload?.error || `SEO run failed with ${response.status}`
    });
    process.exit(0);
  }

  await updateRun({
    status: payload ? "completed" : "failed",
    updatedAt: finishedAt,
    completedAt: finishedAt,
    error: payload ? undefined : "Empty SEO run response.",
    result: payload
  });
} catch (error) {
  const finishedAt = new Date().toISOString();
  await updateRun({
    status: "failed",
    updatedAt: finishedAt,
    completedAt: finishedAt,
    error: formatError(error)
  });
}

async function readRuns() {
  try {
    const raw = await readFile(storageFile, "utf8");
    const payload = JSON.parse(raw);
    return Array.isArray(payload.runs) ? payload.runs : [];
  } catch {
    return [];
  }
}

async function updateRun(patch) {
  const runs = await readRuns();
  const next = runs.map((run) => run.id === runId ? { ...run, ...patch } : run);
  await mkdir(dataDir, { recursive: true });
  await writeFile(storageFile, JSON.stringify({ runs: next }, null, 2), "utf8");
}

function formatError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    return `${error.message}: ${cause.code}`;
  }
  return error.message;
}

function postJson(targetUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request({
      method: "POST",
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: {
        "content-type": "application/json"
      },
      timeout: 30 * 60 * 1000
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          body
        });
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("SEO run timed out after 30 minutes."));
    });
    request.on("error", reject);
    request.end();
  });
}
