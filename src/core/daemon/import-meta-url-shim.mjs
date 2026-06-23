// esbuild outputs this daemon as CommonJS (format: "cjs"). In CJS output
// esbuild replaces `import.meta` with an empty object, so any dependency that
// reads `import.meta.url` at module load (e.g. the `open` package) receives
// `undefined` and throws ERR_INVALID_ARG_TYPE in fileURLToPath.
//
// esbuild.config.mjs maps `import.meta.url` to the `importMetaUrl` identifier
// via `define`, and injects this binding into every module via `inject`. At
// runtime __filename is the bundle path, giving a valid file:// URL.
export const importMetaUrl = require("url").pathToFileURL(__filename).href;
