export function resolveNativeChair({ chair = null, agents, startAgent, writer, mode = "review" }) {
  if (!chair) return { chair: null, agents, startAgent: startAgent || agents[0], writer: mode === "work" ? (writer || startAgent || agents[0]) : null, chairOwnsWork: false };
  const delegated = chair.allowSameProviderDelegation ? [...agents] : agents.filter((agent) => agent !== chair.provider);
  if (!delegated.length) {
    throw new Error(`Native ${chair.provider} chair reuse removed the only delegated provider; select at least one peer or explicitly allow same-provider delegation.`);
  }
  const chairOwnsWork = mode === "work" && !chair.allowSameProviderDelegation && writer === chair.provider;
  return {
    chair: { ...chair, source: "native-chair" },
    agents: delegated,
    startAgent: delegated.includes(startAgent) ? startAgent : delegated[0],
    writer: mode === "work" && !chairOwnsWork ? (delegated.includes(writer) ? writer : delegated[0]) : null,
    chairOwnsWork,
  };
}
