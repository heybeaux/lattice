// Throwaway verifier: loads every JSON rulepack and runs it through the real
// engine loader (flag-restriction + compile + ReDoS budget). Reports per-pack
// and per-rule results. Exit 1 on any failure.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadPack } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'rulepacks');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

let total = 0;
let failures = 0;
const perCategory = {};

for (const file of files) {
  const raw = readFileSync(join(dir, file), 'utf8');
  let pack;
  try {
    pack = JSON.parse(raw);
  } catch (e) {
    console.error(`JSON PARSE FAIL ${file}: ${e.message}`);
    failures++;
    continue;
  }
  // Per-rule new RegExp sanity (independent of loader), then full loader.
  for (const r of pack.rules) {
    if (r.match.kind === 'regex') {
      try {
        new RegExp(r.match.pattern, r.match.flags || '');
      } catch (e) {
        console.error(`REGEX FAIL ${file} ${r.id}: ${e.message}`);
        failures++;
      }
    }
    perCategory[r.category] = (perCategory[r.category] || 0) + 1;
    total++;
  }
  try {
    const compiled = loadPack(pack);
    console.log(`OK  ${file.padEnd(16)} packId=${pack.packId} rules=${compiled.length}`);
  } catch (e) {
    console.error(`LOADER FAIL ${file}: ${e.message}`);
    failures++;
  }
}

console.log('\n--- per-category counts ---');
for (const [c, n] of Object.entries(perCategory).sort()) {
  console.log(`  ${c.padEnd(12)} ${n}`);
}
console.log(`  TOTAL        ${total}`);
console.log(failures ? `\nFAILURES: ${failures}` : '\nALL GREEN');
process.exit(failures ? 1 : 0);
