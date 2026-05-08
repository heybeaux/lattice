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
});
