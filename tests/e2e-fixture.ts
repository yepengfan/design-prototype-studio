import { promises as fs } from "node:fs";
import path from "node:path";

export async function e2eFixture(prefix: string) {
  // Vite ignores the client build output; fixtures remain loadable by their own
  // Vite/Storybook servers without triggering reloads of the Studio editor.
  const temporary = path.join(process.cwd(), "dist/client/.studio-validation");
  await fs.mkdir(temporary, { recursive: true });
  return fs.mkdtemp(path.join(temporary, prefix));
}
