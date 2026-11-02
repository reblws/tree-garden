import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    // Agent worktrees live under .claude/worktrees; don't run their copies of the tests.
    exclude: [...configDefaults.exclude, '.claude/**'],
    setupFiles: ['./src/vitest-setup.ts'],
    server: { deps: { inline: ['foldkit', '@foldkit/devtools'] } },
  },
})
