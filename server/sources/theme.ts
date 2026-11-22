import { z } from "zod";
import type { RegistrySourceSpec } from "../contracts.js";
import { fetchJson } from "./fetcher.js";
import { fetchItem } from "./registry-item.js";

const colorsSchema = z.object({
  cssVarsV4: z.object({
    light: z.record(z.string(), z.string()),
    dark: z.record(z.string(), z.string()),
  }),
});

export type Theme = {
  /** CSS the preview imports before any component styles. */
  css: string;
  /** Packages the base CSS imports, so the preview can check they resolve. */
  packages: string[];
  warnings: string[];
};

/**
 * Builds a preview's base stylesheet from what the registry publishes: its
 * style item names the CSS packages to import, and its base colour payload
 * supplies the design tokens. Nothing here is a hand-copied palette.
 */
export async function resolveTheme(spec: RegistrySourceSpec): Promise<Theme> {
  const warnings: string[] = [];
  const imports = new Set<string>(["tailwindcss"]);

  if (spec.themeItem)
    try {
      const item = await fetchItem(spec, spec.themeItem);
      for (const key of Object.keys(item.css ?? {})) {
        const match = /^@import\s+"([^"]+)"$/.exec(key.trim());
        if (match?.[1]) imports.add(match[1]);
      }
      for (const dependency of item.devDependencies ?? [])
        if (dependency.endsWith("-css")) imports.add(dependency);
    } catch (error) {
      warnings.push(`Base styles: ${error instanceof Error ? error.message : String(error)}`);
    }

  let tokens = "";
  if (spec.colorsUrl)
    try {
      const colors = colorsSchema.parse(await fetchJson(spec.colorsUrl));
      tokens = renderTokens(colors.cssVarsV4.light, colors.cssVarsV4.dark);
    } catch (error) {
      warnings.push(
        `Design tokens: ${error instanceof Error ? error.message : String(error)}. The preview falls back to Tailwind defaults.`,
      );
    }

  const packages = [...imports].map((specifier) => specifier.split("/")[0]!);
  const css = [
    ...[...imports].map((specifier) => `@import "${specifier}";`),
    "",
    `@custom-variant dark (&:is(.dark *));`,
    "",
    tokens,
    "@layer base {",
    "  * {",
    "    @apply border-border outline-ring/50;",
    "  }",
    "  body {",
    "    @apply bg-background text-foreground;",
    "  }",
    "}",
  ].join("\n");

  return { css, packages, warnings };
}

function renderTokens(light: Record<string, string>, dark: Record<string, string>): string {
  const declarations = (values: Record<string, string>) =>
    Object.entries(values)
      .map(([name, value]) => `  --${name}: ${value};`)
      .join("\n");
  const themeMap = Object.keys(light)
    .filter((name) => name !== "radius")
    .map((name) => `  --color-${name}: var(--${name});`)
    .join("\n");

  return [
    ":root {",
    declarations(light),
    "}",
    "",
    ".dark {",
    declarations(dark),
    "}",
    "",
    "@theme inline {",
    "  --radius-sm: calc(var(--radius) - 4px);",
    "  --radius-md: calc(var(--radius) - 2px);",
    "  --radius-lg: var(--radius);",
    "  --radius-xl: calc(var(--radius) + 4px);",
    themeMap,
    "}",
    "",
  ].join("\n");
}
