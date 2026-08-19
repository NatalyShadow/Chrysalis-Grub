/**
 * Narrow an indexed fixture value without hiding a broken fixture behind a
 * non-null assertion. A missing value should fail with an actionable message.
 */
export function requireDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`fixture invariant failed: ${label} is undefined`);
  }
  return value;
}
