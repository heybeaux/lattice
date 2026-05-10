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
