/**
 * AutoHarness PARITY harness.
 *
 * Replays the conformance cases extracted (via AST) from AutoHarness's OWN
 * `tests/test_risk.py` — the (tool input -> expected RiskLevel) risk corpus — through
 * OUR ported engine (`@heybeaux/lattice-aegis` `evaluate`, the same call the Sonder hook
 * makes with `preprocess: true`). Records pass/fail per case so we can make an honest
 * "Aegis matches X% of AutoHarness's risk suite" claim.
 *
 * The cases are DATA, lifted verbatim from their source — see
 * `scripts/extract-autoharness-cases.py` / the committed fixture. Nothing here is
 * hand-authored corpus.
 *
 * Comparison layer: AutoHarness's `test_risk.py` asserts on `RiskAssessment.level`
 * (a RiskLevel severity: low|medium|high|critical). Our engine emits an `Evaluation`
 * with `matches[].severity`; our equivalent of "level" is the MAX severity across hits
 * (or `low` when nothing matches — the same floor AutoHarness uses for a clean call).
 * So we compare THEIR expected RiskLevel against OUR max-severity. This is the
 * apples-to-apples severity comparison; the allow/ask/deny mapping differs between the
 * two projects' constitutions and is deliberately NOT the parity axis here.
 */

import {
  evaluate,
  type CompiledRule,
  type Rule,
  type Severity,
  type ToolCall,
} from '@heybeaux/lattice-aegis';
import { loadAllRules } from './engines/regex.js';
import { loadPack } from '@heybeaux/lattice-aegis';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

const SEVERITY_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** One case as extracted from AutoHarness tests/test_risk.py. */
export interface RawCase {
  id: string;
  kind: 'toolcall' | 'content' | null;
  tool_name: string | null;
  tool_input: Record<string, unknown> | null;
  content: string | null;
  expected_levels: RiskLevel[];
  custom_rules: Array<Record<string, unknown>> | null;
  add_rule: Record<string, unknown> | null;
  expect_error: boolean | null;
}

export type ExclusionReason = string;

export interface CaseResult {
  id: string;
  status: 'pass' | 'fail' | 'excluded';
  /** For applicable cases. */
  expected?: RiskLevel[];
  actual?: RiskLevel;
  /** Which tool/input we fed our engine (for divergence reporting). */
  input?: { tool: string; command?: string; paths?: string[]; content?: string };
  exclusionReason?: ExclusionReason;
}

export interface ParityReport {
  source: string;
  sourceSha: string;
  totalExtracted: number;
  applicable: number;
  excluded: number;
  passed: number;
  failed: number;
  parityPct: number;
  results: CaseResult[];
}

/**
 * Map an AutoHarness tool_name to our engine's tool-name convention.
 * AutoHarness aliases: bash/shell/terminal -> bash category; Write/Edit/file_write -> file_write.
 * Our rule packs use Claude Code names: Bash, Write, Edit, Read.
 */
function mapToolName(name: string): string {
  const n = name.toLowerCase();
  if (['bash', 'shell', 'terminal'].includes(n)) return 'Bash';
  if (['file_write', 'write', 'edit'].includes(n)) return 'Write';
  if (['file_read', 'read'].includes(n)) return 'Read';
  return name;
}

/**
 * Build the ToolCall(s) we feed our engine for a given case + tool name. Returns an array
 * because some AutoHarness tests loop over several tool-name aliases and assert the same
 * expectation for each (test_tool_name_aliases, test_file_write_alias).
 */
function buildCalls(c: RawCase): ToolCall[] {
  if (c.kind === 'content') {
    // classify_content(str): a raw string scanned for secrets/PII. Our content-target
    // rules applyTo Write/Edit, so model it as a Write whose content is the string.
    return [{ tool: 'Write', content: c.content ?? '' }];
  }

  const input = c.tool_input ?? {};
  const command = typeof input.command === 'string' ? input.command : undefined;
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;

  // Determine the set of tool names this case exercises.
  let names: string[];
  if (c.tool_name) {
    names = [c.tool_name];
  } else if (c.id.includes('test_tool_name_aliases')) {
    names = ['bash', 'Bash', 'shell', 'terminal'];
  } else if (c.id.includes('test_file_write_alias')) {
    names = ['Write', 'Edit', 'file_write'];
  } else {
    names = ['bash'];
  }

  return names.map((rawName) => {
    const tool = mapToolName(rawName);
    const call: ToolCall = { tool };
    if (command !== undefined) call.command = command;
    if (filePath !== undefined) call.paths = [filePath];
    // Some content-bearing inputs (file_write with content) — scan content too.
    if (typeof input.content === 'string') call.content = input.content;
    return call;
  });
}

/** Our engine's "level": the max severity across rule hits, or `low` if nothing matched. */
function ourLevel(call: ToolCall, rules: CompiledRule[]): RiskLevel {
  const ev = evaluate(call, rules, { preprocess: true });
  let max: RiskLevel = 'low';
  for (const m of ev.matches) {
    if (SEVERITY_RANK[m.severity as RiskLevel] > SEVERITY_RANK[max]) {
      max = m.severity as RiskLevel;
    }
  }
  return max;
}

/**
 * Compile a case's custom rules (constructor `custom_rules` or `add_custom_rule`) into our
 * rule-pack format and append them to the base rule set. AutoHarness custom-rule shape:
 *   { pattern, level, reason, tool }  (tool defaults to "*")
 */
function compileCustomRules(c: RawCase): CompiledRule[] {
  const specs: Array<Record<string, unknown>> = [];
  if (c.custom_rules) specs.push(...c.custom_rules);
  if (c.add_rule) specs.push(c.add_rule);
  if (specs.length === 0) return [];

  const rules: Rule[] = specs.map((s, i) => {
    const tool = typeof s.tool === 'string' ? s.tool : '*';
    const appliesTo = tool === '*' ? ['*'] : [mapToolName(tool)];
    return {
      id: `custom.${c.id}.${i}`,
      category: 'bash',
      severity: s.level as Severity,
      description: typeof s.reason === 'string' ? s.reason : 'custom rule',
      match: { kind: 'regex', pattern: String(s.pattern), target: 'command' },
      appliesTo,
    };
  });
  return loadPack({ packId: 'parity-custom', version: '0.0.0', rules });
}

const EXCLUSIONS: Record<string, ExclusionReason> = {
  // Framework-API validation tests: they exercise the Python RiskClassifier CONSTRUCTOR /
  // add_custom_rule input validation, not the risk corpus. Our engine is data-only (rules
  // are static JSON validated at load by loadPack); there is no runtime `mode`/level/regex
  // setter API to reject bad input the way their classifier does, so these have no analogue.
  'TestRiskClassifierMisc::test_invalid_mode_rejected':
    'Framework-API: tests RiskClassifier(mode=...) constructor validation; Aegis has no runtime mode param.',
  'TestCustomRules::test_invalid_level_rejected':
    'Framework-API: tests add_custom_rule() level validation; Aegis validates rules at JSON load, not via a runtime setter.',
  'TestCustomRules::test_invalid_regex_rejected':
    'Framework-API: tests add_custom_rule() regex validation; same — load-time concern, no runtime setter.',
};

export function runParity(cases: RawCase[], sourceSha: string): ParityReport {
  const baseRules = loadAllRules();
  const results: CaseResult[] = [];

  for (const c of cases) {
    const exclusion = EXCLUSIONS[c.id];
    if (exclusion) {
      results.push({ id: c.id, status: 'excluded', exclusionReason: exclusion });
      continue;
    }
    if (c.expected_levels.length === 0) {
      results.push({
        id: c.id,
        status: 'excluded',
        exclusionReason: 'No RiskLevel assertion extracted (not a classification case).',
      });
      continue;
    }

    const rules = [...baseRules, ...compileCustomRules(c)];
    const calls = buildCalls(c);

    // A case may exercise several tool aliases; ALL must match for the case to pass
    // (their tests assert the expectation for every alias in the loop).
    let actual: RiskLevel = 'low';
    let allPass = true;
    let failingInput: CaseResult['input'];
    for (const call of calls) {
      const lvl = ourLevel(call, rules);
      actual = lvl;
      const ok = c.expected_levels.includes(lvl);
      if (!ok) {
        allPass = false;
        failingInput = {
          tool: call.tool,
          command: call.command,
          paths: call.paths,
          content: call.content,
        };
        break;
      }
    }

    const first = calls[0];
    results.push({
      id: c.id,
      status: allPass ? 'pass' : 'fail',
      expected: c.expected_levels,
      actual,
      input:
        failingInput ?? {
          tool: first.tool,
          command: first.command,
          paths: first.paths,
          content: first.content,
        },
    });
  }

  const applicableResults = results.filter((r) => r.status !== 'excluded');
  const passed = applicableResults.filter((r) => r.status === 'pass').length;
  const failed = applicableResults.filter((r) => r.status === 'fail').length;
  const applicable = applicableResults.length;
  const excluded = results.length - applicable;

  return {
    source: 'AutoHarness tests/test_risk.py',
    sourceSha,
    totalExtracted: cases.length,
    applicable,
    excluded,
    passed,
    failed,
    parityPct: applicable > 0 ? (passed / applicable) * 100 : 0,
    results,
  };
}
