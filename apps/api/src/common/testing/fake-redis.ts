/**
 * In-memory stand-in for RedisService used by unit tests.
 *
 * Behaves like a real cache (values survive between calls, TTLs are recorded) so tests can
 * assert cache hits/misses and invalidation instead of just asserting that `.set()` was
 * called. TTLs are not expired on a timer - call `expire()` to simulate that deterministically.
 */
export class FakeRedis {
  readonly store = new Map<string, { value: string; ttlSeconds?: number }>();
  readonly get = jest.fn(
    (key: string): Promise<string | null> =>
      Promise.resolve(this.store.get(key)?.value ?? null),
  );
  readonly set = jest.fn(
    (key: string, value: string, ttlSeconds?: number): Promise<void> => {
      this.store.set(key, { value, ttlSeconds });
      return Promise.resolve();
    },
  );
  readonly del = jest.fn((key: string): Promise<void> => {
    this.store.delete(key);
    return Promise.resolve();
  });

  /** Seed the cache directly, bypassing the recorded `set` calls. */
  seed(key: string, value: unknown, ttlSeconds?: number) {
    this.store.set(key, { value: JSON.stringify(value), ttlSeconds });
  }

  /** Simulate a key's TTL elapsing. */
  expire(key: string) {
    this.store.delete(key);
  }

  ttlOf(key: string) {
    return this.store.get(key)?.ttlSeconds;
  }

  keys() {
    return [...this.store.keys()];
  }
}
