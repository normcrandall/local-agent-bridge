import { createInstallationToken } from "./github-app-auth.mjs";
import { providerCapacitySnapshot } from "./provider-concurrency.mjs";

const SHA = /^[0-9a-f]{40}$/i;
const cache = new Map();
const CACHE_MS = 30_000;

function headers(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
}

async function githubGet({ apiUrl, token, path, signal, fetchImpl }) {
  const response = await fetchImpl(`${apiUrl}${path}`, { headers: headers(token), signal });
  if (!response.ok) {
    const error = new Error(`GitHub GET ${path} failed (${response.status}).`);
    error.status = response.status;
    error.retryAfter = response.headers.get("retry-after");
    throw error;
  }
  return response.json();
}

function safeFailure(error) {
  const message = String(error?.message || error || "Remote reconciliation failed.").slice(0, 300);
  const offline = error?.name === "AbortError" ? false
    : /ECONN|ENET|EAI_AGAIN|ETIMEDOUT|fetch failed|network|socket/i.test(`${error?.code || ""} ${message}`);
  const rateLimited = error?.status === 429 || (error?.status === 403 && error?.retryAfter);
  return { reason: rateLimited ? "rate_limited" : offline ? "offline" : "remote_error", message, statusCode: error?.status || null };
}

async function optional(read, source, degradations) {
  try { return await read(); }
  catch (error) {
    if (error?.name === "AbortError") throw error;
    degradations.push({ source, ...safeFailure(error) });
    return null;
  }
}

function ticketKey(ticket) {
  return [ticket.repository, ticket.laneId, ticket.issueNumber || "", ticket.prNumber || "", ticket.headSha || "", ticket.journalSequence || 0, ticket.journalDigest || ""].join("\0");
}

function normalizeTicket(ticket) {
  if (!ticket || typeof ticket !== "object") throw new Error("Mission Control reconciliation ticket must be an object.");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ticket.repository || "")) throw new Error("Mission Control reconciliation repository is invalid.");
  if (typeof ticket.laneId !== "string" || !ticket.laneId || ticket.laneId.length > 512) throw new Error("Mission Control reconciliation laneId is invalid.");
  const positive = (value) => Number.isInteger(value) && value > 0 ? value : null;
  const headSha = SHA.test(ticket.headSha || "") ? String(ticket.headSha).toLowerCase() : null;
  return {
    repository: ticket.repository.toLowerCase(), laneId: ticket.laneId,
    issueNumber: positive(ticket.issueNumber), prNumber: positive(ticket.prNumber), headSha,
    journalSequence: Number.isSafeInteger(ticket.journalSequence) && ticket.journalSequence >= 0 ? ticket.journalSequence : 0,
    journalDigest: /^[0-9a-f]{64}$/.test(ticket.journalDigest || "") ? ticket.journalDigest : null,
  };
}

async function reconcileLane(ticket, { credential, apiUrl, fetchImpl, signal }) {
  const degradations = [];
  const base = `/repos/${ticket.repository}`;
  const issue = ticket.issueNumber ? await optional(
    () => githubGet({ apiUrl, token: credential.token, path: `${base}/issues/${ticket.issueNumber}`, signal, fetchImpl }),
    "issue", degradations,
  ) : null;
  const pull = ticket.prNumber ? await optional(
    () => githubGet({ apiUrl, token: credential.token, path: `${base}/pulls/${ticket.prNumber}`, signal, fetchImpl }),
    "pull_request", degradations,
  ) : null;
  const observedHeadSha = pull?.head?.sha?.toLowerCase() || ticket.headSha;
  const [reviews, statuses, checks] = ticket.prNumber && observedHeadSha ? await Promise.all([
    optional(() => githubGet({ apiUrl, token: credential.token, path: `${base}/pulls/${ticket.prNumber}/reviews?per_page=100`, signal, fetchImpl }), "reviews", degradations),
    optional(() => githubGet({ apiUrl, token: credential.token, path: `${base}/commits/${observedHeadSha}/status`, signal, fetchImpl }), "statuses", degradations),
    optional(() => githubGet({ apiUrl, token: credential.token, path: `${base}/commits/${observedHeadSha}/check-runs?per_page=100`, signal, fetchImpl }), "check_runs", degradations),
  ]) : [null, null, null];
  return {
    repository: ticket.repository,
    laneId: ticket.laneId,
    binding: structuredClone(ticket),
    observedHeadSha,
    exactHead: Boolean(ticket.headSha && observedHeadSha === ticket.headSha),
    issue: issue ? {
      number: issue.number, state: issue.state, stateReason: issue.state_reason || null,
      title: issue.title, url: issue.html_url, updatedAt: issue.updated_at,
      labels: (issue.labels || []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean),
    } : null,
    pullRequest: pull ? {
      number: pull.number, state: pull.state, draft: Boolean(pull.draft), merged: Boolean(pull.merged || pull.merged_at),
      mergeable: pull.mergeable, mergeableState: pull.mergeable_state || null, url: pull.html_url,
      headSha: pull.head?.sha || null, baseSha: pull.base?.sha || null, baseRef: pull.base?.ref || null, updatedAt: pull.updated_at,
    } : null,
    reviews: Array.isArray(reviews) ? reviews.map((review) => ({
      id: review.id, state: review.state, login: review.user?.login || null,
      submittedAt: review.submitted_at || null, commitId: review.commit_id || null,
    })) : [],
    ci: observedHeadSha ? {
      headSha: observedHeadSha,
      combinedState: statuses?.state || null,
      statuses: (statuses?.statuses || []).map((status) => ({ context: status.context, state: status.state, description: status.description || null, updatedAt: status.updated_at || status.created_at || null })),
      checks: (checks?.check_runs || []).map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion, url: check.html_url || null, completedAt: check.completed_at || null })),
    } : null,
    degradations,
    provenance: { source: "github_app", appLogin: credential.verifiedLogin, fetchedAt: new Date().toISOString() },
  };
}

export async function reconcileMissionControlRemote({
  tickets = [], stateRoot, signal, apiUrl = "https://api.github.com", fetchImpl = fetch,
  createCredential = ({ repository }) => createInstallationToken({ role: "builder", repository, apiUrl, fetchImpl }),
} = {}) {
  if (!Array.isArray(tickets) || tickets.length > 100) throw new Error("Mission Control reconciliation accepts at most 100 lane tickets.");
  const normalized = tickets.map(normalizeTicket);
  const observedAt = new Date().toISOString();
  const providerCapacity = await providerCapacitySnapshot(stateRoot, { stateDirectory: stateRoot, reap: false });
  const repositories = new Map();
  const lanes = [];
  const failures = [];
  for (const ticket of normalized) {
    if (signal?.aborted) throw Object.assign(new Error("Mission Control reconciliation aborted."), { name: "AbortError" });
    const key = ticketKey(ticket);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      lanes.push(structuredClone(cached.value));
      continue;
    }
    try {
      let credential = repositories.get(ticket.repository);
      if (!credential) {
        credential = await createCredential({ repository: ticket.repository });
        repositories.set(ticket.repository, credential);
      }
      const value = await reconcileLane(ticket, { credential, apiUrl, fetchImpl, signal });
      cache.set(key, { at: Date.now(), value });
      lanes.push(value);
      failures.push(...value.degradations);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      const failure = safeFailure(error);
      failures.push({ repository: ticket.repository, laneId: ticket.laneId, ...failure });
    }
  }
  const status = failures.some((failure) => failure.reason === "offline") ? "offline" : failures.length ? "degraded" : "current";
  return {
    version: 1, status, observedAt, lanes, providerCapacity,
    failures: failures.slice(0, 100),
    provenance: { source: "broker_remote_reconciliation", fetchedAt: observedAt },
  };
}
