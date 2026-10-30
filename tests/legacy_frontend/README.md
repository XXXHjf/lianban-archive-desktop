# Historical behavior fixtures

These are the exact native frontend modules, HTML and CSS before the Vue migration. Existing Node regression tests use them to preserve the documented behavior and keep the old test oracle reviewable. They are **not** imported by the Vue application, served over HTTP or included in `BUILD_BASELINE.json` / `BUNDLE.json`.

Current frontend tests live under `frontend/src/**/*.test.ts`, and exercise the new implementation. Historical reference tests alone do not validate the Vue UI; type checking, lint, build, current helper/component tests and browser checks are also required.
