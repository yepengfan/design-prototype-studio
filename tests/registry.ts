import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runCommand } from "../server/core/process";
// These are real synthetic published packages for private-registry acceptance only.
// They are not Studio runtime controls or substitutes for a designer's library.
export async function registryFixture(root: string) {
  const packages = new Map<
    string,
    { tarball: Buffer; integrity: string; manifest: any }
  >();
  for (const name of ["@studio-test/controls", "@studio-test/layout"]) {
    const dir = path.join(root, name.split("/")[1]);
    await fs.mkdir(dir, { recursive: true });
    const controls = name.endsWith("controls");
    const manifest = {
      name,
      version: "1.0.0",
      type: "module",
      exports: {
        ".": { types: "./index.d.ts", default: "./index.js" },
        "./tokens.css": "./tokens.css",
      },
      types: "./index.d.ts",
      peerDependencies: { react: "^19.3.1" },
      studio: "./studio.json",
    };
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify(manifest),
    );
    await fs.writeFile(
      path.join(dir, "index.js"),
      controls
        ? `import {createElement as h} from 'react'; export const Button=({children,...props})=>h('button',props,children); export const Input=props=>h('input',props);`
        : `import {createElement as h} from 'react'; export const Card=({children,tone='neutral',...props})=>h('article',{...props,className:'fixture-card '+tone},children); export const Panel=({children,header,footer,spacing={x:12,y:12}})=>h('section',{'aria-label':'Panel',style:{padding:spacing.y+'px '+spacing.x+'px'}},header,h('div',null,children),footer);export const Notice={Root:({children})=>h('section',{'aria-label':'Notice'},children),Title:({children})=>h('h2',null,children)};`,
    );
    await fs.writeFile(
      path.join(dir, "index.d.ts"),
      controls
        ? `import type {ButtonHTMLAttributes,InputHTMLAttributes,ReactNode} from 'react'; export declare function Button(props:ButtonHTMLAttributes<HTMLButtonElement>):ReactNode; export declare function Input(props:InputHTMLAttributes<HTMLInputElement>):ReactNode;`
        : `import type {ReactNode} from 'react'; export declare function Card(props:{children?:ReactNode;tone?:'neutral'|'accent'}):ReactNode;export declare function Panel(props:{children?:ReactNode;header?:ReactNode;footer?:ReactNode;spacing?:{x:number;y:number}}):ReactNode;export declare const Notice:{Root:(props:{children?:ReactNode})=>ReactNode;Title:(props:{children?:ReactNode})=>ReactNode};`,
    );
    await fs.writeFile(
      path.join(dir, "tokens.css"),
      ":root{--fixture-accent:#2a7055}.fixture-card{padding:24px;border:1px solid #dce5d4;border-radius:12px}.fixture-card.accent{background:#eef6e8}button{font:inherit}",
    );
    const components: Record<string, unknown>[] = controls
      ? [
          {
            name: "Button",
            export: "Button",
            description: "Submit a form or perform an action.",
            props: {
              disabled: {
                type: "boolean",
                description: "Prevent the current action",
                business: true,
                default: false,
              },
            },
            children: true,
            examples: [
              { name: "Available", props: {}, children: "Continue" },
              {
                name: "Disabled",
                props: { disabled: true },
                children: "Continue",
              },
            ],
          },
          {
            name: "Input",
            export: "Input",
            description: "Enter a short text field with an accessible label.",
            props: {
              placeholder: {
                type: "string",
                description: "Input hint",
                business: false,
              },
            },
            examples: [{ name: "Empty", props: { placeholder: "Name" } }],
          },
        ]
      : [
          {
            name: "Card",
            export: "Card",
            description: "Group related content in a readable section.",
            props: {
              tone: {
                type: "enum",
                options: ["neutral", "accent"],
                description: "Surface color",
                business: false,
              },
            },
            children: true,
            examples: [
              { name: "Neutral", props: {}, children: "Section content" },
              {
                name: "Accent",
                props: { tone: "accent" },
                children: "Section content",
              },
            ],
          },
        ];
    if (!controls)
      components.push(
        {
          name: "Panel",
          export: "Panel",
          description:
            "Arrange content in named header, body and footer regions.",
          props: {
            spacing: {
              type: "object",
              description: "Horizontal and vertical inset",
              default: { x: 12, y: 12 },
              fields: {
                x: { type: "number", description: "Horizontal inset" },
                y: { type: "number", description: "Vertical inset" },
              },
            },
          },
          children: true,
          slots: ["header", "footer"],
          examples: [{ name: "Default", props: {}, children: "Panel body" }],
        },
        {
          name: "Notice frame",
          export: "Notice.Root",
          description: "Compose a notice from genuine library parts.",
          props: {},
          children: true,
          examples: [{ name: "Default", props: {}, children: "Notice body" }],
        },
        {
          name: "Notice heading",
          export: "Notice.Title",
          description: "A heading for a notice.",
          props: {},
          children: true,
          examples: [
            { name: "Default", props: {}, children: "Notice heading" },
          ],
        },
      );
    await fs.writeFile(
      path.join(dir, "studio.json"),
      JSON.stringify({
        schemaVersion: 1,
        components: components.map((c) => ({
          ...c,
          styles: [name + "/tokens.css"],
        })),
      }),
    );
    const packed = await runCommand(
      "npm",
      ["pack", "--ignore-scripts", "--json"],
      dir,
    );
    if (packed.code) throw new Error("Fixture npm pack failed");
    const packedName = JSON.parse(packed.stdout)[0].filename;
    const tarball = await fs.readFile(path.join(dir, packedName));
    packages.set(name, {
      tarball,
      integrity:
        "sha512-" + createHash("sha512").update(tarball).digest("base64"),
      manifest,
    });
  }
  let base = "";
  let authenticatedRequests = 0;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer synthetic-local-fixture") {
      res.writeHead(401);
      return res.end("Authentication required");
    }
    authenticatedRequests++;
    const url = decodeURIComponent((req.url ?? "").split("?")[0]);
    const tarName = url.match(/^\/(.+)\/-\/package.tgz$/)?.[1];
    if (tarName && packages.has(tarName)) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return res.end(packages.get(tarName)!.tarball);
    }
    const entry = packages.get(url.slice(1));
    if (!entry) {
      res.writeHead(404);
      return res.end("{}");
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        name: entry.manifest.name,
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            ...entry.manifest,
            dist: {
              tarball: base + "/" + entry.manifest.name + "/-/package.tgz",
              integrity: entry.integrity,
            },
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Registry did not bind");
  base = `http://127.0.0.1:${address.port}`;
  const config = path.join(root, "npm-auth");
  await fs.writeFile(
    config,
    `//127.0.0.1:${address.port}/:_authToken=synthetic-local-fixture\n@studio-test:registry=${base}\n`,
    { mode: 0o600 },
  );
  return {
    base,
    config,
    requests: () => authenticatedRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
