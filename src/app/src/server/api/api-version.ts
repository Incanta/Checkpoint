// The actual values come from versions.json (regenerated into
// versions-generated.ts by scripts/set-version.js). We keep a local copy
// rather than re-exporting from @checkpointvcs/common because common has a
// type-only import of @checkpointvcs/app, which would create a build-time
// dist/-as-input cycle if app pulled them through common.
export {
  SERVER_API,
  MIN_SERVER_API,
  SERVER_VERSION,
} from "./versions-generated.js";
