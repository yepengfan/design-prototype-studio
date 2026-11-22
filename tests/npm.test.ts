import path from "node:path";
import { describe, expect, it } from "vitest";
import { readDeclarations } from "../server/sources/npm.js";

describe("npm declaration catalog", () => {
  it("resolves public aliases, star exports, default aliases, functions, refs and classes", () => {
    const warnings: string[] = [];
    const catalog = readDeclarations(path.resolve("tests/fixtures/npm/index.d.ts"), {
      sourceId: "fixture", sourceName: "Fixture", package: "fixture-ui", version: "1.0.0",
    }, warnings);
    expect(catalog.map((component) => component.name).sort()).toEqual([
      "Button", "Card", "DefaultButton", "Input", "PrimaryButton",
    ]);
    expect(catalog.every((component) => component.importPath === "fixture-ui")).toBe(true);
    expect(warnings).toEqual([]);
  });
});
