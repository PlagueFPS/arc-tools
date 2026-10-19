import { defineConfig } from "oxfmt";

export default defineConfig({
  useTabs: false,
  tabWidth: 2,
  printWidth: 80,
  sortImports: {},
  sortPackageJson: false,
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
