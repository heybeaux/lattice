# Delta for L2 Embedding Integration

## ADDED Requirements

### Requirement: Built-in EmbeddingProvider Interface
The system SHALL provide a standard `EmbeddingProvider` interface for L2 validation.

#### Scenario: Provider implements the interface
- GIVEN a class implements `EmbeddingProvider`
- WHEN `embed(text)` is called
- THEN a numeric embedding vector is returned
- WHEN `similarity(a, b)` is called
- THEN a cosine similarity score between 0 and 1 is returned

#### Scenario: Default cosine similarity implementation
- GIVEN no custom similarity function is provided
- WHEN `similarity(a, b)` is called
- THEN cosine similarity is computed: dot(a,b) / (norm(a) * norm(b))
- AND the result is clamped to [0, 1]

### Requirement: OpenAI EmbeddingProvider
The system SHALL ship a ready-to-use `OpenAIEmbeddingProvider` for `text-embedding-3-small`.

#### Scenario: OpenAI provider creates embeddings
- GIVEN a valid OpenAI API key
- WHEN `embed("hello world")` is called
- THEN a 1536-dimensional vector is returned (text-embedding-3-small default)
- AND the call includes proper error handling for rate limits

#### Scenario: OpenAI provider batches requests
- GIVEN multiple `embed()` calls within a short window
- WHEN the batch threshold is reached
- THEN requests are batched into a single API call
- AND individual callers receive their respective vectors

### Requirement: L2 Validation Uses Embedding Similarity
The system SHALL use embedding similarity for L2 validation when an `EmbeddingProvider` is configured.

#### Scenario: L2 validates with embeddings
- GIVEN a TieredCircuitBreaker with L2 enabled and an EmbeddingProvider
- WHEN a contract is validated at L2
- THEN embeddings are computed for input and output payloads
- AND similarity is computed between the vectors
- AND the contract passes if similarity >= l2Threshold

#### Scenario: L2 falls back to string comparison without provider
- GIVEN a TieredCircuitBreaker with L2 enabled but no EmbeddingProvider
- WHEN L2 validation is attempted
- THEN validation fails with a descriptive error
- AND the error message includes instructions for configuring an EmbeddingProvider

## ADDED Types

```typescript
interface EmbeddingProvider {
  /** Compute embedding vector for text */
  embed(text: string): Promise<number[]>;
  /** Compute similarity between two vectors (default: cosine similarity) */
  similarity(a: number[], b: number[]): number;
}

interface OpenAIEmbeddingProviderConfig {
  /** OpenAI API key */
  apiKey: string;
  /** Embedding model (default: text-embedding-3-small) */
  model?: string;
  /** Request timeout in ms (default: 10000) */
  timeoutMs?: number;
  /** Batch size for batched requests (default: 1, disable with 0) */
  batchSize?: number;
  /** Batch window in ms (default: 100) */
  batchWindowMs?: number;
}
```
