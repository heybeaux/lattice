/**
 * Decision-row minting (scope §[A], label-spec §1) + cold-start priors (§7.1).
 *
 * Only actions that were ALLOWED TO RUN (gate allow / ask→approved) get a row.
 * Denied/vetoed actions never executed → deny channel → not minted (null).
 */

import { describe, it, expect } from 'vitest';
import { mintRow, wasAllowedToRun } from '../src/mint.js';
import { coldStartPrior, COLD_START_BASE_RATES } from '../src/cold-start.js';
import { decisionEvent, stubPriors } from './fixtures.js';
import type { SonderEventLike } from '../src/types.js';

function mint(decision: SonderEventLike) {
  return mintRow({ decisionEvent: decision, priorEvents: [], priors: stubPriors });
}

describe('mintRow — deny channel', () => {
  it('mints a row when the gate state is allowed (ask→approved)', () => {
    const row = mint(decisionEvent());
    expect(row).not.toBeNull();
    expect(row?.decisionEventId).toBe('sonder:decision-1');
    expect(row?.dataSource).toBe('real');
  });

  it('mints a row when there is no approval gate (plain allow)', () => {
    const row = mint(decisionEvent({ governance: {} }));
    expect(row).not.toBeNull();
  });

  it('does NOT mint a denied action (deny channel)', () => {
    const denied = decisionEvent({
      governance: {
        approval_gate: { state: 'denied', gate_id: 'g1', default_action: 'deny' },
      },
    });
    expect(mint(denied)).toBeNull();
  });

  it('does NOT mint a still-pending gate', () => {
    const pending = decisionEvent({
      governance: {
        approval_gate: { state: 'pending', gate_id: 'g1', default_action: 'deny' },
      },
    });
    expect(mint(pending)).toBeNull();
  });

  it('computes a window deadline and signalDate on the minted row', () => {
    const row = mint(decisionEvent());
    expect(row?.signalDate).toBe('2026-06-14');
    expect(row?.windowDeadline).toBeTypeOf('string');
  });
});

describe('wasAllowedToRun', () => {
  it('treats a missing gate as allowed', () => {
    expect(wasAllowedToRun(decisionEvent({ governance: {} }))).toBe(true);
  });
  it('treats denied/pending as not-run', () => {
    expect(
      wasAllowedToRun(
        decisionEvent({
          governance: {
            approval_gate: {
              state: 'denied',
              gate_id: 'g',
              default_action: 'deny',
            },
          },
        }),
      ),
    ).toBe(false);
  });
});

describe('coldStartPrior (label-spec §7.1)', () => {
  it('maps each severity to its base rate', () => {
    expect(coldStartPrior('critical').pFailure).toBe(0.9);
    expect(coldStartPrior('high').pFailure).toBe(0.45);
    expect(coldStartPrior('medium').pFailure).toBe(0.2);
    expect(coldStartPrior('low').pFailure).toBe(0.03);
    expect(coldStartPrior('none').pFailure).toBe(0.01);
  });

  it('always reports source=prior', () => {
    expect(coldStartPrior('high').source).toBe('prior');
  });

  it('exposes the rate table', () => {
    expect(COLD_START_BASE_RATES.critical).toBe(0.9);
  });
});
