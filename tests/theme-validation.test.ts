import { describe, expect, it } from "vitest";
import { resolveTheme } from "../server/sources/theme.js";
import { fixtureRegistry } from "./fixtures.js";

describe("registry theme tokens", () => {
  it("accepts colors, dimensions, fonts and nested custom property expressions", async () => {
    const theme = await resolveTheme(fixtureRegistry, [{ name: "valid", cssVars: {
      light: { background: "oklch(1 0 0)", radius: "0.625rem" },
      theme: { "font-sans": '"Geist Sans", sans-serif', "radius-sm": "calc(var(--radius) - 4px)" },
    }, css: { '@import "@fontsource/geist/latin.css"': {} } }]);
    expect(theme.packages).toEqual(["tailwindcss", "@fontsource/geist"]);
    expect(theme.css).toContain('--font-sans: "Geist Sans", sans-serif;');
    expect(theme.css).toContain("--background: oklch(1 0 0);");
  });

  it.each([
    { background: "oklch(1 0 0" },
    { background: "red; color: blue" },
    { "invalid name": "red" },
    { background: "" },
  ])("rejects malformed registry custom properties: %j", async (light) => {
    await expect(resolveTheme(fixtureRegistry, [{ name: "invalid", cssVars: { light } }])).rejects.toThrow("Invalid registry CSS custom property");
  });
});
