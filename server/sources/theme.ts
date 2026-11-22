import { z } from "zod";
import type { RegistrySourceSpec } from "../contracts.js";
import { fetchJson } from "./fetcher.js";
import { fetchItem, type RegistryItem } from "./registry-item.js";

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
export async function resolveTheme(spec: RegistrySourceSpec, publishedItems: RegistryItem[] = []): Promise<Theme> {
  const warnings: string[] = [];
  const imports = new Set<string>(["tailwindcss"]);

  const items = [...publishedItems];
  if (spec.themeItem)
    try {
      items.push(await fetchItem(spec, spec.themeItem));
    } catch (error) {
      warnings.push(`Base styles: ${error instanceof Error ? error.message : String(error)}`);
    }

  let light: Record<string, string> = {};
  let dark: Record<string, string> = {};
  let theme: Record<string, string> = {};
  const variables = z.record(z.string(), z.string());
  for (const item of items) {
    for (const key of Object.keys(item.css ?? {})) {
      const match = /^@import\s+"([^"]+)"$/.exec(key.trim());
      if (match?.[1]) imports.add(match[1]);
    }
    for (const dependency of item.devDependencies ?? [])
      if (dependency.endsWith("-css")) imports.add(dependency);
    light = { ...light, ...variables.safeParse(item.cssVars?.light).data };
    dark = { ...dark, ...variables.safeParse(item.cssVars?.dark).data };
    theme = { ...theme, ...variables.safeParse(item.cssVars?.theme).data };
  }
  if (spec.colorsUrl)
    try {
      const colors = colorsSchema.parse(await fetchJson(spec.colorsUrl));
      light = { ...light, ...colors.cssVarsV4.light };
      dark = { ...dark, ...colors.cssVarsV4.dark };
    } catch (error) {
      warnings.push(
        `Design tokens: ${error instanceof Error ? error.message : String(error)}. The preview uses available registry tokens and Tailwind defaults.`,
      );
    }
  const tokens = renderTokens(light, dark, theme);
  const universal = [(light.border || theme["color-border"]) ? "border-border" : "", (light.ring || theme["color-ring"]) ? "outline-ring/50" : ""].filter(Boolean);
  const body = [(light.background || theme["color-background"]) ? "bg-background" : "", (light.foreground || theme["color-foreground"]) ? "text-foreground" : ""].filter(Boolean);

  const packages = [...imports].map((specifier) => specifier.split("/")[0]!);
  const css = [
    ...[...imports].map((specifier) => `@import "${specifier}";`),
    "",
    `@custom-variant dark (&:is(.dark *));`,
    "",
    tokens,
    "@layer base {",
    ...(universal.length ? [`  * { @apply ${universal.join(" ")}; }`] : []),
    ...(body.length ? [`  body { @apply ${body.join(" ")}; }`] : []),
    "}",
  ].join("\n");

  return { css, packages, warnings };
}

function renderTokens(light: Record<string, string>, dark: Record<string, string>, theme: Record<string, string>): string {
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
    ...((light.radius || theme.radius) ? [
      "  --radius-sm: calc(var(--radius) - 4px);",
      "  --radius-md: calc(var(--radius) - 2px);",
      "  --radius-lg: var(--radius);",
      "  --radius-xl: calc(var(--radius) + 4px);",
    ] : []),
    declarations(theme),
    themeMap,
    "}",
    "",
  ].join("\n");
}
