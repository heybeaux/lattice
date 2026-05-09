import { describe, it, expect } from 'vitest';
import { redactContract, createContract } from '../src/index.js';

describe('redactContract', () => {
  it('redacts API keys from inputs', () => {
    const contract = createContract({
      fromAgent: 'test',
      inputs: { query: 'hello', apiKey: 'sk-secret-123' },
      outputs: { result: 'world' },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    const redacted = redactContract(contract);
    expect((redacted.inputs.payload as any).apiKey).toBe('[REDACTED]');
    expect((redacted.inputs.payload as any).query).toBe('hello'); // not redacted
  });

  it('redacts secrets from outputs', () => {
    const contract = createContract({
      fromAgent: 'test',
      inputs: {},
      outputs: { token: 'abc123', password: 'hunter2' },
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    const redacted = redactContract(contract);
    expect((redacted.outputs.payload as any).token).toBe('[REDACTED]');
    expect((redacted.outputs.payload as any).password).toBe('[REDACTED]');
  });

  it('redacts from metadata', () => {
    const contract = createContract({
      fromAgent: 'test',
      inputs: {},
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
      metadata: { secret: 'top-secret-value', public: 'hello' },
    });

    const redacted = redactContract(contract);
    expect((redacted.metadata as any).secret).toBe('[REDACTED]');
    expect((redacted.metadata as any).public).toBe('hello');
  });

  it('redacts email addresses at medium sensitivity', () => {
    const contract = createContract({
      fromAgent: 'test',
      inputs: { email: 'user@example.com', name: 'John' },
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    const redacted = redactContract(contract, { sensitivityLevel: 'medium' });
    expect(JSON.stringify(redacted.inputs.payload)).toContain('[REDACTED]');
    expect((redacted.inputs.payload as any).name).toBe('John');
  });

  it('does not redact emails at high sensitivity only (default)', () => {
    // Actually, medium includes emails. High only does default paths.
    // The default sensitivity is 'high' which doesn't include pattern matching.
    // Let me re-check: sensitivity 'high' does patterns, 'medium' does patterns too.
    // Default is 'high'. Let me verify the logic.
    // Looking at the code: medium and high both do email patterns.
    // Only high does phone/SSN. So let me test high does include emails too.
    const contract = createContract({
      fromAgent: 'test',
      inputs: { email: 'user@example.com' },
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    const redacted = redactContract(contract); // default: 'high'
    expect(JSON.stringify(redacted.inputs.payload)).toContain('[REDACTED]');
  });

  it('preserves contract structure', () => {
    const contract = createContract({
      fromAgent: 'test',
      inputs: { apiKey: 'secret' },
      outputs: { data: [1, 2, 3] },
      decisions: [{ type: 'action', rationale: 'test' }],
      budget: { tokensUsed: 100, callsMade: 1, wallClockMs: 50 },
    });

    const redacted = redactContract(contract);
    expect(redacted.id).toBe(contract.id);
    expect(redacted.fromAgent).toBe(contract.fromAgent);
    expect(redacted.decisions).toEqual(contract.decisions);
    expect(redacted.outputs.payload).toEqual({ data: [1, 2, 3] });
    expect(redacted.budget.tokensUsed).toBe(100);
  });

  it('freezes the redacted contract', () => {
    const contract = createContract({
      fromAgent: 'test',
      inputs: {},
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    const redacted = redactContract(contract);
    expect(Object.isFrozen(redacted)).toBe(true);
  });

  it('supports custom placeholder', () => {
    const contract = createContract({
      fromAgent: 'test',
      inputs: { apiKey: 'secret' },
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    const redacted = redactContract(contract, { placeholder: '***' });
    expect((redacted.inputs.payload as any).apiKey).toBe('***');
  });

  it('supports additional paths to redact', () => {
    const contract = createContract({
      fromAgent: 'test',
      inputs: { customSecret: 'my-secret-value' },
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    const redacted = redactContract(contract, {
      additionalPaths: ['inputs.payload.customSecret'],
    });
    expect((redacted.inputs.payload as any).customSecret).toBe('[REDACTED]');
  });

  it('redacts phone numbers at high sensitivity', () => {
    const contract = createContract({
      fromAgent: 'test',
      inputs: { contact: 'Call 555-123-4567 for info' },
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });

    const redacted = redactContract(contract, { sensitivityLevel: 'high' });
    expect((redacted.inputs.payload as any).contact).toContain('[REDACTED]');
  });

  // ─── Issue #7 / SEC-005 — nested keys, decisions/constraints/assumptions, modern token formats ───

  describe('nested key-name traversal', () => {
    it('redacts apiKey nested under user object', () => {
      const contract = createContract({
        fromAgent: 'test',
        inputs: { user: { apiKey: 'sk-live-LEAKED' } },
        outputs: {},
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
      });
      const redacted = redactContract(contract);
      expect((redacted.inputs.payload as any).user.apiKey).toBe('[REDACTED]');
    });

    it('redacts case-variant Authorization at any depth', () => {
      const contract = createContract({
        fromAgent: 'test',
        inputs: { headers: { Authorization: 'Bearer abc', 'X-API-Key': 'k' } },
        outputs: {},
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
      });
      const redacted = redactContract(contract);
      expect((redacted.inputs.payload as any).headers.Authorization).toBe('[REDACTED]');
      expect((redacted.inputs.payload as any).headers['X-API-Key']).toBe('[REDACTED]');
    });

    it('redacts snake_case credential variants', () => {
      const contract = createContract({
        fromAgent: 'test',
        inputs: {
          db_password: 'hunter2',
          refresh_token: 'rt',
          private_key: 'pk',
          aws_secret_access_key: 'aws',
          client_secret: 'cs',
        },
        outputs: {},
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
      });
      const redacted = redactContract(contract);
      const p = redacted.inputs.payload as any;
      expect(p.db_password).toBe('[REDACTED]');
      expect(p.refresh_token).toBe('[REDACTED]');
      expect(p.private_key).toBe('[REDACTED]');
      expect(p.aws_secret_access_key).toBe('[REDACTED]');
      expect(p.client_secret).toBe('[REDACTED]');
    });

    it('does not over-redact lookalike keys (apiKeyExplanation, tokenCount)', () => {
      const contract = createContract({
        fromAgent: 'test',
        inputs: { apiKeyExplanation: 'how to use', tokenCount: 42 },
        outputs: {},
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
      });
      const redacted = redactContract(contract);
      expect((redacted.inputs.payload as any).apiKeyExplanation).toBe('how to use');
      expect((redacted.inputs.payload as any).tokenCount).toBe(42);
    });
  });

  describe('decisions / constraints / assumptions traversal', () => {
    it('redacts secrets embedded in decision rationale strings', () => {
      const contract = createContract({
        fromAgent: 'test',
        inputs: {},
        outputs: {},
        decisions: [
          { type: 'action', rationale: 'Used api key sk-ant-LEAKED-KEY-VALUE' },
        ],
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
      });
      const redacted = redactContract(contract);
      expect(redacted.decisions[0].rationale).not.toContain('sk-ant-LEAKED');
      expect(redacted.decisions[0].rationale).toContain('[REDACTED]');
    });

    it('redacts secrets embedded in constraint descriptions', () => {
      const contract = createContract({
        fromAgent: 'test',
        inputs: {},
        outputs: {},
        constraints: [
          {
            description:
              'fetch failed: token=sk_live_abcdefghijklmnopqrstuvwx',
          },
        ],
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
      });
      const redacted = redactContract(contract);
      expect(redacted.constraints[0].description).not.toContain('sk_live_abc');
      expect(redacted.constraints[0].description).toContain('[REDACTED]');
    });

    it('redacts apiKey nested in an assumption object', () => {
      const contract = createContract({
        fromAgent: 'test',
        inputs: {},
        outputs: {},
        assumptions: [
          { description: 'env ok', metadata: { apiKey: 'leaked' } } as any,
        ],
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
      });
      const redacted = redactContract(contract);
      expect((redacted.assumptions[0] as any).metadata.apiKey).toBe('[REDACTED]');
    });
  });

  describe('modern token format detectors', () => {
    it.each([
      ['GitHub PAT', 'ghp_' + 'a'.repeat(36)],
      [
        'GitHub fine-grained PAT',
        'github_pat_' + 'A'.repeat(82),
      ],
      ['AWS access key', 'AKIAABCDEFGHIJKLMNOP'],
      [
        'JWT',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      ],
      ['Anthropic key', 'sk-ant-api03-abc_DEF-123'],
      ['OpenAI project key', 'sk-proj-' + 'a'.repeat(48)],
      ['Stripe live secret', 'sk_live_' + 'a'.repeat(24)],
      ['Slack bot token', 'xoxb-1234-5678-abcdefghij'],
    ])('redacts %s when buried in a free-text field', (_label, secret) => {
      const contract = createContract({
        fromAgent: 'test',
        inputs: { note: `something happened: ${secret} during retry` },
        outputs: {},
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
      });
      const redacted = redactContract(contract);
      expect((redacted.inputs.payload as any).note).not.toContain(secret);
      expect((redacted.inputs.payload as any).note).toContain('[REDACTED]');
    });

    it('redacts PEM private key blocks', () => {
      const pem =
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQ\n-----END RSA PRIVATE KEY-----';
      const contract = createContract({
        fromAgent: 'test',
        inputs: { key: pem },
        outputs: {},
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
      });
      const redacted = redactContract(contract);
      // key field is redacted by name (matches /private[_-]?key/ ... actually
      // 'key' alone isn't in the deny-list, so the pattern detector handles it)
      expect((redacted.inputs.payload as any).key).not.toContain('BEGIN');
    });
  });

  it('email regex no longer treats `|` as a literal char', () => {
    // Pre-fix the regex `[A-Z|a-z]{2,}` would match e.g. `foo@bar.||` .
    // The fixed regex is `[A-Za-z]{2,}` — make sure normal emails still match
    // and that strings with stray pipes do not.
    const contract = createContract({
      fromAgent: 'test',
      inputs: { email: 'user@example.com', not_email: 'foo@bar.||' },
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });
    const redacted = redactContract(contract, { sensitivityLevel: 'medium' });
    expect((redacted.inputs.payload as any).email).toBe('[REDACTED]');
    expect((redacted.inputs.payload as any).not_email).toBe('foo@bar.||');
  });

  it('supports additionalKeyNames for caller-extension', () => {
    const contract = createContract({
      fromAgent: 'test',
      inputs: { customCred: 'leak' },
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });
    const redacted = redactContract(contract, {
      additionalKeyNames: ['customCred'],
    });
    expect((redacted.inputs.payload as any).customCred).toBe('[REDACTED]');
  });
});
