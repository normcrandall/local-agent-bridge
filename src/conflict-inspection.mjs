import { readPortfolio } from "./portfolio-store.mjs";

export async function inspectPortfolioConflict(root, portfolioId, itemId) {
  const portfolio = await readPortfolio(root, portfolioId);
  const item = portfolio.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Portfolio item ${itemId} was not found in ${portfolioId}.`);
  const candidate = portfolio.mergeTrain?.queue?.find((entry) => entry.itemId === itemId) || null;
  return {
    portfolioId,
    revision: portfolio.revision,
    item: {
      id: item.id,
      status: item.status,
      worktree: item.worktree || null,
      branch: item.branch || null,
      headSha: item.headSha || candidate?.headSha || null,
    },
    mergeTarget: portfolio.mergeTrain ? { branch: portfolio.mergeTrain.targetBranch, sha: portfolio.mergeTrain.targetSha } : null,
    candidate,
    dossier: candidate?.dossier || item.arbitrationDossier || null,
    nextAction: candidate?.dossier ? "Open the preserved resolution workspace and assign exactly one authorized resolution writer." : "No arbitration dossier is recorded for this item.",
  };
}
