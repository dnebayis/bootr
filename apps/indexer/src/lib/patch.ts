/**
 * Which fields of a patch differ from the stored row. The snapshot handler recomputes every coin and agent once a
 * minute, and most of the time nothing moved; an `update()` that changes nothing still writes the row (and, while
 * the block is not final, a copy of it to Ponder's reorg table), so the handler writes only when this is not empty.
 * The patch is always computed in full first: fields that depend on the time (the 24 h windows, status, dormancy)
 * roll over because their new value differs from the stored one, not because a write is forced.
 */

/** Equality of two column values: integers and floats, big integers, text, booleans, null, dates and JSON. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // null and undefined are both "no value" in a row; a number never equals a bigint (a column has one type).
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (typeof a === 'object' && typeof b === 'object') return stable(a) === stable(b);
  return false;
}

/** JSON with sorted keys and big integers as tagged text, so `{a, b}` equals `{b, a}` and 1n never equals "1". */
function stable(v: unknown): string {
  return JSON.stringify(v, (_key, value: unknown) => {
    if (typeof value === 'bigint') return { $bigint: value.toString() };
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
    }
    return value;
  });
}

/**
 * The entries of `patch` whose value differs from `row`'s (an `undefined` entry is no change, as for `update().set`).
 * `quiet` names fields that are not worth a write by themselves, such as "refreshed at" stamps: when only they
 * differ the result is empty, and when anything else differs they are written with it.
 */
export function changedFields<R extends Record<string, unknown>, P extends Partial<R>>(row: R, patch: P, quiet: readonly (keyof P)[] = []): Partial<P> {
  const out: Partial<P> = {};
  let loud = false;
  for (const key of Object.keys(patch) as (keyof P & string)[]) {
    const value = patch[key];
    if (value === undefined || sameValue(row[key], value)) continue;
    out[key] = value;
    if (!quiet.includes(key)) loud = true;
  }
  return loud ? out : {};
}
