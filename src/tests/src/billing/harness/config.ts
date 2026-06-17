// Re-export of the canonical harness config so billing tests mutate the
// same in-memory map the global @incanta/config mock reads from. The mock
// is registered against `src/harness/config.ts`'s `testConfigShim` (see
// `src/harness/vitest-setup.ts`); if this file kept its own copy of the
// config map, billing tests would set values the app never sees.
export {
  setConfig,
  setConfigMany,
  resetConfig,
  testConfigShim,
} from "../../harness/config";
