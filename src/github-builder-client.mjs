import { createHash } from "node:crypto";

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

async function verifyIdentity({ fetchImpl, apiUrl, token, expectedLogin, verifiedLogin }) {
  const login = verifiedLogin || (await request({ fetchImpl, apiUrl, token, path: "/user" }))?.login;
  if (login !== expectedLogin) {
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
  token,
  repository,
  expectedLogin,
  verifiedLogin = null,
  headSha,
  prNumber = null,
  headRef = null,
  baseRef = null,
  requiredReviewStatusContext = "agent-review",
  trustedReviewLogins = [],
  trustedHumanReviewLogins = [],
  allowedOperations = ["ensure_pull_request", "read_review_threads", "reply_review_thread", "resolve_review_thread", "mark_ready"],
}) {
  assertRepository(repository);
  assertSha(headSha);
  if (!expectedLogin) throw new Error("expectedLogin is required.");
  if (prNumber !== null && (!Number.isInteger(prNumber) || prNumber < 1)) throw new Error("prNumber is invalid.");
  if (trustedHumanReviewLogins.includes(expectedLogin)) {
    throw new Error("The builder identity cannot be a trusted human reviewer.");
  }
  if (trustedHumanReviewLogins.some((login) => typeof login !== "string" || !login || login.endsWith("[bot]"))) {
    throw new Error("Trusted human reviewer logins must be non-bot GitHub logins.");
  }
  const context = { fetchImpl, apiUrl, token, repository, expectedLogin, verifiedLogin, headSha, prNumber };
  const allowed = new Set(allowedOperations);
  const authorize = (operation) => {
    if (!allowed.has(operation)) throw new Error(`GitHub builder operation is not authorized: ${operation}.`);
  };

  async function identity() {
    return verifyIdentity(context);
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
    let pull = existing.find((candidate) => candidate.head?.sha === headSha && candidate.base?.ref === baseRef);
    if (pull) {
      pull = await request({
        ...context,
        path: `/repos/${repository}/pulls/${pull.number}`,
        method: "PATCH",
        body: { title, body, base: baseRef },
      });
    } else {
      pull = await request({
        ...context,
        path: `/repos/${repository}/pulls`,
        method: "POST",
        body: { title, body, head: headRef, base: baseRef, draft },
      });
    }
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
    const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{id isResolved comments(first:100){nodes{id body url author{login}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}`;
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
    const commentsQuery = `query($id:ID!,$after:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$after){nodes{id body url author{login}} pageInfo{hasNextPage endCursor}}}}}`;
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
      comment.author?.login === expectedLogin && comment.body?.includes(receiptMarker)
    ));
    if (existing) return { operation: "reply_review_thread", threadId, url: existing.url, idempotent: true, login: expectedLogin, headSha };
    const query = `mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id url author{login}}}}`;
    const result = await request({
      ...context,
      path: "/graphql",
      method: "POST",
      body: { query, variables: { threadId, body: `${body.trim()}\n\n${receiptMarker}` } },
    });
    if (result?.errors?.length) throw new Error(`GitHub review-thread reply failed: ${result.errors[0].message}`);
    const comment = result?.data?.addPullRequestReviewThreadReply?.comment;
    if (comment?.author?.login !== expectedLogin) throw new Error("GitHub posted the thread reply with an unexpected identity.");
    return { operation: "reply_review_thread", threadId, url: comment.url, idempotent: false, login: expectedLogin, headSha };
  }

  async function resolveReviewThread({ threadId }) {
    authorize("resolve_review_thread");
    const threads = await loadReviewThreads();
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error("Review thread is not part of the bound pull request.");
    if (thread.isResolved) return { operation: "resolve_review_thread", threadId, idempotent: true, login: expectedLogin, headSha };
    const query = `mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}`;
    const result = await request({ ...context, path: "/graphql", method: "POST", body: { query, variables: { threadId } } });
    if (result?.errors?.length) throw new Error(`GitHub review-thread resolution failed: ${result.errors[0].message}`);
    if (!result?.data?.resolveReviewThread?.thread?.isResolved) throw new Error("GitHub did not resolve the review thread.");
    return { operation: "resolve_review_thread", threadId, idempotent: false, login: expectedLogin, headSha };
  }

  async function markReady() {
    authorize("mark_ready");
    await identity();
    const pull = await boundPullRequest(context);
    if (!pull.draft) return { operation: "mark_ready", prNumber, url: pull.html_url, idempotent: true, login: expectedLogin, headSha };
    const query = `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{number url isDraft headRefOid}}}`;
    const result = await request({ ...context, path: "/graphql", method: "POST", body: { query, variables: { id: pull.node_id } } });
    if (result?.errors?.length) throw new Error(`GitHub mark-ready failed: ${result.errors[0].message}`);
    const ready = result?.data?.markPullRequestReadyForReview?.pullRequest;
    if (ready?.headRefOid !== headSha || ready?.isDraft) throw new Error("GitHub returned an invalid mark-ready receipt.");
    return { operation: "mark_ready", prNumber, url: ready.url, idempotent: false, login: expectedLogin, headSha };
  }

  async function merge({ method = "squash" }) {
    authorize("merge");
    if (!prNumber) throw new Error("Merge requires a builder session bound to a pull request.");
    await identity();
    const pull = await boundPullRequest(context);
    if (pull.merged) return { operation: "merge", prNumber, url: pull.html_url, idempotent: true, login: expectedLogin, headSha };
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
    const merged = await request({
      ...context,
      path: `/repos/${repository}/pulls/${prNumber}/merge`,
      method: "PUT",
      body: { sha: headSha, merge_method: method },
    });
    if (!merged?.merged) throw new Error(`GitHub did not merge the bound pull request: ${merged?.message || "unknown error"}`);
    return {
      operation: "merge", prNumber, sha: merged.sha, idempotent: false, login: expectedLogin, headSha,
      reviewGate,
    };
  }

  return { identity, ensurePullRequest, reviewThreads, replyReviewThread, resolveReviewThread, markReady, merge };
}
