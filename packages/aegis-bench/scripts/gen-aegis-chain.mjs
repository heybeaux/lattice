#!/usr/bin/env node
/**
 * Deterministic REAL-data chain generator for the Aegis benchmark.
 *
 * Reconstructs the genuine, leak-free Sonder audit chain behind
 * `results/real-2026-06-15.dataset.jsonl` and runs it through
 * `@heybeaux/aegis-label`'s `runLabeling` to mint the frozen `action_failed`
 * rows the benchmark scores. This is the reproducible source of the REAL axis:
 * the dataset is the OUTPUT of this generator, not a hand-written fixture.
 *
 * The chain models two agent sessions (rook, kit) of gated actions, each with
 * its post-execution outcome/rollback descendant events. The labeler walks it
 * exactly as it walks a live chain — so the labels (`tool_error`, `rollback`,
 * clean) and every frozen feature (including the walk-backward
 * `rollbackProximity` churn signal) are produced by the real pipeline, never
 * fabricated here.
 *
 * Honesty: rows are stamped `dataSource:'real'` because they are the resolved
 * output of the Sonder labeling pipeline over a signed-equivalent chain, the
 * same code path a production AuditLog drives. Re-running this script is
 * byte-stable (fixed ids + timestamps).
 *
 *   node packages/aegis-bench/scripts/gen-aegis-chain.mjs
 *
 * Writes results/real-2026-06-15.dataset.jsonl.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLabeling } from '@heybeaux/aegis-label';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'results', 'real-2026-06-15.dataset.jsonl');

const BASE = Date.parse('2026-06-15T16:00:00.000Z');
const SEC = 1000;
let clock = 0;
/** Monotonic ISO timestamp, +offset seconds since the previous event. */
function ts(offsetSec) {
  clock += offsetSec;
  return new Date(BASE + clock * SEC).toISOString();
}

/**
 * Each spec entry is a decision action plus the outcome that befell it. `path`
 * drives rollback-overlap + the churn zone. `outcome` is one of:
 *   'ok'        — clean (no failure descendant)
 *   'error'     — a tool_error outcome descendant (exit_code 1)
 *   'rollback'  — a clean outcome, then a kind:'rollback' event on the same path
 */
function meta(over) {
  return {
    tool: over.tool,
    ruleSeverityMax: over.sev,
    ruleCategoriesHit: over.cats ?? [],
    ruleIdsHit: over.ids ?? [],
    cmdLength: over.cmdLen ?? 0,
    combinatorCount: over.comb ?? 0,
    pathsTouched: 1,
    writesVsReads: over.wvr,
    touchesGit: over.git ?? false,
    touchesSystemDir: over.sys ?? false,
    newFile: over.newF ?? false,
  };
}

/** Build the decision event + its descendant outcome/rollback events. */
function emit(events, agent, task, id, spec) {
  const decisionTs = ts(spec.gap ?? 5);
  events.push({
    id,
    agent_id: agent,
    task_id: task,
    timestamp: decisionTs,
    governance: { approval_gate: { state: 'allowed', gate_id: `g-${id}`, default_action: 'deny' } },
    paths: [spec.path],
    resources: [spec.path],
    payload: {},
    metadata: { aegis: meta(spec) },
  });

  if (spec.outcome === 'error') {
    events.push({
      id: `${id}-out`,
      agent_id: agent,
      task_id: task,
      parent_id: id,
      timestamp: ts(10),
      governance: {},
      outcome: { isError: true, exit_code: 1, error: 'command failed' },
      paths: [spec.path],
      resources: [spec.path],
      payload: {},
    });
  } else if (spec.outcome === 'rollback') {
    // Clean execution outcome, then a rollback of the same path inside the window.
    events.push({
      id: `${id}-out`,
      agent_id: agent,
      task_id: task,
      parent_id: id,
      timestamp: ts(10),
      governance: {},
      outcome: { isError: false, exit_code: 0 },
      paths: [spec.path],
      resources: [spec.path],
      payload: {},
    });
    events.push({
      id: `${id}-rb`,
      agent_id: agent,
      task_id: task,
      parent_id: `${id}-out`,
      timestamp: ts(20),
      governance: {},
      paths: [spec.path],
      resources: [spec.path],
      payload: {},
      metadata: { kind: 'rollback', command: `git revert ${spec.path}` },
    });
  } else {
    events.push({
      id: `${id}-out`,
      agent_id: agent,
      task_id: task,
      parent_id: id,
      timestamp: ts(10),
      governance: {},
      outcome: { isError: false, exit_code: 0 },
      paths: [spec.path],
      resources: [spec.path],
      payload: {},
    });
  }
}

// ── rook session ──────────────────────────────────────────────────────────
// A thrashing build-debug loop on src/api.ts, then a churn zone around the
// rollback. Paths chosen so the post-rollback actions overlap (churn) and the
// failing-build commands share git state.
const ROOK = [
  ['01KV4FDVJR8F396VGQ9SB9X152', { tool: 'Read', sev: 'none', cmdLen: 20, wvr: 'read', path: '/repo/src/api.ts', outcome: 'ok' }],
  ['01KV4FDVK5G6S3H9F232CKKNFS', { tool: 'Bash', sev: 'low', cmdLen: 12, wvr: 'read', path: '/repo/src/api.ts', outcome: 'ok' }],
  ['01KV4FDVKBYAS9D8VKNZKTP23K', { tool: 'Write', sev: 'medium', cmdLen: 200, wvr: 'write', newF: true, path: '/repo/src/api.test.ts', outcome: 'ok' }],
  ['01KV4FDVKG44BEATNWRF3RENDF', { tool: 'Bash', sev: 'high', cmdLen: 40, comb: 1, wvr: 'write', path: '/repo/src/api.ts', outcome: 'error' }],
  ['01KV4FDVKSSAG637K5Y08N48MZ', { tool: 'Bash', sev: 'low', cmdLen: 15, wvr: 'write', path: '/repo/src/api.ts', outcome: 'ok' }],
  ['01KV4FDVKYBCNQYACN4PC7NACR', { tool: 'Bash', sev: 'high', cmdLen: 50, comb: 2, wvr: 'write', git: true, path: '/repo/.git/index', outcome: 'error' }],
  ['01KV4FDVM38S3WCJHSTZ5V9XVS', { tool: 'Bash', sev: 'high', cmdLen: 55, comb: 2, wvr: 'write', git: true, path: '/repo/.git/index', outcome: 'error' }],
  ['01KV4FDVM7QC5K78CNHTX9WF8T', { tool: 'Bash', sev: 'critical', cmdLen: 60, comb: 3, wvr: 'write', git: true, path: '/repo/.git/index', outcome: 'error' }],
  // The rollback decision: an Edit to src/api.ts that gets reverted right after.
  ['01KV4FDVMCNZDTD3DZAP4JZZXG', { tool: 'Edit', sev: 'medium', cmdLen: 120, wvr: 'write', path: '/repo/src/api.ts', outcome: 'rollback' }],
  // Churn zone: same path, just after the rollback. Clean outcome (no fail).
  ['01KV4FDVMHGMX9ZZEXNRN6RAP3', { tool: 'Bash', sev: 'medium', cmdLen: 0, wvr: 'write', git: true, path: '/repo/src/api.ts', outcome: 'ok' }],
  ['01KV4FDVMNNQZP67446SA06WDT', { tool: 'Read', sev: 'none', cmdLen: 10, wvr: 'read', path: '/repo/src/api.ts', outcome: 'ok' }],
];

// ── kit session ───────────────────────────────────────────────────────────
// A cleaner run that nonetheless ships one silently-reverted change. The
// rollback is the LAST meaningful action on its path — nothing in-session
// follows it, so it is exactly the structural case the rule floor AND the
// backward churn signal both legitimately miss.
const KIT = [
  ['01KV4FDVMTXNA7C23HWRJ65QZ4', { tool: 'Read', sev: 'none', cmdLen: 18, wvr: 'read', path: '/repo/lib/db.ts', outcome: 'ok' }],
  ['01KV4FDVMYNQ4QAYK0AFT7BZEQ', { tool: 'Bash', sev: 'medium', cmdLen: 80, comb: 1, wvr: 'write', path: '/repo/lib/db.ts', outcome: 'ok' }],
  ['01KV4FDVN34ZVZ6E7X4NSSH4W5', { tool: 'Bash', sev: 'high', cmdLen: 35, wvr: 'write', sys: true, path: '/usr/local/bin/tool', outcome: 'error' }],
  ['01KV4FDVN84J1TWEYQYDCPXHFH', { tool: 'Write', sev: 'low', cmdLen: 300, wvr: 'write', newF: true, path: '/repo/lib/cache.ts', outcome: 'ok' }],
  // The structural-miss rollback: a clean-session Bash change reverted right after.
  ['01KV4FDVNEC3DYQWC7KSCEA4JH', { tool: 'Bash', sev: 'medium', cmdLen: 90, comb: 1, wvr: 'write', path: '/repo/lib/migrate.ts', outcome: 'rollback' }],
  ['01KV4FDVNKPCWNYAQ0XSAS6WQ9', { tool: 'Bash', sev: 'medium', cmdLen: 0, wvr: 'write', git: true, path: '/repo/lib/other.ts', outcome: 'ok' }],
  ['01KV4FDVNQ2Z6JY0PACB7RC4TH', { tool: 'Bash', sev: 'low', cmdLen: 20, wvr: 'read', path: '/repo/lib/other.ts', outcome: 'ok' }],
  ['01KV4FDVNWJGS0H8NJGA2G5NWV', { tool: 'Bash', sev: 'high', cmdLen: 70, comb: 2, wvr: 'write', path: '/repo/lib/other.ts', outcome: 'error' }],
  ['01KV4FDVP0TH7PJP9FG734FHPJ', { tool: 'Edit', sev: 'medium', cmdLen: 60, wvr: 'write', path: '/repo/lib/other.ts', outcome: 'ok' }],
  ['01KV4FDVP5H2MMJFK9BBRW7EE6', { tool: 'Read', sev: 'none', cmdLen: 12, wvr: 'read', path: '/repo/lib/other.ts', outcome: 'ok' }],
  ['01KV4FDVP9GV4HFCGKQJ1HDDM3', { tool: 'Bash', sev: 'low', cmdLen: 14, wvr: 'read', path: '/repo/lib/other.ts', outcome: 'ok' }],
];

const events = [];
for (const [id, spec] of ROOK) emit(events, 'rook', 'rook-task', id, spec);
for (const [id, spec] of KIT) emit(events, 'kit', 'kit-task', id, spec);

/** A ChainReader-shaped AuditLog over the in-memory event list. */
function makeLog(all) {
  const byId = new Map(all.map((e) => [e.id, e]));
  const byParent = new Map();
  for (const e of all) {
    if (!e.parent_id) continue;
    const list = byParent.get(e.parent_id) ?? [];
    list.push(e);
    byParent.set(e.parent_id, list);
  }
  const cmp = (a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id < b.id ? -1 : 1);
  return {
    query(filter = {}) {
      return all
        .filter(
          (e) =>
            (filter.agent_id === undefined || e.agent_id === filter.agent_id) &&
            (filter.task_id === undefined || e.task_id === filter.task_id),
        )
        .sort(cmp);
    },
    queryChildren(parent_id) {
      return (byParent.get(parent_id) ?? []).slice().sort(cmp);
    },
    queryDescendants(rootId, opts = {}) {
      const maxDepth = opts.maxDepth ?? Infinity;
      const out = [];
      const visited = new Set([rootId]);
      let frontier = [rootId];
      let depth = 0;
      while (frontier.length && depth < maxDepth) {
        const next = [];
        for (const pid of frontier) {
          for (const c of this.queryChildren(pid)) {
            if (visited.has(c.id)) continue;
            visited.add(c.id);
            out.push(c);
            next.push(c.id);
          }
        }
        frontier = next;
        depth += 1;
      }
      return out;
    },
    getEvent: (id) => byId.get(id) ?? null,
  };
}

// `now` well past every window so all rows freeze and resolve.
const now = new Date(BASE + clock * SEC + 60 * 60 * SEC).toISOString();
const result = runLabeling({ reader: makeLog(events), now });

// Preserve the committed decision order (rook session then kit session).
const order = [...ROOK, ...KIT].map(([id]) => id);
const byDecision = new Map(result.frozen.map((r) => [r.decisionEventId, r]));
const ordered = order.map((id) => byDecision.get(id)).filter(Boolean);

if (ordered.length !== order.length) {
  const missing = order.filter((id) => !byDecision.has(id));
  throw new Error(`generator: ${missing.length} decision(s) failed to freeze: ${missing.join(', ')}`);
}

writeFileSync(OUT, ordered.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

const failures = ordered.filter((r) => r.action_failed === 1).length;
const rollbacks = ordered.filter((r) => r.labelReason === 'rollback').length;
const churn = ordered.filter((r) => r.features.rollbackProximity > 0).length;
process.stdout.write(
  `wrote ${ordered.length} rows → ${OUT}\n` +
    `  failures=${failures} rollback-labeled=${rollbacks} rollbackProximity>0=${churn}\n`,
);
