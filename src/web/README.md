# Web structure

- `main.ts` boots Vue and imports global styles; `App.vue` selects the current page.
- `pages/` composes features and layout components into screens.
- `features/<feature>/` owns feature components, API calls, and state composables.
- `components/ui/` contains reusable UI primitives.
- `components/layout/` contains shared application layout components.
- `lib/http.ts` owns transport, timeouts, response validation, and API errors.
- `lib/health.ts` contains the shared health endpoint call.
- `styles/` contains global tokens and base styles. Component styles are scoped in Vue files.
- `components/ui/button/` and `components/ui/textarea/` contain the installed
  shadcn-vue primitives. `BaseButton.vue` preserves the demo's busy indicator.

Keep feature-specific code within its feature. Pages connect features using props,
events, and composables. Promote code to shared folders when it has multiple consumers.
Create new folders only when there is implemented code to put in them.

The root `components.json` points the shadcn-vue CLI at `src/web`. The Vite and
TypeScript aliases exist for CLI generation; checked-in web imports use explicit
relative paths. Tailwind CSS and the small theme mapping live in `styles/index.css`.

API schemas and shared types belong in `src/shared/`; frontend code must never import
`src/server/`. Use explicit relative `.ts` imports. Keep state local until multiple
screens require shared ownership.

The `echo` feature remains the starter connectivity demo, not a Voice Router implementation.
Its page creates a `useEcho()` controller once and passes its refs and actions to
`EchoPanel`. Existing API and SSR regression tests remain in the repository's `tests/` folder.
