// Strict typed-linting config for @cplieger/actions.
//
// The shared, org-synced ruleset lives in eslint.config.base.mjs (synced from
// cplieger/ci). Do NOT edit the base here — the next sync would clobber it. This
// file imports the base and layers the two repo-specific deltas on top:
//   1. *.mjs handling — the base is vendored as a bare `eslint.config.base.mjs`
//      (a `.mjs` that does not match the base's `*.config.mjs` glob), so the lint
//      run must allow it under the default project and drop type-checked rules.
//   2. A few extra test-file relaxations the actions suite relies on (void-typed
//      callbacks, empty stub fns, throw-literal characterization, single-line if,
//      non-null-asserted optional chains) that the shared preset does not grant.

import baseConfig from "./eslint.config.base.mjs";

const LOCAL_MJS = "*.mjs";

export default [
  ...baseConfig.map((block) => {
    // Project-setup block: add *.mjs to allowDefaultProject. Kept as the single
    // projectService block — a second global projectService entry breaks tsconfig
    // discovery for the test files.
    const adp = block.languageOptions?.parserOptions?.projectService?.allowDefaultProject;
    if (Array.isArray(adp) && !adp.includes(LOCAL_MJS)) {
      return {
        ...block,
        languageOptions: {
          ...block.languageOptions,
          parserOptions: {
            ...block.languageOptions.parserOptions,
            projectService: {
              ...block.languageOptions.parserOptions.projectService,
              allowDefaultProject: [LOCAL_MJS, ...adp],
            },
          },
        },
      };
    }

    // disableTypeChecked block: the base lists only *.config.mjs, which misses the
    // bare-named vendored base; add *.mjs so it isn't type-checked.
    if (
      Array.isArray(block.files) &&
      block.files.includes("*.config.mjs") &&
      !block.files.includes(LOCAL_MJS)
    ) {
      return { ...block, files: [...block.files, LOCAL_MJS] };
    }

    return block;
  }),

  // Extra test-file relaxations (layered after the base's disableTypeChecked so
  // the non-type-checked rules among these actually turn off for tests).
  {
    files: ["**/*.test.ts", "**/*.fuzz.test.ts", "**/*.property.test.ts"],
    rules: {
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "off",
      "@typescript-eslint/no-deprecated": "off",
      "no-throw-literal": "off",
      curly: "off",
    },
  },
];
