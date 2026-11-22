# Design Prototype Studio

Turn a written use case into an interactive prototype built from a real design
system, review it in the browser, and send anchored notes back to an agent.

The designer never writes code. They import a design system, describe the
scenario in Gherkin, pick a page template, and read the result. Anything the
scenario asks for that the imported systems cannot provide is reported as a
named gap rather than faked with a substitute component.

## The flow

1. **Import a design system.** A shadcn-compatible registry URL or a published
   npm package. Registry items are inspected for exports; npm packages must
   publish typed React exports. Unusable items are reported as import warnings,
   and catalog entries retain their provenance.
2. **Search the catalog.** Components are indexed by name, export and
   capability (table, badge, chart, timeline, and so on).
3. **Pick a page template.** Templates are the registry's own block items, for
   example shadcn/ui's `dashboard-01`.
4. **Write the use case in Gherkin.** Data tables in the `Given` step become the
   page's mock data.
5. **Generate.** The Studio plans the page from the scenario, renders it with
   the imported components inside the template's layout, bundles it, and serves
   it in an iframe.
6. **Review.** *Interact* runs the prototype. *Annotate* turns clicks into
   anchored notes instead of actions.
7. **Send.** Queued notes are written as a briefing, then delivered through
   `STUDIO_AGENT_COMMAND`. A batch counts as sent only after the agent answers.
   Without a configured agent, or if delivery fails, the notes stay queued.
   Each briefing carries the scenario, template and anchors.

npm imports supply components, not templates. Keep a registry selected to
provide the page template. Deselecting or re-importing its system clears the
template selection. Regenerating replaces the current page; existing notes,
including notes queued from an older browser tab, are marked as belonging to a
prior generation.

The Studio is a strictly local, single-user tool. The API binds to `127.0.0.1`.
Imported registry and npm code runs in a sandboxed preview on an opaque origin.
It cannot access the Studio document or project API. Mode and element selection
pass through a narrow postMessage channel tied to the preview frame.

## Running it

Use Node.js 22.6 or newer.

```bash
npm install
npm run dev     # Studio on http://localhost:5173, API on 5174
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Client and API together, with hot reload |
| `npm run build` | Typecheck, then build the client |
| `npm start` | Serve the built client and the API from one process |
| `npm test` | Unit tests |
| `npm run test:e2e` | The designer flow end to end against the real shadcn/ui registry |
| `npm run lint` | ESLint, type-aware |
| `npm run vendor:ui` | Re-vendor the Studio's own shadcn components from the registry |

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5174` | API port |
| `STUDIO_CLIENT_PORT` | `5173` | Vite development client port |
| `STUDIO_DATA_DIR` | `.studio` | Projects, generated sources, registry cache |
| `STUDIO_DELIVERY_DIR` | `<data>/deliveries` | Where note briefings are written |
| `STUDIO_AGENT_COMMAND` | unset | Required for sending: receives the briefing on stdin and must answer on stdout |
| `STUDIO_AGENT_TIMEOUT_MS` | `120000` | Maximum time for the review agent to answer |
| `STUDIO_REGISTRY_CACHE_SECONDS` | `86400` | How long a fetched registry payload stays valid on disk |
| `STUDIO_NETWORK_TIMEOUT_MS` | `30000` | Timeout per registry fetch |
| `STUDIO_SHADCN_REGISTRY` | `https://ui.shadcn.com/r/styles/new-york-v4` | shadcn preset item base URL |
| `STUDIO_SHADCN_INDEX` | `https://ui.shadcn.com/r/index.json` | shadcn preset catalog URL |
| `STUDIO_SHADCN_COLORS` | `https://ui.shadcn.com/r/colors/neutral.json` | shadcn preset token URL |

For Cursor review, install and authenticate its agent separately, then launch
the Studio with `STUDIO_AGENT_COMMAND='cursor-agent -p' npm run dev`. The
command is split on spaces into an executable and arguments; shell quoting,
pipes and redirection are not interpreted. Sending requires a successful exit
and a nonempty stdout reply. The Studio shows that reply with the sent batch.

`STUDIO_DATA_DIR` must stay inside the repository: generated projects resolve
React, Tailwind and the registry's own dependencies through the repository's
`node_modules`.

The `shadcn` dependency is present for one file, `shadcn/tailwind.css`, which
the shadcn/ui registry's own style item imports. The CLI it also ships is never
run here.

## How generation works

**Templates are extracted, not hand-written.** The Studio preserves the block's
layout around a generated content slot and prunes unused imports. See
`extractLayout` in `server/tsx.ts` for the extraction rules and supported page
shape.

**Plans are derived from the scenario.** `server/planner.ts` turns each
scenario into ordered blocks (heading, filters, row-count summary, table) using
only capabilities the selected systems actually publish. A requirement with no
matching component becomes a gap naming the Gherkin step that asked for it, and
the designer is offered the choice to import another system or reword the step.

The MVP supports one feature and one concrete scenario per generation, using
the Orders pilot's `Given the following mock orders exist:` data table. Start
with the supplied scenario in the editor. Supported interactions are text
search, selecting a value from a matching column, and a `Show <status>` toggle;
outcomes can describe visible orders, status badges, hidden orders and an
explicit `Row count` summary. Multiple controls constraining the same column
are reported as unsupported, as are other interaction semantics and visual
blocks such as charts, even when a matching component is imported. Scenario
Outlines are rejected. The step forms are defined in `server/planner.ts`.

**Nothing is invented.** `server/generator.ts` fails loudly if a component it
needs does not export the symbol the plan expects, so a prototype never renders
a stand-in that the design system does not have.

## Layout

| Path | Contents |
| --- | --- |
| `server/` | API, registry and npm import, planner, generator, preview build, delivery |
| `preview-runtime/` | The annotation bridge copied verbatim into generated projects |
| `src/` | The Studio client |
| `src/components/ui/` | shadcn components vendored by `scripts/vendor-ui.ts` |
| `tests/` | Unit tests plus the end-to-end designer flow |
