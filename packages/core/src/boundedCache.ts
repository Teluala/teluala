/*!
 * Copyright (c) 2026 The Teluala Authors
 * SPDX-License-Identifier: MIT
 */
/**
 * Least-recently-used cache with one bound, in entries or in bytes.
 *
 * Recency is the Map's insertion order: get() re-inserts, so the head is
 * always the least recently used and no per-entry timestamp or frame counter
 * exists. prune() sums sizeOf() over the entries (so a size that changes
 * after insertion, a content's byteLength once loaded, is always current),
 * evicts from the head, skips what the caller protects (the tiles a frame
 * still wants), and returns what it dropped so the owner can release GPU
 * memory or abort a load. One mechanism for every tile cache.
 */
export interface BoundedCacheOptions<V> {
  /** Upper bound on the summed sizeOf() of the entries. */
  readonly limit: number;
  /** Size of one entry; default 1 (a bound in entries). 0 keeps an entry out of the budget. */
  readonly sizeOf?: (value: V) => number;
}

export class BoundedCache<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #limit: number;
  readonly #sizeOf: (value: V) => number;

  constructor(options: BoundedCacheOptions<V>) {
    if (!Number.isFinite(options.limit) || options.limit < 0) {
      throw new RangeError('cache limit must be a non-negative number');
    }
    this.#limit = options.limit;
    this.#sizeOf = options.sizeOf ?? (() => 1);
  }

  get size(): number {
    return this.#entries.size;
  }
  get limit(): number {
    return this.#limit;
  }
  /** Summed sizeOf() of the entries, read at call time. */
  get total(): number {
    let total = 0;
    for (const value of this.#entries.values()) total += this.#sizeOf(value);
    return total;
  }
  has(key: K): boolean {
    return this.#entries.has(key);
  }
  /** Read without touching recency (identity checks, snapshots). */
  peek(key: K): V | undefined {
    return this.#entries.get(key);
  }
  /** Read and mark as most recently used. */
  get(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }
  /** Insert or replace as most recently used. */
  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
  }
  delete(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value !== undefined) this.#entries.delete(key);
    return value;
  }
  clear(): void {
    this.#entries.clear();
  }
  /** Least recently used first. Deleting during iteration is safe; get() is not (it re-inserts). */
  keys(): IterableIterator<K> {
    return this.#entries.keys();
  }
  values(): IterableIterator<V> {
    return this.#entries.values();
  }
  entries(): IterableIterator<[K, V]> {
    return this.#entries.entries();
  }
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.#entries.entries();
  }
  /** Evict least recently used entries until total <= limit, never a protected
   * or zero-sized one. Returns what was dropped. `limit` overrides the
   * constructor's for this call — an owner whose protected set varies per
   * frame bounds what it keeps BEYOND that set (protected.size + retained). */
  prune(isProtected?: (key: K, value: V) => boolean, limit: number = this.#limit): [K, V][] {
    if (!Number.isFinite(limit) || limit < 0) {
      throw new RangeError('cache limit must be a non-negative number');
    }
    const dropped: [K, V][] = [];
    let total = this.total;
    if (total <= limit) return dropped;
    for (const [key, value] of this.#entries) {
      const size = this.#sizeOf(value);
      // Dropping a zero-sized entry frees nothing: it is outside the budget.
      if (size === 0 || isProtected?.(key, value)) continue;
      this.#entries.delete(key);
      total -= size;
      dropped.push([key, value]);
      if (total <= limit) break;
    }
    return dropped;
  }
}
