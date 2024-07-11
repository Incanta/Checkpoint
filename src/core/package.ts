import { promisify } from "util";
import { exec } from "child_process";

// TODO --minify crashes bun currently
const buildPrefix = `bun build --compile --sourcemap`;

const packages = {
  cli: "packages/client/src/bin.ts",
};

for (const [outFile, sourceEntry] of Object.entries(packages)) {
  await promisify(exec)(
    `${buildPrefix} --outfile ./dist/${outFile} ${sourceEntry}`
  );
}
