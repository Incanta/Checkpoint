// Replacement for the `server-only` package in tests. The real package's
// index.js throws to enforce that server-only modules aren't bundled into
// client code; in tests we just need it to do nothing.
export {};
