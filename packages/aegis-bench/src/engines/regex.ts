/**
 * Engine configs (the three columns of every table, spec §2.2) plus the `none` baseline.
 *
 * All three real configs wrap @heybeaux/lattice-aegis `evaluate`:
 *   - `regex`            : evaluate the call as-is, no prediction (AutoHarness parity).
 *   - `regex+decode`     : also evaluate decoded candidates; take strictest verdict.
 *   - `regex+decode+awm` : same, plus feed a synthetic Prediction into opts.prediction.
 *
 * `none` is the raw-model baseline (no harness) — modeled only for the tool-use axis; it
 * never intervenes.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  evaluate,
  loadPack,
  type CompiledRule,
  type Evaluation,
  type GateAction,
  type Prediction,
  type RulePack,
  type ToolCall,
} from '@heybeaux/lattice-aegis';
import { decodeCommand } from './decode.js';

export type ConfigName = 'none' | 'regex' | 'regex+decode' | 'regex+decode+awm';

export const REAL_CONFIGS: readonly ConfigName[] = [
  'regex',
  'regex+decode',
  'regex+decode+awm',
] as const;

export const ALL_CONFIGS: readonly ConfigName[] = [
  'none',
  'regex',
  'regex+decode',
  'regex+decode+awm',
] as const;

const ACTION_RANK: Record<GateAction, number> = { allow: 0, ask: 1, deny: 2 };
function strictest(a: Evaluation, b: Evaluation): Evaluation {
  return ACTION_RANK[a.action] >= ACTION_RANK[b.action] ? a : b;
}

/** Resolve the shipped rule packs from the installed @heybeaux/lattice-aegis package. */
function rulepackDir(): string {
  // The aegis package ships rulepacks/ alongside dist/. The package's exports map only
  // declares an `import` condition, so import.meta.resolve / createRequire().resolve are
  // both blocked under vitest's SSR transform. Instead, walk up from this module looking
  // for node_modules/@heybeaux/lattice-aegis/rulepacks (the workspace symlink target).
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, 'node_modules', '@heybeaux', 'lattice-aegis', 'rulepacks');
    if (existsSync(cand)) return cand;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate @heybeaux/lattice-aegis/rulepacks from ' + import.meta.url);
}

const PACK_FILES = ['bash.json', 'file.json', 'injection.json', 'pii.json', 'secrets.json'];

/** Load + compile all shipped rule packs once. */
export function loadAllRules(): CompiledRule[] {
  const dir = rulepackDir();
  const compiled: CompiledRule[] = [];
  for (const file of PACK_FILES) {
    const pack = JSON.parse(readFileSync(join(dir, file), 'utf8')) as RulePack;
    compiled.push(...loadPack(pack));
  }
  return compiled;
}

/** Evaluate a call under `regex` (no decode, no prediction). */
export function evalRegex(call: ToolCall, rules: CompiledRule[]): Evaluation {
  return evaluate(call, rules);
}

/** Evaluate under `regex+decode`: original + every decoded candidate, strictest wins. */
export function evalRegexDecode(call: ToolCall, rules: CompiledRule[]): Evaluation {
  let best = evaluate(call, rules);
  if (call.command) {
    for (const { candidate } of decodeCommand(call.command)) {
      const decodedCall: ToolCall = { ...call, command: candidate };
      best = strictest(best, evaluate(decodedCall, rules));
    }
  }
  return best;
}

/** Evaluate under `regex+decode+awm`: decode path + a synthetic prediction overlay. */
export function evalRegexDecodeAwm(
  call: ToolCall,
  rules: CompiledRule[],
  prediction: Prediction | undefined,
): Evaluation {
  // Start from the decode result, then re-evaluate the original call WITH the prediction
  // so the predictor can escalate even when no rule (decoded or not) matched.
  const decoded = evalRegexDecode(call, rules);
  const withPred = evaluate(call, rules, prediction ? { prediction } : {});
  return strictest(decoded, withPred);
}
