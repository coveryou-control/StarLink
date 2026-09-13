/**
 * Draft autosave (doc §51, UC-C05, §19.6).
 *
 * Three rules, all of them privacy properties rather than conveniences:
 *
 *   * **Client-only.** A draft is never sent to the server without a deliberate user
 *     action. Half-written text is not a message, and posting it on someone's behalf —
 *     even into a "drafts" table — means the company holds words the person never
 *     chose to send. Server-side drafts are FUTURE (§42) and deliberately absent.
 *   * **IndexedDB, not localStorage.** Survives a tab crash and a refresh, and is not
 *     capped at a few megabytes the way localStorage is.
 *   * **Scoped by conversation AND principal.** A shared machine must not surface one
 *     colleague's unsent text to the next person who signs in.
 */

const DB_NAME = 'starlink-employee';
const DB_VERSION = 1;
const STORE = 'drafts';

export interface Draft {
  /** `${principalId}:${conversationId}` — the composite scope key. */
  readonly key: string;
  readonly principalId: string;
  readonly conversationId: string;
  readonly body: string;
  /** Internal notes and customer replies are different drafts in the same thread. */
  readonly visibility: 'INTERNAL' | 'CUSTOMER_VISIBLE';
  readonly updatedAt: number;
}

export const draftKey = (principalId: string, conversationId: string, visibility: string): string =>
  `${principalId}:${conversationId}:${visibility}`;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb open failed'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = fn(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexeddb request failed'));
    });
  } finally {
    db.close();
  }
}

export const DraftStore = {
  async save(draft: Omit<Draft, 'key' | 'updatedAt'>): Promise<void> {
    const trimmed = draft.body;
    const key = draftKey(draft.principalId, draft.conversationId, draft.visibility);

    // An empty draft is a DELETED draft, not a stored empty string. Otherwise clearing
    // the composer leaves a record that the person was once typing here.
    if (trimmed.trim() === '') {
      await withStore('readwrite', (store) => store.delete(key));
      return;
    }

    await withStore('readwrite', (store) =>
      store.put({ ...draft, body: trimmed, key, updatedAt: Date.now() } satisfies Draft),
    );
  },

  async load(
    principalId: string,
    conversationId: string,
    visibility: Draft['visibility'],
  ): Promise<Draft | undefined> {
    const result = await withStore<Draft | undefined>('readonly', (store) =>
      store.get(draftKey(principalId, conversationId, visibility)) as IDBRequest<Draft | undefined>,
    );
    // A draft belonging to someone else must never surface, even if the key were
    // somehow reachable — belt to the composite key's braces on a shared machine.
    if (result !== undefined && result.principalId !== principalId) return undefined;
    return result;
  },

  /** Called after a successful send: the text is now a message, not a draft. */
  async clear(principalId: string, conversationId: string, visibility: Draft['visibility']): Promise<void> {
    await withStore('readwrite', (store) => store.delete(draftKey(principalId, conversationId, visibility)));
    /* Sending clears the draft, and the sidebar must stop saying "Draft:" at the same
       moment the message appears — otherwise the row contradicts the thread. */
    announceDraftChange();
  },

  /**
   * Every conversation this person has unsent words in, and what they say.
   *
   * The sidebar shows "Draft: …" in place of the last message, which needs all of them at
   * once — there was no way to ask for that, only for one draft at a time by conversation.
   *
   * Empty bodies are dropped rather than returned: clearing a composer leaves a row behind
   * until the next write, and a row whose body is `''` is not a draft, it is the absence of
   * one. Filtering here means no caller has to remember that.
   *
   * Reads every draft and filters in memory, as `clearAllFor` does. The store holds one
   * row per conversation the person has typed in and never touched, so this is tens of
   * rows, not thousands; an index on `principalId` would be a schema migration for a scan
   * that costs nothing at this size.
   */
  async listFor(principalId: string): Promise<ReadonlyMap<string, string>> {
    const all = await withStore<Draft[]>('readonly', (store) => store.getAll() as IDBRequest<Draft[]>);
    const drafts = new Map<string, string>();
    for (const draft of all) {
      if (draft.principalId !== principalId) continue;
      const body = draft.body.trim();
      if (body === '') continue;
      drafts.set(draft.conversationId, body);
    }
    return drafts;
  },

  /** Called on sign-out. One person's unsent words must not outlive their session. */
  async clearAllFor(principalId: string): Promise<number> {
    const all = await withStore<Draft[]>('readonly', (store) => store.getAll() as IDBRequest<Draft[]>);
    const theirs = all.filter((draft) => draft.principalId === principalId);
    for (const draft of theirs) {
      await withStore('readwrite', (store) => store.delete(draft.key));
    }
    return theirs.length;
  },
};

/**
 * Debounced autosave.
 *
 * Writing on every keystroke would be wasteful; writing only on blur would lose text
 * to a crash. A short debounce is the honest middle, and the same reasoning as
 * FR-READ-4's "must not write on every scroll event".
 */
/**
 * Fired when a draft is written, so anything rendering them can re-read.
 *
 * A window event rather than shared state: the composer and the sidebar sit on opposite
 * sides of the tree with no common owner below the shell, and this carries no data — the
 * answer still comes from the store. The same shape `announceAvatarChange` uses.
 */
export const DRAFT_CHANGED_EVENT = 'starlink:draft-changed';

export function announceDraftChange(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DRAFT_CHANGED_EVENT));
}

export function createDraftAutosaver(delayMs = 400): {
  schedule: (draft: Omit<Draft, 'key' | 'updatedAt'>) => void;
  flush: () => Promise<void>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Omit<Draft, 'key' | 'updatedAt'> | undefined;

  const write = async (): Promise<void> => {
    if (pending === undefined) return;
    const draft = pending;
    pending = undefined;
    await DraftStore.save(draft);
    /* The sidebar renders "Draft: …" from these and has no other way to learn one
       changed — the store is IndexedDB, which notifies nobody. */
    announceDraftChange();
  };

  return {
    schedule(draft) {
      pending = draft;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void write(), delayMs);
    },
    async flush() {
      if (timer !== undefined) clearTimeout(timer);
      await write();
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      pending = undefined;
    },
  };
}
