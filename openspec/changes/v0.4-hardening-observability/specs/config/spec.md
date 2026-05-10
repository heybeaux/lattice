# Delta for Developer Config System

## ADDED Requirements

### Requirement: Config File Auto-Discovery
The system SHALL automatically discover and load a Lattice config file from the working directory.

#### Scenario: Config file is auto-discovered
- GIVEN a file named `lattice.config.{js,yaml,toml,json}` exists in `process.cwd()`
- WHEN `createConfig()` is called without arguments
- THEN the file is loaded and parsed
- AND the config is validated against the schema
- AND invalid configs throw a `ConfigValidationError`

#### Scenario: Config file priority
- GIVEN multiple config files exist in the same directory
- WHEN `createConfig()` is called
- THEN files are tried in order: `lattice.config.js`, `lattice.config.yaml`, `lattice.config.toml`, `lattice.config.json`
- AND the first found file is loaded

#### Scenario: Config file path is explicit
- GIVEN a config file at a custom path
- WHEN `createConfig('/path/to/custom.config.js')` is called
- THEN that file is loaded
- AND auto-discovery is skipped

### Requirement: Config Schema Validation
The system SHALL validate config files against a known schema and provide actionable error messages.

#### Scenario: Valid config loads
- GIVEN a config with valid fields
- WHEN `createConfig()` is called
- THEN the config object is returned with defaults applied

#### Scenario: Invalid config rejects
- GIVEN a config with `circuitBreaker.l3ConfidenceThreshold: 1.5` (out of range)
- WHEN `createConfig()` is called
- THEN a `ConfigValidationError` is thrown
- AND the error message includes: field name, expected range, actual value

#### Scenario: Config defaults are applied
- GIVEN a config with only `circuitBreaker.tier: 'L1+L2'`
- WHEN `createConfig()` is called
- THEN unspecified fields use defaults: `l3ConfidenceThreshold: 0.7`, `l2Threshold: 0.85`, etc.

### Requirement: Programmatic Config Override
The system SHALL allow programmatic values to override config file values.

#### Scenario: Programmatic values override file
- GIVEN a config file with `circuitBreaker.tier: 'L1'`
- WHEN `createConfig({ circuitBreaker: { tier: 'L1+L3' } })` is called
- THEN the programmatic value takes precedence
- AND all other file values are preserved

## ADDED Types

```typescript
interface LatticeConfig {
  circuitBreaker: {
    tier: 'L1' | 'L1+L2' | 'L1+L3' | 'L1+L2+L3' | 'auto';
    l2Threshold?: number;
    l3ConfidenceThreshold?: number;
    l3EscalationThreshold?: number;
    failureThreshold?: number;
    recoveryTimeoutMs?: number;
    persist?: {
      backend: 'json' | 'sqlite';
      path: string;
      syncIntervalMs?: number;
    };
  };
  observability: {
    jsonLinePath?: string;
    otlpExporter?: {
      endpoint: string;
      protocol: 'http' | 'grpc';
    };
  };
  audit: {
    logPath?: string;
    retentionDays?: number;
    algorithm?: 'sha256' | 'sha512';
  };
  redaction: {
    sensitivityLevel: 'low' | 'medium' | 'high';
    additionalPaths?: string[];
  };
}
```
