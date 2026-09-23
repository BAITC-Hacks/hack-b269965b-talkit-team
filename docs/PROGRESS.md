# Progress

## 2026-09-23 — Web folder organization

- Extracted the existing starter echo screen into `pages/EchoPage.vue`, feature UI,
  and a `useEcho` state composable under `src/web/features/echo/`.
- Split generic HTTP handling from echo and health endpoint calls; updated existing
  API client tests to import the new modules.
- Moved BaseButton to shared UI, extracted AppHeader, and scoped component styles.
  Global CSS now contains base styles and design tokens.
- Added `src/web/README.md` with ownership and dependency rules. No new product
  features or external integrations were introduced.
- Installed dependencies from the unchanged lockfile. `pnpm run check` passed:
  type checks and all 32 tests, including initial Vue SSR rendering and API tests.
- The first `pnpm run verify` stopped at the missing local `.env` check. Ran the
  existing setup script to create `.env` from the non-secret example defaults.
- Final `pnpm run verify`: diagnostics passed, then repository-wide formatting
  stopped on the unchanged root `README.md`. No other formatting issues were reported.
- Ran the remaining build and smoke checks separately: `pnpm run build` passed;
  `pnpm run smoke:built` passed health, echo, API 404, built SPA, and asset checks.
- Interactive browser behavior and visual layout were not manually checked.
- `docs/BRIEF.md` and `docs/PREEXISTING.md` were absent from this checkout.
