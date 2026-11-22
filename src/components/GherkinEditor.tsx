import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  gherkin: string;
  busy: boolean;
  canGenerate: boolean;
  onChange: (gherkin: string) => void;
  onGenerate: () => void;
};

export function GherkinEditor({ gherkin, busy, canGenerate, onChange, onGenerate }: Props) {
  return (
    <Card data-testid="gherkin-editor">
      <CardHeader>
        <CardTitle>Use case</CardTitle>
        <CardDescription>
          Describe the scenario in Gherkin. Data tables become the mock data of the generated page.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Label htmlFor="gherkin" className="sr-only">
          Gherkin use case
        </Label>
        <Textarea
          id="gherkin"
          className="min-h-56 font-mono text-xs"
          spellCheck={false}
          value={gherkin}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button onClick={onGenerate} disabled={busy || !canGenerate} data-testid="generate">
          {busy ? "Generating…" : "Generate page"}
        </Button>
        {!canGenerate && (
          <p className="text-muted-foreground text-xs">
            Select a design system and a template before generating.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
