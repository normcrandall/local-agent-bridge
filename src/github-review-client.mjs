import { createHash } from "node:crypto";

function canonicalPayload({ event, body, comments, headSha }) {
  return JSON.stringify({ event, body, comments, headSha });
}

export function reviewMarker(payload) {
  const digest = createHash("sha256").update(canonicalPayload(payload)).digest("hex").slice(0, 20);
  return `<!-- agent-bridge-review:${payload.headSha}:${digest} -->`;
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

export async function submitBoundReview({
  fetchImpl = fetch,
  apiUrl = "https://api.github.com",
  token,
  repository,
  prNumber,
  headSha,
  expectedLogin,
  event,
  body,
  comments = [],
}) {
  const userResponse = await fetchImpl(`${apiUrl}/user`, { headers: headers(token) });
  const user = await responseJson(userResponse, "GitHub identity check");
  if (user?.login !== expectedLogin) {
    throw new Error(`GitHub review identity mismatch: expected ${expectedLogin}, received ${user?.login || "unknown"}.`);
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
    return {
      id: existing.id,
      url: existing.html_url,
      state: existing.state,
      login: existing.user.login,
      headSha,
      marker,
      idempotent: true,
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
  return {
    id: review.id,
    url: review.html_url,
    state: review.state,
    login: review.user.login,
    headSha,
    marker,
    idempotent: false,
  };
}
