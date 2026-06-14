/**
 * Three-layer rule cascade: builtin -> user -> project (project wins).
 * Merge by (packId is provenance; rule.id is identity). Higher layers override
 * matching fields or add new ids. No delete — disable via enabled:false.
 *
 * Strictness invariant: a higher layer may tighten freely. LOWERING a builtin's
 * strictness (disabling, or reducing severity) requires allowDowngrade:true, else
 * the loader keeps the stricter builtin and warns.
 * See docs/aegis-rulepack-spec-2026-06-14.md §3.
 */

import type { Rule, Severity } from '../types.js';

const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function isEnabled(r: Rule): boolean {
  return r.enabled !== false;
}

/** True if `overlay` makes `base` less strict (disables it, or lowers severity). */
function isDowngrade(base: Rule, overlay: Rule): boolean {
  if (isEnabled(base) && !isEnabled(overlay)) return true;
  if (SEVERITY_RANK[overlay.severity] < SEVERITY_RANK[base.severity]) return true;
  return false;
}

export interface MergeWarning {
  ruleId: string;
  message: string;
}

export interface MergeResult {
  rules: Rule[];
  warnings: MergeWarning[];
}

/**
 * Merge layers in increasing precedence. Pass [builtin, user, project].
 * Returns the effective rule set plus any strictness warnings.
 */
export function mergeLayers(layers: Rule[][]): MergeResult {
  const effective = new Map<string, Rule>();
  const warnings: MergeWarning[] = [];

  for (const layer of layers) {
    for (const overlay of layer) {
      const base = effective.get(overlay.id);
      if (!base) {
        effective.set(overlay.id, overlay);
        continue;
      }
      if (isDowngrade(base, overlay) && overlay.allowDowngrade !== true) {
        warnings.push({
          ruleId: overlay.id,
          message: `overlay tried to weaken rule without allowDowngrade:true — keeping stricter builtin`,
        });
        // Keep the stricter base; ignore the weakening overlay.
        continue;
      }
      // Deep-merge: overlay fields win over base.
      effective.set(overlay.id, { ...base, ...overlay });
    }
  }

  return { rules: [...effective.values()], warnings };
}
