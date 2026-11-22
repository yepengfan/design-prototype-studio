import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ComponentSearch } from "@/components/ComponentSearch";
import { DesignSystemsPanel } from "@/components/DesignSystemsPanel";
import { GapsPanel } from "@/components/GapsPanel";
import { GherkinEditor } from "@/components/GherkinEditor";
import { NotesPanel } from "@/components/NotesPanel";
import { PreviewPane, type ReviewMode } from "@/components/PreviewPane";
import { TemplatePicker } from "@/components/TemplatePicker";
import {
  api,
  ApiError,
  type AnnotationTarget,
  type CatalogComponent,
  type Preset,
  type Project,
  type SourceSpec,
} from "@/lib/api";

export function App() {
  const [project, setProject] = useState<Project>();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [gherkin, setGherkin] = useState("");
  const [components, setComponents] = useState<CatalogComponent[]>([]);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ReviewMode>("interact");
  const [target, setTarget] = useState<AnnotationTarget>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; details: string[] }>();
  const [importPrompt, setImportPrompt] = useState<string>();
  const [buildKey, setBuildKey] = useState("initial");

  const running = useRef(false);

  const run = useCallback(async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError({
        message: cause instanceof Error ? cause.message : String(cause),
        details: cause instanceof ApiError ? cause.details : [],
      });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run(async () => {
      const [{ presets: available, defaultGherkin }, { projects }] = await Promise.all([
        api.presets(),
        api.listProjects(),
      ]);
      setPresets(available);
      const current = projects[0] ?? (await api.createProject("Orders prototype")).project;
      setProject(current);
      setGherkin(current.gherkin || defaultGherkin);
      if (current.pages.length) setBuildKey(current.pages[0]!.generatedAt);
    });
  }, [run]);

  const projectId = project?.id;

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const timer = setTimeout(() => {
      void api
        .searchComponents(projectId, query)
        .then((result) => active && setComponents(result.components))
        .catch(() => active && setComponents([]));
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [projectId, query, project?.selectedSystemIds, project?.systems.length]);

  const templates = useMemo(
    () =>
      (project?.systems ?? [])
        .filter((system) => project?.selectedSystemIds.includes(system.id))
        .flatMap((system) => system.templates),
    [project],
  );

  const page = project?.pages.at(-1);

  const onSelect = useCallback((selected: AnnotationTarget) => {
    setTarget(selected);
    setNote("");
  }, []);

  if (!project)
    return (
      <main className="text-muted-foreground grid min-h-dvh place-items-center text-sm">
        {error ? error.message : "Starting the Studio…"}
      </main>
    );

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Design Prototype Studio</h1>
          <p className="text-muted-foreground text-sm">
            Import a design system, describe the use case, review the page it generates.
          </p>
        </div>
        <span className="text-muted-foreground text-xs">{project.name}</span>
      </header>

      {error && (
        <div className="px-6 pt-4">
          <Alert variant="destructive" data-testid="error">
            <AlertTitle>Something needs attention</AlertTitle>
            <AlertDescription>
              <span>{error.message}</span>
              {error.details.length > 0 && (
                <ul className="mt-1 grid gap-1 text-xs">
                  {error.details.slice(0, 5).map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              )}
            </AlertDescription>
          </Alert>
        </div>
      )}

      {/* Inputs on the left, the artefact in the middle, review on the right.
          The third column only appears once it can leave the preview wide
          enough for a design system's desktop breakpoints. */}
      <main className="grid min-h-0 flex-1 gap-4 overflow-hidden p-6 lg:grid-cols-[minmax(300px,340px)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto] 2xl:grid-cols-[minmax(300px,340px)_minmax(0,1fr)_minmax(320px,360px)] 2xl:grid-rows-1">
        <ScrollArea className="min-h-0 lg:row-span-2 2xl:row-span-1">
          <div className="grid gap-4 pr-4">
            <DesignSystemsPanel
              project={project}
              presets={presets}
              busy={busy}
              prompt={importPrompt}
              onImport={(name, spec: SourceSpec) =>
                void run(async () => {
                  const { project: updated } = await api.importSystem(project.id, name, spec);
                  setProject(updated);
                  setImportPrompt(undefined);
                })
              }
              onToggle={(systemId, selected) => {
                const next = selected
                  ? [...project.selectedSystemIds, systemId]
                  : project.selectedSystemIds.filter((id) => id !== systemId);
                // Shown at once so the control answers the click, then reconciled.
                void run(async () => {
                  setProject({ ...project, selectedSystemIds: next });
                  try {
                    setProject((await api.selectSystems(project.id, next)).project);
                  } catch (cause) {
                    setProject((await api.getProject(project.id)).project);
                    throw cause;
                  }
                });
              }}
            />

            <ComponentSearch query={query} components={components} onQueryChange={setQuery} />

            <TemplatePicker
              busy={busy}
              templates={templates}
              selectedId={project.selectedTemplateId}
              onSelect={(templateId) => {
                void run(async () => {
                  setProject({ ...project, selectedTemplateId: templateId });
                  try {
                    setProject((await api.selectTemplate(project.id, templateId)).project);
                  } catch (cause) {
                    setProject((await api.getProject(project.id)).project);
                    throw cause;
                  }
                });
              }}
            />

            <GherkinEditor
              gherkin={gherkin}
              busy={busy}
              canGenerate={templates.some((template) => template.id === project.selectedTemplateId)}
              onChange={setGherkin}
              onGenerate={() =>
                void run(async () => {
                  const result = await api.generate(project.id, gherkin, project.selectedTemplateId!);
                  setProject(result.project);
                  setBuildKey(result.page.generatedAt);
                  setTarget(undefined);
                  setMode("interact");
                })
              }
            />
          </div>
        </ScrollArea>

        <PreviewPane
          projectId={project.id}
          page={page}
          mode={mode}
          buildKey={buildKey}
          onModeChange={(next) => {
            setMode(next);
            if (next === "interact") setTarget(undefined);
          }}
          onSelect={onSelect}
        />

        <ScrollArea className="min-h-0 lg:max-h-[30dvh] 2xl:max-h-none">
          <div className="grid gap-4 pr-4">
            {!page && (
              <p className="text-muted-foreground rounded-xl border border-dashed p-6 text-sm">
                Missing building blocks and feedback notes appear here once a page is generated.
              </p>
            )}

            {page && (
              <GapsPanel
                gaps={page.plan.gaps}
                onWidenScope={(gap) =>
                  setImportPrompt(`“${gap.requirement}” still needs ${gap.capability}. ${gap.suggestion}`)
                }
              />
            )}

            {page && <NotesPanel
              project={project}
              target={target}
              note={note}
              busy={busy}
              onNoteChange={setNote}
              onDiscard={() => setTarget(undefined)}
              onQueue={() =>
                void run(async () => {
                  if (!page || !target) return;
                  setProject((await api.addAnnotation(project.id, page.id, target, note.trim(), buildKey)).project);
                  setTarget(undefined);
                  setNote("");
                })
              }
              onRemove={(annotationId) =>
                void run(async () => {
                  setProject((await api.removeAnnotation(project.id, annotationId)).project);
                })
              }
              onSend={() =>
                void run(async () => {
                  setProject((await api.sendAnnotations(project.id)).project);
                })
              }
            />}
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}
