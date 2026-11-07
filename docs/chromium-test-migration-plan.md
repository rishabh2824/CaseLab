# Move the jsdom test suite to Chromium (Vitest browser mode)

## Context
24 test files in `tests/` run in jsdom (the `client` project in `vite.config.ts`: `*.svelte.test.ts` and `*.dom.test.ts`). jsdom has no layout, CSS, animation or real input, so:
- the suite carries workarounds in `tests/support/setup.client.ts`;
- PersonaDiagram can't be tested and is replaced by `tests/support/PersonaDiagramStub.svelte`;
- the Composer ring test has to spy on `getBoundingClientRect`.

The goal is to run all of these tests in real Chromium through Vitest browser mode. You chose a **full rewrite**: tests will use `vitest-browser-svelte`'s `render`, `page` locators, `expect.element` (which retries) and Vitest's real `userEvent`. jsdom and Testing Library will be removed at the end.

The `server` (Node) and `convex` (edge-runtime) projects do not change.

Some tests may break temporarily during the move; you said that's fine. Each numbered step is a self-contained change that can be committed on its own.

**Coordination:** another session has uncommitted edits in `tests/components/case/CaseForm.svelte.test.ts` and some source files (the prompt revision). Land or settle those before steps 21–24.

---

## Phase A — Set up the browser project (no tests moved yet)

**1. Install packages.** Use the terminal, take the latest versions, and keep the `>=` range policy:
`pnpm add -D @vitest/browser-playwright vitest-browser-svelte`

**2. Add a `browser` project to `vite.config.ts`** next to `client`:
- Add `extends: "./vite.config.ts"`, `name: "browser"`, and `browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: "chromium" }] }`.
- Add `setupFiles: ["./tests/support/setup.browser.ts"]`.
- Keep a `const inBrowser: string[] = []` list of migrated file paths. Use it as the browser project's `include`, and add it to the `client` project's `exclude`. Moving a file is then one line, and no file is renamed.

**3. Create `tests/support/setup.browser.ts`.** Start from `setup.client.ts`, then:
- Keep:
  - the `__sveltekit_dev` global;
  - the `vi.mock`s for `$app/navigation`, `convex-svelte` (via `convexSvelteModule` from `tests/support/convexFake.svelte.ts`) and `svelte-sonner`;
  - the `afterEach` that calls `convexFake.reset()`, clears `sessionStorage` and resets `document.body.style.pointerEvents`.
- Drop:
  - the jest-dom import (Vitest browser mode has these matchers built in);
  - the `scrollIntoView`, `getClientRects`, `randomUUID` and `createObjectURL` shims;
  - MSW. Only `tests/case/submitCase.test.ts`, a server-project test, uses MSW, so `tests/support/msw.ts` stays for that project.

**4. Make `pnpm test` install Chromium first.** Use the same pattern as `test:e2e`: `"test": "playwright install chromium && vitest run"`.

**5. Pilot with `tests/components/student/SimulationClock.svelte.test.ts`** (48 lines). Rewrite it using the conversion rules below and add it to `inBrowser`. Then confirm three things:
- it passes with `pnpm exec vitest run --project browser`;
- v8 coverage now includes the browser project;
- `pnpm run check` and `pnpm run lint` are clean.

This step proves the setup works before anything else moves.

---

## Conversion rules (apply in every migration step)
| jsdom / Testing Library | Chromium / vitest-browser-svelte |
|---|---|
| `render(C, { props })` from `@testing-library/svelte` | `await render(C, props)` from `vitest-browser-svelte`; cleanup is automatic |
| `screen.getByRole/Text/LabelText/...` | `page.getByRole/...` from `vitest/browser`, or the locators `render` returns |
| `expect(el).toBeInTheDocument()` / `toHaveValue` / `toBeDisabled` … | `await expect.element(locator).toBeInTheDocument()` etc. These retry, so drop `waitFor` and `findBy*` |
| `queryBy*(...)` with `toBeNull()` | `await expect.element(locator).not.toBeInTheDocument()` |
| `within(x).getBy*` | `xLocator.getBy*` (locators chain) |
| `userEvent.setup()`, `user.click/type/clear/upload` | `userEvent` from `vitest/browser`, or `locator.click()/fill()/clear()/upload()`. Use `userEvent.keyboard` for Enter or Shift+Enter |
| `fireEvent.x` | A real interaction. Where none exists (e.g. IME `isComposing` in `studentPage`), use `element.dispatchEvent(new KeyboardEvent(...))` |
| `vi.spyOn(moduleNamespace, "x")` | `vi.mock(path, { spy: true })` plus `vi.mocked(...)`. ESM namespaces are sealed in the browser. Spies on objects (`console`, `history`, `URL`) still work |
| `vi.waitFor` on store state | unchanged |

Other rules:
- **Fake timers:** keep `toFake` narrow (as `Composer.svelte.test.ts` already does), so locator retries still advance.
- **Shared page state:** tests share a page, so reset any global state a test changes.
- **Delete jsdom workarounds** as each file moves. For example, the `window.matchMedia` stub in `wrappers.svelte.test.ts`, and the `scrollIntoView`/`scrollTo` stubs in `studentPage.svelte.test.ts` unless a test asserts on them.

---

## Phase B — Logic and store tests (little or no rendering)
Mostly mechanical: these files rarely use Testing Library. One step per file:
6. `tests/session.svelte.dom.test.ts` and `tests/authClient.dom.test.ts` (both small; one step)
7. `tests/case/caseDraft.svelte.test.ts`
8. `tests/case/graph.svelte.test.ts`
9. `tests/case/caseFormStore.svelte.test.ts`
10. `tests/student/run.svelte.test.ts` (881 lines; mostly `vi.waitFor` on store state)
11. `tests/case/leaveGuard.svelte.test.ts` (still uses `tests/support/LeaveGuardHarness.svelte`)

## Phase C — Import, export and PDF tests
12. `tests/case/importCase.dom.test.ts` and `tests/case/roundTrip.dom.test.ts` (`DOMParser` is native)
13. `tests/case/exportCase.dom.test.ts`. The `buildHTMLForm's embedded script` tests use `new JSDOM(html, { runScripts })`. Instead, load the HTML into an `<iframe srcdoc>` with `sandbox="allow-scripts allow-same-origin"` and wait for `load`.
    - The `randomUUID` override can't be injected before the iframe's scripts run. Assert the UUID format and uniqueness instead of exact values.
    - The XSS checks (`__pwned`) read the iframe's window.
14. `tests/student/pdf.dom.test.ts`

## Phase D — Small components
15. `tests/components/ui/AdminTopBar.svelte.test.ts`
16. `tests/components/case/CaseList.svelte.test.ts`
17. `tests/components/case/PersonaFields.svelte.test.ts`. Use `locator.upload(file)` for the photo.
18. `tests/components/student/Composer.svelte.test.ts`. Drop the `getBoundingClientRect` spy. Assert on the real CSS transition instead: `ring.getAnimations()[0]`, its `effect.getKeyframes()` (the start offset, e.g. 51.5 after a reload) and its `effect.getTiming().duration`. Use `getComputedStyle(ring).strokeDashoffset` for the end state.

## Phase E — Route tests
19. `tests/routes/landing.svelte.test.ts` and `tests/routes/adminPages.svelte.test.ts`
20. `tests/routes/wrappers.svelte.test.ts` (remove the `matchMedia` stub) and `tests/routes/adminsPage.svelte.test.ts`
21. `tests/routes/caseLists.svelte.test.ts` and `tests/routes/adminLayout.svelte.test.ts`. Since `history.replaceState` is real, restore the URL in `afterEach`.
22. `tests/routes/studentPage.svelte.test.ts`, in two steps:
    - 22a: lifecycle, contacts and files, and the chat pane;
    - 22b: composer, notes, authors and PDF export.
    - Until 22b lands, the half-moved file is listed in both projects with a `describe` filter, or split into two files; whichever is less churn.

## Phase F — CaseForm and the real diagram
23. `tests/components/case/CaseForm.svelte.test.ts` (1298 lines), moved one `describe` group per step. Split it into files under `tests/components/case/caseForm/` that share a `support.ts` built from today's top-of-file helpers (`makeCaseDoc`, `stubLoadCase`, `stubMutations`, `renderForm`, `fillValidCase`, `openTab`):
    - 23a: create-mode validation and submit, edit mode, teaching notes
    - 23b: tabs, view-only, template mode, concurrent saves, unsaved-changes guard
    - 23c: the persona editor
    - 23d: import, and the collaborator picker
24. **Remove `PersonaDiagramStub.svelte`** and the `vi.mock` of `PersonaDiagram.svelte`. Update the persona-editor tests to click the real diagram nodes and edges, using the accessible names @xyflow renders.
25. **Add `tests/components/case/PersonaDiagram.svelte.test.ts`**, the coverage jsdom could never give:
    - one node per persona and one edge per referral;
    - clicking a node or edge calls `onSelect` / `onSelectReferral`;
    - dragging from one persona's handle onto another adds a referral (`userEvent.dragAndDrop`);
    - a node renders `PersonaNode` content (name, role).

## Phase G — Remove jsdom
26. Delete the `client` project and the `inBrowser` list. The browser project then includes `tests/**/*.svelte.{test,spec}.{js,ts}` and `tests/**/*.dom.{test,spec}.{js,ts}`, with the same globs as today, so no renames.
27. Delete `tests/support/setup.client.ts`. Remove dependencies from the terminal: `pnpm remove jsdom @types/jsdom @testing-library/svelte @testing-library/user-event @testing-library/jest-dom`. Then grep `tests/` for any leftover imports.
28. Optional speed pass. Try `browser.isolate: false` or run test files in parallel. Keep it only if the full suite stays green across 3 runs.

---

## Verification
- **Every step:**
  - `pnpm exec vitest run --project browser <moved files>` passes;
  - `pnpm exec vitest run --project client` still runs whatever hasn't moved yet (temporary failures are acceptable);
  - `pnpm run check` and `pnpm run lint` are clean for the touched files.
- **After Phase G:**
  - `pnpm run test`: all three projects green, and the test count is at least today's 632 (plus the new diagram tests);
  - `pnpm exec vitest run --coverage`: statement and branch totals are no lower than today's 97.7% / 91.1%. `PersonaDiagram.svelte` and `PersonaNode.svelte` should show real, non-zero statement counts;
  - `pnpm run typecheck` (Convex) is unchanged;
  - `pnpm run test:e2e`: all 15 Playwright tests still pass (they are untouched, but they share the Chromium install);
  - grep `tests/` and `package.json` for `jsdom` or `@testing-library`: no matches.
