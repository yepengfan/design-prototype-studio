import { StudioError } from "./contracts.js";
import { safeRelative } from "./files.js";
export function projectSpecifier(module: string, localPrefix: string) {
  if (module.startsWith("/") || module.includes("..") || module.includes("\\"))
    throw new StudioError(
      "Imports must reference published packages or project source.",
    );
  return module.startsWith("src/")
    ? localPrefix + safeRelative(module)
    : module;
}
/** Published provider references use module#Export (default export when omitted). */
export function providerSetup(
  reference: string | undefined,
  localPrefix: string,
  alias = "StudioProvider",
) {
  if (!reference) return { imports: "", wrap: (child: string) => child };
  const [module, exported = "default"] = reference.split("#");
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exported))
    throw new StudioError("The provider export name is invalid.");
  const specifier = projectSpecifier(module, localPrefix).replace(
    /\.tsx?$/,
    "",
  );
  if (module.startsWith("/") || module.includes("..") || module.includes("\\"))
    throw new StudioError(
      "Provider modules must be published package imports or project source.",
    );
  return {
    imports: `import { ${exported} as ${alias} } from ${JSON.stringify(specifier)};\n`,
    wrap: (child: string) => `<${alias}>${child}</${alias}>`,
  };
}
