export const GITHUB_MERGE_ENFORCEMENT_MODES = [
  "broker",
  "branch-protection",
  "organization-ruleset",
  "auto",
];

export function parseGitHubVerificationArguments(argv = []) {
  let repository = null;
  let branch = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      json = true;
      continue;
    }
    if (value === "--branch") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--branch requires a branch name.");
      branch = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
    if (repository) throw new Error("Only one OWNER/REPO argument is allowed.");
    repository = value;
  }
  return { repository, branch, json };
}

const CAPABILITY_KEYS = {
  "branch-protection": "branchProtection",
  "organization-ruleset": "organizationRuleset",
};

function trustedAppIdSet(values) {
  return new Set((values || []).map(Number).filter((value) => Number.isInteger(value) && value > 0));
}

export function inspectGitHubMergeCapabilities({
  rules = [],
  branchProtection = null,
  trustedAppIds = [],
  context = "agent-review",
} = {}) {
  const trusted = trustedAppIdSet(trustedAppIds);
  const organizationRule = (Array.isArray(rules) ? rules : []).find((rule) => (
    rule?.type === "required_status_checks"
    && rule.ruleset_source_type === "Organization"
    && rule.parameters?.required_status_checks?.some((check) => (
      check.context === context && trusted.has(Number(check.integration_id))
    ))
  ));
  const organizationCheck = organizationRule?.parameters?.required_status_checks?.find((check) => (
    check.context === context && trusted.has(Number(check.integration_id))
  ));
  const branchCheck = branchProtection?.required_status_checks?.checks?.find((check) => (
    check.context === context && trusted.has(Number(check.app_id))
  ));
  return {
    organizationRuleset: organizationRule ? {
      verified: true,
      source: `github-api:organization-ruleset/${organizationRule.ruleset_id}`,
      reason: `Organization ruleset ${organizationRule.ruleset_id} requires ${context} from trusted GitHub App ${organizationCheck.integration_id}.`,
    } : {
      verified: false,
      source: "github-api:organization-ruleset",
      reason: `No active organization ruleset requires ${context} from a trusted reviewer App.`,
    },
    branchProtection: branchCheck ? {
      verified: true,
      source: "github-api:branch-protection",
      reason: `Branch protection requires ${context} from trusted GitHub App ${branchCheck.app_id}.`,
    } : {
      verified: false,
      source: "github-api:branch-protection",
      reason: `Branch protection does not require ${context} from a trusted reviewer App.`,
    },
  };
}

function verifiedCapability(configuredMode, capabilities) {
  const capability = capabilities?.[CAPABILITY_KEYS[configuredMode]];
  return capability?.verified === true ? capability : null;
}

export function resolveGitHubMergeEnforcement({ configuredMode = "broker", capabilities = {} } = {}) {
  if (!GITHUB_MERGE_ENFORCEMENT_MODES.includes(configuredMode)) {
    throw new Error(`github.mergeEnforcement must be one of: ${GITHUB_MERGE_ENFORCEMENT_MODES.join(", ")}.`);
  }
  if (configuredMode !== "broker" && configuredMode !== "auto") {
    const capability = verifiedCapability(configuredMode, capabilities);
    if (!capability) {
      return {
        configuredMode,
        effectiveMode: null,
        verified: false,
        blocked: true,
        downgraded: false,
        verificationSource: capabilities?.[CAPABILITY_KEYS[configuredMode]]?.source || "unverified",
        reason: `GitHub ${configuredMode} enforcement was requested explicitly but is not verified for this repository.`,
      };
    }
    return {
      configuredMode,
      effectiveMode: configuredMode,
      verified: true,
      blocked: false,
      downgraded: false,
      verificationSource: capability.source || "github-api",
      reason: capability.reason || `GitHub ${configuredMode} enforcement is verified for this repository.`,
    };
  }
  if (configuredMode === "auto") {
    for (const candidate of ["organization-ruleset", "branch-protection"]) {
      const capability = verifiedCapability(candidate, capabilities);
      if (!capability) continue;
      return {
        configuredMode,
        effectiveMode: candidate,
        verified: true,
        blocked: false,
        downgraded: candidate !== "organization-ruleset",
        verificationSource: capability.source || "github-api",
        reason: candidate === "organization-ruleset"
          ? "Auto mode selected the strongest verified GitHub enforcement capability."
          : "Auto mode selected the strongest verified capability available: repository branch protection.",
      };
    }
    return {
      configuredMode,
      effectiveMode: "broker",
      verified: true,
      blocked: false,
      downgraded: true,
      verificationSource: "local-broker-policy",
      reason: "No GitHub-enforced merge gate was verified, so auto mode selected broker enforcement.",
    };
  }
  return {
    configuredMode,
    effectiveMode: "broker",
    verified: true,
    blocked: false,
    downgraded: false,
    verificationSource: "local-broker-policy",
    reason: "The bridge enforces exact-head review and merge authorization locally.",
  };
}
