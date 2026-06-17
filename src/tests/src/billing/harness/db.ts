// Per-test SQLite database for billing tests — re-export of the canonical
// harness DB. The shared version's `tableOrder` includes the premium
// tables (Invoice, License, OrgStoragePeak, etc.), so there's nothing
// premium-specific left here.
export { createTestDb, type TestDb } from "../../harness/db";
