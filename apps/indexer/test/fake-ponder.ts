/**
 * Stand-ins for Ponder's virtual modules in handler tests (outside src/: Ponder runs every file under src/ that is
 * not a test as an indexing file). The tables are only names here, an in-memory store stands in for `context.db`
 * (find / insert … onConflict / update … set by `id`, and `sql.select().from().where()` with `eq` / `and`), and
 * `ponder.on` keeps the handlers so a test can call them with the logs of a real receipt.
 */
export type Row = Record<string, unknown> & { id: unknown };
type Table = { name: string };
type Pred = (row: Row) => boolean;

export const TABLES = [
  'agent',
  'balance',
  'burn',
  'burner',
  'dailyStat',
  'dividendCredit',
  'feeAccrual',
  'feeBalance',
  'feeClaim',
  'feeCredit',
  'feeRecipient',
  'feeSlot',
  'feeSlotUpdate',
  'milestone',
  'platformConfig',
  'platformStats',
  'pool',
  'priceFeed',
  'sourceStats',
  'swapSync',
  'token',
  'tokenWindow',
  'trade',
] as const;

/** `ponder:schema`: each table knows its name, and any other property is a column reference for `eq`. */
export function schemaMock() {
  return Object.fromEntries(
    TABLES.map((name) => [name, new Proxy({ name }, { get: (t, prop) => (prop === 'name' ? t.name : { column: String(prop) }) })]),
  );
}

/** `ponder`: the query helpers the handlers use, as row predicates. */
export function ponderMock() {
  const eq = (c: { column: string }, v: unknown): Pred => (row) => row[c.column] === v;
  const and = (...preds: Pred[]): Pred => (row) => preds.every((p) => p(row));
  const inArray = (c: { column: string }, values: unknown[]): Pred => (row) => values.includes(row[c.column]);
  return { eq, and, inArray };
}

export type Handler = (args: { event: unknown; context: unknown }) => Promise<void>;

/** `ponder:registry`: `ponder.on` files each handler under its event name. */
export function registryMock(handlers: Map<string, Handler>) {
  return { ponder: { on: (name: string, fn: Handler) => handlers.set(name, fn) } };
}

export function fakeDb() {
  const tables = new Map<string, Map<unknown, Row>>();
  const rows = (t: Table) => {
    let m = tables.get(t.name);
    if (!m) tables.set(t.name, (m = new Map()));
    return m;
  };
  const put = (t: Table, v: Row) => {
    const row = { ...v };
    rows(t).set(v.id, row);
    return row;
  };
  const db = {
    find: async (t: Table, k: { id: unknown }) => rows(t).get(k.id) ?? null,
    insert: (t: Table) => ({
      values: (v: Row) => ({
        then: (ok: (r: Row) => void, fail: (e: unknown) => void) =>
          rows(t).has(v.id) ? fail(new Error(`duplicate ${t.name} ${String(v.id)}`)) : ok(put(t, v)),
        onConflictDoNothing: async () => (rows(t).has(v.id) ? null : put(t, v)),
        onConflictDoUpdate: async (u: Partial<Row> | ((r: Row) => Partial<Row>)) => {
          const prev = rows(t).get(v.id);
          if (!prev) return put(t, v);
          return put(t, { ...prev, ...(typeof u === 'function' ? u(prev) : u) } as Row);
        },
      }),
    }),
    update: (t: Table, k: { id: unknown }) => ({
      set: async (u: Partial<Row> | ((r: Row) => Partial<Row>)) => {
        const prev = rows(t).get(k.id);
        if (!prev) throw new Error(`no ${t.name} ${String(k.id)}`);
        return put(t, { ...prev, ...(typeof u === 'function' ? u(prev) : u) } as Row);
      },
    }),
    sql: {
      select: () => ({
        from: (t: Table) => ({ where: async (pred?: Pred) => [...rows(t).values()].filter(pred ?? (() => true)) }),
      }),
    },
  };
  return { db, rows: (name: string) => [...(tables.get(name)?.values() ?? [])] };
}
