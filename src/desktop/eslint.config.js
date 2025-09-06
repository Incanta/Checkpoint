/* eslint-disable @typescript-eslint/no-require-imports */
const { defineConfig } = require("eslint/config");

const tsParser = require("@typescript-eslint/parser");
const typescriptEslint = require("@typescript-eslint/eslint-plugin");
const preferArrow = require("eslint-plugin-prefer-arrow");
const _import = require("eslint-plugin-import");

const { fixupPluginRules } = require("@eslint/compat");

const globals = require("globals");
const js = require("@eslint/js");

const { FlatCompat } = require("@eslint/eslintrc");

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

module.exports = defineConfig([
  {
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2020,
      sourceType: "module",
      parserOptions: {},

      globals: {
        ...globals.node,
      },
    },

    plugins: {
      "@typescript-eslint": typescriptEslint,
      "prefer-arrow": preferArrow,
      import: fixupPluginRules(_import),
    },

    extends: compat.extends(
      "eslint:recommended",
      "plugin:@typescript-eslint/recommended",
      "plugin:prettier/recommended",
    ),

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

    ignores: [
      // Logs
      "logs",
      "*.log",

      // Runtime data
      "pids",
      "*.pid",
      "*.seed",

      // Coverage directory used by tools like istanbul
      "coverage",
      ".eslintcache",

      // Dependency directory
      // https://www.npmjs.org/doc/misc/npm-faq.html//should-i-check-my-node_modules-folder-into-git
      "node_modules",

      // OSX
      ".DS_Store",

      "release/app/dist",
      "release/build",
      ".erb/dll",

      ".idea",
      "npm-debug.log.*",
      "*.css.d.ts",
      "*.sass.d.ts",
      "*.scss.d.ts",

      // eslint ignores hidden directories by default:
      // https://github.com/eslint/eslint/issues/8429
      "!*.erb",
    ],
  },
]);
