/**
 * A deterministic policy rejection. `code` is a stable machine-readable
 * identifier that callers (and tests) match on; `definite` marks the failure
 * as confirmed (never worth retrying with the same input).
 */
export class PolicyError extends Error {
  readonly code: string;
  readonly definite = true as const;
  readonly retryAt?: number;

  constructor(code: string, options: { message?: string; retryAt?: number } = {}) {
    super(options.message ?? code);
    this.name = 'PolicyError';
    this.code = code;
    if (options.retryAt !== undefined) this.retryAt = options.retryAt;
  }
}

export function isPolicyError(error: unknown): error is PolicyError {
  return error instanceof PolicyError;
}
