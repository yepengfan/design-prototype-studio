import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PlanGap } from "../../server/contracts.js";

type Props = {
  gaps: PlanGap[];
  onWidenScope: (gap: PlanGap) => void;
};

/**
 * Blocks the use case asked for that no selected system can fill. Generation
 * still produced a page, so the decision stays with the designer.
 */
export function GapsPanel({ gaps, onWidenScope }: Props) {
  if (gaps.length === 0) return null;

  return (
    <Card data-testid="gaps-panel" className="border-amber-300 dark:border-amber-800">
      <CardHeader>
        <CardTitle>Missing building blocks</CardTitle>
        <CardDescription>
          These requirements were left out of the page. Import another design system to cover them, or
          reword the step.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3">
          {gaps.map((gap) => (
            <li key={`${gap.capability}:${gap.requirement}`} className="grid gap-2 rounded-md border p-3">
              <p className="text-sm font-medium">{gap.reason}</p>
              <p className="text-muted-foreground text-xs">
                Affected requirement: <span className="font-mono">{gap.requirement}</span>
              </p>
              <p className="text-muted-foreground text-xs">{gap.suggestion}</p>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onWidenScope(gap)}
                  data-testid={`widen-scope-${gap.capability}`}
                >
                  Import another design system
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
