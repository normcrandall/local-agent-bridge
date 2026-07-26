import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function receiptPath(root, { repository, prNumber, mergedSha }) {
  if (!REPOSITORY_PATTERN.test(repository || "")) throw new Error("Merge receipt requires owner/name repository identity.");
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error("Merge receipt requires a positive PR number.");
  if (!SHA_PATTERN.test(mergedSha || "")) throw new Error("Merge receipt requires the exact merged SHA.");
  const key = createHash("sha256")
    .update(`${repository.toLowerCase()}\n${prNumber}\n${mergedSha.toLowerCase()}`)
    .digest("hex");
  return resolve(root, `${key}.json`);
}

export async function recordMergeDeliveryReceipt(root, receipt) {
  const path = receiptPath(root, receipt);
  const normalized = {
    version: 1,
    repository: receipt.repository,
    issueNumber: receipt.issueNumber,
    prNumber: receipt.prNumber,
    approvedHeadSha: String(receipt.approvedHeadSha || "").toLowerCase(),
    mergedSha: String(receipt.mergedSha || "").toLowerCase(),
    issueRecording: receipt.issueRecording || null,
    recordedAt: receipt.recordedAt || new Date().toISOString(),
  };
  if (!Number.isInteger(normalized.issueNumber) || normalized.issueNumber < 1) throw new Error("Merge receipt requires the immutable issue number.");
  if (!SHA_PATTERN.test(normalized.approvedHeadSha)) throw new Error("Merge receipt requires the exact approved head SHA.");
  if (normalized.issueRecording?.status !== "recorded" || !normalized.issueRecording.commentUrl) {
    throw new Error("Merge receipt requires the durable issue-recording comment URL.");
  }
  await mkdir(root, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return normalized;
}

export async function readMergeDeliveryReceipt(root, identity) {
  const path = receiptPath(root, identity);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Failed to read durable merge receipt: ${error.message}`);
  }
  return parsed;
}
