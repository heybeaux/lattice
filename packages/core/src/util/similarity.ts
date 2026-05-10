/**
 * Vector similarity utilities for L2 embedding validation.
 *
 * @module util/similarity
 */

/**
 * Compute cosine similarity between two vectors.
 *
 * Returns a value in [-1, 1]:
 *   1.0  — identical direction
 *   0.0  — orthogonal
 *  -1.0  — opposite direction
 *
 * Returns 0 when either vector is the zero vector (degenerate case).
 *
 * @throws {Error} If `a` and `b` have different lengths.
 *
 * @example
 * ```ts
 * import { cosineSimilarity } from '@heybeaux/lattice-core';
 *
 * const sim = cosineSimilarity([1, 0, 0], [0.707, 0.707, 0]); // ≈ 0.707
 * ```
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: got ${a.length} and ${b.length}`,
    );
  }

  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);

  if (magA === 0 || magB === 0) {
    return 0;
  }

  return dotProduct / (magA * magB);
}
