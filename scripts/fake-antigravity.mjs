#!/usr/bin/env node

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("fake-antigravity 1.0.0\n");
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write("--print --print-timeout --mode --model --sandbox --dangerously-skip-permissions --conversation --log-file --add-dir\n");
  process.exit(0);
}
const modelIndex = args.indexOf("--model");
const selectedModel = modelIndex >= 0 ? args[modelIndex + 1] : "provider-configured model";
if ((process.env.FAKE_ANTIGRAVITY_OVERLOAD_MODELS || "").split(",").includes(selectedModel)) {
  process.stderr.write(`Model ${selectedModel} is overloaded.\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(args)}\n`);
