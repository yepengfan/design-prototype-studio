# Design Prototype Studio

A local macOS workspace for designers building reusable React pages with their team's published React design system. Select existing Gherkin requirements, import npm libraries, edit the live page, review proposed changes, and hand off runnable React and Storybook source.

## Run locally

Use macOS and Node.js 22.18 or newer.

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run dev
```

Open **http://127.0.0.1:4310**. For a production client build, run `npm run build` followed by `npm start`.

Projects and their local history are saved under `~/Library/Application Support/Design Prototype Studio`. `STUDIO_DATA` changes that location; `STUDIO_PORT` changes the loopback port. There is no Studio account or hosted sharing service.

For AI editing, install and sign in to **Codex CLI** or **Cursor Agent** using that tool's normal login. Studio starts its own child process and reuses the existing login. It does not require a new model API key. Prompts use the selected tool's normal inference service. Codex uses `gpt-6.1-sol` with medium effort; Cursor uses the account's configured model. The local adapters have been exercised with Codex 0.166.0 and Cursor Agent 2026.10.18-ea085cb. See [integration behavior](docs/integrations.md).

## Make a page

1. Create a project or import supported source. Choose specific `.feature` files or a folder and inspect the included scenarios. Gherkin is written before entering Studio.
2. Import an exact npm package release. For private registries, sign in with npm outside Studio, then provide the registry address. Review the package identity, version, common states, gaps, and installation trust before applying it. Multiple packages share one searchable component browser while retaining their identities.
3. Generate from the selected requirements or arrange real components in the page outline. Select a component to edit supported properties and layout. Controlled behavior remains in the page. Missing business facts and missing library capabilities require clarification or a library update.
4. Describe changes in the prompt box. Presentation changes preserve the requirements. Business changes require review of the corresponding Gherkin difference before source and requirements are applied together.
5. Turn annotation mode on to capture targeted drafts. Review and approve the batch, submit it, and inspect each result separately. Accept it, undo it, or leave it pending for rework. Dependent changes require a choice before affecting accepted results.
6. Review each scenario's test interpretation, then run delivery checks. Passing checks are necessary; inspect the visual experience and interactions yourself before handing off.
7. Export source. The recipient installs its declared dependencies with their own registry access and runs React or Storybook. Data adapters can be replaced while retaining page layout, styles, validation, and interaction state.

Autosave, ordinary undo/redo, named versions, and restoration operate on source, requirements, fixtures, and dependency versions together. If an exact historical dependency is unavailable, restoration keeps the current working revision. An interrupted AI request is quarantined on restart and can be retried from the saved page.

## Contracts

- [Published libraries, private registries, properties, and templates](docs/libraries.md)
- [Source import/export and supported legacy forms](docs/source-projects.md)
- [Local AI integration, staging, cancellation, and recovery](docs/integrations.md)

The editor supports flow, stack, and grid composition. It uses real imported components and preserves TSX as the editable source. Arbitrary-coordinate free-canvas editing, visual event wiring, Figma import, mobile layouts, online reviewer collaboration, and real-time multiuser editing are outside this version's contract.

## Development checks

```sh
npm run check
npm run test:e2e
```

Tests use synthetic source and real npm-packed libraries served by an authenticated local registry. CI does not require an AI account, send account-backed model requests, or publish packages. Account-backed integration probes are local acceptance work. Builds alone do not establish Gherkin compliance.
