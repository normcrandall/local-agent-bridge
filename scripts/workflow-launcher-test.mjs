import assert from "node:assert/strict";
import { councilUxReviewInput, parseWorkflowArguments } from "../src/workflow-launcher.mjs";

const options = parseWorkflowArguments([
  "council-ux-review",
  "--workspace", "/tmp/example",
  "--url", "http://127.0.0.1:3000",
  "--agents", "claude,codex,antigravity",
  "--no-follow",
]);
assert.equal(options.workflow, "council-ux-review");
assert.equal(options.follow, false);
assert.equal(options.workspace, "/tmp/example");

const input = councilUxReviewInput(options);
assert.deepEqual(input.agents, ["claude", "codex", "antigravity"]);
assert.equal(input.browser, true);
assert.equal(input.mode, "review");
assert.match(input.task, /http:\/\/127\.0\.0\.1:3000/);
assert.match(input.task, /HANDOFF/);

console.log("Deterministic workflow launcher tests passed.");
