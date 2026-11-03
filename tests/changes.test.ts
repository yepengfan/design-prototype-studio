import { expect, it } from "vitest";
import { blankProject, synchronizeRuntime } from "../server/core/project";
import { prepareChange } from "../server/core/changes";
import type { Proposal, Snapshot } from "../server/core/contracts";

function fixture(source: string): Snapshot {
  const { files, manifest } = blankProject("Notice");
  manifest.generationState = "generated";
  manifest.scope = ["requirements/notice.feature"];
  files["requirements/notice.feature"] =
    "Feature: Notice\nScenario: Read\nGiven the notice exists\nThen its content is visible\n";
  files["src/pages/Page.tsx"] = source;
  return {
    id: "base",
    at: new Date().toISOString(),
    label: "Accepted",
    manifest,
    files: synchronizeRuntime(files, manifest),
  };
}
function proposal(files: Record<string, string>): Proposal {
  return {
    kind: "presentation",
    summary: "Adjust notice",
    files,
    questions: [],
    affectedScenarios: [],
  };
}
it("accepts formatting and literal presentation changes while preserving significant string content", () => {
  const base = fixture(
    `export function Page(){const label='Read  carefully'; return <main style={{padding:12}} className="notice"><h1>{label}</h1></main>}`,
  );
  const visual = `// Formatting supplied by the tool\nexport function Page() { const label = "Read  carefully"; return <main style={{padding:24}} className={'wide'}><h1>{label}</h1></main>; }`;
  const change = prepareChange(
    base,
    proposal({ "src/pages/Page.tsx": visual }),
  );
  expect(change.requiresConfirmation).toBe(false);
  expect(change.files["src/pages/Page.tsx"]).toBe(visual);
  expect(() =>
    prepareChange(
      base,
      proposal({
        "src/pages/Page.tsx": visual.replace(
          "Read  carefully",
          "Read carefully",
        ),
      }),
    ),
  ).toThrow("matching requirements");
});
it("does not conceal behavior inside computed presentation expressions", () => {
  const base = fixture(
    `export function Page(){return <main style={{padding:12}}>Notice</main>}`,
  );
  expect(() =>
    prepareChange(
      base,
      proposal({
        "src/pages/Page.tsx": `export function Page(){return <main style={submit()}>Notice</main>}`,
      }),
    ),
  ).toThrow("matching requirements");
});
it("quarantines executable configuration and its transitive helper changes before preview", () => {
  const base = fixture(`export function Page(){return <main>Notice</main>}`);
  base.files["vite.config.ts"] =
    `import {plugins} from './config/plugins';export default {plugins};`;
  base.files["config/plugins.ts"] = `export {plugins} from './local';`;
  base.files["config/local.ts"] = `export const plugins=[];`;
  for (const name of [
    "vite.config.ts",
    "config/plugins.ts",
    "config/local.ts",
    ".storybook/main.ts",
    "scripts/new.js",
    "package.json",
  ])
    expect(() =>
      prepareChange(
        base,
        proposal({ [name]: "throw new Error('must never execute')" }),
      ),
    ).toThrow("executable configuration");
});
it("rejects native controls disguised with roles or handlers even with a Gherkin difference", () => {
  const base = fixture(`export function Page(){return <main>Notice</main>}`);
  for (const control of [
    '<div role="button">Confirm</div>',
    "<span onClick={()=>{}}>Confirm</span>",
    '<a href="/confirm">Confirm</a>',
  ])
    expect(() =>
      prepareChange(
        base,
        proposal({
          "src/pages/Page.tsx": `export function Page(){return <main>${control}</main>}`,
          "requirements/notice.feature": base.files[
            "requirements/notice.feature"
          ].replace("content is visible", "confirmation is visible"),
        }),
      ),
    ).toThrow("invents");
});

it("permits semantic form containers and noninteractive status roles around genuine content", () => {
  const base = fixture(`export function Page(){return <main>Notice</main>}`);
  base.manifest.generationState = "unstarted";
  const source = `export function Page(){return <form onSubmit={event=>event.preventDefault()}><div role="status">Ready</div></form>}`;
  expect(
    prepareChange(base, proposal({ "src/pages/Page.tsx": source })).files[
      "src/pages/Page.tsx"
    ],
  ).toBe(source);
});

it("keeps side-effect CSS and documented visual component properties out of business edits", () => {
  const base = fixture(
    `import {Card} from '@fixture/cards';export function Page(){return <main><Card tone="neutral">Notice</Card></main>}`,
  );
  base.manifest.libraries = [
    {
      name: "@fixture/cards",
      version: "1.0.0",
      components: [
        {
          name: "Card",
          export: "Card",
          package: "@fixture/cards",
          version: "1.0.0",
          description: "Group content",
          provenance: "Published",
          children: true,
          requiresBehavior: false,
          slots: [],
          props: {
            tone: {
              type: "enum",
              options: ["neutral", "accent"],
              description: "Surface color",
              business: false,
            },
          },
          examples: [{ name: "Default", props: { tone: "neutral" } }],
          styles: [],
        },
      ],
    },
  ];
  const result = prepareChange(
    base,
    proposal({
      "src/pages/Page.tsx": `import './notice.css';import {Card} from '@fixture/cards';export function Page(){return <main><Card tone="accent">Notice</Card></main>}`,
      "src/pages/notice.css": "main{color:green}",
    }),
  );
  expect(result.requiresConfirmation).toBe(false);
  const module = prepareChange(
    base,
    proposal({
      "src/pages/Page.tsx": `import styles from './notice.module.css';import {Card} from '@fixture/cards';export function Page(){return <main className={styles.notice}><Card tone="neutral">Notice</Card></main>}`,
      "src/pages/notice.module.css": ".notice{color:green}",
    }),
  );
  expect(module.requiresConfirmation).toBe(false);
});
