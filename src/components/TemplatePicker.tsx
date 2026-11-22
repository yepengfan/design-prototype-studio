import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CatalogTemplate } from "@/lib/api";

type Props = {
  templates: CatalogTemplate[];
  selectedId?: string;
  onSelect: (templateId: string) => void;
};

export function TemplatePicker({ templates, selectedId, onSelect }: Props) {
  return (
    <Card data-testid="template-picker">
      <CardHeader>
        <CardTitle>Page template</CardTitle>
        <CardDescription>
          The template's layout regions are preserved; generated content fills its content area.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {templates.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No templates yet. Import a design system that publishes blocks.
          </p>
        ) : (
          <ul className="grid gap-2">
            {templates.map((template) => (
              <li key={template.id}>
                <label className="hover:bg-accent/50 flex cursor-pointer items-start gap-3 rounded-md border p-3">
                  <input
                    type="radio"
                    name="template"
                    className="accent-primary mt-1 size-4"
                    checked={selectedId === template.id}
                    onChange={() => onSelect(template.id)}
                    aria-label={template.title}
                  />
                  <span className="grid min-w-0 gap-1">
                    <span className="text-sm font-medium">{template.title}</span>
                    {template.description && (
                      <span className="text-muted-foreground text-xs">{template.description}</span>
                    )}
                    {template.regions.length > 0 && (
                      <span className="flex flex-wrap gap-1">
                        {template.regions.map((region) => (
                          <Badge key={region} variant="secondary" className="text-[11px]">
                            {region}
                          </Badge>
                        ))}
                      </span>
                    )}
                    <span className="text-muted-foreground text-xs break-all">{template.provenance}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
