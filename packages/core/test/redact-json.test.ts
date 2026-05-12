import { describe, it, expect } from 'vitest';
import { redactJson, redactContract, createContract } from '../src/index.js';
import type { StateContract } from '../src/index.js';

// The TRAVERSED_SECTIONS used by redactContract — the parity tests below
// shape the wrapper behavior we need to match.
const SECTIONS = ['inputs', 'outputs', 'metadata', 'decisions', 'constraints', 'assumptions'] as const;

describe('redactJson — basic redaction', () => {
  it('returns the cloned tree unchanged when no rules match', () => {
    const tree = { foo: 'bar', n: 1 };
    const r = redactJson(tree, { sensitivityLevel: 'high' });
    expect(r.redacted).toEqual({ foo: 'bar', n: 1 });
    expect(r.redacted).not.toBe(tree); // cloned, not the same reference
    expect(r.fields).toEqual([]);
    expect(r.refusalPath).toBeUndefined();
  });

  it('replaces sensitive keys at root', () => {
    const r = redactJson({ apiKey: 'sk-123', plain: 'ok' }, { sensitivityLevel: 'high' });
    expect((r.redacted as Record<string, unknown>).apiKey).toBe('[REDACTED]');
    expect((r.redacted as Record<string, unknown>).plain).toBe('ok');
    expect(r.fields).toContain('$.apiKey');
  });

  it('replaces sensitive keys at depth', () => {
    const r = redactJson(
      { outer: { inner: { password: 'hunter2', visible: 'yes' } } },
      { sensitivityLevel: 'high' },
    );
    const inner = (r.redacted as { outer: { inner: Record<string, unknown> } }).outer.inner;
    expect(inner.password).toBe('[REDACTED]');
    expect(inner.visible).toBe('yes');
    expect(r.fields).toContain('$.outer.inner.password');
  });

  it('matches token formats independent of key name', () => {
    const r = redactJson(
      { note: 'My key is ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa rotating soon' },
      { sensitivityLevel: 'low' },
    );
    expect((r.redacted as { note: string }).note).toMatch(/\[REDACTED\]/);
    expect(r.fields).toContain('$.note');
  });

  it('redacts emails at medium+', () => {
    const r = redactJson({ to: 'a@b.com' }, { sensitivityLevel: 'medium' });
    expect((r.redacted as { to: string }).to).toBe('[REDACTED]');
  });

  it('does NOT redact emails at low', () => {
    const r = redactJson({ to: 'a@b.com' }, { sensitivityLevel: 'low' });
    expect((r.redacted as { to: string }).to).toBe('a@b.com');
  });

  it('redacts phone/SSN/credit at high', () => {
    const r = redactJson(
      { phone: '555-867-5309', ssn: '111-22-3333', card: '4111 1111 1111 1111' },
      { sensitivityLevel: 'high' },
    );
    const rd = r.redacted as Record<string, string>;
    expect(rd.phone).toContain('[REDACTED]');
    expect(rd.ssn).toContain('[REDACTED]');
    expect(rd.card).toContain('[REDACTED]');
  });

  it("custom placeholder is honored", () => {
    const r = redactJson(
      { apiKey: 'sk-secret' },
      { sensitivityLevel: 'high', placeholder: '<<gone>>' },
    );
    expect((r.redacted as { apiKey: string }).apiKey).toBe('<<gone>>');
  });

  it('additionalKeyNames extends the deny list', () => {
    const r = redactJson(
      { sessionToken: 'abc', mySecret: '123' },
      { sensitivityLevel: 'low', additionalKeyNames: ['mysecret'] },
    );
    expect((r.redacted as Record<string, string>).mySecret).toBe('[REDACTED]');
  });

  it('handles arrays in tree', () => {
    const r = redactJson(
      { items: [{ password: 'a' }, { password: 'b' }] },
      { sensitivityLevel: 'high' },
    );
    const items = (r.redacted as { items: Record<string, string>[] }).items;
    expect(items[0].password).toBe('[REDACTED]');
    expect(items[1].password).toBe('[REDACTED]');
    expect(r.fields).toContain('$.items[0].password');
    expect(r.fields).toContain('$.items[1].password');
  });

  it('handles non-identifier keys via bracket-notation in paths', () => {
    const r = redactJson(
      { 'odd key': 'a@b.com' },
      { sensitivityLevel: 'medium' },
    );
    expect(r.fields).toContain("$['odd key']");
  });

  it('returns undefined input verbatim', () => {
    const r = redactJson(undefined, { sensitivityLevel: 'high' });
    expect(r.redacted).toBeUndefined();
    expect(r.fields).toEqual([]);
  });

  it('returns null and primitives unchanged', () => {
    expect(redactJson(null, { sensitivityLevel: 'high' }).redacted).toBeNull();
    expect(redactJson('hello', { sensitivityLevel: 'high' }).redacted).toBe('hello');
    expect(redactJson(42, { sensitivityLevel: 'high' }).redacted).toBe(42);
  });
});

describe('redactJson — mustNotRedact (Spec 1 R11)', () => {
  it('short-circuits at the first protected key', () => {
    const r = redactJson(
      { apiKey: 'sk-1', secret: 'shh' },
      {
        sensitivityLevel: 'high',
        mustNotRedact: ['$.apiKey'],
      },
    );
    expect(r.refusalPath).toBe('$.apiKey');
    // Partial: apiKey was not redacted, downstream keys may or may not be.
    expect((r.redacted as Record<string, string>).apiKey).toBe('sk-1');
  });

  it('short-circuits at the first protected pattern hit', () => {
    const r = redactJson(
      { ssn: '111-22-3333' },
      { sensitivityLevel: 'high', mustNotRedact: ['$.ssn'] },
    );
    expect(r.refusalPath).toBe('$.ssn');
    expect((r.redacted as Record<string, string>).ssn).toBe('111-22-3333');
  });

  it('allows redaction when mustNotRedact does not cover the path', () => {
    const r = redactJson(
      { apiKey: 'sk-1' },
      { sensitivityLevel: 'high', mustNotRedact: ['$.somewhere.else'] },
    );
    expect(r.refusalPath).toBeUndefined();
    expect((r.redacted as Record<string, string>).apiKey).toBe('[REDACTED]');
  });

  it('records earlier successful redactions before refusing', () => {
    const r = redactJson(
      { a: { password: 'first' }, b: { token: 'protected' } },
      { sensitivityLevel: 'high', mustNotRedact: ['$.b.token'] },
    );
    expect(r.refusalPath).toBe('$.b.token');
    // The earlier redaction in `a.password` still ran.
    expect((r.redacted as { a: { password: string } }).a.password).toBe('[REDACTED]');
    expect(r.fields).toContain('$.a.password');
  });
});

describe('redactContract / redactJson — parity (>=10 inputs)', () => {
  // For each shaped input below, redactContract must produce the same value
  // as a section-by-section redactJson call. The parity sweep is the
  // load-bearing test for Task 4.5 — it locks the wrapped/wrappee invariant.
  const CASES: Array<{ name: string; payload: Record<string, unknown> }> = [
    { name: 'plain credentials', payload: { inputs: { apiKey: 'sk-123' }, outputs: {} } },
    { name: 'nested credentials', payload: { inputs: { auth: { token: 'abc' } } } },
    { name: 'email at medium', payload: { inputs: { to: 'a@b.com' } } },
    { name: 'phone at high', payload: { outputs: { phone: '555-867-5309' } } },
    { name: 'SSN at high', payload: { outputs: { ssn: '111-22-3333' } } },
    { name: 'credit card at high', payload: { outputs: { card: '4111 1111 1111 1111' } } },
    { name: 'github PAT in text', payload: { outputs: { note: 'leaked ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } } },
    { name: 'aws access key', payload: { outputs: { note: 'AKIAIOSFODNN7EXAMPLE leaked' } } },
    { name: 'JWT token', payload: { outputs: { auth: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' } } },
    { name: 'OpenAI key', payload: { outputs: { note: 'sk-proj-AAAAAAAAAAAAAAAAAAAA leaked' } } },
    { name: 'array of credentials', payload: { metadata: { items: [{ password: 'a' }, { password: 'b' }] } } },
    { name: 'deep array nesting', payload: { metadata: { tree: { rows: [{ secret: 's1' }, { token: 't2' }] } } } },
    { name: 'mixed visible + secret', payload: { outputs: { ok: 'visible', secret: 'no' } } },
  ];

  for (const tc of CASES) {
    it(`redactContract matches the section-by-section redactJson call for: ${tc.name}`, () => {
      // Build a contract whose sections mirror the case payload. The
      // contract id/traceId/timestamp are excluded from redaction by both
      // paths, so any difference would surface elsewhere.
      const contract = createContract({
        fromAgent: 'parity-test',
        inputs: tc.payload.inputs ?? {},
        outputs: tc.payload.outputs ?? {},
        budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
        metadata: (tc.payload.metadata as Record<string, unknown>) ?? {},
      });

      const viaContract = redactContract(contract, { sensitivityLevel: 'high' });

      // Reconstruct by walking each section through redactJson.
      const cloned = JSON.parse(JSON.stringify(contract)) as Record<string, unknown>;
      for (const section of SECTIONS) {
        const node = cloned[section];
        if (node === undefined) continue;
        cloned[section] = redactJson(node, { sensitivityLevel: 'high' }).redacted;
      }

      // Compare the section slots (the ones redactContract touches). The
      // outer envelope fields (id/traceId/...) are not touched by either
      // path, so we equality-check the whole contract here.
      for (const section of SECTIONS) {
        expect(
          (viaContract as unknown as Record<string, unknown>)[section],
          `${tc.name}: section '${section}' diverged`,
        ).toEqual(cloned[section]);
      }
    });
  }

  it('redactContract still freezes its return value', () => {
    const contract: StateContract = createContract({
      fromAgent: 't',
      inputs: { apiKey: 'sk-x' },
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });
    const r = redactContract(contract);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('redactContract public signature is unchanged (positional contract + optional options)', () => {
    // Type-level check via successful compilation; the runtime check below
    // is just a smoke test of the existing two arities.
    const c = createContract({
      fromAgent: 't',
      inputs: { secret: 'a' },
      outputs: {},
      budget: { tokensUsed: 0, callsMade: 0, wallClockMs: 0 },
    });
    expect(() => redactContract(c)).not.toThrow();
    expect(() => redactContract(c, { sensitivityLevel: 'low' })).not.toThrow();
  });
});
