# Source projects and handoff

A native archive contains `studio.project.json`, `package.json`, an npm lockfile, React/Storybook configuration, canonical page/controller/style source, Gherkin, scenario mappings, fixtures, provider modules, and referenced assets. Keep archive paths relative to its root. Source is preserved on import; derived editor anchors are rebuilt.

Exports exclude credentials, agent configuration, node_modules, local history, and caches. Private package implementations are not vendored. A recipient supplies their own registry authentication and runs:

```sh
npm ci --ignore-scripts
npm run dev
npm run storybook
npm run build
npm run build-storybook
npx playwright install chromium
npm run test:scenarios
```

The exported scenario tests parse the selected Gherkin, require an explicit check for every step, and exercise the mapped Storybook story. A designer must review the test interpretation in Studio. The typed query/operation adapter lives in `src/data`; replace its data methods while retaining validation and interaction state in pages/controllers. Scenario fixtures should provide their own initial state and reset behavior.

## Legacy React/Vite Storybook source

The adapter targets CSF TSX source with imported page components, default metadata objects or identifiers (including `as`/`satisfies` forms), named object stories, args, render functions, decorators, and parameters. Preserve complete local controller, provider, stylesheet, font, and asset closure. Dependencies must have exact published npm versions and a matching lockfile. Original hooks, controlled properties, render functions, and decorators remain source. Choose an original story as the editing preview so its args, render function, decorators, and global preview setup remain active. Import inspects the published contracts of external JSX packages; insufficient information produces a concrete library gap.

Supply matching `.feature` documents. Gherkin blocks in Markdown are proposed for review and correction; prose is not automatically treated as executable requirements. Story order and names do not prove business equivalence. In Check delivery, choose existing scenario stories and explicitly map each requirement to its page/story. This keeps the story's original initial-state data and creates no new business scope. Ask Studio for missing executable checks, then review their interpretation. Missing requirements block editing, and discrepancies need explicit reconciliation.

Computed metadata, unsupported dynamic loading, incomplete aliases/bundler plugins, missing source closure, nonportable local dependencies, static Storybook builds, screenshots, and HTML-only exports do not establish full editability. They receive a compatibility diagnostic while the original archive stays intact. Preview-only import is not presented as a successful editable conversion.

## Safety and acceptance

Absolute paths, traversal, duplicate archive entries, symlinks, oversized source, and credential-bearing configuration are rejected. Source/requirements/dependencies change through one transaction. Stale or ambiguous selections stop rather than editing a different component.

Delivery checks build and run React and Storybook, detect runtime errors, and execute reviewed scenario steps with suitable fixtures. Missing mappings, assertions, initial data, or dependency versions remain incomplete. Inspect the final desktop experience as the last acceptance step.

The exported scenario runner starts its own local Storybook server and does not reuse an unrelated existing server. Set `STUDIO_STORYBOOK_PORT` to an available port if 6006 is already in use. `STUDIO_CHROME` can point to an existing compatible Chromium executable; otherwise install Playwright Chromium as shown above.
