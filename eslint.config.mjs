import obsidian from "eslint-plugin-obsidianmd";

export default [
	...obsidian.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: { parserOptions: { project: "./tsconfig.json" } },
	},
	{
		ignores: [
			"dist/**",
			"runtime/**",
			"artifacts/**",
			"node_modules/**",
			"tests/**",
			"tools/**",
		],
	},
];
