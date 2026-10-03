/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
/**
 * One HTTP failure shape and one retry policy for every tile source. These
 * are pure: nothing here calls fetch(). A package's source throws
 * TileHttpError, and its loader asks isRetryableError() / retryDelay() how to
 * schedule the next attempt.
 */
export class TileHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly retryAfter?: string;
  constructor(status: number, url: string, retryAfter?: string) {
    super(`HTTP ${status}: ${url}`);
    this.name = 'TileHttpError';
    this.status = status;
    this.url = url;
    this.retryAfter = retryAfter;
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Milliseconds to wait from a Retry-After header value (seconds or HTTP date), or null when absent/invalid. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | null {
  if (value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Transient failures only: retryable HTTP statuses and network TypeErrors; never an abort. */
export function isRetryableError(error: unknown): boolean {
  const value = error as { readonly status?: unknown; readonly name?: unknown } | null;
  if (value?.name === 'AbortError') return false;
  if (typeof value?.status === 'number') return RETRYABLE_STATUS.has(value.status);
  return error instanceof TypeError;
}

export interface RetryDelayOptions {
  /** First delay, doubled per attempt. Default 250. */
  readonly baseMs?: number;
  /** Cap on every delay, Retry-After included. Default 10 000. */
  readonly maxMs?: number;
  readonly random?: () => number;
  readonly now?: () => number;
}

/** Exponential backoff with full jitter, raised to Retry-After when the error carries one, capped at maxMs. */
export function retryDelay(
  attempt: number,
  error: unknown,
  options: RetryDelayOptions = {},
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError('retry attempt must be a positive integer');
  }
  const baseMs = options.baseMs ?? 250;
  const maxMs = options.maxMs ?? 10_000;
  if (!Number.isFinite(baseMs) || baseMs < 0 || !Number.isFinite(maxMs) || maxMs < 0) {
    throw new RangeError('retry delays must be non-negative finite values');
  }
  const random = options.random ?? Math.random;
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jittered = Math.max(0, Math.min(1, random())) * exponential;
  const retryAfterValue = (error as { readonly retryAfter?: unknown } | null)?.retryAfter;
  const retryAfter =
    typeof retryAfterValue === 'string'
      ? parseRetryAfter(retryAfterValue, options.now?.() ?? Date.now())
      : null;
  return Math.min(maxMs, Math.max(jittered, retryAfter ?? 0));
}
