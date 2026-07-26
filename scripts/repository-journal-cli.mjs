#!/usr/bin/env node

import { resolve } from "node:path";
import { createRepositoryJournalOperations } from "../src/repository-journal-operations.mjs";

const [command = "inspect", ...args] = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const directory = resolve(value("--directory", process.env.BRIDGE_REPOSITORY_JOURNAL_DIR || resolve(process.cwd(), ".bridge/repository-journal")));
const operations = createRepositoryJournalOperations({ directory, receiptDirectory: value("--receipt-directory") });
let result;

switch (command) {
  case "inspect":
    result = await operations.inspect();
    break;
  case "retain":
    result = await operations.retain({ maxRecords: Number(value("--max-records")), apply: args.includes("--apply") });
    break;
  case "archive":
    result = await operations.archive({ output: value("--output") });
    break;
  case "export":
    result = await operations.export({ output: value("--output"), repository: value("--repository") });
    break;
  case "import":
    result = await operations.import({ input: value("--input"), repository: value("--repository"), apply: args.includes("--apply") });
    break;
  case "recover":
    result = await operations.recover({ apply: args.includes("--apply") });
    break;
  case "restore":
    result = await operations.restore({ input: value("--input"), apply: args.includes("--apply") });
    break;
  default:
    throw new Error("journal supports inspect, retain, archive, export, import, recover, or restore.");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
