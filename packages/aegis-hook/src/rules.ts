/**
 * Load + compile every rule pack shipped by @heybeaux/lattice-aegis.
 *
 * The aegis package ships its compiled rule packs as JSON under `rulepacks/`,
 * declared in its `files` array but NOT exposed via a package `exports` subpath.
 * That means `import.meta.resolve` / `createRequire().resolve` cannot reach the
 * JSON (and both are additionally blocked under vitest's SSR transform). The
 * robust approach — already proven in @heybeaux/aegis-bench — is to walk up from
 * this module looking for `node_modules/@heybeaux/lattice-aegis/rulepacks`, which
 * the pnpm workspace symlinks to the sibling package. No absolute path hardcoded.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadPack, type CompiledRule, type RulePack } from '@heybeaux/lattice-aegis';

/** The five builtin packs aegis ships (spec §rulepacks). */
const PACK_FILES = ['bash.json', 'file.json', 'injection.json', 'pii.json', 'secrets.json'];

/** Resolve the rulepacks dir off the installed @heybeaux/lattice-aegis package. */
function rulepackDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, 'node_modules', '@heybeaux', 'lattice-aegis', 'rulepacks');
    if (existsSync(cand)) return cand;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not locate @heybeaux/lattice-aegis/rulepacks from ' + import.meta.url,
  );
}

/** Module-level cache: compile the packs once per process; repeat calls are cheap. */
let cached: CompiledRule[] | undefined;

/**
 * Load + compile all five shipped rule packs and concatenate the compiled arrays.
 * Throws if a pack is missing or fails aegis's fail-closed loader validation.
 * The result is cached for the lifetime of the process.
 */
export function loadAllPacks(): CompiledRule[] {
  if (cached !== undefined) return cached;
  const dir = rulepackDir();
  const compiled: CompiledRule[] = [];
  for (const file of PACK_FILES) {
    const pack = JSON.parse(readFileSync(join(dir, file), 'utf8')) as RulePack;
    compiled.push(...loadPack(pack));
  }
  cached = compiled;
  return cached;
}
