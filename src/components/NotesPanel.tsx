import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AnnotationTarget, Project } from "@/lib/api";

type Props = {
  project: Project;
  target?: AnnotationTarget;
  note: string;
  busy: boolean;
  onNoteChange: (note: string) => void;
  onQueue: () => void;
  onDiscard: () => void;
  onRemove: (annotationId: string) => void;
  onSend: () => void;
};

export function NotesPanel({
  project,
  target,
  note,
  busy,
  onNoteChange,
  onQueue,
  onDiscard,
  onRemove,
  onSend,
}: Props) {
  const queued = project.annotations.filter((annotation) => !annotation.batchId);
  const lastBatch = project.batches.at(-1);

  return (
    <Card data-testid="notes-panel">
      <CardHeader>
        <CardTitle>Feedback</CardTitle>
        <CardDescription>
          In Annotate mode, selecting an element attaches a note to it instead of running its action.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {target && (
          <div className="grid gap-2 rounded-md border p-3" data-testid="note-editor">
            <Label htmlFor="note">Note on “{target.label}”</Label>
            <p className="text-muted-foreground font-mono text-xs break-all">
              {target.anchor ?? target.domPath}
            </p>
            <Input
              id="note"
              autoFocus
              placeholder="What should change?"
              value={note}
              onChange={(event) => onNoteChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !busy && note.trim()) onQueue();
              }}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={onQueue} disabled={busy || !note.trim()} data-testid="queue-note">
                Queue note
              </Button>
              <Button size="sm" variant="ghost" onClick={onDiscard}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {queued.length === 0 ? (
          <p className="text-muted-foreground text-sm">No notes queued.</p>
        ) : (
          <ul className="grid gap-2" data-testid="queued-notes">
            {queued.map((annotation) => (
              <li key={annotation.id} className="flex items-start justify-between gap-2 rounded-md border p-3">
                <span className="grid min-w-0 gap-1">
                  <span className="text-sm">{annotation.note}</span>
                  <span className="text-muted-foreground text-xs break-all">
                    {annotation.pageTitle} · {annotation.target.label}
                  </span>
                </span>
                <Button
                  disabled={busy}
                  size="sm"
                  variant="ghost"
                  onClick={() => onRemove(annotation.id)}
                  aria-label={`Remove note ${annotation.note}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <Button onClick={onSend} disabled={busy || queued.length === 0} data-testid="send-notes">
          Send {queued.length} note{queued.length === 1 ? "" : "s"} to the review agent
        </Button>

        {lastBatch && (
          <div className="grid gap-1 rounded-md border p-3" data-testid="delivery-receipt">
            <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
              Delivered
              <Badge variant="secondary">{lastBatch.delivery.transport}</Badge>
            </span>
            <span className="text-muted-foreground text-xs">{lastBatch.delivery.receipt}</span>
            {lastBatch.delivery.reply && (
              <p className="bg-muted mt-1 rounded p-2 text-xs whitespace-pre-wrap">
                {lastBatch.delivery.reply}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
