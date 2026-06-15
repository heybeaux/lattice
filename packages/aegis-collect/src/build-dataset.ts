#!/usr/bin/env node
/**
 * build-dataset — join decisions.jsonl ⨝ outcomes.jsonl → dataset-live.jsonl.
 *
 * Join key and reliability:
 *   PRIMARY:  tool_use_id (exact match). Reliable when Claude Code provides it.
 *   FALLBACK: (tool, timestamp ±FUZZY_WINDOW_MS). Fuzzy joins are flagged
 *             separately and gated by TRUST_FUZZY_JOIN env var. Under parallel
 *             tool execution, a fuzzy join may match the wrong outcome — in that
 *             case action_failed is null (truth-above-all: never guess).
 *
 * Output: one DatasetRow per decision. If no outcome can be confidently joined,
 * action_failed = null and joinMethod = 'none'. Rows with action_failed = null
 * are INCLUDED in the output (so we can track join coverage) but must be
 * EXCLUDED from AWM training (filter before refit).
 *
 * Run: pnpm --filter @heybeaux/aegis-collect build-dataset
 * Or:  node dist/build-dataset.js
 *
 * Env:
 *   AEGIS_COLLECT_DIR  — override data dir (default ~/.aegis)
 *   TRUST_FUZZY_JOIN   — set to '1' to allow fuzzy joins (default: off)
 *   FUZZY_WINDOW_MS    — fuzzy match window in ms (default: 5000)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatasetRow, DecisionRow, OutcomeRow } from './types.js';

function collectDir(): string {
  return process.env['AEGIS_COLLECT_DIR'] ?? join(homedir(), '.aegis');
}

function parseJsonlFile<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const rows: T[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      rows.push(JSON.parse(t) as T);
    } catch {
      // Skip malformed lines.
    }
  }
  return rows;
}

function buildDataset(): void {
  const dir = collectDir();
  const decisionsPath = join(dir, 'decisions.jsonl');
  const outcomesPath = join(dir, 'outcomes.jsonl');
  const datasetPath = join(dir, 'dataset-live.jsonl');

  const trustFuzzy = process.env['TRUST_FUZZY_JOIN'] === '1';
  const fuzzyWindowMs = parseInt(process.env['FUZZY_WINDOW_MS'] ?? '5000', 10);

  const decisions = parseJsonlFile<DecisionRow>(decisionsPath);
  const outcomes = parseJsonlFile<OutcomeRow>(outcomesPath);

  // Build indexes for fast lookups.
  // Exact index: toolUseId → OutcomeRow[]
  const byToolUseId = new Map<string, OutcomeRow[]>();
  for (const outcome of outcomes) {
    if (outcome.toolUseId) {
      const bucket = byToolUseId.get(outcome.toolUseId) ?? [];
      bucket.push(outcome);
      byToolUseId.set(outcome.toolUseId, bucket);
    }
  }

  // Fuzzy index: group outcomes by tool name for fast pre-filter.
  const byTool = new Map<string, OutcomeRow[]>();
  for (const outcome of outcomes) {
    const bucket = byTool.get(outcome.tool) ?? [];
    bucket.push(outcome);
    byTool.set(outcome.tool, bucket);
  }

  const datasetRows: DatasetRow[] = [];

  for (const decision of decisions) {
    let action_failed: 0 | 1 | null = null;
    let joinMethod: DatasetRow['joinMethod'] = 'none';
    let outcomeTimestamp: string | undefined;

    // 1. Try exact join on toolUseId.
    if (decision.toolUseId) {
      const matches = byToolUseId.get(decision.toolUseId) ?? [];
      if (matches.length === 1 && matches[0]) {
        const m = matches[0];
        action_failed = m.isError ? 1 : 0;
        joinMethod = 'exact';
        outcomeTimestamp = m.timestamp;
      } else if (matches.length > 1) {
        // Multiple outcomes for same toolUseId — ambiguous, null.
        action_failed = null;
        joinMethod = 'none';
      }
    }

    // 2. Fuzzy join fallback (only when exact failed and TRUST_FUZZY_JOIN=1).
    if (joinMethod === 'none' && trustFuzzy) {
      const decTs = new Date(decision.timestamp).getTime();
      const candidates = (byTool.get(decision.tool) ?? []).filter((o) => {
        const diff = Math.abs(new Date(o.timestamp).getTime() - decTs);
        return diff <= fuzzyWindowMs;
      });

      if (candidates.length === 1 && candidates[0]) {
        const m = candidates[0];
        action_failed = m.isError ? 1 : 0;
        joinMethod = 'fuzzy';
        outcomeTimestamp = m.timestamp;
      } else if (candidates.length > 1) {
        // Ambiguous fuzzy match — null (truth-above-all: never guess).
        action_failed = null;
        joinMethod = 'none';
      }
      // candidates.length === 0: no match, action_failed stays null.
    }

    const row: DatasetRow = {
      decisionId: decision.decisionId,
      ...(outcomeTimestamp !== undefined ? { outcomeTimestamp } : {}),
      decision,
      action_failed,
      joinMethod,
    };

    datasetRows.push(row);
  }

  const lines = datasetRows.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(datasetPath, lines + (lines.length > 0 ? '\n' : ''), 'utf8');

  const exact = datasetRows.filter((r) => r.joinMethod === 'exact').length;
  const fuzzy = datasetRows.filter((r) => r.joinMethod === 'fuzzy').length;
  const none = datasetRows.filter((r) => r.joinMethod === 'none').length;
  const labeled = datasetRows.filter((r) => r.action_failed !== null).length;

  process.stdout.write(
    `[aegis-collect] build-dataset complete\n` +
      `  decisions:  ${decisions.length}\n` +
      `  outcomes:   ${outcomes.length}\n` +
      `  joined:     ${labeled} (exact=${exact}, fuzzy=${fuzzy})\n` +
      `  unjoinable: ${none} (action_failed=null)\n` +
      `  output:     ${datasetPath}\n`,
  );
}

try {
  buildDataset();
} catch (err) {
  process.stderr.write(`[aegis-collect] build-dataset error: ${String(err)}\n`);
  process.exit(1);
}
