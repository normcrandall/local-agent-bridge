import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertBranchRef,
  pushCommit,
  resolveGitBinary,
  resolveTransportUrl,
  runGit,
  sanitizedGitEnv,
} from "./github-builder-transport.mjs";
import {
  inspectGitHubMergeCapabilities,
  resolveGitHubMergeEnforcement,
} from "./github-merge-enforcement.mjs";
import { loadBranchReconciliationState, loadNonBranchIntents } from "./builder-operation-store.mjs";
import { classifyDeliveryOutcome } from "./builder-contract.mjs";

const LFS_POINTER_REGEX = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:[0-9a-f]{64}\r?\nsize [0-9]+\r?\n$/;
const MAX_PUSH_FILES = 2000;
const PROTECTED_BRANCH_NAMES = ["main", "master", "production", "release", "develop"];

async function assertLocalAncestry({ gitPath, workspace, ancestor, descendant }) {
  try {
    await runGit(["merge-base", "--is-ancestor", ancestor, descendant], {
      gitPath, cwd: workspace, env: sanitizedGitEnv(),
    });
  } catch (error) {
    if (error.code === 1) {
      throw new Error(`Push is not a fast-forward. Base ${ancestor} is not an ancestor of head ${descendant}.`);
    }
    throw new Error(`Fast-forward ancestry could not be verified for base ${ancestor}: ${error.message}`);
  }
}

async function validateLocalGitState({
  gitPath,
  workspace,
  repository,
  ref,
  sha,
  oldSha,
  requireFastForward = true,
  requireWorkspaceHead = false,
}) {
  if (!workspace || typeof workspace !== "string") {
    throw new Error("Workspace path GITHUB_BUILDER_WORKSPACE is not set or invalid.");
  }
  const local = (args) => runGit(args, { gitPath, cwd: workspace, env: sanitizedGitEnv() });

  // The origin remote must be bound exactly to the authorized GitHub HTTPS repository.
  let remoteUrl;
  try {
    remoteUrl = (await local(["remote", "get-url", "origin"])).stdout.toString("utf8").trim();
  } catch (error) {
    throw new Error(`Failed to get git remote URL: ${error.message}`);
  }
  if (remoteUrl !== `https://github.com/${repository}.git` && remoteUrl !== `https://github.com/${repository}`) {
    throw new Error(`Remote URL mismatch: origin points to ${remoteUrl}, expected exactly https://github.com/${repository} (.git optional).`);
  }

  // Local url.<base>.insteadOf rewrites could silently redirect the transport.
  let rewriteConfig = "";
  try {
    rewriteConfig = (await local(["config", "--local", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"])).stdout.toString("utf8").trim();
  } catch (error) {
    if (error.code !== 1) throw new Error(`Failed to inspect local URL-rewrite configuration: ${error.message}`);
  }
  if (rewriteConfig) {
    throw new Error("Local url.<base>.insteadOf rewrite configuration is present; the bounded transport rejects rewritten remotes.");
  }

  // Ambient local HTTP authorization (http.extraHeader or per-URL variants)
  // could inject credentials or override the askpass channel.
  let extraHeaderConfig = "";
  try {
    extraHeaderConfig = (await local(["config", "--local", "--get-regexp", "^http\\.(.*\\.)?extraheader$"])).stdout.toString("utf8").trim();
  } catch (error) {
    if (error.code !== 1) throw new Error(`Failed to inspect local HTTP header configuration: ${error.message}`);
  }
  if (extraHeaderConfig) {
    throw new Error("Local http.extraHeader configuration is present; the bounded transport rejects ambient HTTP authorization.");
  }

  try {
    await local(["cat-file", "-e", `${sha}^{commit}`]);
  } catch (error) {
    throw new Error(`Local object availability check failed for SHA ${sha}: ${error.message}`);
  }

  // If the ref exists locally it must match the bound SHA; a missing local ref
  // is acceptable because the commit object itself was verified above.
  let localRefSha = null;
  try {
    localRefSha = (await local(["rev-parse", "--verify", "--quiet", "--end-of-options", ref])).stdout.toString("utf8").trim();
  } catch {
    localRefSha = null;
  }
  if (localRefSha && localRefSha !== sha) {
    throw new Error(`Local ref ${ref} points to ${localRefSha}, expected SHA ${sha}.`);
  }
  if (requireWorkspaceHead) {
    if (localRefSha !== sha) {
      throw new Error(`Local ref ${ref} does not resolve to the requested workspace SHA ${sha}.`);
    }
    const currentHead = (await local(["rev-parse", "HEAD"])).stdout.toString("utf8").trim();
    if (currentHead !== sha) {
      throw new Error(`Workspace HEAD ${currentHead || "unknown"} does not match requested SHA ${sha}.`);
    }
  }

  if (oldSha !== undefined && requireFastForward) {
    await assertLocalAncestry({ gitPath, workspace, ancestor: oldSha, descendant: sha });
  }

  // Payload size, binaries, and LFS pointers validation
  let filesOutput;
  try {
    if (oldSha) {
      filesOutput = (await local(["diff", "--name-only", "-z", "--diff-filter=d", oldSha, sha])).stdout;
    } else {
      filesOutput = (await local(["ls-tree", "-r", "--name-only", "-z", sha])).stdout;
    }
  } catch (error) {
    throw new Error(`Failed to list modified files: ${error.message}`);
  }

  const files = filesOutput.toString("utf8").split("\0").filter(Boolean);
  if (files.length > MAX_PUSH_FILES) {
    throw new Error(`Payload validation failed: ${files.length} files exceed the ${MAX_PUSH_FILES}-file bound.`);
  }
  for (const file of files) {
    let sizeStr;
    try {
      sizeStr = (await local(["cat-file", "-s", `${sha}:${file}`])).stdout.toString("utf8").trim();
    } catch (error) {
      throw new Error(`Failed to get size of ${file}: ${error.message}`);
    }
    const size = Number.parseInt(sizeStr, 10);

    // We enforce a 10 MB limit for non-LFS files
    if (size > 10 * 1024 * 1024) {
      throw new Error(`File ${file} exceeds size limit (10MB) and must be tracked via LFS.`);
    }

    let buffer;
    try {
      buffer = (await local(["cat-file", "blob", `${sha}:${file}`])).stdout;
    } catch (error) {
      throw new Error(`Failed to read contents of ${file}: ${error.message}`);
    }

    const text = buffer.toString("utf8");
    if (text.startsWith("version https://git-lfs.github.com/spec/v1")) {
      if (!LFS_POINTER_REGEX.test(text)) {
        throw new Error(`LFS validation failed: file ${file} has an invalid LFS pointer format.`);
      }
      // Fail closed: remote LFS object availability cannot be proven before mutation.
      throw new Error(`LFS validation failed: file ${file} is an LFS pointer, but LFS object availability on the remote cannot be proven before mutation; rejecting.`);
    }
    if (buffer.includes(0)) {
      throw new Error(`File ${file} is binary and must be tracked via LFS.`);
    }
  }
}

function isRemoteCasRejection(stderr) {
  return /\[rejected\]|\[remote rejected\]|stale info|non-fast-forward|fetch first|already exists/.test(stderr || "");
}

function headers(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "local-agent-bridge",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function responseJson(response, label) {
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const error = new Error(`${label} failed: ${parsed?.message || text || response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return parsed;
}

async function request({ fetchImpl, apiUrl, token, path, method = "GET", body }) {
  return responseJson(await fetchImpl(`${apiUrl}${path}`, {
    method,
    headers: headers(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), `GitHub ${method} ${path}`);
}

async function requestPages({ fetchImpl, apiUrl, token, path, maxPages = 20 }) {
  const values = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await request({ fetchImpl, apiUrl, token, path: `${path}${separator}page=${page}` });
    if (!Array.isArray(batch)) throw new Error("GitHub returned an invalid paginated response.");
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error(`GitHub pagination exceeded the ${maxPages}-page safety limit.`);
}

function assertRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) {
    throw new Error("repository must be owner/name.");
  }
}

function assertSha(headSha) {
  if (!/^[0-9a-f]{40}$/i.test(headSha || "")) throw new Error("headSha must be a full commit SHA.");
}

function marker(operation, headSha, value) {
  const digest = createHash("sha256").update(`${operation}:${headSha}:${value}`).digest("hex").slice(0, 20);
  return `<!-- agent-bridge-builder:${operation}:${headSha}:${digest} -->`;
}

function normalizeBotLogin(login) {
  const normalized = (login || "").toLowerCase();
  return normalized.endsWith("[bot]") ? normalized.slice(0, -5) : normalized;
}

async function verifyIdentity({ fetchImpl, apiUrl, token, expectedLogin, verifiedLogin }) {
  const login = verifiedLogin || (await request({ fetchImpl, apiUrl, token, path: "/user" }))?.login;
  if (normalizeBotLogin(login) !== normalizeBotLogin(expectedLogin)) {
    throw new Error(`GitHub builder identity mismatch: expected ${expectedLogin}, received ${login || "unknown"}.`);
  }
  return login;
}

async function boundPullRequest(context) {
  const pull = await request({
    ...context,
    path: `/repos/${context.repository}/pulls/${context.prNumber}`,
  });
  if (pull?.head?.sha !== context.headSha) {
    throw new Error(`Pull request head changed: authorized ${context.headSha}, current ${pull?.head?.sha || "unknown"}.`);
  }
  return pull;
}

export function createBoundBuilderClient({
  fetchImpl = fetch,
  apiUrl = "https://api.github.com",
  token = null,
  repository,
  expectedLogin,
  verifiedLogin = null,
  headSha,
  prNumber = null,
  issueNumber = null,
  headRef = null,
  baseRef = null,
  baseSha = null,
  requiredReviewStatusContext = "agent-review",
  trustedReviewLogins = [],
  trustedReviewAppIds = [],
  trustedHumanReviewLogins = [],
  mergeEnforcement = "broker",
  allowedOperations = ["ensure_pull_request", "read_review_threads", "reply_review_thread", "resolve_review_thread", "mark_ready"],
  getToken = null,
  workspace = null,
  transportUrl = null,
  receiptPath = null,
  allowWorkspaceHead = false,
}) {
  assertRepository(repository);
  assertSha(headSha);
  if (baseSha !== null) assertSha(baseSha);
  if (!apiUrl.startsWith("https://")) {
    throw new Error("API URL must use HTTPS.");
  }
  // Test-only loopback seam; rejects anything that is not 127.0.0.1.
  if (transportUrl !== null) resolveTransportUrl({ repository, transportUrl });
  if (!getToken) {
    if (!token || typeof token !== "string" || !token.startsWith("ghs_")) {
      throw new Error("Only short-lived GitHub App installation tokens (ghs_...) are permitted for builder operations.");
    }
  }
  if (!expectedLogin) throw new Error("expectedLogin is required.");
  if (prNumber !== null && (!Number.isInteger(prNumber) || prNumber < 1)) throw new Error("prNumber is invalid.");
  if (trustedHumanReviewLogins.includes(expectedLogin)) {
    throw new Error("The builder identity cannot be a trusted human reviewer.");
  }
  if (trustedReviewLogins.some((login) => typeof login !== "string" || !login || !login.endsWith("[bot]"))) {
    throw new Error("Trusted reviewer logins must be bot logins.");
  }
  if (trustedReviewAppIds.some((appId) => !Number.isInteger(Number(appId)) || Number(appId) < 1)) {
    throw new Error("Trusted reviewer App IDs must be positive integers.");
  }
  resolveGitHubMergeEnforcement({ configuredMode: mergeEnforcement });
  if (trustedHumanReviewLogins.some((login) => typeof login !== "string" || !login || login.endsWith("[bot]"))) {
    throw new Error("Trusted human reviewer logins must be non-bot GitHub logins.");
  }

  let cachedToken = token || null;
  let cachedVerifiedLogin = verifiedLogin || null;

  const context = { fetchImpl, apiUrl, token: cachedToken, repository, expectedLogin, verifiedLogin: cachedVerifiedLogin, headSha, prNumber, issueNumber };
  const allowed = new Set(allowedOperations);
  const authorize = (operation) => {
    if (!allowed.has(operation)) throw new Error(`GitHub builder operation is not authorized: ${operation}.`);
  };

  const assertIssueBound = (num) => {
    if (issueNumber === null || Number(issueNumber) !== Number(num)) {
      throw new Error(`Client is bound to issue ${issueNumber}, cannot mutate issue ${num}.`);
    }
  };

  async function ensureToken() {
    if (cachedToken) {
      return { token: cachedToken, verifiedLogin: cachedVerifiedLogin };
    }
    if (!getToken) {
      throw new Error("Token factory 'getToken' is required.");
    }
    const credential = await getToken();
    if (!credential.token || typeof credential.token !== "string" || !credential.token.startsWith("ghs_")) {
      throw new Error("Only short-lived GitHub App installation tokens (ghs_...) are permitted for builder operations.");
    }
    cachedToken = credential.token;
    cachedVerifiedLogin = credential.verifiedLogin;
    context.token = cachedToken;
    context.verifiedLogin = cachedVerifiedLogin;
    return credential;
  }

  async function identity() {
    const cred = await ensureToken();
    return verifyIdentity({ ...context, token: cred.token, verifiedLogin: cred.verifiedLogin });
  }

  async function ensurePullRequest({ title, body, draft = false }) {
    authorize("ensure_pull_request");
    if (!headRef || !baseRef) throw new Error("Creating or updating a pull request requires bound headRef and baseRef.");
    await identity();
    const [owner] = repository.split("/");
    const encodedRef = headRef.split("/").map(encodeURIComponent).join("/");
    const ref = await request({ ...context, path: `/repos/${repository}/git/ref/heads/${encodedRef}` });
    if (ref?.object?.sha !== headSha) {
      throw new Error(`Head ref changed: authorized ${headSha}, current ${ref?.object?.sha || "unknown"}.`);
    }
    const existing = await request({
      ...context,
      path: `/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${headRef}`)}&per_page=100`,
    });
    const existingPull = existing.find((candidate) => candidate.head?.sha === headSha && candidate.base?.ref === baseRef);
    const pull = await withNonBranchMutation("ensure_pull_request", { headRef, baseRef }, async () => (
      existingPull
        ? request({
            ...context,
            path: `/repos/${repository}/pulls/${existingPull.number}`,
            method: "PATCH",
            body: { title, body, base: baseRef },
          })
        : request({
            ...context,
            path: `/repos/${repository}/pulls`,
            method: "POST",
            body: { title, body, head: headRef, base: baseRef, draft },
          })
    ));
    if (pull?.head?.sha !== headSha) throw new Error("GitHub returned a pull request at an unexpected head SHA.");
    prNumber = pull.number;
    context.prNumber = pull.number;
    return { operation: "ensure_pull_request", prNumber: pull.number, url: pull.html_url, headSha, login: expectedLogin };
  }

  async function loadReviewThreads() {
    if (!prNumber) throw new Error("This builder session is not bound to a pull request.");
    await identity();
    await boundPullRequest(context);
    const [owner, name] = repository.split("/");
    const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{id isResolved comments(first:100){nodes{id body url author{login __typename}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}`;
    const threads = [];
    let after = null;
    do {
      const result = await request({
        ...context, path: "/graphql", method: "POST",
        body: { query, variables: { owner, name, number: prNumber, after } },
      });
      if (result?.errors?.length) throw new Error(`GitHub review-thread query failed: ${result.errors[0].message}`);
      const connection = result?.data?.repository?.pullRequest?.reviewThreads;
      threads.push(...(connection?.nodes || []));
      after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);
    const commentsQuery = `query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$after){nodes{id body url author{login __typename}} pageInfo{hasNextPage endCursor}}}}}`;
    for (const thread of threads) {
      let commentsAfter = thread.comments?.pageInfo?.hasNextPage ? thread.comments.pageInfo.endCursor : null;
      while (commentsAfter) {
        const result = await request({
          ...context, path: "/graphql", method: "POST",
          body: { query: commentsQuery, variables: { id: thread.id, after: commentsAfter } },
        });
        if (result?.errors?.length) throw new Error(`GitHub review-thread comments query failed: ${result.errors[0].message}`);
        const connection = result?.data?.node?.comments;
        thread.comments.nodes.push(...(connection?.nodes || []));
        commentsAfter = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
      }
    }
    return threads;
  }

  async function reviewThreads() {
    authorize("read_review_threads");
    return loadReviewThreads();
  }

  async function replyReviewThread({ threadId, body }) {
    authorize("reply_review_thread");
    const threads = await loadReviewThreads();
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error("Review thread is not part of the bound pull request.");
    const receiptMarker = marker("reply", headSha, `${threadId}:${body}`);
    const existing = thread.comments?.nodes?.find((comment) => (
      comment.author?.__typename === "Bot"
      && normalizeBotLogin(comment.author?.login) === normalizeBotLogin(expectedLogin)
      && comment.body?.includes(receiptMarker)
    ));
    const replyKey = { threadId, marker: receiptMarker };
    if (existing) {
      recordNonBranchSettled("reply_review_thread", replyKey);
      return { operation: "reply_review_thread", threadId, url: existing.url, idempotent: true, login: expectedLogin, headSha };
    }
    const query = `mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id url author{login __typename}}}}`;
    return withNonBranchMutation("reply_review_thread", replyKey, async () => {
      const result = await request({
        ...context,
        path: "/graphql",
        method: "POST",
        body: { query, variables: { threadId, body: `${body.trim()}\n\n${receiptMarker}` } },
      });
      if (result?.errors?.length) throw new Error(`GitHub review-thread reply failed: ${result.errors[0].message}`);
      const comment = result?.data?.addPullRequestReviewThreadReply?.comment;
      if (comment?.author?.__typename !== "Bot" || normalizeBotLogin(comment?.author?.login) !== normalizeBotLogin(expectedLogin)) {
        throw new Error("GitHub posted the thread reply with an unexpected identity.");
      }
      return { operation: "reply_review_thread", threadId, url: comment.url, idempotent: false, login: expectedLogin, headSha };
    });
  }

  async function resolveReviewThread({ threadId }) {
    authorize("resolve_review_thread");
    const threads = await loadReviewThreads();
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error("Review thread is not part of the bound pull request.");
    if (thread.isResolved) {
      recordNonBranchSettled("resolve_review_thread", { threadId });
      return { operation: "resolve_review_thread", threadId, idempotent: true, login: expectedLogin, headSha };
    }
    const query = `mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}`;
    return withNonBranchMutation("resolve_review_thread", { threadId }, async () => {
      const result = await request({ ...context, path: "/graphql", method: "POST", body: { query, variables: { threadId } } });
      if (result?.errors?.length) throw new Error(`GitHub review-thread resolution failed: ${result.errors[0].message}`);
      if (!result?.data?.resolveReviewThread?.thread?.isResolved) throw new Error("GitHub did not resolve the review thread.");
      return { operation: "resolve_review_thread", threadId, idempotent: false, login: expectedLogin, headSha };
    });
  }

  async function markReady() {
    authorize("mark_ready");
    await identity();
    const pull = await boundPullRequest(context);
    if (!pull.draft) {
      recordNonBranchSettled("mark_ready", {});
      return { operation: "mark_ready", prNumber, url: pull.html_url, idempotent: true, login: expectedLogin, headSha };
    }
    const query = `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{number url isDraft headRefOid}}}`;
    return withNonBranchMutation("mark_ready", {}, async () => {
      const result = await request({ ...context, path: "/graphql", method: "POST", body: { query, variables: { id: pull.node_id } } });
      if (result?.errors?.length) throw new Error(`GitHub mark-ready failed: ${result.errors[0].message}`);
      const ready = result?.data?.markPullRequestReadyForReview?.pullRequest;
      if (ready?.headRefOid !== headSha || ready?.isDraft) throw new Error("GitHub returned an invalid mark-ready receipt.");
      return { operation: "mark_ready", prNumber, url: ready.url, idempotent: false, login: expectedLogin, headSha };
    });
  }

  async function merge({ method = "squash" }) {
    authorize("merge");
    if (!prNumber) throw new Error("Merge requires a builder session bound to a pull request.");
    await identity();
    const pull = await boundPullRequest(context);
    if (pull.merged) {
      recordNonBranchSettled("merge", { method });
      return { operation: "merge", prNumber, url: pull.html_url, idempotent: true, login: expectedLogin, headSha };
    }
    if (!trustedReviewLogins.length && !trustedHumanReviewLogins.length) {
      throw new Error("No trusted reviewer App or human reviewer identities are configured for merge authorization.");
    }
    let reviewGate = null;
    let machineStatus = null;
    let machineStatusUnavailableReason = null;
    let reviews = null;
    const effectiveReviewsFor = async (trustedLogins) => {
      if (!reviews) {
        reviews = await requestPages({
          ...context,
          path: `/repos/${repository}/pulls/${prNumber}/reviews?per_page=100`,
        });
      }
      const decisiveStates = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
      const latestByLogin = new Map();
      const chronological = [...reviews].sort((left, right) => (
        String(left.submitted_at || "").localeCompare(String(right.submitted_at || ""))
        || Number(left.id || 0) - Number(right.id || 0)
      ));
      for (const review of chronological) {
        const login = review.user?.login;
        if (review.commit_id !== headSha || !trustedLogins.includes(login) || !decisiveStates.has(review.state)) continue;
        latestByLogin.set(login, review);
      }
      return [...latestByLogin.values()];
    };
    const effectiveAppReviews = trustedReviewLogins.length
      ? await effectiveReviewsFor(trustedReviewLogins)
      : [];
    if (effectiveAppReviews.length) {
      const changesRequested = effectiveAppReviews.find((review) => review.state === "CHANGES_REQUESTED");
      const approval = effectiveAppReviews.find((review) => review.state === "APPROVED");
      if (approval && !changesRequested) {
        reviewGate = {
          type: "trusted_app_review",
          state: "APPROVED",
          login: approval.user.login,
          reviewId: approval.id,
          submittedAt: approval.submitted_at,
        };
      }
    }
    if (!reviewGate && effectiveAppReviews.length === 0 && requiredReviewStatusContext && trustedReviewLogins.length) {
      try {
        const statuses = await requestPages({
          ...context,
          path: `/repos/${repository}/commits/${headSha}/statuses?per_page=100`,
        });
        if (!Array.isArray(statuses)) throw new Error("GitHub returned an invalid machine-review status history.");
        machineStatus = statuses.find((candidate) => candidate.context === requiredReviewStatusContext);
        if (machineStatus?.state === "success" && trustedReviewLogins.includes(machineStatus.creator?.login)) {
          reviewGate = {
            type: "machine_status",
            context: machineStatus.context,
            state: machineStatus.state,
            login: machineStatus.creator.login,
          };
        }
      } catch (error) {
        if (error?.status !== 403) throw error;
        machineStatusUnavailableReason = error.message;
      }
    }
    if (!reviewGate && trustedHumanReviewLogins.length) {
      const effectiveReviews = await effectiveReviewsFor(trustedHumanReviewLogins);
      const changesRequested = effectiveReviews.find((review) => review.state === "CHANGES_REQUESTED");
      const approval = effectiveReviews.find((review) => review.state === "APPROVED");
      if (approval && !changesRequested) {
        reviewGate = {
          type: "human_approval",
          state: "APPROVED",
          login: approval.user.login,
          reviewId: approval.id,
          submittedAt: approval.submitted_at,
        };
      }
    }
    if (!reviewGate) {
      if (!trustedHumanReviewLogins.length && effectiveAppReviews.length) {
        const decisions = effectiveAppReviews
          .map((review) => `${review.user.login}:${review.state}`)
          .join(", ");
        throw new Error(`Configured reviewer App decisions do not authorize merge on exact head ${headSha}: ${decisions}.`);
      }
      if (!trustedHumanReviewLogins.length && machineStatus?.state !== "success") {
        const statusDetail = machineStatusUnavailableReason
          ? `the optional machine-review status could not be read (${machineStatusUnavailableReason})`
          : `machine-review status ${requiredReviewStatusContext} is not successful`;
        throw new Error(`No exact-head approval from a configured reviewer App was found, and ${statusDetail} on ${headSha}.`);
      }
      if (!trustedHumanReviewLogins.length && !trustedReviewLogins.includes(machineStatus?.creator?.login)) {
        throw new Error(`No exact-head approval from a configured reviewer App was found, and machine-review status was not authored by a configured reviewer App: ${machineStatus?.creator?.login || "unknown"}.`);
      }
      throw new Error(`Merge authorization found neither a trusted machine review nor a trusted human approval on exact head ${headSha}.`);
    }
    let enforcement = resolveGitHubMergeEnforcement({ configuredMode: mergeEnforcement });
    if (mergeEnforcement !== "broker") {
      const branch = pull.base?.ref || baseRef;
      if (!branch) throw new Error("GitHub merge enforcement verification requires the pull request base branch.");
      const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
      let rules = [];
      let branchProtection = null;
      const evidenceErrors = [];
      if (["auto", "organization-ruleset"].includes(mergeEnforcement)) {
        try {
          rules = await request({ ...context, path: `/repos/${repository}/rules/branches/${encodedBranch}` });
        } catch (error) {
          evidenceErrors.push(`organization ruleset evidence unavailable: ${error.message}`);
        }
      }
      if (["auto", "branch-protection"].includes(mergeEnforcement)) {
        try {
          branchProtection = await request({ ...context, path: `/repos/${repository}/branches/${encodedBranch}/protection` });
        } catch (error) {
          evidenceErrors.push(`branch protection evidence unavailable: ${error.message}`);
        }
      }
      const capabilities = inspectGitHubMergeCapabilities({
        rules,
        branchProtection,
        trustedAppIds: trustedReviewAppIds,
        context: requiredReviewStatusContext,
      });
      enforcement = resolveGitHubMergeEnforcement({ configuredMode: mergeEnforcement, capabilities });
      if (enforcement.blocked) {
        const evidence = evidenceErrors.length ? ` ${evidenceErrors.join("; ")}.` : "";
        throw new Error(`${enforcement.reason}${evidence}`);
      }
    }
    const merged = await withNonBranchMutation("merge", { method }, async () => {
      const response = await request({
        ...context,
        path: `/repos/${repository}/pulls/${prNumber}/merge`,
        method: "PUT",
        body: { sha: headSha, merge_method: method },
      });
      if (!response?.merged) throw new Error(`GitHub did not merge the bound pull request: ${response?.message || "unknown error"}`);
      return response;
    });
    return {
      operation: "merge", prNumber, sha: merged.sha, idempotent: false, login: expectedLogin, headSha,
      reviewGate, mergeEnforcement: enforcement,
    };
  }

  function assertBranchOperationInput({ ref, sha, oldSha }) {
    const branchName = assertBranchRef(ref);
    assertSha(sha);
    if (!allowWorkspaceHead && sha !== headSha) {
      throw new Error(`SHA mismatch: expected ${headSha}, received ${sha}.`);
    }
    const expectedRef = headRef ? (headRef.startsWith("refs/heads/") ? headRef : `refs/heads/${headRef}`) : null;
    if (expectedRef && ref !== expectedRef) {
      throw new Error(`Ref mismatch: expected ${expectedRef}, received ${ref}.`);
    }
    if (oldSha !== undefined) assertSha(oldSha);
    if (PROTECTED_BRANCH_NAMES.includes(branchName)) {
      throw new Error(`Cannot modify a protected or default branch: ${branchName}.`);
    }
    return branchName;
  }

  function adoptWorkspaceHead(sha) {
    if (!allowWorkspaceHead || sha === headSha) return;
    headSha = sha;
    context.headSha = sha;
  }

  async function assertRemoteBranchMutable({ branchName, encodedBranch, activeToken }) {
    const repoInfo = await request({ ...context, token: activeToken, path: `/repos/${repository}` });
    const defaultBranch = repoInfo?.default_branch || "main";
    if (branchName === defaultBranch) {
      throw new Error(`Cannot modify a protected or default branch: ${branchName}.`);
    }
    let isProtected = false;
    try {
      const branchInfo = await request({ ...context, token: activeToken, path: `/repos/${repository}/branches/${encodedBranch}` });
      if (branchInfo?.protected === true) isProtected = true;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (isProtected) {
      throw new Error(`Cannot modify a protected or default branch: ${branchName}.`);
    }
  }

  async function readRemoteBranch({ encodedBranch, activeToken }) {
    return request({ ...context, token: activeToken, path: `/repos/${repository}/git/ref/heads/${encodedBranch}` }).catch((error) => {
      if (error.status === 404) return null;
      throw error;
    });
  }

  // Refs whose last mutation attempt ended without a provable outcome. A
  // retry must complete a read-only remote reconciliation before any push.
  // Seeded from the durable receipt log so the fail-closed guard survives a
  // process/agent restart, not only retries within one process lifetime.
  const indeterminateRefs = loadBranchReconciliationState(receiptPath);

  function branchOperationId({ operation, ref, requestedSha, expectedOldSha = null }) {
    return createHash("sha256")
      .update(JSON.stringify({ operation, repository, ref, requestedSha, expectedOldSha }))
      .digest("hex");
  }

  function persistReceipt(receipt) {
    if (!receiptPath) return receipt;
    try {
      mkdirSync(dirname(receiptPath), { recursive: true });
      appendFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    } catch (error) {
      throw new Error(`Failed to record durable builder receipt: ${error.message}`);
    }
    return receipt;
  }

  function appIdentity(receiptLogin) {
    return { expectedLogin, verifiedLogin: receiptLogin || cachedVerifiedLogin || expectedLogin };
  }

  function branchReceipt({ operation, ref, requestedSha, expectedOldSha = null, observedRemoteSha, outcome, idempotent, verifiedLogin: receiptLogin, reconciled = false }) {
    const identity = appIdentity(receiptLogin);
    return persistReceipt({
      operationId: branchOperationId({ operation, ref, requestedSha, expectedOldSha }),
      operation,
      repository,
      ref,
      requestedSha,
      expectedOldSha,
      observedRemoteSha,
      outcome,
      deliveryOutcome: classifyDeliveryOutcome({ outcome }),
      sha: requestedSha,
      readBackSha: observedRemoteSha,
      idempotent,
      ...(reconciled ? { reconciled: true } : {}),
      appIdentity: identity,
      login: expectedLogin,
      verifiedLogin: identity.verifiedLogin,
      transport: "git-https-app-token",
      remoteVerified: true,
      recordedAt: new Date().toISOString(),
    });
  }

  function recordFailureReceipt({ operation, ref, requestedSha, expectedOldSha = null, outcome, detail, verifiedLogin: receiptLogin }) {
    persistReceipt({
      operationId: branchOperationId({ operation, ref, requestedSha, expectedOldSha }),
      operation,
      repository,
      ref,
      requestedSha,
      expectedOldSha,
      observedRemoteSha: null,
      outcome,
      deliveryOutcome: classifyDeliveryOutcome({ outcome }),
      appIdentity: appIdentity(receiptLogin),
      transport: "git-https-app-token",
      remoteVerified: false,
      detail,
      recordedAt: new Date().toISOString(),
    });
  }

  // Durable receipts for the non-branch operations (PR create/update, review
  // reply/resolve, mark-ready, merge). Each mutating call records a persisted
  // intent immediately before its network mutation and a terminal receipt after,
  // keyed by a content-addressed operationId so a restart can inspect the
  // outcome and distinguish a fresh idempotent no-op from a prior process's
  // intent that has since landed (reconciled). Return values are unchanged.
  const danglingNonBranchIntents = loadNonBranchIntents(receiptPath);

  function nonBranchOperationId(operation, key) {
    return createHash("sha256")
      .update(JSON.stringify({ operation, repository, headSha, ...key }))
      .digest("hex");
  }

  function persistNonBranchReceipt({ operation, key, outcome, idempotent = false, detail = null }) {
    return persistReceipt({
      operationId: nonBranchOperationId(operation, key),
      operation,
      repository,
      headSha,
      prNumber: prNumber ?? null,
      issueNumber: issueNumber ?? null,
      request: { operation, ...key },
      outcome,
      deliveryOutcome: outcome === "intent" ? "indeterminate" : classifyDeliveryOutcome({ outcome }),
      idempotent: Boolean(idempotent),
      ...(detail ? { detail } : {}),
      appIdentity: appIdentity(cachedVerifiedLogin),
      login: expectedLogin,
      verifiedLogin: cachedVerifiedLogin || expectedLogin,
      transport: "github-api-app-token",
      remoteVerified: outcome !== "indeterminate" && outcome !== "intent",
      recordedAt: new Date().toISOString(),
    });
  }

  // Record a terminal receipt for an already-satisfied (idempotent) pre-check.
  // If a prior process left a dangling intent for the same operationId, the
  // observed landed state is a reconciliation rather than a fresh no-op.
  function recordNonBranchSettled(operation, key) {
    const wasPending = danglingNonBranchIntents.has(nonBranchOperationId(operation, key));
    danglingNonBranchIntents.delete(nonBranchOperationId(operation, key));
    persistNonBranchReceipt({ operation, key, outcome: wasPending ? "reconciled" : "idempotent", idempotent: true });
  }

  // Wrap the actual network mutation: intent before, terminal after. A thrown
  // error is recorded as a determinate failure (HTTP status) or a fail-closed
  // indeterminate outcome (transport error, outcome unprovable) before rethrow.
  async function withNonBranchMutation(operation, key, mutate) {
    persistNonBranchReceipt({ operation, key, outcome: "intent" });
    let result;
    try {
      result = await mutate();
    } catch (error) {
      const determinate = typeof error?.status === "number";
      persistNonBranchReceipt({
        operation, key,
        outcome: determinate ? "failed" : "indeterminate",
        detail: String(error?.message || error).slice(0, 500),
      });
      throw error;
    }
    danglingNonBranchIntents.delete(nonBranchOperationId(operation, key));
    persistNonBranchReceipt({ operation, key, outcome: "succeeded" });
    return result;
  }

  // Read the remote ref while honoring a pending indeterminate marker: the
  // read must succeed before any further mutation is considered, and a read
  // proving the requested SHA resolves the marker as reconciled.
  async function reconcileBeforeMutation({ operation, ref, sha, encodedBranch, activeToken, verifiedLogin: receiptLogin }) {
    const pending = indeterminateRefs.get(ref);
    let currentRef;
    try {
      currentRef = await readRemoteBranch({ encodedBranch, activeToken });
    } catch (error) {
      if (pending) {
        throw new Error(`Ref ${ref} has an indeterminate prior mutation and remote read-back is still unavailable; read-only reconciliation must succeed before retry: ${error.message}`);
      }
      throw error;
    }
    if (!pending) return { currentRef, reconciledReceipt: null };

    // Resolve the pending marker strictly on its OWN requestedSha via read-back.
    // A retry that targets a different SHA must never silently erase an
    // unresolved attempt: the prior marker is reconciled or failed on its own
    // terms first, then the current operation proceeds.
    const observedSha = currentRef?.object?.sha ?? null;
    const priorLanded = observedSha !== null && observedSha === pending.requestedSha;
    indeterminateRefs.delete(ref);

    if (pending.requestedSha === sha) {
      if (priorLanded) {
        return {
          currentRef,
          reconciledReceipt: branchReceipt({
            operation, ref, requestedSha: sha, expectedOldSha: pending.expectedOldSha,
            observedRemoteSha: observedSha, outcome: "reconciled", idempotent: false, reconciled: true,
            verifiedLogin: receiptLogin,
          }),
        };
      }
      // The prior attempt provably did not land; fall through to a normal
      // evaluation of the current operation against the observed remote state.
      return { currentRef, reconciledReceipt: null };
    }

    // Different-SHA retry: durably record the prior marker's real fate before
    // continuing, so no indeterminate state is discarded without a read-back.
    if (priorLanded) {
      branchReceipt({
        operation: pending.operation, ref, requestedSha: pending.requestedSha,
        expectedOldSha: pending.expectedOldSha, observedRemoteSha: observedSha,
        outcome: "reconciled", idempotent: false, reconciled: true, verifiedLogin: receiptLogin,
      });
    } else {
      recordFailureReceipt({
        operation: pending.operation, ref, requestedSha: pending.requestedSha,
        expectedOldSha: pending.expectedOldSha, outcome: "failed",
        detail: `prior indeterminate attempt for ${pending.requestedSha} did not land; remote observed at ${observedSha || "none"}`,
        verifiedLogin: receiptLogin,
      });
    }
    return { currentRef, reconciledReceipt: null };
  }

  // Shared handling for a failed push: one bounded read-back decides between
  // reconciled success, determinate failure, and explicit indeterminate state.
  async function resolvePushFailure({ operation, ref, sha, expectedOldSha, encodedBranch, activeToken, error, verifiedLogin: receiptLogin }) {
    let readBack = null;
    let readBackError = null;
    try {
      readBack = await readRemoteBranch({ encodedBranch, activeToken });
    } catch (caught) {
      readBackError = caught;
    }
    if (readBackError) {
      indeterminateRefs.set(ref, { operation, requestedSha: sha, expectedOldSha, recordedAt: new Date().toISOString() });
      recordFailureReceipt({
        operation, ref, requestedSha: sha, expectedOldSha, outcome: "indeterminate",
        detail: `push transport failed and remote read-back is unavailable: ${readBackError.message}`,
        verifiedLogin: receiptLogin,
      });
      throw new Error(`Mutation outcome for ${ref} is indeterminate: the push transport failed (${error.message}) and remote read-back is unavailable (${readBackError.message}). Perform read-only reconciliation before any retry.`);
    }
    if (readBack?.object?.sha === sha) {
      return branchReceipt({
        operation, ref, requestedSha: sha, expectedOldSha, observedRemoteSha: sha,
        outcome: "reconciled", idempotent: false, reconciled: true, verifiedLogin: receiptLogin,
      });
    }
    recordFailureReceipt({
      operation, ref, requestedSha: sha, expectedOldSha, outcome: "failed",
      detail: error.message, verifiedLogin: receiptLogin,
    });
    if (isRemoteCasRejection(error.stderr)) {
      throw new Error(operation === "create_branch"
        ? `Branch creation lost the compare-and-swap race for ${ref}. Remote rejection: ${error.stderr}`
        : operation === "replace_branch"
          ? `Branch replacement lost the compare-and-swap race for ${ref}. Remote rejection: ${error.stderr}`
          : `Push is not a fast-forward. Remote rejection: ${error.stderr}`);
    }
    throw error;
  }

  // Post-push verification: a successful transport result still requires a
  // remote read-back at the exact SHA before a receipt is issued.
  async function verifyMutation({ operation, ref, sha, expectedOldSha, encodedBranch, activeToken, verifiedLogin: receiptLogin, outcome }) {
    let readBack;
    try {
      readBack = await readRemoteBranch({ encodedBranch, activeToken });
    } catch (error) {
      indeterminateRefs.set(ref, { operation, requestedSha: sha, expectedOldSha, recordedAt: new Date().toISOString() });
      recordFailureReceipt({
        operation, ref, requestedSha: sha, expectedOldSha, outcome: "indeterminate",
        detail: `push succeeded at the transport but read-back verification is unavailable: ${error.message}`,
        verifiedLogin: receiptLogin,
      });
      throw new Error(`Mutation for ${ref} completed at the transport but remote read-back verification is unavailable; state is indeterminate and requires read-only reconciliation before retry: ${error.message}`);
    }
    if (readBack?.object?.sha !== sha) {
      recordFailureReceipt({
        operation, ref, requestedSha: sha, expectedOldSha, outcome: "failed",
        detail: `read-back mismatch: expected ${sha}, found ${readBack?.object?.sha || "none"}`,
        verifiedLogin: receiptLogin,
      });
      throw new Error(`Read-back validation failed: expected ${sha}, found ${readBack?.object?.sha || "none"}`);
    }
    return branchReceipt({ operation, ref, requestedSha: sha, expectedOldSha, observedRemoteSha: sha, outcome, idempotent: false, verifiedLogin: receiptLogin });
  }

  async function createBranch({ ref, sha }) {
    authorize("create_branch");
    if (baseSha === null) {
      throw new Error("create_branch requires an exact baseSha authorization.");
    }
    if (!baseRef) {
      throw new Error("create_branch requires an exact baseRef authorization.");
    }
    const branchName = assertBranchOperationInput({ ref, sha });
    const encodedBranch = branchName.split("/").map(encodeURIComponent).join("/");

    // 1. Local validation completes before any token issuance or API call.
    const gitPath = resolveGitBinary();
    await validateLocalGitState({
      gitPath, workspace, repository, ref, sha,
      ...(baseSha === null ? {} : { oldSha: baseSha }),
      requireWorkspaceHead: allowWorkspaceHead,
    });
    adoptWorkspaceHead(sha);

    // 2. Token issuance and identity verification after validation.
    const credential = await ensureToken();
    const activeToken = credential.token;
    await verifyIdentity({ ...context, token: activeToken, verifiedLogin: credential.verifiedLogin });

    // 3. Remote-side gate, then reconciliation-aware current ref state.
    await assertRemoteBranchMutable({ branchName, encodedBranch, activeToken });
    const { currentRef, reconciledReceipt } = await reconcileBeforeMutation({
      operation: "create_branch", ref, sha, encodedBranch, activeToken, verifiedLogin: credential.verifiedLogin,
    });
    if (reconciledReceipt) return reconciledReceipt;
    if (currentRef?.object?.sha === sha) {
      return branchReceipt({ operation: "create_branch", ref, requestedSha: sha, expectedOldSha: null, observedRemoteSha: sha, outcome: "idempotent", idempotent: true, verifiedLogin: credential.verifiedLogin });
    }
    if (currentRef?.object?.sha) {
      throw new Error(`Branch ${branchName} already exists at ${currentRef.object.sha}; create_branch requires the ref to be absent or already at the bound SHA.`);
    }

    // A prior mutation is reconciled above even if the base has since moved.
    // A genuinely new branch still requires its exact authorized base to be
    // current immediately before the push.
    const encodedBaseRef = baseRef.split("/").map(encodeURIComponent).join("/");
    const remoteBase = await request({
      ...context,
      token: activeToken,
      path: `/repos/${repository}/git/ref/heads/${encodedBaseRef}`,
    });
    if (remoteBase?.object?.sha !== baseSha) {
      throw new Error(`Base ref ${baseRef} changed: authorized ${baseSha}, current ${remoteBase?.object?.sha || "unknown"}.`);
    }

    // 4. Exact create CAS: the lease requires the remote ref to not exist.
    try {
      await pushCommit({ gitPath, workspace, repository, ref, sha, expectedRemoteSha: null, token: activeToken, transportUrl });
    } catch (error) {
      return resolvePushFailure({ operation: "create_branch", ref, sha, expectedOldSha: null, encodedBranch, activeToken, error, verifiedLogin: credential.verifiedLogin });
    }

    // 5. Remote read-back proves the mutation landed at the exact SHA.
    return verifyMutation({ operation: "create_branch", ref, sha, expectedOldSha: null, encodedBranch, activeToken, verifiedLogin: credential.verifiedLogin, outcome: "created" });
  }

  async function pushBranch({ ref, sha, oldSha }) {
    authorize("push_branch");
    const authorizedOldSha = oldSha ?? baseSha ?? undefined;
    const branchName = assertBranchOperationInput({ ref, sha, oldSha: authorizedOldSha });
    const encodedBranch = branchName.split("/").map(encodeURIComponent).join("/");

    // 1. Local validation (including ancestry when an operation or binding pins
    // the base) before token issuance. A bound baseSha is the provider-omission
    // fallback so unchanged inherited blobs never expand the payload to the
    // full tree.
    const gitPath = resolveGitBinary();
    await validateLocalGitState({
      gitPath, workspace, repository, ref, sha, oldSha: authorizedOldSha,
      requireWorkspaceHead: allowWorkspaceHead,
    });
    adoptWorkspaceHead(sha);

    // 2. Token issuance and identity verification after validation.
    const credential = await ensureToken();
    const activeToken = credential.token;
    await verifyIdentity({ ...context, token: activeToken, verifiedLogin: credential.verifiedLogin });

    // 3. Remote-side gate, then reconciliation-aware exact base discovery.
    await assertRemoteBranchMutable({ branchName, encodedBranch, activeToken });
    const { currentRef, reconciledReceipt } = await reconcileBeforeMutation({
      operation: "push_branch", ref, sha, encodedBranch, activeToken, verifiedLogin: credential.verifiedLogin,
    });
    if (reconciledReceipt) return reconciledReceipt;
    const remoteSha = currentRef?.object?.sha;
    if (!remoteSha) {
      throw new Error(authorizedOldSha !== undefined
        ? `Remote branch refs/heads/${branchName} does not exist, but oldSha was provided.`
        : `Remote branch refs/heads/${branchName} does not exist.`);
    }
    if (remoteSha === sha) {
      return branchReceipt({ operation: "push_branch", ref, requestedSha: sha, expectedOldSha: authorizedOldSha ?? null, observedRemoteSha: sha, outcome: "idempotent", idempotent: true, verifiedLogin: credential.verifiedLogin });
    }
    if (authorizedOldSha !== undefined && remoteSha !== authorizedOldSha) {
      throw new Error(`Remote branch ref changed: expected ${authorizedOldSha}, current ${remoteSha}.`);
    }
    if (authorizedOldSha === undefined) {
      // The caller did not pin a base; the observed remote SHA becomes the CAS
      // base and must be a local ancestor of the head, fail-closed.
      await assertLocalAncestry({ gitPath, workspace, ancestor: remoteSha, descendant: sha });
    }

    // 4. Exact fast-forward CAS pinned to the observed remote SHA.
    try {
      await pushCommit({ gitPath, workspace, repository, ref, sha, expectedRemoteSha: remoteSha, token: activeToken, transportUrl });
    } catch (error) {
      return resolvePushFailure({ operation: "push_branch", ref, sha, expectedOldSha: remoteSha, encodedBranch, activeToken, error, verifiedLogin: credential.verifiedLogin });
    }

    // 5. Remote read-back proves the mutation landed at the exact SHA.
    return verifyMutation({ operation: "push_branch", ref, sha, expectedOldSha: remoteSha, encodedBranch, activeToken, verifiedLogin: credential.verifiedLogin, outcome: "fast_forwarded" });
  }

  async function replaceBranch({ ref, sha, oldSha }) {
    authorize("replace_branch");
    if (oldSha === undefined) {
      throw new Error("replace_branch requires an exact oldSha lease.");
    }
    const branchName = assertBranchOperationInput({ ref, sha, oldSha });
    const encodedBranch = branchName.split("/").map(encodeURIComponent).join("/");

    // Replacement is intentionally allowed to be non-fast-forward, but all
    // local binding and payload checks still complete before token issuance.
    const gitPath = resolveGitBinary();
    await validateLocalGitState({
      gitPath, workspace, repository, ref, sha, oldSha, requireFastForward: false,
      requireWorkspaceHead: allowWorkspaceHead,
    });
    adoptWorkspaceHead(sha);

    const credential = await ensureToken();
    const activeToken = credential.token;
    await verifyIdentity({ ...context, token: activeToken, verifiedLogin: credential.verifiedLogin });

    await assertRemoteBranchMutable({ branchName, encodedBranch, activeToken });
    const { currentRef, reconciledReceipt } = await reconcileBeforeMutation({
      operation: "replace_branch", ref, sha, encodedBranch, activeToken, verifiedLogin: credential.verifiedLogin,
    });
    if (reconciledReceipt) return reconciledReceipt;
    const remoteSha = currentRef?.object?.sha;
    if (!remoteSha) {
      throw new Error(`Remote branch refs/heads/${branchName} does not exist; replace_branch never creates refs.`);
    }
    // A retry of the same old/new/ref envelope is idempotent after a landed
    // mutation, even though the oldSha lease no longer matches the remote.
    if (remoteSha === sha) {
      return branchReceipt({
        operation: "replace_branch", ref, requestedSha: sha, expectedOldSha: oldSha,
        observedRemoteSha: sha, outcome: "idempotent", idempotent: true,
        verifiedLogin: credential.verifiedLogin,
      });
    }
    if (remoteSha !== oldSha) {
      throw new Error(`Remote branch ref changed: expected ${oldSha}, current ${remoteSha}.`);
    }

    try {
      await pushCommit({
        gitPath, workspace, repository, ref, sha, expectedRemoteSha: oldSha,
        token: activeToken, transportUrl,
      });
    } catch (error) {
      return resolvePushFailure({
        operation: "replace_branch", ref, sha, expectedOldSha: oldSha,
        encodedBranch, activeToken, error, verifiedLogin: credential.verifiedLogin,
      });
    }

    return verifyMutation({
      operation: "replace_branch", ref, sha, expectedOldSha: oldSha,
      encodedBranch, activeToken, verifiedLogin: credential.verifiedLogin, outcome: "replaced",
    });
  }

  async function getIssue(issueNum) {
    authorize("get_issue");
    assertIssueBound(issueNum);
    await identity();
    return await request({
      ...context,
      path: `/repos/${repository}/issues/${issueNum}`,
    });
  }

  async function addIssueLabel(issueNum, label) {
    authorize("add_issue_label");
    assertIssueBound(issueNum);
    await identity();
    try {
      await request({
        ...context,
        path: `/repos/${repository}/labels/${encodeURIComponent(label)}`,
      });
    } catch (err) {
      if (err.status === 404) {
        try {
          await request({
            ...context,
            path: `/repos/${repository}/labels`,
            method: "POST",
            body: { name: label, color: "ededed", description: "Agent Bridge issue claim label" },
          });
        } catch (createErr) {
          if (createErr.status !== 422) {
            throw createErr;
          }
        }
      } else {
        throw err;
      }
    }
    return await request({
      ...context,
      path: `/repos/${repository}/issues/${issueNum}/labels`,
      method: "POST",
      body: { labels: [label] },
    });
  }

  async function removeIssueLabel(issueNum, label) {
    authorize("remove_issue_label");
    assertIssueBound(issueNum);
    await identity();
    return await request({
      ...context,
      path: `/repos/${repository}/issues/${issueNum}/labels/${encodeURIComponent(label)}`,
      method: "DELETE",
    });
  }

  async function getIssueComments(issueNum) {
    authorize("get_issue_comments");
    assertIssueBound(issueNum);
    await identity();
    return await requestPages({
      ...context,
      path: `/repos/${repository}/issues/${issueNum}/comments?per_page=100`,
    });
  }

  async function postIssueComment(issueNum, body) {
    authorize("post_issue_comment");
    assertIssueBound(issueNum);
    await identity();
    return await request({
      ...context,
      path: `/repos/${repository}/issues/${issueNum}/comments`,
      method: "POST",
      body: { body },
    });
  }

  async function updateIssueComment(commentId, body) {
    authorize("update_issue_comment");
    const comments = await getIssueComments(issueNumber);
    if (!comments.some(c => c.id === commentId)) {
      throw new Error(`Comment ${commentId} does not belong to bound issue ${issueNumber}.`);
    }
    await identity();
    return await request({
      ...context,
      path: `/repos/${repository}/issues/comments/${commentId}`,
      method: "PATCH",
      body: { body },
    });
  }

  async function deleteIssueComment(commentId) {
    authorize("delete_issue_comment");
    const comments = await getIssueComments(issueNumber);
    if (!comments.some(c => c.id === commentId)) {
      throw new Error(`Comment ${commentId} does not belong to bound issue ${issueNumber}.`);
    }
    await identity();
    return await request({
      ...context,
      path: `/repos/${repository}/issues/comments/${commentId}`,
      method: "DELETE",
    });
  }

  async function listTagLocks() {
    authorize("list_tag_locks");
    await identity();
    const locks = await request({
      ...context,
      path: `/repos/${repository}/git/matching-refs/tags/claims/issue-${issueNumber}`,
    });
    const exactPrefix = `refs/tags/claims/issue-${issueNumber}-generation-`;
    return locks.filter((lock) => {
      if (!String(lock?.ref || "").startsWith(exactPrefix)) return false;
      const generation = Number.parseInt(lock.ref.slice(exactPrefix.length), 10);
      return Number.isInteger(generation)
        && generation > 0
        && lock.ref === `${exactPrefix}${generation}`;
    });
  }

  async function acquireTagLock(generation, sha) {
    authorize("acquire_tag_lock");
    if (!Number.isInteger(generation) || generation < 1) {
      throw new Error("Claim lock generation must be a positive integer.");
    }
    await identity();
    return await request({
      ...context,
      path: `/repos/${repository}/git/refs`,
      method: "POST",
      body: { ref: `refs/tags/claims/issue-${issueNumber}-generation-${generation}`, sha },
    });
  }

  async function releaseTagLock(generation) {
    authorize("release_tag_lock");
    if (!Number.isInteger(generation) || generation < 1) {
      throw new Error("Claim lock generation must be a positive integer.");
    }
    await identity();
    return await request({
      ...context,
      path: `/repos/${repository}/git/refs/tags/claims/issue-${issueNumber}-generation-${generation}`,
      method: "DELETE",
    });
  }

  return { identity, ensurePullRequest, reviewThreads, replyReviewThread, resolveReviewThread, markReady, merge, createBranch, pushBranch, replaceBranch, getIssue, addIssueLabel, removeIssueLabel, getIssueComments, postIssueComment, updateIssueComment, deleteIssueComment, listTagLocks, acquireTagLock, releaseTagLock, expectedLogin, repository, issueNumber };
}
