import path from "path";
import { fileURLToPath } from "url";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { FlatCompat } from "@eslint/eslintrc";
import { fixupPluginRules } from "@eslint/compat";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import preferArrow from "eslint-plugin-prefer-arrow";
import importPlugin from "eslint-plugin-import";
import globals from "globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

export default tseslint.config(
  // ===========================================================
  // Global ignores
  // ===========================================================
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/lib/**",
      "**/build/**",
      "src/app/.next/**",
      "src/seaweedfs/**",
      "src/longtail/**",
      "logs/**",
      "**/*.log",
      "**/*.pid",
      "**/*.seed",
      "**/coverage/**",
      "**/.eslintcache",
      "**/.DS_Store",
      "**/*.css.d.ts",
      "**/*.sass.d.ts",
      "**/*.scss.d.ts",
    ],
  },

  // ===========================================================
  // Core & Desktop — TypeScript + Prettier
  // ===========================================================
  {
    files: ["src/core/**/*.{ts,tsx}", "src/clients/desktop/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      eslintPluginPrettierRecommended,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "prefer-arrow": preferArrow,
      import: fixupPluginRules(importPlugin),
    },
    rules: {
      semi: ["error", "always"],
      indent: "off",
      "max-len": "off",
      "no-empty-function": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/explicit-member-accessibility": ["warn"],
      "@typescript-eslint/explicit-function-return-type": ["warn"],
      "@typescript-eslint/no-unused-vars": ["warn"],
    },
  },

  // ===========================================================
  // App — Next.js + TypeScript (type-checked)
  // ===========================================================
  ...compat.extends("next/core-web-vitals").map((config) => ({
    ...config,
    files: ["src/app/**/*.{ts,tsx,js,jsx}"],
  })),
  {
    files: ["src/app/**/*.{ts,tsx}"],
    extends: [
      ...tseslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: path.join(__dirname, "src", "app"),
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
