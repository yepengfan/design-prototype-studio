import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { CatalogComponent } from "@/lib/api";

type Props = {
  query: string;
  components: CatalogComponent[];
  onQueryChange: (query: string) => void;
};

export function ComponentSearch({ query, components, onQueryChange }: Props) {
  return (
    <Card data-testid="component-search">
      <CardHeader>
        <CardTitle>Components</CardTitle>
        <CardDescription>Search the selected systems by name, export or capability.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-2">
          <Label htmlFor="component-query">Find a component</Label>
          <Input
            id="component-query"
            placeholder="table, badge, status…"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>

        {components.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="no-components">
            {query
              ? `No component matching “${query}” in the selected systems. Import another design system to widen the scope.`
              : "Import a design system to list its components."}
          </p>
        ) : (
          <ScrollArea className="h-56 rounded-md border">
            <ul className="divide-y" data-testid="component-results">
              {components.map((component) => (
                <li key={component.id} className="grid gap-1 p-3">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {component.title}
                    <Badge variant="outline">{component.sourceName}</Badge>
                  </span>
                  {component.description && (
                    <span className="text-muted-foreground text-xs">{component.description}</span>
                  )}
                  <code className="text-muted-foreground text-xs break-all">{component.importPath}</code>
                  <a
                    className="text-muted-foreground text-xs underline underline-offset-2 break-all"
                    href={component.provenance}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {component.provenance}
                  </a>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
