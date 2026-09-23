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

## 2026-09-23 — shadcn-vue essentials

- Configured Tailwind CSS 4, the Vite plugin, the CLI registry, and the web alias.
- Installed only the Button and Textarea primitives used by the existing echo form.
  Adapted generated imports to the repository's relative `.ts` import convention
  and fixed generated Textarea typing under strict TypeScript settings.
- Reused the existing demo's busy behavior through `BaseButton` and mapped shadcn
  colors to the current palette. Removed the icon dependency added by the CLI,
  since these primitives do not use it.
- `pnpm run check` passed: type checks and all 32 tests.
- `pnpm run verify` passed: diagnostics, formatting, types, tests, build, and
  smoke checks. Formatted only table spacing in the root `README.md` to satisfy
  the existing repository-wide formatting gate.
- Browser layout was not manually inspected.

## 2026-09-23 — shadcn-vue regression audit

- Reviewed dependency and component changes and confirmed the generated Button
  forwards submit and busy attributes in rendered HTML.
- Found that the generated Textarea's content sizing conflicts with the existing
  five-row field. Restored fixed field sizing for the echo form and added render
  assertions for Textarea and Button attributes.
- Tailwind's preflight removed the page headings' implicit bold weight; restored
  explicit heading weights. Restored the enabled Button's pointer cursor.
- `pnpm run verify` passed after these repairs: diagnostics, formatting, types,
  all 32 tests, build, and built API/SPA smoke checks. Browser inspection was
  unavailable because no browser surface was exposed in this session.
