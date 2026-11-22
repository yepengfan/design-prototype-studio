import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { Preset, Project, SourceSpec } from "@/lib/api";

type Props = {
  project: Project;
  presets: Preset[];
  busy: boolean;
  /** Set when a gap asked the designer to widen the scope. */
  prompt?: string;
  onImport: (name: string, spec: SourceSpec) => void;
  onToggle: (systemId: string, selected: boolean) => void;
};

export function DesignSystemsPanel({ project, presets, busy, prompt, onImport, onToggle }: Props) {
  const [registryName, setRegistryName] = useState("");
  const [registryUrl, setRegistryUrl] = useState("");
  const [packageName, setPackageName] = useState("");
  const [packageVersion, setPackageVersion] = useState("latest");

  return (
    <Card data-testid="design-systems">
      <CardHeader>
        <CardTitle>Design systems</CardTitle>
        <CardDescription>
          Import a component registry or a published npm package, then choose which systems may be used.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {prompt && (
          <Alert data-testid="import-prompt">
            <AlertTitle>The use case needs another system</AlertTitle>
            <AlertDescription>{prompt}</AlertDescription>
          </Alert>
        )}

        {project.systems.length > 0 && (
          <ul className="grid gap-2" data-testid="imported-systems">
            {project.systems.map((system) => (
              <li key={system.id} className="rounded-md border p-3">
                <label className="flex items-start gap-3">
                  <input
                    disabled={busy}
                    type="checkbox"
                    className="accent-primary mt-1 size-4"
                    checked={project.selectedSystemIds.includes(system.id)}
                    onChange={(event) => onToggle(system.id, event.target.checked)}
                    aria-label={`Use ${system.name}`}
                  />
                  <span className="grid min-w-0 gap-1">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {system.name}
                      <Badge variant="secondary">{system.components.length} components</Badge>
                      {system.templates.length > 0 && (
                        <Badge variant="outline">{system.templates.length} templates</Badge>
                      )}
                    </span>
                    <span className="text-muted-foreground text-xs break-all">{system.origin}</span>
                    {system.warnings.length > 0 && (
                      <details className="text-muted-foreground text-xs">
                        <summary className="cursor-pointer">
                          {system.warnings.length} item{system.warnings.length === 1 ? "" : "s"} skipped
                        </summary>
                        <ul className="mt-1 grid gap-1 pl-4">
                          {system.warnings.map((warning) => (
                            <li key={warning} className="list-disc">
                              {warning}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {presets.map((preset) => {
          const imported = project.systems.some((system) => system.name === preset.name);
          return (
            <Button
              key={preset.name}
              variant={imported ? "outline" : "default"}
              disabled={busy}
              onClick={() => onImport(preset.name, preset.spec)}
              data-testid={`import-preset-${preset.name}`}
            >
              {imported ? `Re-import ${preset.name}` : `Import ${preset.name}`}
            </Button>
          );
        })}

        <Separator />

        <div className="grid gap-2">
          <Label htmlFor="registry-url">Registry URL</Label>
          <Input
            id="registry-name"
            placeholder="Name, for example Acme UI"
            value={registryName}
            onChange={(event) => setRegistryName(event.target.value)}
          />
          <Input
            id="registry-url"
            placeholder="https://example.com/r"
            value={registryUrl}
            onChange={(event) => setRegistryUrl(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={busy || !registryName.trim() || !registryUrl.trim()}
            onClick={() => onImport(registryName.trim(), { kind: "registry", url: registryUrl.trim() })}
          >
            Import registry
          </Button>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="npm-package">npm package</Label>
          <Input
            id="npm-package"
            placeholder="@acme/design-system"
            value={packageName}
            onChange={(event) => setPackageName(event.target.value)}
          />
          <Input
            id="npm-version"
            placeholder="latest"
            value={packageVersion}
            onChange={(event) => setPackageVersion(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={busy || !packageName.trim()}
            onClick={() =>
              onImport(packageName.trim(), {
                kind: "npm",
                package: packageName.trim(),
                version: packageVersion.trim() || "latest",
              })
            }
          >
            Import package
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
