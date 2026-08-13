import type { BunPlugin } from "bun";
import { readFile } from "node:fs/promises";
import { transformAsync } from "@babel/core";
import tsPreset from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";

/**
 * SolidJS JSX transform for .jsx/.tsx sources.
 * (bun-plugin-solid@1.0.0 parses TSX without `isTSX: true` and breaks on it,
 * so we call Babel with the correct preset options ourselves.)
 */
export default {
  name: "solid-tsx-transform",

  setup(build) {
    build.onLoad({ filter: /\.(js|ts)x$/ }, async (args) => {
      const code = await readFile(args.path, "utf8");
      const isTs = args.path.endsWith(".tsx") || args.path.endsWith(".ts");
      const out = await transformAsync(code, {
        filename: args.path,
        // Babel runs presets last-to-first: preset-typescript (with isTSX)
        // strips types while preserving JSX, then babel-preset-solid compiles
        // the JSX. Requires @babel/core + preset-typescript v7 (v8 removed
        // the isTSX/allExtensions options).
        presets: [
          [solidPreset, { generate: "dom" }] as const,
          ...(isTs ? [[tsPreset, { isTSX: true, allExtensions: true }] as const] : []),
        ],
        sourceMaps: false,
        babelrc: false,
        configFile: false,
      });
      return { contents: out?.code ?? code, loader: "js" };
    });
  },
} as BunPlugin;
