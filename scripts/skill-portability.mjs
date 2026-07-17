#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const PROFILE_VERSION = 1;
export const MANIFEST_RELATIVE_PATH = ".local/share/agent-bridge/skill-exports/manifest.v1.json";

export const TARGET_PROFILES = Object.freeze({
  codex: {
    root: ".codex/skills",
    layout: "directory",
    invocation: "$<skill-name>",
    includeOpenAiMetadata: true,
  },
  claude: {
    root: ".claude/skills",
    layout: "directory",
    invocation: "/<skill-name>",
    includeOpenAiMetadata: false,
  },
  gemini: {
    root: ".gemini/config/skills",
    layout: "directory",
    invocation: "/<skill-name>",
    includeOpenAiMetadata: false,
  },
  "antigravity-cli": {
    root: ".gemini/antigravity-cli/skills",
    layout: "flat-markdown",
    invocation: "/<skill-name>",
    includeOpenAiMetadata: false,
  },
});

const ALLOWED_FRONTMATTER = new Set(["name", "description"]);
const ALLOWED_MCP_SERVERS = new Set(["collaboration", "claude_code", "codex", "antigravity", "playwright"]);
const SAFE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function slash(path) {
  return path.split(sep).join("/");
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { values: {}, keys: [], body: content, error: "missing-frontmatter" };
  const values = {};
  const keys = [];
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    const [, key, raw] = field;
    keys.push(key);
    values[key] = raw.replace(/^(["'])(.*)\1$/, "$2");
  }
  return { values, keys, body: content.slice(match[0].length), error: null };
}

function parseMcpServers(content = "") {
  return [...content.matchAll(/^\s*value:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/gm)]
    .map((match) => match[1])
    .sort();
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function isInside(root, candidate) {
  const base = resolve(root);
  const path = resolve(candidate);
  return path !== base && path.startsWith(`${base}${sep}`);
}

function resolveInside(root, relativePath, code = "path-escape") {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\0")) {
    throw new Error(`${code}: path must be a non-empty relative string.`);
  }
  const path = resolve(root, relativePath);
  if (!isInside(root, path)) throw new Error(`${code}: path must stay inside its configured root: ${relativePath}`);
  return path;
}

async function inventoryUnder(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  const symlinks = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) {
      const nested = await inventoryUnder(root, path);
      files.push(...nested.files);
      symlinks.push(...nested.symlinks);
    }
    else if (entry.isFile()) files.push(slash(relative(root, path)));
    else if (entry.isSymbolicLink()) symlinks.push(slash(relative(root, path)));
  }
  return { files, symlinks };
}

async function filesUnder(root) {
  return (await inventoryUnder(root)).files;
}

function referencedLocalResources(content) {
  const candidates = new Set();
  for (const match of content.matchAll(/\]\((?!https?:|#)([^)\s]+)\)/g)) candidates.add(match[1]);
  for (const match of content.matchAll(/`((?:assets|references|scripts)\/[A-Za-z0-9._/-]+)`/g)) candidates.add(match[1]);
  return [...candidates].filter((path) => !path.includes("<") && !path.includes("*")).sort();
}

function finding(skill, code, message, path = "SKILL.md") {
  return { skill, code, path, message };
}

export async function lintSkillCatalog({ sourceRoot, exportedHome } = {}) {
  const root = resolve(sourceRoot || resolve(import.meta.dirname, ".."));
  const skillsRoot = resolve(root, "skills");
  const names = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const findings = [];
  const machineHostname = hostname();

  for (const name of names) {
    const skillRoot = resolve(skillsRoot, name);
    const inventory = await inventoryUnder(skillRoot);
    for (const path of inventory.symlinks) {
      findings.push(finding(name, "symlink-resource", "Symlinked skill files are not portable and are rejected.", path));
    }
    const skillPath = resolve(skillRoot, "SKILL.md");
    if (!await exists(skillPath)) {
      findings.push(finding(name, "missing-skill", "SKILL.md is required."));
      continue;
    }
    const content = await readFile(skillPath, "utf8");
    const frontmatter = parseFrontmatter(content);
    if (frontmatter.error) findings.push(finding(name, frontmatter.error, "A YAML frontmatter block is required."));
    for (const key of frontmatter.keys.filter((key) => !ALLOWED_FRONTMATTER.has(key))) {
      findings.push(finding(name, "unsupported-metadata", `Unsupported frontmatter field: ${key}.`));
    }
    if (frontmatter.values.name !== name) {
      findings.push(finding(name, "metadata-name-mismatch", `Frontmatter name must equal directory name ${name}.`));
    }
    if (!frontmatter.values.description) findings.push(finding(name, "missing-description", "Frontmatter description is required."));

    for (const resource of referencedLocalResources(content)) {
      const resourcePath = resolve(skillRoot, resource);
      if (!isInside(skillRoot, resourcePath)) {
        findings.push(finding(name, "resource-path-escape", `Referenced resource leaves the skill directory: ${resource}.`, resource));
      } else if (!await exists(resourcePath)) {
        findings.push(finding(name, "missing-resource", `Referenced resource does not exist: ${resource}.`, resource));
      }
    }

    if (/\/(?:Users|home)\/[^\s`"')]+/.test(content)) {
      findings.push(finding(name, "absolute-local-path", "User-specific absolute paths are not portable."));
    }
    if (machineHostname && machineHostname.length >= 4 && content.includes(machineHostname)) {
      findings.push(finding(name, "machine-identity", "Machine-local hostname is embedded in the skill."));
    }
    if (/[A-Za-z0-9-]+\[bot\]/.test(content)) findings.push(finding(name, "embedded-app-identity", "A concrete GitHub App identity is embedded."));
    if (/(?:github_pat_|gh[ps]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(content)) {
      findings.push(finding(name, "embedded-credential", "Credential-like material is embedded."));
    }
    if (/\b(?:bridge|helm)-[0-9a-f]{8}(?:-[0-9a-f-]{27,})?\b/i.test(content)
      || /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(content)) {
      findings.push(finding(name, "collaboration-history", "A concrete collaboration identifier is embedded."));
    }

    const yamlPath = resolve(skillRoot, "agents/openai.yaml");
    const yaml = await readFile(yamlPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    for (const server of parseMcpServers(yaml)) {
      if (!ALLOWED_MCP_SERVERS.has(server)) {
        findings.push(finding(name, "unresolved-tool", `Unknown MCP server: ${server}.`, "agents/openai.yaml"));
      }
    }
    for (const match of content.matchAll(/\$([a-z][a-z0-9-]+)/g)) {
      if (!names.includes(match[1])) {
        findings.push(finding(name, "unadapted-invocation", `No slash-command adapter exists for $${match[1]}.`));
      }
    }
  }

  if (exportedHome) {
    const verification = await verifySkillExport({ homeRoot: exportedHome, sourceRoot: root });
    findings.push(...verification.findings);
  }
  return { ok: findings.length === 0, profileVersion: PROFILE_VERSION, skills: names, findings };
}

function adaptSkillMarkdown(content, target, skillNames) {
  if (TARGET_PROFILES[target].invocation.startsWith("$")) return content;
  return content.replace(/\$([a-z][a-z0-9-]+)/g, (original, name) => (
    skillNames.includes(name) ? `/${name}` : original
  ));
}

function deriveContracts(content) {
  return {
    progress: {
      durablePolling: /get_collaboration|waitSeconds/.test(content),
      narrativeUpdates: /narrative|milestone|status update/i.test(content),
      providerFallback: /PROVIDER SKIPPED|unavailable provider|available provider/i.test(content),
    },
    completion: {
      structuredHandoff: /HANDOFF/.test(content),
      explicitStatus: /STATUS:/.test(content),
      chairVerification: /acknowledge_handoff|chair.*verif/i.test(content),
    },
  };
}

function deriveBoundaries(content) {
  return {
    oneWriter: /exactly one writer|single writer|one designated writer|sole writer/i.test(content),
    appIdentity: /GitHub App|reviewer App|builder App/.test(content),
    personalCredentialFallbackDenied: /never .*personal (?:PAT|token)|must not .*personal (?:PAT|token)/i.test(content),
    humanEscalationDefined: /NEEDS_USER|human intervention|escalat/i.test(content),
  };
}

async function skillProfile({ skillRoot, name }) {
  const content = await readFile(resolve(skillRoot, "SKILL.md"), "utf8");
  const frontmatter = parseFrontmatter(content);
  const allFiles = await filesUnder(skillRoot);
  const sourceFiles = await Promise.all(allFiles.map(async (path) => ({
    path,
    sha256: sha256(await readFile(resolveInside(skillRoot, path, "source-path-escape"))),
  })));
  const yaml = await readFile(resolve(skillRoot, "agents/openai.yaml"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return {
    name,
    description: frontmatter.values.description || "",
    trigger: frontmatter.values.description || "",
    requiredCapabilities: { mcpServers: parseMcpServers(yaml) },
    contracts: deriveContracts(content),
    permissionIdentityBoundaries: deriveBoundaries(content),
    referencedResources: allFiles.filter((path) => path !== "SKILL.md" && path !== "agents/openai.yaml"),
    sourceFiles,
  };
}

async function writeExportFile({ home, relativePath, content }) {
  const path = resolveInside(home, relativePath, "export-path-escape");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
  return { path: slash(relativePath), sha256: sha256(content) };
}

export async function exportSkills({ homeRoot, sourceRoot, skillNames, targets } = {}) {
  const home = resolve(homeRoot || homedir());
  const source = resolve(sourceRoot || resolve(import.meta.dirname, ".."));
  const skillsRoot = resolve(source, "skills");
  const availableNames = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const selectedNames = (skillNames?.length ? [...new Set(skillNames)] : availableNames).sort();
  const selectedTargets = (targets?.length ? [...new Set(targets)] : Object.keys(TARGET_PROFILES)).sort();
  for (const name of selectedNames) {
    if (!availableNames.includes(name) || !SAFE_SKILL_NAME.test(name)) throw new Error(`Unknown or unsafe skill: ${name}`);
  }
  for (const target of selectedTargets) {
    if (!TARGET_PROFILES[target]) throw new Error(`Unknown target: ${target}`);
  }
  const lint = await lintSkillCatalog({ sourceRoot: source });
  if (!lint.ok) throw new Error(`Skill portability lint failed: ${JSON.stringify(lint.findings)}`);

  const profiles = {};
  const exports = {};
  for (const name of selectedNames) profiles[name] = await skillProfile({ skillRoot: resolve(skillsRoot, name), name });

  for (const target of selectedTargets) {
    const targetProfile = TARGET_PROFILES[target];
    exports[target] = {};
    for (const name of selectedNames) {
      const skillRoot = resolve(skillsRoot, name);
      const sourceFiles = await filesUnder(skillRoot);
      const materialResources = sourceFiles.filter((path) => path !== "SKILL.md" && path !== "agents/openai.yaml");
      const unsupported = targetProfile.layout === "flat-markdown" && materialResources.length
        ? [`flat-markdown target cannot package resources: ${materialResources.join(", ")}`]
        : [];
      const warnings = [];
      if (!targetProfile.includeOpenAiMetadata && sourceFiles.includes("agents/openai.yaml")) {
        warnings.push("agents/openai.yaml omitted; required MCP servers remain declared in the portable manifest");
      }
      const files = [];
      if (!unsupported.length) {
        if (targetProfile.layout === "flat-markdown") {
          const markdown = adaptSkillMarkdown(await readFile(resolve(skillRoot, "SKILL.md"), "utf8"), target, availableNames);
          files.push(await writeExportFile({
            home,
            relativePath: join(targetProfile.root, `${name}.md`),
            content: markdown,
          }));
        } else {
          const destination = resolve(home, targetProfile.root, name);
          await rm(destination, { recursive: true, force: true });
          for (const file of sourceFiles) {
            if (file === "agents/openai.yaml" && !targetProfile.includeOpenAiMetadata) continue;
            let content = await readFile(resolve(skillRoot, file));
            if (file === "SKILL.md") content = Buffer.from(adaptSkillMarkdown(content.toString("utf8"), target, availableNames));
            files.push(await writeExportFile({
              home,
              relativePath: join(targetProfile.root, name, file),
              content,
            }));
          }
        }
      }
      exports[target][name] = { supported: unsupported.length === 0, unsupported, warnings, files };
    }
  }

  const manifest = {
    manifestVersion: 1,
    profileVersion: PROFILE_VERSION,
    targets: Object.fromEntries(selectedTargets.map((target) => [target, TARGET_PROFILES[target]])),
    skills: profiles,
    exports,
    excludes: [
      "provider authentication",
      "GitHub identity configuration",
      "collaboration state and history",
      "machine identity",
      "user-specific absolute paths",
    ],
  };
  const manifestPath = resolve(home, MANIFEST_RELATIVE_PATH);
  await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

export async function verifySkillExport({ homeRoot, sourceRoot } = {}) {
  const home = resolve(homeRoot || homedir());
  const source = resolve(sourceRoot || resolve(import.meta.dirname, ".."));
  const manifestPath = resolve(home, MANIFEST_RELATIVE_PATH);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      findings: [{ skill: "catalog", code: "missing-export-manifest", path: MANIFEST_RELATIVE_PATH, message: error.message }],
    };
  }
  const findings = [];
  for (const [skill, profile] of Object.entries(manifest.skills || {})) {
    if (!SAFE_SKILL_NAME.test(skill)) {
      findings.push(finding(skill, "unsafe-source-skill", "Manifest skill name is unsafe."));
      continue;
    }
    const skillRoot = resolve(source, "skills", skill);
    let currentFiles = [];
    try {
      const inventory = await inventoryUnder(skillRoot);
      currentFiles = inventory.files;
      for (const path of inventory.symlinks) {
        findings.push(finding(skill, "symlink-resource", "Symlinked skill files are not portable and are rejected.", path));
      }
    } catch (error) {
      findings.push(finding(skill, "missing-source-skill", `Source skill is missing: ${error.message}`));
      continue;
    }
    const byPath = (a, b) => a.localeCompare(b);
    const expectedFiles = (profile.sourceFiles || []).map((file) => file.path).sort(byPath);
    currentFiles.sort(byPath);
    if (JSON.stringify(currentFiles) !== JSON.stringify(expectedFiles)) {
      findings.push(finding(skill, "stale-source", "Source skill file set differs from the exported manifest."));
    }
    for (const file of profile.sourceFiles || []) {
      try {
        const content = await readFile(resolveInside(skillRoot, file.path, "source-path-escape"));
        if (sha256(content) !== file.sha256) findings.push(finding(skill, "stale-source", "Source skill hash differs from the exported manifest.", file.path));
      } catch (error) {
        findings.push(finding(skill, "stale-source", `Source skill file cannot be verified: ${error.message}`, file.path));
      }
    }
  }
  for (const [target, skills] of Object.entries(manifest.exports || {})) {
    for (const [skill, result] of Object.entries(skills)) {
      for (const file of result.files || []) {
        try {
          const content = await readFile(resolveInside(home, file.path, "export-path-escape"));
          if (sha256(content) !== file.sha256) findings.push(finding(skill, "stale-export", `Export hash differs for ${target}.`, file.path));
        } catch (error) {
          const code = error.message.startsWith("export-path-escape:") ? "export-path-escape" : "missing-export";
          findings.push(finding(skill, code, `Export file cannot be verified for ${target}: ${error.message}`, file.path));
        }
      }
    }
  }
  return { ok: findings.length === 0, profileVersion: manifest.profileVersion, findings, manifest };
}

function optionValues(args, option) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  const sourceRoot = resolve(import.meta.dirname, "..");
  const homeRoot = resolve(optionValues(args, "--home")[0] || homedir());
  const formatJson = optionValues(args, "--format")[0] === "json";
  let result;
  if (command === "lint") {
    result = await lintSkillCatalog({ sourceRoot, exportedHome: args.includes("--verify-export") ? homeRoot : undefined });
  } else if (command === "export") {
    result = await exportSkills({
      homeRoot,
      sourceRoot,
      skillNames: optionValues(args, "--skill"),
      targets: optionValues(args, "--target"),
    });
  } else if (command === "verify") {
    result = await verifySkillExport({ homeRoot, sourceRoot });
  } else {
    console.log("Usage: bridge skills <lint|export|verify> [--home PATH] [--skill NAME] [--target TARGET] [--verify-export] [--format json]");
    return;
  }
  if (formatJson) console.log(JSON.stringify(result, null, 2));
  else if (command === "export") {
    const unsupported = Object.entries(result.exports).flatMap(([target, skills]) => (
      Object.entries(skills).filter(([, value]) => !value.supported).map(([skill, value]) => `${target}/${skill}: ${value.unsupported.join("; ")}`)
    ));
    console.log(`Exported ${Object.keys(result.skills).length} skills to ${Object.keys(result.targets).join(", ")}.`);
    for (const message of unsupported) console.log(`UNSUPPORTED: ${message}`);
  } else {
    console.log(result.ok ? "Skill portability validation passed." : JSON.stringify(result.findings, null, 2));
  }
  if (result.ok === false) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
