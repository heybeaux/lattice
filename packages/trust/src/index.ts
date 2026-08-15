export interface TrustConfig {
  probeBase?: number;
  probeBackoff?: number;
  evidenceMargin?: number;
}

export interface ResolvedTrustConfig {
  probeBase: number;
  probeBackoff: number;
  evidenceMargin: number;
}

export type MonotonicNow = () => number;
export type CapabilityOutcome = 'success' | 'failure';
export type ProbationStatus = 'active' | 'probation' | 'conclusive';
export type ProbationEntryKind = 'entered' | 'probe-issued' | 'readmitted' | 'conclusive';

export interface CapabilityHistoryEntry {
  at: number;
  outcome: CapabilityOutcome;
}

export interface ProbationEntry {
  kind: ProbationEntryKind;
  at: number;
  failures: number;
  successes: number;
  probes: number;
  interval: number | null;
  nextProbeAt: number | null;
}

export interface ProbationState {
  status: ProbationStatus;
  enteredAt: number | null;
  nextProbeAt: number | null;
  interval: number | null;
  probes: number;
  entries: ProbationEntry[];
}

export interface CapabilityRecord {
  id: string;
  successes: number;
  failures: number;
  history: CapabilityHistoryEntry[];
  probation: ProbationState;
}

export interface TrustRoot {
  version: 1;
  config: ResolvedTrustConfig;
  capabilities: Record<string, CapabilityRecord>;
}

export interface IssuedProbe {
  id: string;
  record: CapabilityRecord;
}

export interface IssueProbeResult {
  root: TrustRoot;
  issued: IssuedProbe | null;
}

export const DEFAULT_TRUST_CONFIG: ResolvedTrustConfig = {
  probeBase: 2,
  probeBackoff: 2,
  evidenceMargin: 3,
};

const ROOT_VERSION = 1 as const;

function resolveNow(now?: MonotonicNow | number): number {
  if (typeof now === 'function') {
    return now();
  }

  return now ?? 0;
}

function cloneEntries(entries: ProbationEntry[] | undefined): ProbationEntry[] {
  return (entries ?? []).map((entry) => ({ ...entry }));
}

function createProbationState(): ProbationState {
  return {
    status: 'active',
    enteredAt: null,
    nextProbeAt: null,
    interval: null,
    probes: 0,
    entries: [],
  };
}

function appendProbationEntry(record: CapabilityRecord, kind: ProbationEntryKind, at: number): CapabilityRecord {
  const entry: ProbationEntry = {
    kind,
    at,
    failures: record.failures,
    successes: record.successes,
    probes: record.probation.probes,
    interval: record.probation.interval,
    nextProbeAt: record.probation.nextProbeAt,
  };

  return {
    ...record,
    probation: {
      ...record.probation,
      entries: [...record.probation.entries, entry],
    },
  };
}

function enterProbation(
  record: CapabilityRecord,
  config: ResolvedTrustConfig,
  at: number,
): CapabilityRecord {
  const nextProbeAt = at + config.probeBase;

  return appendProbationEntry(
    {
      ...record,
      probation: {
        ...record.probation,
        status: 'probation',
        enteredAt: at,
        nextProbeAt,
        interval: config.probeBase,
        probes: 0,
      },
    },
    'entered',
    at,
  );
}

function readmit(record: CapabilityRecord, at: number): CapabilityRecord {
  return appendProbationEntry(
    {
      ...record,
      probation: {
        ...record.probation,
        status: 'active',
        enteredAt: null,
        nextProbeAt: null,
        interval: null,
        probes: 0,
      },
    },
    'readmitted',
    at,
  );
}

function conclude(record: CapabilityRecord, at: number): CapabilityRecord {
  return appendProbationEntry(
    {
      ...record,
      probation: {
        ...record.probation,
        status: 'conclusive',
        enteredAt: record.probation.enteredAt ?? at,
        nextProbeAt: null,
      },
    },
    'conclusive',
    at,
  );
}

function evaluateEvidence(
  record: CapabilityRecord,
  config: ResolvedTrustConfig,
  at: number,
): CapabilityRecord {
  if (record.probation.status === 'conclusive') {
    return record;
  }

  const imbalance = record.failures - record.successes;

  if (imbalance > config.evidenceMargin) {
    return conclude(record, at);
  }

  if (imbalance <= 0) {
    if (record.probation.status === 'probation') {
      return readmit(record, at);
    }

    return record;
  }

  if (record.probation.status === 'active') {
    return enterProbation(record, config, at);
  }

  return record;
}

function normalizeCapabilityRecord(input: Partial<CapabilityRecord> & Pick<CapabilityRecord, 'id'>): CapabilityRecord {
  return {
    id: input.id,
    successes: input.successes ?? 0,
    failures: input.failures ?? 0,
    history: (input.history ?? []).map((entry) => ({ ...entry })),
    probation: {
      status: input.probation?.status ?? 'active',
      enteredAt: input.probation?.enteredAt ?? null,
      nextProbeAt: input.probation?.nextProbeAt ?? null,
      interval: input.probation?.interval ?? null,
      probes: input.probation?.probes ?? 0,
      entries: cloneEntries(input.probation?.entries),
    },
  };
}

function updateCapability(
  root: TrustRoot,
  id: string,
  update: (record: CapabilityRecord) => CapabilityRecord,
): TrustRoot {
  const current = getCapabilityRecord(root, id);
  const next = update(current);

  return {
    ...root,
    capabilities: {
      ...root.capabilities,
      [id]: next,
    },
  };
}

export function resolveTrustConfig(config: TrustConfig = {}): ResolvedTrustConfig {
  return {
    probeBase: config.probeBase ?? DEFAULT_TRUST_CONFIG.probeBase,
    probeBackoff: config.probeBackoff ?? DEFAULT_TRUST_CONFIG.probeBackoff,
    evidenceMargin: config.evidenceMargin ?? DEFAULT_TRUST_CONFIG.evidenceMargin,
  };
}

export function createCapabilityRecord(id: string): CapabilityRecord {
  return {
    id,
    successes: 0,
    failures: 0,
    history: [],
    probation: createProbationState(),
  };
}

export function createTrustRoot(config: TrustConfig = {}): TrustRoot {
  return {
    version: ROOT_VERSION,
    config: resolveTrustConfig(config),
    capabilities: {},
  };
}

export function restoreTrustRoot(snapshot: Partial<TrustRoot>): TrustRoot {
  return {
    version: ROOT_VERSION,
    config: resolveTrustConfig(snapshot.config),
    capabilities: Object.fromEntries(
      Object.entries(snapshot.capabilities ?? {}).map(([id, record]) => [
        id,
        normalizeCapabilityRecord(record),
      ]),
    ),
  };
}

export function getCapabilityRecord(root: TrustRoot, id: string): CapabilityRecord {
  return normalizeCapabilityRecord(root.capabilities[id] ?? createCapabilityRecord(id));
}

export function shouldBench(record: CapabilityRecord): boolean {
  return record.failures > record.successes;
}

export function recordSuccess(root: TrustRoot, id: string, now?: MonotonicNow | number): TrustRoot {
  const at = resolveNow(now);

  return updateCapability(root, id, (record) =>
    evaluateEvidence(
      {
        ...record,
        successes: record.successes + 1,
        history: [...record.history, { at, outcome: 'success' }],
      },
      root.config,
      at,
    ),
  );
}

export function recordFailure(root: TrustRoot, id: string, now?: MonotonicNow | number): TrustRoot {
  const at = resolveNow(now);

  return updateCapability(root, id, (record) =>
    evaluateEvidence(
      {
        ...record,
        failures: record.failures + 1,
        history: [...record.history, { at, outcome: 'failure' }],
      },
      root.config,
      at,
    ),
  );
}

export function listDueProbeIds(root: TrustRoot, now?: MonotonicNow | number): string[] {
  const at = resolveNow(now);

  return Object.values(root.capabilities)
    .filter(
      (record) =>
        record.probation.status === 'probation'
        && record.probation.nextProbeAt !== null
        && record.probation.nextProbeAt <= at,
    )
    .sort((left, right) => {
      const leftAt = left.probation.nextProbeAt ?? Number.POSITIVE_INFINITY;
      const rightAt = right.probation.nextProbeAt ?? Number.POSITIVE_INFINITY;

      if (leftAt !== rightAt) {
        return leftAt - rightAt;
      }

      return left.id.localeCompare(right.id);
    })
    .map((record) => record.id);
}

export function issueProbe(root: TrustRoot, id: string, now?: MonotonicNow | number): IssueProbeResult {
  const at = resolveNow(now);
  const record = getCapabilityRecord(root, id);

  if (
    record.probation.status !== 'probation'
    || record.probation.nextProbeAt === null
    || record.probation.nextProbeAt > at
  ) {
    return { root, issued: null };
  }

  const interval = (record.probation.interval ?? root.config.probeBase) * root.config.probeBackoff;
  const updated = appendProbationEntry(
    {
      ...record,
      probation: {
        ...record.probation,
        probes: record.probation.probes + 1,
        interval,
        nextProbeAt: at + interval,
      },
    },
    'probe-issued',
    at,
  );

  return {
    root: updateCapability(root, id, () => updated),
    issued: {
      id,
      record: updated,
    },
  };
}

export function issueNextProbe(root: TrustRoot, now?: MonotonicNow | number): IssueProbeResult {
  const [id] = listDueProbeIds(root, now);

  if (!id) {
    return { root, issued: null };
  }

  return issueProbe(root, id, now);
}
