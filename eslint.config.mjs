// Lint wie im Obsidian-Community-Store: eslint-plugin-obsidianmd prüft u. a.
// per no-unsupported-api statisch, dass keine API neuer als minAppVersion
// (manifest.json, 1.12.4) verwendet wird.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{
		ignores: ["main.js", "node_modules/**", "test-vault/**", "esbuild.config.mjs", "version-bump.mjs"],
	},
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs"],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
]);
