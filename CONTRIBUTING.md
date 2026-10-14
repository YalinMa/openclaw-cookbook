# Contributing

**English** · [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for helping! New recipes, fixes, translations and better explanations are all welcome.

## Adding a recipe

1. Create `examples/NN-short-name/` with:
   - `workflow.json`: a Lobster workflow with `name`, `description` and an `args` entry (with `default` and `description`) for everything a user might change
   - `README.md` and `README.zh-CN.md`, following the structure of the existing recipes (what you'll learn, run it, example output, how it works, ideas, troubleshooting)
   - sample data if the recipe needs input files
2. Follow the house rules:
   - **Never splice data into shell commands.** Pass step output with `stdin` or `env`, and args as `$LOBSTER_ARG_NAME`.
   - The recipe should run with its defaults and without accounts where possible (free public APIs, sample files).
   - Anything that sends, posts, deletes or spends money goes behind an `approval` step.
   - Prefer reversible actions (move, not delete).
   - Only use `node` and `curl` in steps (both are available wherever OpenClaw runs).
3. Add test cases to `scripts/test-recipes.mjs` that check the *content* of the result.
4. Run:

   ```bash
   npm install
   npm run validate
   npm test
   ```

5. Add the recipe to both READMEs.

## Reporting a problem

Please include your `openclaw --version`, the plugin version (`openclaw plugins list`), the recipe, and the exact error (`openclaw logs --follow` helps).

## Commit style

Short imperative subject (`Add recipe 11: RSS to Notion`), with details in the body if needed.
