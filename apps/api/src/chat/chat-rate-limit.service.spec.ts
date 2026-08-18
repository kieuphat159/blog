import { ChatRateLimitService } from './chat-rate-limit.service';

describe('ChatRateLimitService', () => {
  let service: ChatRateLimitService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    service = new ChatRateLimitService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows the first hit and reports the remaining allowance', () => {
    expect(service.consume('user:1', 3, 1000)).toEqual({
      allowed: true,
      remaining: 2,
      retryAfterMs: 0,
    });
  });

  it('allows exactly `limit` hits inside one window', () => {
    const results = [1, 2, 3].map(() => service.consume('user:1', 3, 1000));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0]);
  });

  it('blocks the hit that exceeds the limit and reports when to retry', () => {
    for (let i = 0; i < 3; i++) service.consume('user:1', 3, 1000);
    jest.advanceTimersByTime(400);

    expect(service.consume('user:1', 3, 1000)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 600,
    });
  });

  it('keeps blocking for the rest of the window without extending it', () => {
    for (let i = 0; i < 4; i++) service.consume('user:1', 3, 1000);
    jest.advanceTimersByTime(999);

    expect(service.consume('user:1', 3, 1000).allowed).toBe(false);
  });

  it('starts a fresh window once the old one elapses', () => {
    for (let i = 0; i < 3; i++) service.consume('user:1', 3, 1000);
    jest.advanceTimersByTime(1000);

    expect(service.consume('user:1', 3, 1000)).toEqual({
      allowed: true,
      remaining: 2,
      retryAfterMs: 0,
    });
  });

  it('tracks each key independently', () => {
    for (let i = 0; i < 3; i++) service.consume('user:1', 3, 1000);

    expect(service.consume('user:1', 3, 1000).allowed).toBe(false);
    expect(service.consume('user:2', 3, 1000).allowed).toBe(true);
  });

  it('blocks everything when the limit is zero', () => {
    const first = service.consume('user:1', 0, 1000);

    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(0);
    expect(service.consume('user:1', 0, 1000).allowed).toBe(false);
  });

  it('evicts expired buckets instead of growing without bound', () => {
    for (let i = 0; i < 250; i++) {
      service.consume(`user:${i}`, 5, 1000);
    }
    jest.advanceTimersByTime(2000);

    // The next 200 hits trigger a sweep, which drops every bucket already past its reset.
    for (let i = 0; i < 200; i++) {
      service.consume('sweeper', 1000, 60_000);
    }

    const buckets: Map<string, unknown> = (service as any).buckets;
    expect(buckets.size).toBeLessThan(250);
    expect(buckets.has('sweeper')).toBe(true);
  });
});
