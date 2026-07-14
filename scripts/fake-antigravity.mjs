#!/usr/bin/env node

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("fake-antigravity 1.0.0\n");
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write("--print --print-timeout --mode --model --sandbox --dangerously-skip-permissions --conversation --log-file\n");
  process.exit(0);
}
process.stdout.write(`${JSON.stringify(args)}\n`);
