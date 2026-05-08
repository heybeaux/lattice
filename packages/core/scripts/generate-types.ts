#!/usr/bin/env node
/**
 * Generate TypeScript types from the State Contract JSON Schema IDL.
 *
 * This script reads the canonical JSON Schema and generates TypeScript
 * type definitions. Run after any schema changes to keep types in sync.
 *
 * Usage: npx tsx scripts/generate-types.ts
 */

import { compileFromFile } from 'json-schema-to-typescript';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '../src/schema/contract.schema.json');
const outputPath = join(__dirname, '../src/schema/generated-types.ts');

async function generate() {
  console.log('Generating TypeScript types from JSON Schema IDL...');

  const ts = await compileFromFile(schemaPath, {
    bannerComment: `/**
 * Auto-generated TypeScript types from the State Contract JSON Schema IDL.
 * DO NOT EDIT — run \`npx tsx scripts/generate-types.ts\` to regenerate.
 *
 * Source: src/schema/contract.schema.json
 * Schema: https://lattice.dev/schemas/state-contract/v0.1.0.json
 */`,
    style: {
      singleQuote: true,
      semi: true,
  },
    unknownAny: false,
    format: true,
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, ts);
  console.log(`✓ Generated ${outputPath}`);
}

generate().catch(err => {
  console.error('Failed to generate types:', err);
  process.exit(1);
});
