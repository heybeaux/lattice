# Delta for Error Boundaries

## ADDED Requirements

### Requirement: Provider Timeout Handling
The system SHALL gracefully handle timeouts from L2/L3 providers without crashing the validation pipeline.

#### Scenario: L2 provider times out
- GIVEN an EmbeddingProvider that does not respond within the timeout
- WHEN L2 validation is attempted
- THEN the validation fails with a `ProviderTimeoutError`
- AND the circuit breaker records the failure
- AND the pipeline continues (in shadow/degrade mode)

#### Scenario: L3 provider times out
- GIVEN a JudgeProvider that does not respond within the timeout
- WHEN L3 validation is attempted
- THEN the validation fails with a `ProviderTimeoutError`
- AND the circuit breaker records the failure
- AND the pipeline continues (in shadow/degrade mode)

### Requirement: Rate Limit Handling
The system SHALL detect and handle rate limit responses from L2/L3 providers.

#### Scenario: L2 provider returns rate limit
- GIVEN an EmbeddingProvider that returns a 429 response
- WHEN L2 validation is attempted
- THEN the validation fails with a `ProviderRateLimitError`
- AND the system backs off for the retry-after duration (if provided)
- AND subsequent calls use the backoff timer

### Requirement: Malformed Response Handling
The system SHALL handle malformed responses from L3 providers gracefully.

#### Scenario: L3 provider returns non-JSON
- GIVEN a JudgeProvider that returns invalid JSON
- WHEN the response is parsed
- THEN the validation fails with a `MalformedProviderResponseError`
- AND the circuit breaker records the failure
- AND the error includes the raw response for debugging

### Requirement: Graceful Degradation
The system SHALL provide configurable degradation behavior when providers fail.

#### Scenario: Provider fails, degrade mode active
- GIVEN a pipeline with `onReject: 'degrade'`
- WHEN a provider fails (timeout, rate-limit, malformed)
- THEN the pipeline continues with a flagged contract
- AND the contract metadata includes `providerFailure: true` and `failureReason`

## ADDED Types

```typescript
class ProviderTimeoutError extends Error {
  constructor(provider: string, timeoutMs: number);
}

class ProviderRateLimitError extends Error {
  constructor(provider: string, retryAfterMs?: number);
}

class MalformedProviderResponseError extends Error {
  constructor(provider: string, rawResponse: string);
}
```
