import { annotationTargetSchema } from "../../server/contracts";
import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AnnotationTarget, GeneratedPage } from "@/lib/api";

export type ReviewMode = "interact" | "annotate";

type Props = {
  projectId: string;
  page?: GeneratedPage;
  mode: ReviewMode;
  /** Changes whenever a new build is ready, to reload the iframe. */
  buildKey: string;
  onModeChange: (mode: ReviewMode) => void;
  onSelect: (target: AnnotationTarget) => void;
};

export function PreviewPane({ projectId, page, mode, buildKey, onModeChange, onSelect }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const post = () => frame.current?.contentWindow?.postMessage({ type: "studio:mode", mode }, "*");
    post();

    const onMessage = (event: MessageEvent) => {
      // The preview runs on an opaque origin, so its messages are the only
      // thing it can reach us with. Accept them from this frame alone.
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: string; target?: unknown } | undefined;
      if (data?.type === "studio:ready") return post();
      if (data?.type === "studio:select") {
        const target = annotationTargetSchema.safeParse(data.target);
        if (target.success) onSelect(target.data);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [mode, onSelect, buildKey]);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3" data-testid="preview-pane">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-medium">{page ? page.title : "No page generated yet"}</h2>
          {page && <Badge variant="secondary">{page.path}</Badge>}
        </div>
        <div className="flex items-center gap-2" role="group" aria-label="Review mode">
          <Button
            size="sm"
            variant={mode === "interact" ? "default" : "outline"}
            aria-pressed={mode === "interact"}
            disabled={!page}
            onClick={() => onModeChange("interact")}
            data-testid="mode-interact"
          >
            Interact
          </Button>
          <Button
            size="sm"
            variant={mode === "annotate" ? "default" : "outline"}
            aria-pressed={mode === "annotate"}
            disabled={!page}
            onClick={() => onModeChange("annotate")}
            data-testid="mode-annotate"
          >
            Annotate
          </Button>
        </div>
      </div>

      <div className="bg-card min-h-0 flex-1 overflow-hidden rounded-xl border">
        {page ? (
          <iframe
            ref={frame}
            key={buildKey}
            title="Prototype preview"
            className="size-full"
            // Imported design-system code is third-party. Withholding
            // allow-same-origin puts it on an opaque origin, so it cannot read
            // this document or call the Studio API; postMessage stays as the
            // one channel it has, carrying only mode and selection.
            sandbox="allow-scripts"
            src={`/preview/${projectId}/index.html?build=${encodeURIComponent(buildKey)}`}
            data-testid="preview-frame"
          />
        ) : (
          <p className="text-muted-foreground grid size-full place-items-center p-8 text-center text-sm">
            Import a design system, pick a template and generate a page to see it here.
          </p>
        )}
      </div>
    </section>
  );
}
