import { createHash } from "node:crypto";

function canonicalPayload({ event, body, comments, headSha }) {
  return JSON.stringify({ event, body, comments, headSha });
}

export function reviewMarker(payload) {
  const digest = createHash("sha256").update(canonicalPayload(payload)).digest("hex").slice(0, 20);
  return `<!-- agent-bridge-review:${payload.headSha}:${digest} -->`;
}

export function reviewGateState(reviewState) {
  const normalized = String(reviewState || "").toUpperCase();
  if (["APPROVE", "APPROVED"].includes(normalized)) {
    return { state: "success", description: "Independent agent review approved this exact commit." };
  }
  if (["REQUEST_CHANGES", "CHANGES_REQUESTED"].includes(normalized)) {
    return { state: "failure", description: "Independent agent review requested changes." };
  }
  return { state: "pending", description: "Independent agent review did not approve this commit." };
}

async function responseJson(response, label) {
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  if (!response.ok) {
    const detail = parsed?.message || text || `${response.status} ${response.statusText}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return parsed;
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

async function getAllPages({ fetchImpl, apiUrl, path, token }) {
  const values = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await fetchImpl(`${apiUrl}${path}${separator}per_page=100&page=${page}`, {
      headers: headers(token),
    });
    const batch = await responseJson(response, `GitHub GET ${path}`);
    if (!Array.isArray(batch)) throw new Error(`GitHub GET ${path} returned a non-array response.`);
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error(`GitHub GET ${path} exceeded the pagination safety limit.`);
}

async function publishReviewGate({
  fetchImpl, apiUrl, token, repository, headSha, expectedLogin, reviewState, reviewUrl, context,
}) {
  const gate = reviewGateState(reviewState);
  const priorStatuses = await getAllPages({
    fetchImpl,
    apiUrl,
    path: `/repos/${repository}/commits/${headSha}/statuses`,
    token,
  });
  const existing = priorStatuses.find((status) => (
    status.context === context
    && status.state === gate.state
    && status.target_url === reviewUrl
    && status.creator?.login === expectedLogin
  ));
  if (existing) return { ...gate, context, targetUrl: reviewUrl, id: existing.id, idempotent: true };
  const response = await fetchImpl(`${apiUrl}/repos/${repository}/statuses/${headSha}`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      state: gate.state,
      context,
      description: gate.description,
      target_url: reviewUrl,
    }),
  });
  const status = await responseJson(response, "GitHub review gate status");
  if (status?.creator?.login !== expectedLogin || status?.context !== context || status?.state !== gate.state) {
    throw new Error("GitHub returned an invalid review gate status receipt.");
  }
  return { ...gate, context, targetUrl: reviewUrl, id: status.id, idempotent: false };
}

export async function submitBoundReview({
  fetchImpl = fetch,
  apiUrl = "https://api.github.com",
  token,
  repository,
  prNumber,
  headSha,
  expectedLogin,
  verifiedLogin = null,
  event,
  body,
  comments = [],
  statusContext = "agent-review",
  publishGate = true,
}) {
  if (verifiedLogin) {
    if (verifiedLogin !== expectedLogin) {
      throw new Error(`GitHub review identity mismatch: expected ${expectedLogin}, received ${verifiedLogin}.`);
    }
  } else {
    const userResponse = await fetchImpl(`${apiUrl}/user`, { headers: headers(token) });
    const user = await responseJson(userResponse, "GitHub identity check");
    if (user?.login !== expectedLogin) {
      throw new Error(`GitHub review identity mismatch: expected ${expectedLogin}, received ${user?.login || "unknown"}.`);
    }
  }

  const prResponse = await fetchImpl(`${apiUrl}/repos/${repository}/pulls/${prNumber}`, {
    headers: headers(token),
  });
  const pullRequest = await responseJson(prResponse, "GitHub pull request lookup");
  if (pullRequest?.head?.sha !== headSha) {
    throw new Error(`Pull request head changed: authorized ${headSha}, current ${pullRequest?.head?.sha || "unknown"}.`);
  }

  if (comments.length) {
    const files = await getAllPages({
      fetchImpl,
      apiUrl,
      path: `/repos/${repository}/pulls/${prNumber}/files`,
      token,
    });
    const changedPaths = new Set(files.map((file) => file.filename));
    for (const comment of comments) {
      if (!changedPaths.has(comment.path)) {
        throw new Error(`Inline review path is not in the pull request diff: ${comment.path}`);
      }
    }
  }

  const marker = reviewMarker({ event, body, comments, headSha });
  const priorReviews = await getAllPages({
    fetchImpl,
    apiUrl,
    path: `/repos/${repository}/pulls/${prNumber}/reviews`,
    token,
  });
  const existing = priorReviews.find((review) => (
    review.user?.login === expectedLogin && review.body?.includes(marker)
  ));
  if (existing) {
    const gate = publishGate ? await publishReviewGate({
      fetchImpl, apiUrl, token, repository, headSha, expectedLogin,
      reviewState: existing.state || event, reviewUrl: existing.html_url, context: statusContext,
    }) : null;
    return {
      id: existing.id,
      url: existing.html_url,
      state: existing.state,
      login: existing.user.login,
      headSha,
      marker,
      idempotent: true,
      gate,
    };
  }

  const response = await fetchImpl(`${apiUrl}/repos/${repository}/pulls/${prNumber}/reviews`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      commit_id: headSha,
      event,
      body: `${body.trim()}\n\n${marker}`,
      comments,
    }),
  });
  const review = await responseJson(response, "GitHub review submission");
  if (review?.user?.login !== expectedLogin) {
    throw new Error(`GitHub posted with unexpected identity: ${review?.user?.login || "unknown"}.`);
  }
  const gate = publishGate ? await publishReviewGate({
    fetchImpl, apiUrl, token, repository, headSha, expectedLogin,
    reviewState: review.state || event, reviewUrl: review.html_url, context: statusContext,
  }) : null;
  return {
    id: review.id,
    url: review.html_url,
    state: review.state,
    login: review.user.login,
    headSha,
    marker,
    idempotent: false,
    gate,
  };
}
