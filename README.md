# Design Prototype Studio

Turn a written use case into an interactive prototype built from a real design
system, review it in the browser, and send anchored notes back to an agent.

The designer never writes code. They import a design system, describe the
scenario in Gherkin, pick a page template, and read the result. Anything the
scenario asks for that the imported systems cannot provide is reported as a
named gap rather than faked with a substitute component.

## The flow

1. **Import a design system.** A shadcn-compatible registry URL or a published
   npm package. The Studio reads every published item to record what each
   component really exports, and keeps the source URL as provenance.
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

The Studio is a strictly local, single-user tool. The API binds to `127.0.0.1`.
Imported registry and npm code runs in a sandboxed preview on an opaque origin.
It cannot access the Studio document or project API. Mode and element selection
pass through a narrow postMessage channel tied to the preview frame.

## Running it

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
| `STUDIO_DATA_DIR` | `.studio` | Projects, generated sources, registry cache |
| `STUDIO_DELIVERY_DIR` | `<data>/deliveries` | Where note briefings are written |
| `STUDIO_AGENT_COMMAND` | unset | Required for sending: receives the briefing on stdin and must answer on stdout |
| `STUDIO_REGISTRY_CACHE_SECONDS` | `86400` | How long a fetched registry payload stays valid on disk |

`STUDIO_DATA_DIR` must stay inside the repository: generated projects resolve
React, Tailwind and the registry's own dependencies through the repository's
`node_modules`.

The `shadcn` dependency is present for one file, `shadcn/tailwind.css`, which
the shadcn/ui registry's own style item imports. The CLI it also ships is never
run here.

## How generation works

**Templates are extracted, not hand-written.** `server/tsx.ts` parses the
block's `page.tsx` with the TypeScript compiler API and walks down the JSX
spine, following the single child or the child holding most of the component
references. Everything passed on the way is chrome and is kept. The first
element whose references are spread across several children is the content
slot, and its children are replaced with `{children}`. Imports the remaining
tree no longer uses are pruned, which is also what strips a block's sample-only
dependencies such as charting and drag-and-drop libraries.

**Plans are derived from the scenario.** `server/planner.ts` turns each
scenario into ordered blocks (heading, filters, row-count summary, table) using
only capabilities the selected systems actually publish. A requirement with no
matching component becomes a gap naming the Gherkin step that asked for it, and
the designer is offered the choice to import another system or reword the step.

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
