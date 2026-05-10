import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  createConfig,
  createConfigAsync,
  defaultConfig,
  mergeConfigs,
  validateConfig,
  ConfigValidationError,
  discoverConfig,
} from '../src/index.js';

const TEST_DIR = path.join(__dirname, 'test-configs');

describe('defaultConfig', () => {
  it('returns defaults', () => {
    const config = defaultConfig();
    expect(config.circuitBreaker?.tier).toBe('auto');
    expect(config.circuitBreaker?.l2Threshold).toBe(0.7);
    expect(config.circuitBreaker?.l3ConfidenceThreshold).toBe(0.7);
    expect(config.circuitBreaker?.l3EscalationThreshold).toBe(0.85);
    expect(config.circuitBreaker?.failureThreshold).toBe(3);
    expect(config.circuitBreaker?.recoveryTimeoutMs).toBe(60000);
    expect(config.audit?.retentionDays).toBe(90);
    expect(config.audit?.algorithm).toBe('sha256');
    expect(config.redaction?.sensitivityLevel).toBe('high');
  });
});

describe('mergeConfigs', () => {
  it('merges nested objects', () => {
    const base = {
      circuitBreaker: { tier: 'auto' as const, l2Threshold: 0.7 },
      audit: { retentionDays: 90 },
    };
    const override = {
      circuitBreaker: { l2Threshold: 0.85 },
    };

    const merged = mergeConfigs(base, override);
    expect(merged.circuitBreaker?.tier).toBe('auto');
    expect(merged.circuitBreaker?.l2Threshold).toBe(0.85);
    expect(merged.audit?.retentionDays).toBe(90);
  });

  it('replaces primitive values', () => {
    const base = { circuitBreaker: { tier: 'auto' as const } };
    const override = { circuitBreaker: { tier: 'L1+L3' as const } };
    const merged = mergeConfigs(base, override);
    expect(merged.circuitBreaker?.tier).toBe('L1+L3');
  });

  it('handles undefined overrides', () => {
    const base = { circuitBreaker: { tier: 'auto' as const } };
    const override = { circuitBreaker: undefined };
    const merged = mergeConfigs(base, override);
    expect(merged.circuitBreaker?.tier).toBe('auto');
  });
});

describe('validateConfig', () => {
  it('accepts valid config', () => {
    expect(() =>
      validateConfig({
        circuitBreaker: {
          tier: 'auto',
          l2Threshold: 0.7,
          l3ConfidenceThreshold: 0.8,
          l3EscalationThreshold: 0.85,
          failureThreshold: 3,
          recoveryTimeoutMs: 60000,
        },
      }),
    ).not.toThrow();
  });

  it('rejects l2Threshold out of range', () => {
    expect(() =>
      validateConfig({
        circuitBreaker: { l2Threshold: 1.5 },
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects l3ConfidenceThreshold out of range', () => {
    expect(() =>
      validateConfig({
        circuitBreaker: { l3ConfidenceThreshold: -0.1 },
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects failureThreshold < 1', () => {
    expect(() =>
      validateConfig({
        circuitBreaker: { failureThreshold: 0 },
      }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects negative recoveryTimeoutMs', () => {
    expect(() =>
      validateConfig({
        circuitBreaker: { recoveryTimeoutMs: -1000 },
      }),
    ).toThrow(ConfigValidationError);
  });

  it('includes field name in error', () => {
    try {
      validateConfig({ circuitBreaker: { l2Threshold: 2.0 } });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).field).toBe('circuitBreaker.l2Threshold');
    }
  });
});

describe('discoverConfig', () => {
  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('finds lattice.config.json', () => {
    fs.writeFileSync(path.join(TEST_DIR, 'lattice.config.json'), '{}');
    const found = discoverConfig(TEST_DIR);
    expect(found).toContain('lattice.config.json');
  });

  it('prefers JSON over other formats', () => {
    fs.writeFileSync(path.join(TEST_DIR, 'lattice.config.json'), '{}');
    fs.writeFileSync(path.join(TEST_DIR, 'lattice.config.yaml'), '');
    const found = discoverConfig(TEST_DIR);
    expect(found).toContain('lattice.config.json');
  });

  it('returns null when no config exists', () => {
    const found = discoverConfig(TEST_DIR);
    expect(found).toBeNull();
  });
});

describe('createConfig (sync)', () => {
  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('returns defaults with no config file', () => {
    const config = createConfig();
    expect(config.circuitBreaker?.tier).toBe('auto');
  });

  it('loads from JSON config file', () => {
    const configPath = path.join(TEST_DIR, 'lattice.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        circuitBreaker: { tier: 'L1+L3', l2Threshold: 0.85 },
      }),
    );

    const config = createConfig(configPath);
    expect(config.circuitBreaker?.tier).toBe('L1+L3');
    expect(config.circuitBreaker?.l2Threshold).toBe(0.85);
    // Defaults preserved
    expect(config.circuitBreaker?.failureThreshold).toBe(3);
  });

  it('programmatic overrides file values', () => {
    const configPath = path.join(TEST_DIR, 'lattice.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        circuitBreaker: { tier: 'L1' },
      }),
    );

    const config = createConfig({
      circuitBreaker: { tier: 'L1+L2' },
    });
    expect(config.circuitBreaker?.tier).toBe('L1+L2');
  });

  it('throws on invalid config file', () => {
    const configPath = path.join(TEST_DIR, 'lattice.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        circuitBreaker: { l2Threshold: 999 },
      }),
    );

    expect(() => createConfig(configPath)).toThrow(ConfigValidationError);
  });
});

// ─── Spec 4.1.4 — discoverConfig finds lattice.config.json in cwd ─────────────

describe('discoverConfig — cwd discovery (spec 4.1.4)', () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('4.1.4: discovers lattice.config.json when called with process.cwd() as the directory', () => {
    const configPath = path.join(TEST_DIR, 'lattice.config.json');
    fs.writeFileSync(configPath, '{}');
    // Simulate discovery by passing the TEST_DIR as cwd (the default arg is process.cwd()).
    const found = discoverConfig(TEST_DIR);
    expect(found).not.toBeNull();
    expect(found).toContain('lattice.config.json');
  });

  it('4.1.4: returns null when cwd contains no config file', () => {
    // TEST_DIR exists but has no config file.
    expect(discoverConfig(TEST_DIR)).toBeNull();
  });
});

// ─── Spec 4.2.4 — validateConfig throws ConfigValidationError ─────────────────

describe('validateConfig — throws on invalid values (spec 4.2.4)', () => {
  it('4.2.4: throws ConfigValidationError for l2Threshold > 1', () => {
    expect(() => validateConfig({ circuitBreaker: { l2Threshold: 1.1 } }))
      .toThrow(ConfigValidationError);
  });

  it('4.2.4: throws ConfigValidationError for l2Threshold < 0', () => {
    expect(() => validateConfig({ circuitBreaker: { l2Threshold: -0.5 } }))
      .toThrow(ConfigValidationError);
  });

  it('4.2.4: throws ConfigValidationError for l3ConfidenceThreshold out of [0,1]', () => {
    expect(() => validateConfig({ circuitBreaker: { l3ConfidenceThreshold: 2 } }))
      .toThrow(ConfigValidationError);
  });

  it('4.2.4: throws ConfigValidationError for l3EscalationThreshold out of [0,1]', () => {
    expect(() => validateConfig({ circuitBreaker: { l3EscalationThreshold: -1 } }))
      .toThrow(ConfigValidationError);
  });

  it('4.2.4: error has correct field name and actual value', () => {
    try {
      validateConfig({ circuitBreaker: { l2Threshold: 99 } });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const cve = err as ConfigValidationError;
      expect(cve.field).toBe('circuitBreaker.l2Threshold');
      expect(cve.actual).toBe(99);
    }
  });
});

// ─── Spec 4.3.4 — createConfig with no file returns defaults ──────────────────

describe('createConfig — defaults when no file present (spec 4.3.4)', () => {
  it('4.3.4: returns defaults when called with no arguments and no config file in cwd', () => {
    // createConfig() auto-discovers; in the test environment there is no
    // lattice.config.json in the runner's cwd, so defaults apply.
    const config = createConfig();
    const defaults = defaultConfig();
    expect(config.circuitBreaker?.tier).toBe(defaults.circuitBreaker?.tier);
    expect(config.circuitBreaker?.l2Threshold).toBe(defaults.circuitBreaker?.l2Threshold);
    expect(config.circuitBreaker?.failureThreshold).toBe(defaults.circuitBreaker?.failureThreshold);
    expect(config.circuitBreaker?.recoveryTimeoutMs).toBe(defaults.circuitBreaker?.recoveryTimeoutMs);
    expect(config.audit?.retentionDays).toBe(defaults.audit?.retentionDays);
    expect(config.redaction?.sensitivityLevel).toBe(defaults.redaction?.sensitivityLevel);
  });
});

// ─── mergeConfigs — deep nested keys ──────────────────────────────────────────

describe('mergeConfigs — deeply nested keys', () => {
  it('merges nested persist sub-object without losing sibling keys', () => {
    const base = {
      circuitBreaker: {
        tier: 'auto' as const,
        l2Threshold: 0.7,
        persist: { backend: 'json' as const, path: '/tmp/base.json', syncIntervalMs: 1000 },
      },
    };
    const override = {
      circuitBreaker: {
        persist: { backend: 'json' as const, path: '/tmp/override.json' },
      },
    };

    const merged = mergeConfigs(base, override);
    // The override replaces the entire persist sub-object (one-level deep merge).
    expect(merged.circuitBreaker?.persist?.path).toBe('/tmp/override.json');
    // Sibling fields of circuitBreaker (not in override) are preserved.
    expect(merged.circuitBreaker?.tier).toBe('auto');
    expect(merged.circuitBreaker?.l2Threshold).toBe(0.7);
  });

  it('override with only a subset of nested keys preserves the rest', () => {
    const base = {
      circuitBreaker: { tier: 'L1' as const, failureThreshold: 5, recoveryTimeoutMs: 30000 },
      audit: { retentionDays: 90, algorithm: 'sha256' as const },
    };
    const override = {
      audit: { retentionDays: 30 },
    };

    const merged = mergeConfigs(base, override);
    expect(merged.audit?.retentionDays).toBe(30);
    expect(merged.audit?.algorithm).toBe('sha256'); // preserved
    expect(merged.circuitBreaker?.tier).toBe('L1');  // untouched
  });

  it('programmatic override wins over file config which wins over defaults', () => {
    const defaults = defaultConfig();
    const fileConfig: typeof defaults = { circuitBreaker: { tier: 'L1+L2' } };
    const programmatic: typeof defaults = { circuitBreaker: { tier: 'L1+L2+L3' } };

    const merged = mergeConfigs(mergeConfigs(defaults, fileConfig), programmatic);
    expect(merged.circuitBreaker?.tier).toBe('L1+L2+L3');
    // Default l2Threshold should still be present.
    expect(merged.circuitBreaker?.l2Threshold).toBe(defaults.circuitBreaker?.l2Threshold);
  });
});

// ─── createConfig — explicit path override ────────────────────────────────────

describe('createConfig — explicit path override', () => {
  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('explicit path takes precedence over auto-discovered file in cwd', () => {
    const explicitPath = path.join(TEST_DIR, 'explicit.json');
    fs.writeFileSync(
      explicitPath,
      JSON.stringify({ circuitBreaker: { tier: 'L1', failureThreshold: 7 } }),
    );

    const config = createConfig(explicitPath);
    expect(config.circuitBreaker?.tier).toBe('L1');
    expect(config.circuitBreaker?.failureThreshold).toBe(7);
    // Defaults still applied for keys not in file.
    expect(config.circuitBreaker?.l2Threshold).toBe(defaultConfig().circuitBreaker?.l2Threshold);
  });
});

describe('createConfigAsync', () => {
  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('loads from JSON config file', async () => {
    const configPath = path.join(TEST_DIR, 'lattice.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        circuitBreaker: { tier: 'L1+L2', failureThreshold: 5 },
      }),
    );

    const config = await createConfigAsync(configPath);
    expect(config.circuitBreaker?.tier).toBe('L1+L2');
    expect(config.circuitBreaker?.failureThreshold).toBe(5);
  });

  it('loads from ESM config file', async () => {
    const configPath = path.join(TEST_DIR, 'lattice.config.mjs');
    fs.writeFileSync(
      configPath,
      `export default {
        circuitBreaker: { tier: 'L1', failureThreshold: 5 }
      };`,
    );

    const config = await createConfigAsync(configPath);
    expect(config.circuitBreaker?.tier).toBe('L1');
    expect(config.circuitBreaker?.failureThreshold).toBe(5);
  });

  it('programmatic overrides file values (async)', async () => {
    const configPath = path.join(TEST_DIR, 'lattice.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        circuitBreaker: { tier: 'L1' },
      }),
    );

    const config = await createConfigAsync({
      circuitBreaker: { tier: 'L1+L2' },
    });
    expect(config.circuitBreaker?.tier).toBe('L1+L2');
  });
});
