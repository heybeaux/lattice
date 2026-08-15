import { describe, expect, it } from 'vitest';

import {
  createTrustRoot,
  getCapabilityRecord,
  issueNextProbe,
  listDueProbeIds,
  recordFailure,
  recordSuccess,
  restoreTrustRoot,
  shouldBench,
} from '../src/index.js';

describe('@heybeaux/lattice-trust', () => {
  it('crosses into probation when cumulative failures exceed successes', () => {
    let root = createTrustRoot();

    root = recordSuccess(root, 'alpha', 1);
    root = recordFailure(root, 'alpha', 2);

    let alpha = getCapabilityRecord(root, 'alpha');
    expect(alpha.probation.status).toBe('active');
    expect(shouldBench(alpha)).toBe(false);

    root = recordFailure(root, 'alpha', 3);
    alpha = getCapabilityRecord(root, 'alpha');

    expect(alpha.failures).toBe(2);
    expect(alpha.successes).toBe(1);
    expect(alpha.probation.status).toBe('probation');
    expect(alpha.probation.enteredAt).toBe(3);
    expect(alpha.probation.nextProbeAt).toBe(5);
  });

  it('schedules probes at +2, +6, and +14 from probation entry', () => {
    let root = createTrustRoot();
    root = recordFailure(root, 'alpha', 10);

    expect(getCapabilityRecord(root, 'alpha').probation.nextProbeAt).toBe(12);

    root = issueNextProbe(root, 12).root;
    expect(getCapabilityRecord(root, 'alpha').probation).toMatchObject({
      probes: 1,
      interval: 4,
      nextProbeAt: 16,
    });

    root = issueNextProbe(root, 16).root;
    expect(getCapabilityRecord(root, 'alpha').probation).toMatchObject({
      probes: 2,
      interval: 8,
      nextProbeAt: 24,
    });
  });

  it('does not readmit on a single lucky success when cumulative evidence is still negative', () => {
    let root = createTrustRoot();
    root = recordFailure(root, 'alpha', 1);
    root = recordFailure(root, 'alpha', 2);
    root = recordSuccess(root, 'alpha', 3);

    const alpha = getCapabilityRecord(root, 'alpha');
    expect(alpha.failures).toBe(2);
    expect(alpha.successes).toBe(1);
    expect(alpha.probation.status).toBe('probation');
    expect(shouldBench(alpha)).toBe(true);
  });

  it('readmits only after cumulative successes rebalance failures', () => {
    let root = createTrustRoot();
    root = recordFailure(root, 'alpha', 1);
    root = recordFailure(root, 'alpha', 2);
    root = recordSuccess(root, 'alpha', 3);
    root = recordSuccess(root, 'alpha', 4);

    const alpha = getCapabilityRecord(root, 'alpha');
    expect(alpha.failures).toBe(2);
    expect(alpha.successes).toBe(2);
    expect(alpha.probation.status).toBe('active');
    expect(alpha.probation.nextProbeAt).toBeNull();
    expect(shouldBench(alpha)).toBe(false);
  });

  it('becomes conclusive once the evidence margin is exceeded and never probes again', () => {
    let root = createTrustRoot();
    root = recordFailure(root, 'alpha', 1);
    root = recordFailure(root, 'alpha', 2);
    root = recordFailure(root, 'alpha', 3);
    root = recordFailure(root, 'alpha', 4);

    let alpha = getCapabilityRecord(root, 'alpha');
    expect(alpha.probation.status).toBe('conclusive');
    expect(alpha.probation.nextProbeAt).toBeNull();
    expect(listDueProbeIds(root, 1_000)).toEqual([]);

    root = issueNextProbe(root, 1_000).root;
    root = recordSuccess(root, 'alpha', 1_001);
    alpha = getCapabilityRecord(root, 'alpha');

    expect(alpha.probation.status).toBe('conclusive');
    expect(alpha.probation.nextProbeAt).toBeNull();
  });

  it('selects due probes deterministically by earliest nextProbeAt then id', () => {
    let root = createTrustRoot();
    root = recordFailure(root, 'beta', 0);
    root = recordFailure(root, 'alpha', 0);

    expect(listDueProbeIds(root, 2)).toEqual(['alpha', 'beta']);

    const issued = issueNextProbe(root, 2);
    expect(issued.issued?.id).toBe('alpha');
    expect(listDueProbeIds(issued.root, 2)).toEqual(['beta']);
  });

  it('serializes, restores, and continues scheduling after root transfer', () => {
    let root = createTrustRoot();
    root = recordFailure(root, 'alpha', 5);
    root = issueNextProbe(root, 7).root;
    root = recordSuccess(root, 'alpha', 8);

    const transferred = restoreTrustRoot(
      JSON.parse(JSON.stringify(root)) as ReturnType<typeof createTrustRoot>,
    );

    let alpha = getCapabilityRecord(transferred, 'alpha');
    expect(alpha.failures).toBe(1);
    expect(alpha.successes).toBe(1);
    expect(alpha.history).toEqual([
      { at: 5, outcome: 'failure' },
      { at: 8, outcome: 'success' },
    ]);
    expect(alpha.probation.entries.map((entry) => entry.kind)).toEqual([
      'entered',
      'probe-issued',
      'readmitted',
    ]);

    const moved = recordFailure(transferred, 'beta', 11);
    alpha = getCapabilityRecord(moved, 'beta');
    expect(alpha.probation.status).toBe('probation');
    expect(alpha.probation.nextProbeAt).toBe(13);
  });
});
