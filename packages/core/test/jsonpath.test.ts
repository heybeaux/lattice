import { describe, it, expect } from 'vitest';
import {
  compileJSONPath,
  evaluateJSONPath,
  type CompiledJSONPath,
} from '../src/breaker/jsonpath.js';

// Helper: compile + evaluate in one shot so the test reads as JSONPath-against-data.
const evalPath = (root: unknown, path: string) =>
  evaluateJSONPath(root, compileJSONPath(path));

describe('JSONPath compile — supported subset', () => {
  it('compiles bare root', () => {
    const c = compileJSONPath('$');
    expect(c.source).toBe('$');
    expect(c.steps).toEqual([]);
  });

  it('compiles dot-notation child', () => {
    expect(compileJSONPath('$.a').steps).toEqual([{ kind: 'key', name: 'a' }]);
  });

  it('compiles nested dot-notation', () => {
    expect(compileJSONPath('$.a.b.c').steps).toEqual([
      { kind: 'key', name: 'a' },
      { kind: 'key', name: 'b' },
      { kind: 'key', name: 'c' },
    ]);
  });

  it('compiles bracket-notation child', () => {
    expect(compileJSONPath("$['a']").steps).toEqual([{ kind: 'key', name: 'a' }]);
  });

  it('compiles bracket-notation with non-identifier chars', () => {
    expect(compileJSONPath("$['a.b']").steps).toEqual([{ kind: 'key', name: 'a.b' }]);
    expect(compileJSONPath("$['a b c']").steps).toEqual([{ kind: 'key', name: 'a b c' }]);
    expect(compileJSONPath("$['a-b']").steps).toEqual([{ kind: 'key', name: 'a-b' }]);
  });

  it('compiles numeric index', () => {
    expect(compileJSONPath('$.a[0]').steps).toEqual([
      { kind: 'key', name: 'a' },
      { kind: 'index', idx: 0 },
    ]);
    expect(compileJSONPath('$.a[12]').steps).toEqual([
      { kind: 'key', name: 'a' },
      { kind: 'index', idx: 12 },
    ]);
  });

  it('compiles wildcard', () => {
    expect(compileJSONPath('$.a[*]').steps).toEqual([
      { kind: 'key', name: 'a' },
      { kind: 'wildcard' },
    ]);
  });

  it('compiles mixed dot/bracket/index/wildcard', () => {
    expect(compileJSONPath("$.a['b-c'][0][*].d").steps).toEqual([
      { kind: 'key', name: 'a' },
      { kind: 'key', name: 'b-c' },
      { kind: 'index', idx: 0 },
      { kind: 'wildcard' },
      { kind: 'key', name: 'd' },
    ]);
  });
});

describe('JSONPath compile — error cases', () => {
  it('rejects empty string', () => {
    expect(() => compileJSONPath('')).toThrow(/non-empty/);
  });

  it('rejects non-string', () => {
    // @ts-expect-error — testing runtime guard
    expect(() => compileJSONPath(123)).toThrow(/non-empty/);
  });

  it("rejects paths not starting with '$'", () => {
    expect(() => compileJSONPath('a.b')).toThrow(/start with '\$'/);
    expect(() => compileJSONPath('.a')).toThrow(/start with '\$'/);
  });

  it("rejects recursive descent '..'", () => {
    expect(() => compileJSONPath('$..a')).toThrow(/recursive descent/);
  });

  it("rejects filter expressions '?'", () => {
    expect(() => compileJSONPath('$.a[?(@.x)]')).toThrow(/filter/);
  });

  it("rejects current-node refs '@'", () => {
    expect(() => compileJSONPath('$.@')).toThrow(/current-node/);
  });

  it('rejects union [a,b]', () => {
    expect(() => compileJSONPath("$['a','b']")).toThrow(/union/);
  });

  it('rejects slice [a:b]', () => {
    expect(() => compileJSONPath('$.a[0:2]')).toThrow(/slice/);
  });

  it("rejects dangling '.'", () => {
    expect(() => compileJSONPath('$.')).toThrow(/dangling/);
  });

  it("rejects empty identifier after '.'", () => {
    expect(() => compileJSONPath('$.[0]')).toThrow(/missing identifier/);
  });

  it('rejects unterminated bracket', () => {
    expect(() => compileJSONPath("$['a")).toThrow(/unterminated bracket/);
  });

  it('rejects unterminated quoted key', () => {
    expect(() => compileJSONPath("$['a]")).toThrow(/unterminated quoted key/);
  });

  it('rejects empty brackets', () => {
    expect(() => compileJSONPath('$.a[]')).toThrow(/empty brackets/);
  });

  it('rejects escapes inside quoted keys', () => {
    expect(() => compileJSONPath("$['a'b']")).toThrow(/unterminated quoted key|escape sequences/);
  });

  it('rejects negative indices', () => {
    expect(() => compileJSONPath('$.a[-1]')).toThrow(/unsupported bracket content/);
  });

  it('rejects non-integer bracket content', () => {
    expect(() => compileJSONPath('$.a[abc]')).toThrow(/unsupported bracket content/);
    expect(() => compileJSONPath('$.a[1.5]')).toThrow(/unsupported bracket content/);
  });

  it('rejects unexpected characters', () => {
    expect(() => compileJSONPath('$!a')).toThrow(/unexpected character/);
  });

  it('rejects identifiers that start with a digit', () => {
    expect(() => compileJSONPath('$.0abc')).toThrow(/invalid identifier/);
  });
});

describe('JSONPath evaluate — happy path', () => {
  const root = {
    a: { b: { c: 'hello' } },
    arr: [10, 20, 30],
    mixed: { x: [1, 2], y: { z: 'leaf' } },
    'odd key': 'value-with-space',
    nullable: null,
    falsy: 0,
  };

  it('returns root for $', () => {
    const r = evalPath(root, '$');
    expect(r.resolved).toBe(true);
    expect(r.value).toBe(root);
    expect(r.values).toEqual([root]);
  });

  it('resolves nested dot-notation', () => {
    const r = evalPath(root, '$.a.b.c');
    expect(r.resolved).toBe(true);
    expect(r.value).toBe('hello');
  });

  it('resolves numeric index', () => {
    expect(evalPath(root, '$.arr[0]').value).toBe(10);
    expect(evalPath(root, '$.arr[2]').value).toBe(30);
  });

  it('resolves bracket-notation key with space', () => {
    expect(evalPath(root, "$['odd key']").value).toBe('value-with-space');
  });

  it('resolves null value as RESOLVED (not missing)', () => {
    const r = evalPath(root, '$.nullable');
    expect(r.resolved).toBe(true);
    expect(r.value).toBeNull();
  });

  it('resolves falsy value (0) as RESOLVED', () => {
    const r = evalPath(root, '$.falsy');
    expect(r.resolved).toBe(true);
    expect(r.value).toBe(0);
  });
});

describe('JSONPath evaluate — wildcards', () => {
  it('wildcards over array yield each element', () => {
    const r = evalPath({ arr: [10, 20, 30] }, '$.arr[*]');
    expect(r.resolved).toBe(true);
    expect(r.values).toEqual([10, 20, 30]);
  });

  it('wildcards over object yield each value', () => {
    const r = evalPath({ obj: { a: 1, b: 2, c: 3 } }, '$.obj[*]');
    expect(r.resolved).toBe(true);
    // Insertion order preserved
    expect(r.values).toEqual([1, 2, 3]);
  });

  it('wildcards over empty array yield no resolution', () => {
    expect(evalPath({ arr: [] }, '$.arr[*]').resolved).toBe(false);
  });

  it('wildcards over scalar yield no resolution', () => {
    expect(evalPath({ a: 'string' }, '$.a[*]').resolved).toBe(false);
  });

  it('wildcards over null yield no resolution', () => {
    expect(evalPath({ a: null }, '$.a[*]').resolved).toBe(false);
  });

  it('nested wildcards traverse all branches', () => {
    const root = { rows: [{ vals: [1, 2] }, { vals: [3, 4] }] };
    const r = evalPath(root, '$.rows[*].vals[*]');
    expect(r.resolved).toBe(true);
    expect(r.values).toEqual([1, 2, 3, 4]);
  });

  it('wildcard followed by missing key collapses', () => {
    const root = { rows: [{ x: 1 }, { x: 2 }] };
    expect(evalPath(root, '$.rows[*].missing').resolved).toBe(false);
  });
});

describe('JSONPath evaluate — missing paths', () => {
  it('missing key resolves false', () => {
    expect(evalPath({ a: 1 }, '$.missing').resolved).toBe(false);
  });

  it('deep missing key resolves false', () => {
    expect(evalPath({ a: { b: 1 } }, '$.a.b.c').resolved).toBe(false);
  });

  it('index out of range resolves false', () => {
    expect(evalPath({ arr: [1, 2] }, '$.arr[5]').resolved).toBe(false);
  });

  it('key access on array resolves false', () => {
    expect(evalPath({ arr: [1, 2] }, '$.arr.length').resolved).toBe(false);
  });

  it('index access on object resolves false', () => {
    expect(evalPath({ obj: { a: 1 } }, '$.obj[0]').resolved).toBe(false);
  });

  it('property explicitly set to undefined resolves false', () => {
    expect(evalPath({ a: undefined as unknown }, '$.a').resolved).toBe(false);
  });

  it('key access on primitive resolves false', () => {
    expect(evalPath({ a: 'string' }, '$.a.b').resolved).toBe(false);
    expect(evalPath({ a: 42 }, '$.a.b').resolved).toBe(false);
  });

  it('key access on null resolves false', () => {
    expect(evalPath({ a: null }, '$.a.b').resolved).toBe(false);
  });

  it('non-own property (prototype) does not resolve', () => {
    const proto = { fromProto: 'leak' };
    const root = Object.create(proto);
    root.own = 'real';
    expect(evalPath(root, '$.fromProto').resolved).toBe(false);
    expect(evalPath(root, '$.own').value).toBe('real');
  });
});

describe('JSONPath evaluate — compiled cache reuse', () => {
  it('re-evaluating a compiled path against different roots is independent', () => {
    const compiled: CompiledJSONPath = compileJSONPath('$.outputs.payload.tool');
    const r1 = evaluateJSONPath(
      { outputs: { payload: { tool: 'a' } } },
      compiled,
    );
    const r2 = evaluateJSONPath(
      { outputs: { payload: { tool: 'b' } } },
      compiled,
    );
    expect(r1.value).toBe('a');
    expect(r2.value).toBe('b');
  });

  it('evaluating against null root resolves only $', () => {
    expect(evaluateJSONPath(null, compileJSONPath('$')).resolved).toBe(true);
    expect(evaluateJSONPath(null, compileJSONPath('$.a')).resolved).toBe(false);
  });
});
