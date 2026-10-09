import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", ".wrangler/**", ".venv/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: { console: "readonly" } },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: {
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
        URL: "readonly",
        crypto: "readonly",
        performance: "readonly",
        console: "readonly",
      },
    },
  },
);
