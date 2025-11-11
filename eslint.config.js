import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-plugin-prettier/recommended";

export default tseslint.config(
  // Ignore patterns
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },

  // Base ESLint recommended rules for all files
  eslint.configs.recommended,

  // JavaScript files configuration
  {
    files: ["**/*.js"],
    ...eslint.configs.recommended,
  },

  // TypeScript files configuration
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript specific rules
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/require-await": "warn",

      // General rules
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-const": "warn",
      "no-var": "error",

      // Code quality
      eqeqeq: ["error", "always"],
      "no-unused-expressions": "error",
      "no-duplicate-imports": "error",
    },
  },

  // Prettier integration (must be last)
  prettier
);
