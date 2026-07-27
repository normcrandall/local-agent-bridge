function revision(lane) {
  return {
    repository: String(lane.repository || "").toLowerCase(),
    laneId: lane.id,
    issueNumber: lane.issueNumber || null,
    prNumber: lane.prNumber || null,
    headSha: lane.headSha || null,
    journalSequence: lane.repositoryJournal?.sequence || 0,
    journalDigest: lane.repositoryJournal?.digest || null,
  };
}

function laneKey(lane) {
  return `${String(lane.repository || "").toLowerCase()}\0${lane.id || lane.laneId}`;
}

function sameRevision(left, right) {
  return JSON.stringify(revision(left)) === JSON.stringify(right);
}

function ticketFor(lane) {
  return revision(lane);
}

export function mergeMissionControlRemote(localSnapshot, remote, ticket) {
  const facts = new Map((remote?.lanes || []).map((lane) => [laneKey(lane), lane]));
  let accepted = 0;
  let rejected = 0;
  const mergeLane = (lane) => {
    const expected = ticket.revisions.get(laneKey(lane));
    const fact = facts.get(laneKey(lane));
    if (!expected || !fact || !sameRevision(lane, expected) || fact.binding?.journalSequence !== expected.journalSequence || fact.binding?.journalDigest !== expected.journalDigest) {
      if (fact) rejected += 1;
      return lane;
    }
    accepted += 1;
    const exactHead = !lane.headSha || fact.observedHeadSha === lane.headSha;
    return {
      ...lane,
      github: {
        ...fact,
        ...(exactHead ? {} : { reviews: [], ci: null, exactHead: false, staleHead: fact.observedHeadSha }),
      },
    };
  };
  return {
    ...localSnapshot,
    lanes: (localSnapshot.lanes || []).map(mergeLane),
    operatorLanes: (localSnapshot.operatorLanes || []).map(mergeLane),
    providerCapacity: structuredClone(remote?.providerCapacity || localSnapshot.providerCapacity || {}),
    reconciliation: {
      status: remote?.status || "degraded", source: "broker_remote_reconciliation",
      observedAt: remote?.observedAt || null, accepted, rejected,
      failures: structuredClone(remote?.failures || []),
    },
  };
}

function preserveRemoteFacts(localSnapshot, previousSnapshot) {
  const previous = new Map([
    ...(previousSnapshot?.lanes || []),
    ...(previousSnapshot?.operatorLanes || []),
  ].filter((lane) => lane?.github).map((lane) => [laneKey(lane), lane]));
  const preserve = (lane) => {
    const prior = previous.get(laneKey(lane));
    return prior && sameRevision(lane, revision(prior))
      ? { ...lane, github: structuredClone(prior.github) }
      : lane;
  };
  return {
    ...structuredClone(localSnapshot),
    lanes: (localSnapshot?.lanes || []).map(preserve),
    operatorLanes: (localSnapshot?.operatorLanes || []).map(preserve),
  };
}

export function createMissionControlJournalFirstReconciler({ reconcile, onUpdate = () => {}, refreshMs = 60_000, now = Date.now } = {}) {
  if (typeof reconcile !== "function") throw new Error("Mission Control reconciler requires a remote reconcile function.");
  let local = null;
  let value = null;
  let active = null;
  let controller = null;
  let generation = 0;
  let lastStartedAt = 0;
  let stopped = false;

  const publish = () => { if (!stopped && value) onUpdate(structuredClone(value)); };
  const observeLocal = (snapshot) => {
    local = structuredClone(snapshot);
    value = { ...preserveRemoteFacts(local, value), reconciliation: value?.reconciliation || { status: "local", source: "repository_journal", observedAt: null, accepted: 0, rejected: 0, failures: [] } };
    publish();
    return value;
  };
  const refresh = ({ force = false } = {}) => {
    if (stopped || !local) return { started: false, promise: Promise.resolve({ status: stopped ? "cancelled" : "not_ready" }) };
    if (active) return { started: false, promise: active };
    if (!force && lastStartedAt && now() - lastStartedAt < refreshMs) return { started: false, promise: Promise.resolve({ status: "not_due" }) };
    lastStartedAt = now();
    const requestGeneration = ++generation;
    const requestLocal = structuredClone(local);
    const remotelyBound = (requestLocal.lanes || []).filter((lane) => (
      (lane.issueNumber || lane.prNumber) && !String(lane.repository || "").startsWith("local/")
    ));
    const revisions = new Map(remotelyBound.map((lane) => [laneKey(lane), revision(lane)]));
    const ticket = { streamId: requestLocal.streamId || null, eventCursor: requestLocal.eventCursor ?? null, revisions };
    const requestController = new AbortController();
    controller = requestController;
    value = { ...preserveRemoteFacts(requestLocal, value), reconciliation: { status: "refreshing", source: "broker_remote_reconciliation", observedAt: value?.reconciliation?.observedAt || null, accepted: 0, rejected: 0, failures: [] } };
    publish();
    active = Promise.resolve(reconcile({ tickets: [...revisions.values()], signal: requestController.signal }))
      .then((remote) => {
        if (stopped || requestGeneration !== generation || requestController.signal.aborted) return { status: "cancelled" };
        if ((local.streamId || null) !== ticket.streamId) return { status: "stale_stream" };
        value = mergeMissionControlRemote(local, remote, ticket);
        publish();
        return { status: remote.status, value };
      })
      .catch((error) => {
        if (stopped || requestGeneration !== generation || requestController.signal.aborted || error?.name === "AbortError") return { status: "cancelled" };
        value = { ...preserveRemoteFacts(local, value), reconciliation: { status: "degraded", source: "broker_remote_reconciliation", observedAt: value?.reconciliation?.observedAt || null, accepted: 0, rejected: 0, failures: [{ reason: "remote_error", message: String(error.message || error).slice(0, 300) }] } };
        publish();
        return { status: "degraded", error };
      })
      .finally(() => { if (requestGeneration === generation) { active = null; if (controller === requestController) controller = null; } });
    return { started: true, promise: active };
  };
  return {
    observeLocal,
    refresh,
    cancel() { generation += 1; controller?.abort(); active = null; controller = null; },
    stop() { stopped = true; generation += 1; controller?.abort(); },
    get snapshot() { return { active: Boolean(active), value: structuredClone(value), generation }; },
  };
}
