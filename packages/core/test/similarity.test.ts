import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../src/util/similarity.js';

describe('cosineSimilarity (spec 2.1.2–2.1.3)', () => {
  // ─── Basic geometry ───────────────────────────────────────────────────────

  it('returns 1.0 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it('returns 1.0 for parallel vectors (same direction, different magnitude)', () => {
    expect(cosineSimilarity([1, 0, 0], [5, 0, 0])).toBeCloseTo(1.0);
  });

  it('returns -1.0 for antiparallel vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it('returns approx 0.707 for 45-degree vectors', () => {
    const a = [1, 0];
    const b = [1, 1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(Math.SQRT1_2, 3);
  });

  // ─── High-dimensional vectors (embedding model scale) ─────────────────────

  it('handles 1536-dimension vectors (text-embedding-3-small scale)', () => {
    const a = Array.from({ length: 1536 }, (_, i) => Math.sin(i * 0.1));
    const b = Array.from({ length: 1536 }, (_, i) => Math.sin(i * 0.1));
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });

  it('handles 3072-dimension vectors (text-embedding-3-large scale)', () => {
    const a = Array.from({ length: 3072 }, (_, i) => Math.cos(i));
    const b = Array.from({ length: 3072 }, (_, i) => Math.cos(i) * 2); // scaled, same direction
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────

  it('returns 0 for zero vector (a)', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for zero vector (b)', () => {
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it('returns 0 for both zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('handles 1-element vectors', () => {
    expect(cosineSimilarity([3], [7])).toBeCloseTo(1.0);
    expect(cosineSimilarity([3], [-7])).toBeCloseTo(-1.0);
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow('dimension mismatch');
  });

  it('error message includes both lengths', () => {
    try {
      cosineSimilarity([1, 2, 3], [1, 2]);
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('3');
      expect((err as Error).message).toContain('2');
    }
  });

  // ─── Exported from core index ─────────────────────────────────────────────

  it('is re-exported from the core package index', async () => {
    const core = await import('../src/index.js');
    expect(typeof core.cosineSimilarity).toBe('function');
    expect(core.cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1.0);
  });
});
