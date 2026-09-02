/**
 * `fake-indexeddb` provides a real IndexedDB implementation over an in-memory backend,
 * so the draft tests exercise the actual transaction/keyPath semantics rather than a
 * hand-written stub that would agree with whatever the code happens to do.
 */
import 'fake-indexeddb/auto';
