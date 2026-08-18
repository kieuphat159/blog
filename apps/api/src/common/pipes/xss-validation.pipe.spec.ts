/**
 * `isomorphic-dompurify` boots a full jsdom window at import time, and jsdom's dependency
 * tree is ESM-only, which Jest's CommonJS loader cannot require. DOMPurify is therefore
 * stubbed here.
 *
 * That still leaves the part this repo owns under test: which values get handed to the
 * sanitizer, which are passed through untouched, and with what configuration. The escaping
 * itself is DOMPurify's job and is covered by its own suite.
 */
const sanitizeMock = jest.fn(
  (value: string) => `sanitized(${value})`,
) as jest.Mock;

jest.mock('isomorphic-dompurify', () => ({
  __esModule: true,
  default: { sanitize: (...args: unknown[]) => sanitizeMock(...args) },
}));

import { XssSanitizationPipe } from './xss-validation.pipe';

describe('XssSanitizationPipe', () => {
  const pipe = new XssSanitizationPipe();
  const sanitize = (value: unknown) => pipe.transform(value, {} as any);

  beforeEach(() => {
    sanitizeMock.mockClear();
  });

  describe('what reaches the sanitizer', () => {
    it('sanitizes a bare string', () => {
      expect(sanitize('<script>')).toBe('sanitized(<script>)');
    });

    it('sanitizes every string field of a plain object', () => {
      expect(sanitize({ title: 'a', content: 'b' })).toEqual({
        title: 'sanitized(a)',
        content: 'sanitized(b)',
      });
    });

    it('recurses into nested objects', () => {
      expect(sanitize({ post: { body: 'a', meta: { note: 'b' } } })).toEqual({
        post: { body: 'sanitized(a)', meta: { note: 'sanitized(b)' } },
      });
    });

    it('sanitizes strings and nested objects inside arrays', () => {
      expect(sanitize({ tags: ['a', { name: 'b' }] })).toEqual({
        tags: ['sanitized(a)', { name: 'sanitized(b)' }],
      });
    });

    it('leaves non-string array items alone', () => {
      expect(sanitize({ ids: [1, true, null] })).toEqual({
        ids: [1, true, null],
      });
      expect(sanitizeMock).not.toHaveBeenCalled();
    });

    it('sanitizes an object with a null prototype', () => {
      const bare = Object.create(null);
      bare.title = 'a';

      expect(sanitize(bare)).toEqual({ title: 'sanitized(a)' });
    });

    it('passes the editor-specific config on every call', () => {
      sanitize({ content: 'a', nested: { deep: 'b' } });

      expect(sanitizeMock).toHaveBeenCalledTimes(2);
      for (const [, config] of sanitizeMock.mock.calls) {
        // Dropping these would strip Tiptap's classes, link targets and inline images.
        expect(config.ADD_ATTR).toEqual(
          expect.arrayContaining(['class', 'target', 'rel', 'src', 'alt']),
        );
        expect('data:image/png;base64,AAA').toMatch(config.ALLOWED_URI_REGEXP);
        expect('javascript:alert(1)').not.toMatch(config.ALLOWED_URI_REGEXP);
      }
    });
  });

  describe('what must not reach the sanitizer', () => {
    it.each([[42], [true], [null], [undefined]])(
      'passes %p through unchanged',
      (value) => {
        expect(sanitize(value)).toBe(value);
        expect(sanitizeMock).not.toHaveBeenCalled();
      },
    );

    // GraphQL context objects, Sockets and Dates reach pipes too. Rebuilding them as plain
    // objects would drop their prototype and break every method on them.
    it('passes a class instance through by reference', () => {
      class Ctx {
        req = { headers: {} };
        getReq() {
          return this.req;
        }
      }
      const ctx = new Ctx();

      expect(sanitize(ctx)).toBe(ctx);
      expect(sanitizeMock).not.toHaveBeenCalled();
    });

    it('passes a Date through by reference', () => {
      const date = new Date('2024-01-01T00:00:00.000Z');

      expect(sanitize(date)).toBe(date);
    });

    it('passes an array argument through untouched', () => {
      const values = ['a', 'b'];

      expect(sanitize(values)).toBe(values);
      expect(sanitizeMock).not.toHaveBeenCalled();
    });
  });

  it('does not mutate the object it was given', () => {
    const input = { title: 'a', nested: { body: 'b' } };
    const result = sanitize(input);

    expect(input).toEqual({ title: 'a', nested: { body: 'b' } });
    expect(result).not.toBe(input);
    expect(result.nested).not.toBe(input.nested);
  });
});
