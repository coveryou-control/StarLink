/**
 * Deletes conversations and everything that references them, transitively, without naming
 * the tables.
 *
 * ## Why this is not a list
 *
 * Two suites hand-wrote their teardown as `outbox → messages → participants →
 * conversations`. Thirteen tables carry a foreign key to `conversation.conversations`, so
 * the list was missing eleven of them, and both suites duly failed in `afterAll` with
 *
 *     update or delete on table "conversations" violates foreign key constraint
 *     "queue_entries_conversation_id_fkey" on table "queue_entries"
 *
 * as soon as a conversation of theirs reached the queue.
 *
 * The obvious repair is to add `queue_entries` to both lists. That repair is wrong for the
 * same reason the original was: the list is a copy of the schema, kept by hand, in two
 * places, and the next migration that adds a child table breaks it again — in teardown,
 * where the failure names a constraint rather than a cause and looks like flake.
 *
 * ## Why one level of children is also not enough
 *
 * The first version of this file read the direct children of `conversations` from the
 * catalog and deleted them in whatever order the scan returned. It claimed, in this
 * docblock, that "a new child table is covered the day it is created". Both halves were
 * wrong, and both were reproduced against the dev database rather than argued about:
 *
 *   * **Order.** `attachments.message_id → messages` is a foreign key BETWEEN two children
 *     of `conversations`. The catalog returns `messages` before `attachments`, so deleting
 *     the children in scan order failed with
 *     `violates foreign key constraint "attachments_message_id_fkey"` — the same error
 *     shape quoted above, one table over.
 *   * **Depth.** `message_revisions`, `delivery_state` and `attachment_scan_results`
 *     reference `messages` and `attachments`, not `conversations`, so a query filtered on
 *     `tgt.relname = 'conversations'` cannot see them at all. A redaction, delivery or
 *     scan test adopting this helper would fail in teardown for precisely the reason the
 *     helper claimed to have eliminated.
 *
 * So the walk is recursive and depth-first: before deleting the rows of any table, delete
 * the rows of every table that references THOSE rows. Order then falls out of the graph
 * instead of being asserted, and depth is whatever the schema actually is.
 *
 * ## Why teardown failing matters at all
 *
 * Every test in both suites had already passed when this first fired. It would be easy to
 * read that as cosmetic and swallow it. It is not: a teardown that dies partway leaves the
 * rows it had not reached, and the next run inherits them. These suites assert on counts
 * and on "the only conversation for this team", so inherited rows do not produce a clean
 * failure — they produce a suite that passes until it doesn't, for reasons that have
 * nothing to do with the change being tested.
 */
import type pg from 'pg';

interface ForeignKey {
  readonly schema: string;
  readonly table: string;
  /** The referencing column on the child. */
  readonly column: string;
  readonly parentSchema: string;
  readonly parentTable: string;
  /** The referenced column on the parent. */
  readonly parentColumn: string;
}

/** Read once per process. The schema does not change under a running test. */
let graph: readonly ForeignKey[] | undefined;

async function foreignKeys(pool: pg.Pool): Promise<readonly ForeignKey[]> {
  if (graph !== undefined) return graph;

  /**
   * Single-column foreign keys only.
   *
   * `conkey`/`confkey` are unnested WITH ORDINALITY and joined on position so a composite
   * key produces one row per column rather than a cross product — and composites are then
   * excluded by `cardinality(con.conkey) = 1`, because a composite reference cannot be
   * expressed by the single-column `IN (SELECT …)` this file builds. There are none today;
   * the filter is here so that adding one produces a missed table rather than silently
   * malformed SQL. The assertion below is what would catch it.
   */
  const found = await pool.query<ForeignKey>(
    `SELECT src_ns.nspname AS schema,
            src.relname     AS table,
            srcatt.attname  AS column,
            tgt_ns.nspname  AS "parentSchema",
            tgt.relname     AS "parentTable",
            tgtatt.attname  AS "parentColumn"
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
       JOIN pg_class tgt ON tgt.oid = con.confrelid
       JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
       JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN unnest(con.confkey) WITH ORDINALITY AS f(attnum, ord) ON f.ord = k.ord
       JOIN pg_attribute srcatt ON srcatt.attrelid = src.oid AND srcatt.attnum = k.attnum
       JOIN pg_attribute tgtatt ON tgtatt.attrelid = tgt.oid AND tgtatt.attnum = f.attnum
      WHERE con.contype = 'f'
        AND cardinality(con.conkey) = 1`,
  );

  /**
   * A guard, not decoration. If this query ever returns nothing — a renamed catalog view, a
   * permission change — the walk below would quietly become "delete the parents only",
   * which fails on the first foreign key and reintroduces exactly the bug this file
   * replaces. Asserted against a known-present edge rather than a bare count, so a query
   * that returns SOME rows but not the ones that matter also fails.
   */
  const hasQueueEntries = found.rows.some(
    (fk) => fk.table === 'queue_entries' && fk.parentTable === 'conversations',
  );
  if (!hasQueueEntries) {
    throw new Error(
      'the foreign-key catalog query did not find queue_entries → conversations, so the ' +
        'purge would delete parents while leaving children. This is a broken query, not a ' +
        'schema without child tables.',
    );
  }

  graph = found.rows;
  return graph;
}

const quote = (fk: { schema: string; table: string }): string => `"${fk.schema}"."${fk.table}"`;

/**
 * Deletes the rows of one table selected by `predicate`, after deleting everything that
 * references them.
 *
 * `predicate` is a SQL boolean over `schema.table` using the same `args`. Children are
 * expressed as `childColumn IN (SELECT parentColumn FROM parent WHERE predicate)`, which
 * nests one level per hop — three at most against this schema.
 */
async function purgeTable(
  pool: pg.Pool,
  fks: readonly ForeignKey[],
  target: { schema: string; table: string },
  predicate: string,
  args: readonly unknown[],
  seen: readonly string[],
): Promise<void> {
  const key = `${target.schema}.${target.table}`;

  /**
   * Cycle and depth guard. `messages.reply_to_message_id → messages` and
   * `categories.parent_id → categories` are self-references, and a self-reference needs no
   * recursion: referential integrity is checked at statement end, so a single DELETE that
   * removes both the referencing and the referenced row succeeds. Without this the walk
   * would not terminate.
   */
  if (seen.includes(key)) return;

  const children = fks.filter(
    (fk) =>
      fk.parentSchema === target.schema &&
      fk.parentTable === target.table &&
      !(fk.schema === target.schema && fk.table === target.table),
  );

  for (const child of children) {
    await purgeTable(
      pool,
      fks,
      { schema: child.schema, table: child.table },
      `"${child.column}" IN (SELECT "${child.parentColumn}" FROM ${quote(target)} WHERE ${predicate})`,
      args,
      [...seen, key],
    );
  }

  await pool.query(`DELETE FROM ${quote(target)} WHERE ${predicate}`, args as unknown[]);
}

/**
 * Deletes every conversation matched by `selectConversationIds`, and everything reachable
 * from them, deepest first.
 *
 * `selectConversationIds` is a SQL SELECT returning one column of conversation ids, and
 * `args` are its parameters — the same shape the suites already had, so the call sites keep
 * their own definition of "conversations this suite owns".
 */
export async function purgeConversations(
  pool: pg.Pool,
  selectConversationIds: string,
  args: readonly unknown[],
): Promise<void> {
  const fks = await foreignKeys(pool);

  /**
   * `outbox` references the conversation by `aggregate_id` with NO foreign key, so it is
   * invisible to the catalog walk and has to be named. Deleted first because nothing
   * references it.
   */
  await pool.query(
    `DELETE FROM conversation.outbox WHERE aggregate_id IN (${selectConversationIds})`,
    args as unknown[],
  );

  await purgeTable(
    pool,
    fks,
    { schema: 'conversation', table: 'conversations' },
    `"conversation_id" IN (${selectConversationIds})`,
    args,
    [],
  );
}
