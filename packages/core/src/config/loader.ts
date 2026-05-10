/**
 * Lattice configuration loader and validator.
 *
 * Auto-discovers `lattice.config.json` from cwd,
 * validates against the schema, and merges with defaults.
 *
 * JS/YAML/TOML config files are supported via async `loadConfigFile()`.
 */

import * as fs from 'fs';
import * as path from 'path';

const CONFIG_FILES = [
  'lattice.config.json',
  'lattice.config.yaml',
  'lattice.config.yml',
  'lattice.config.toml',
  'lattice.config.mjs',
  'lattice.config.cjs',
];

/**
 * Lattice configuration schema.
 */
export interface LatticeConfig {
  circuitBreaker?: {
    tier?: 'L1' | 'L1+L2' | 'L1+L3' | 'L1+L2+L3' | 'auto';
    l2Threshold?: number;
    l3ConfidenceThreshold?: number;
    l3EscalationThreshold?: number;
    failureThreshold?: number;
    recoveryTimeoutMs?: number;
    persist?: {
      backend?: 'json' | 'sqlite';
      path: string;
      syncIntervalMs?: number;
    };
  };
  observability?: {
    jsonLinePath?: string;
    otlpExporter?: {
      endpoint: string;
      protocol?: 'http' | 'grpc';
    };
  };
  audit?: {
    logPath?: string;
    retentionDays?: number;
    algorithm?: 'sha256' | 'sha512';
  };
  redaction?: {
    sensitivityLevel?: 'low' | 'medium' | 'high';
    additionalPaths?: string[];
  };
}

/**
 * Default configuration values.
 */
export function defaultConfig(): LatticeConfig {
  return {
    circuitBreaker: {
      tier: 'auto',
      l2Threshold: 0.7,
      l3ConfidenceThreshold: 0.7,
      l3EscalationThreshold: 0.85,
      failureThreshold: 3,
      recoveryTimeoutMs: 60_000,
    },
    audit: {
      retentionDays: 90,
      algorithm: 'sha256',
    },
    redaction: {
      sensitivityLevel: 'high',
    },
  };
}

/**
 * Deep merge two config objects.
 * Programmatic values override file values.
 */
export function mergeConfigs(base: LatticeConfig, override: LatticeConfig): LatticeConfig {
  const merged: LatticeConfig = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null) continue;

    if (typeof value === 'object' && !Array.isArray(value)) {
      merged[key as keyof LatticeConfig] = {
        ...((base as any)[key] || {}),
        ...(value as object),
      };
    } else {
      (merged as any)[key] = value;
    }
  }

  return merged;
}

/**
 * Validate a config object against known constraints.
 */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public field: string,
    public expected: string,
    public actual: unknown,
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export function validateConfig(config: LatticeConfig): void {
  const cb = config.circuitBreaker;
  if (!cb) return;

  if (cb.l2Threshold !== undefined && (cb.l2Threshold < 0 || cb.l2Threshold > 1)) {
    throw new ConfigValidationError(
      `circuitBreaker.l2Threshold must be between 0 and 1`,
      'circuitBreaker.l2Threshold',
      '0-1',
      cb.l2Threshold,
    );
  }

  if (cb.l3ConfidenceThreshold !== undefined && (cb.l3ConfidenceThreshold < 0 || cb.l3ConfidenceThreshold > 1)) {
    throw new ConfigValidationError(
      `circuitBreaker.l3ConfidenceThreshold must be between 0 and 1`,
      'circuitBreaker.l3ConfidenceThreshold',
      '0-1',
      cb.l3ConfidenceThreshold,
    );
  }

  if (cb.l3EscalationThreshold !== undefined && (cb.l3EscalationThreshold < 0 || cb.l3EscalationThreshold > 1)) {
    throw new ConfigValidationError(
      `circuitBreaker.l3EscalationThreshold must be between 0 and 1`,
      'circuitBreaker.l3EscalationThreshold',
      '0-1',
      cb.l3EscalationThreshold,
    );
  }

  if (cb.failureThreshold !== undefined && cb.failureThreshold < 1) {
    throw new ConfigValidationError(
      `circuitBreaker.failureThreshold must be >= 1`,
      'circuitBreaker.failureThreshold',
      '>=1',
      cb.failureThreshold,
    );
  }

  if (cb.recoveryTimeoutMs !== undefined && cb.recoveryTimeoutMs < 0) {
    throw new ConfigValidationError(
      `circuitBreaker.recoveryTimeoutMs must be >= 0`,
      'circuitBreaker.recoveryTimeoutMs',
      '>=0',
      cb.recoveryTimeoutMs,
    );
  }
}

/**
 * Discover a config file in the given directory.
 * Returns the path to the first found file, or null.
 */
export function discoverConfig(cwd: string = process.cwd()): string | null {
  for (const file of CONFIG_FILES) {
    const filePath = path.join(cwd, file);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

/**
 * Load and parse a JSON config file synchronously.
 */
function loadJsonFile(filePath: string): Record<string, unknown> {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Load and parse a config file asynchronously.
 * Supports JSON, YAML, TOML, and ESM/CJS JS files.
 */
export async function loadConfigFile(filePath: string): Promise<Record<string, unknown>> {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case '.json':
      return loadJsonFile(filePath);
    case '.mjs': {
      const mod = await import(filePath);
      return mod.default || mod;
    }
    case '.cjs': {
      const mod = require(filePath);
      return mod.default || mod;
    }
    case '.yaml':
    case '.yml': {
      try {
        const yaml = require('js-yaml');
        return yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      } catch {
        throw new Error('YAML config requires js-yaml. Install it: npm install js-yaml');
      }
    }
    case '.toml': {
      try {
        const toml = require('toml');
        return toml.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        throw new Error('TOML config requires toml. Install it: npm install toml');
      }
    }
    default:
      throw new Error(`Unsupported config file format: ${ext}`);
  }
}

/**
 * Create a validated Lattice configuration.
 *
 * @param configOrPath - Programmatic config override, or path to a JSON config file.
 *                       If omitted, auto-discovers `lattice.config.json` from cwd.
 * @returns Validated LatticeConfig with defaults applied
 *
 * For non-JSON config files (.yaml, .toml, .mjs, .cjs), use `await createConfigAsync()`.
 */
export function createConfig(configOrPath?: string | LatticeConfig): LatticeConfig {
  let fileConfig: LatticeConfig = {};

  // Load from file if path provided or auto-discover
  let configPath: string | null = null;
  if (typeof configOrPath === 'string') {
    configPath = configOrPath;
  } else if (configOrPath === undefined) {
    configPath = discoverConfig();
  }

  // Only support JSON synchronously
  if (configPath && configPath.endsWith('.json')) {
    fileConfig = loadJsonFile(configPath) as LatticeConfig;
  }

  // Merge: defaults <- file <- programmatic
  const programmatic = typeof configOrPath === 'object' ? configOrPath : {};
  const merged = mergeConfigs(mergeConfigs(defaultConfig(), fileConfig), programmatic);

  // Validate
  validateConfig(merged);

  return merged;
}

/**
 * Create a validated Lattice configuration from any config file format.
 * Async version supports YAML, TOML, ESM, and CJS in addition to JSON.
 */
export async function createConfigAsync(configOrPath?: string | LatticeConfig): Promise<LatticeConfig> {
  let fileConfig: LatticeConfig = {};

  let configPath: string | null = null;
  if (typeof configOrPath === 'string') {
    configPath = configOrPath;
  } else if (configOrPath === undefined) {
    configPath = discoverConfig();
  }

  if (configPath) {
    fileConfig = (await loadConfigFile(configPath)) as LatticeConfig;
  }

  const programmatic = typeof configOrPath === 'object' ? configOrPath : {};
  const merged = mergeConfigs(mergeConfigs(defaultConfig(), fileConfig), programmatic);

  validateConfig(merged);

  return merged;
}
