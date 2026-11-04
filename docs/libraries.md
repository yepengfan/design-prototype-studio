# Published React libraries

Provide the npm package name, exact version, and optional credential-free registry URL. Scoped packages in one npm scope must use the same registry. Studio uses npm's existing authentication, disables installation scripts, resolves compatible peers, and pins the dependency closure. Tokens, `.npmrc`, environment files, and caches do not belong in source archives.

A package must publish browser-compatible React exports and enough version-matched types, descriptions, examples, styles, and provider setup to use the admitted capabilities reliably. Studio first uses published information. Its documented-declaration/README path admits described scalar properties with runnable literal JSX examples. It also discovers package-published CSF object stories that import the public package export, including controlled render recipes and a published `.storybook/preview` setup. These common states run with the original story code and decorators. A required callback recipe can be previewed and used by generation while manual insertion still requests the business configuration. Hooks, undocumented utilities, required callbacks without a usable recipe, ambiguous composition, missing exports/styles/providers, and incompatible peers remain concrete gaps. Missing a custom Studio entry alone does not disqualify a package.

## Optional published contract

A package can publish a versioned `studio` JSON manifest and point to it from `package.json`. This is optional library-owned information, not a Studio metadata authoring workflow.

```json
{
  "studio": "./studio.json"
}
```

The manifest has `schemaVersion: 1`, `components`, and optional `templates`. A component identifies its actual exported symbol, purpose description, documented property controls, children/slots, common-state examples, package CSS subpaths, and optional provider reference. Controls support strings, numbers, booleans, enums, and literal objects with documented `fields`; behavior-owned values remain prompt controlled. Nested fields use the same contracts. Published declaration and README content also supplies callback/controlled-value usage to generation. Component identity always includes package and version. Published types and examples are checked against the release, and common-state examples are rendered before admission.

Provider references use `module#Export`, or `module` for a default export. A published provider must be usable with its documented default setup. A provider requiring undisclosed configuration is a library gap. Local project provider references use `src/...#Export`. Local stylesheet references use `src/...`; package styles use their published subpaths.

`templates` contains package-relative JSON or ZIP paths. Each is a complete native source project with Gherkin, behavior, fixtures, styles, exact dependencies, and the providing package pinned to its release. A providing package's own lock entry can omit its integrity checksum to avoid embedding a circular checksum in its own tarball; the exact version and complete remaining lock closure are still required. Invalid templates are reported separately from otherwise usable components. Designer-saved templates use the same complete source format.

Reusing a template compares its requirements with the new selected scope. Different scopes create a reviewable adaptation draft. The original accepted template stays intact until the new requirements and implementation are accepted together; export and delivery remain blocked in the meantime. A template never silently enlarges the new business scope.

Upgrades require an explicit impact review. Versions and lockfiles are part of local history, and restoration installs the exact closure before changing the accepted page.
