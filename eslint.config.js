import js from "@eslint/js";
import tseslint from "typescript-eslint";
import solid from "eslint-plugin-solid";

/**
 * Flat config. Goal: catch dead code (unused vars/imports), accidental
 * promises, and Solid reactivity footguns — without fighting the codebase's
 * deliberate `any` zones (wasm shims, ws payloads) or its logging.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "data/**",
      "patches/**",
      "**/*.wasm",
      "docs/**",
      // Third-party reference snapshots (git-ignored, carry their own configs).
      "remote-code-ref/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["web/src/**/*.{ts,tsx}"],
    extends: [solid.configs["flat/typescript"]],
    rules: {
      // Solid refs are let-bindings assigned by the compiled `ref={var}` prop —
      // the assignment is invisible to this ESLint 10 rule.
      "no-unassigned-vars": "off",
      // Systematic false positives here: AG Grid cell renderers are one-shot
      // plain functions (not components, early returns are fine), and event
      // helpers read signals at call time by design.
      "solid/reactivity": "off",
      "solid/components-return-once": "off",
    },
  },
  {
    rules: {
      // Dead code: underscore prefix marks intentional unused.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // The codebase uses `any` deliberately (pandoc.wasm, daemon payloads).
      "@typescript-eslint/no-explicit-any": "off",
      // Empty catches are an accepted idiom here (best-effort paths).
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
);
