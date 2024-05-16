import { pathsToModuleNameMapper } from "ts-jest";
import type { JestConfigWithTsJest } from "ts-jest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { compilerOptions } = require("./tsconfig.json");

const paths: Record<string, string[]> = compilerOptions.paths;

for (const key in paths) {
  paths[key] = paths[key].map((p) => p.replace(/^\./, __dirname));
}

const config: JestConfigWithTsJest = {
  preset: "ts-jest",
  testEnvironment: "node",
  testPathIgnorePatterns: ["node_modules", "dist", "lib"],
  roots: ["<rootDir>"],
  modulePaths: [compilerOptions.baseUrl],
  moduleNameMapper: pathsToModuleNameMapper(paths),
  projects: [
    "<rootDir>/packages/common",
    "<rootDir>/packages/client",
    "<rootDir>/packages/server",
  ],
};

export default config;
