import { createServer } from "vite";
import { Project, Node } from "ts-morph";
import { digest } from "./core/files.js";

const [root, editorOrigin, dependencyRoot] = process.argv.slice(2);
const bridge = `<script type="module">
let capture=false;
addEventListener('message',e=>{if(e.source!==parent||e.origin!==${JSON.stringify(editorOrigin)})return;if(e.data?.type==='studio:capture')capture=e.data.enabled;if(e.data?.type==='studio:highlight'){document.querySelectorAll('[data-studio-selected]').forEach(n=>n.removeAttribute('data-studio-selected'));document.querySelectorAll('[data-studio-id="'+CSS.escape(e.data.id)+'"]').forEach(n=>n.setAttribute('data-studio-selected',''));}});
document.addEventListener('click',e=>{if(!capture)return;const node=e.target.closest('[data-studio-id]');if(!node)return;e.preventDefault();e.stopImmediatePropagation();parent.postMessage({type:'studio:selection',id:node.dataset.studioId,file:node.dataset.studioFile},${JSON.stringify(editorOrigin)});},true);
addEventListener('error',e=>parent.postMessage({type:'studio:error',message:e.message},${JSON.stringify(editorOrigin)}));
</script><style>[data-studio-selected]{outline:2px solid #267c66!important;outline-offset:3px!important}</style>`;
const server = await createServer({
  root,
  configFile: root + "/vite.config.ts",
  cacheDir: root + "/.studio-preview-cache",
  plugins: [
    {
      name: "studio-select",
      enforce: "pre",
      transformIndexHtml: (html) => html.replace("</body>", bridge + "</body>"),
      transform(code, id) {
        if (
          !/\.[tj]sx$/.test(id) ||
          id.includes("node_modules") ||
          !id.startsWith(root + "/src/")
        )
          return;
        const project = new Project({ useInMemoryFileSystem: true });
        const file = project.createSourceFile("page.tsx", code);
        const patches: { at: number; text: string }[] = [];
        for (const node of file
          .getDescendants()
          .filter(
            (n) => Node.isJsxElement(n) || Node.isJsxSelfClosingElement(n),
          )) {
          const op = Node.isJsxElement(node) ? node.getOpeningElement() : node;
          const tag = op.getTagNameNode();
          // Attributes are advisory. Components that do not forward them remain selectable in the outline.
          const anchor = digest([node.getStart(), node.getText()]).slice(0, 16);
          patches.push({
            at: tag.getEnd(),
            text: ` data-studio-id=${JSON.stringify(anchor)} data-studio-file=${JSON.stringify(id.slice(root.length + 1))}`,
          });
        }
        let text = code;
        for (const p of patches.sort((a, b) => b.at - a.at))
          text = text.slice(0, p.at) + p.text + text.slice(p.at);
        return { code: text, map: null };
      },
    },
  ],
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
    cors: false,
    fs: { strict: true, allow: [root, dependencyRoot].filter(Boolean) },
  },
});
await server.listen();
const address = server.httpServer!.address();
if (address && typeof address === "object")
  process.stdout.write(
    JSON.stringify({ ready: true, url: `http://127.0.0.1:${address.port}` }) +
      "\n",
  );
process.on("SIGTERM", () => {
  void server.close().then(() => process.exit());
});
process.on("disconnect", () => {
  void server.close().then(() => process.exit());
});
