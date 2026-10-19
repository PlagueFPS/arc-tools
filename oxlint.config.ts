import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc"],
  categories: {
    correctness: "error",
  },
  ignorePatterns: [
    "**/dist/**",
    "**/.turbo/**",
    ".repos/**",
    ".vscode/**",
    ".cursor/**",
    "**/.alchemy/**",
    "**/.cloud-tests/**",
  ],
});
