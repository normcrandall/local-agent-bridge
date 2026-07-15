#!/usr/bin/env node

import { canPublishReviewStatus, createInstallationToken } from "../src/github-app-auth.mjs";

const repository = process.argv[2];
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "")) {
  console.error("Usage: npm run github-app:verify -- OWNER/REPO");
  process.exit(2);
}

const roles = [
  { label: "builder", role: "builder" },
  ...["claude", "codex", "antigravity"].map((reviewerProvider) => ({
    label: `reviewer:${reviewerProvider}`,
    role: "reviewer",
    reviewerProvider,
  })),
];
let failed = false;
for (const entry of roles) {
  try {
    const credential = await createInstallationToken({
      role: entry.role,
      reviewerProvider: entry.reviewerProvider,
      repository,
    });
    console.log(`OK   ${entry.label} as ${credential.expectedLogin}`);
    if (entry.role === "reviewer" && !canPublishReviewStatus(credential.permissions)) {
      console.log(`WARN ${entry.label}: formal reviews are enabled; agent-review status publication is unavailable (statuses:write).`);
    }
  } catch (error) {
    failed = true;
    console.error(`FAIL ${entry.label}: ${error.message}`);
  }
}
if (failed) process.exit(1);
