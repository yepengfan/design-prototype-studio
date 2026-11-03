import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ProjectState,
  Snapshot,
  Component,
  Run,
  Property,
} from "../server/core/contracts";
import type { Anchor, Edit } from "../server/core/source";
import type { Scenario } from "../server/core/requirements";
import type { Change } from "../server/core/changes";
import "./styles.css";
const count = (n: number, item: string) => `${n} ${item}${n === 1 ? "" : "s"}`;
class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: any,
  ) {
    super(message);
  }
}
let secret = "";
async function api<T = any>(
  url: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  if (!secret) secret = (await (await fetch("/api/session")).json()).secret;
  const response = await fetch("/api" + url, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", "X-Studio-Session": secret },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok)
    throw new RequestError(data.error, response.status, data.detail);
  return data;
}
type Data = {
  state: ProjectState;
  snapshot: Snapshot;
  history: { id: string; label: string; at: string }[];
  scope: { files: { file: string }[]; scenarios: Scenario[] };
  outline: {
    id: string;
    title: string;
    file: string;
    hash: string;
    nodes: Anchor[];
  }[];
};
type Modal =
  | "requirements"
  | "library"
  | "versions"
  | "import"
  | "quality"
  | "templates"
  | null;
function Studio() {
  const [id, setId] = useState(localStorage.getItem("studio-project") ?? "");
  return <ProjectStudio key={id} id={id} setId={setId} />;
}
function ProjectStudio({ id, setId }: { id: string; setId: (id: string) => void }) {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [data, setData] = useState<Data>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [modal, setModal] = useState<Modal>(null);
  const [tab, setTab] = useState("components");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState("");
  const [insertionSlot, setInsertionSlot] = useState("");
  const [page, setPage] = useState("");
  const [preview, setPreview] = useState<{
    id: string;
    url: string;
    revision: string;
    label?: string;
  }>();
  const previewRequest = useRef(0);
  const [scenario, setScenario] = useState("");
  const [capture, setCapture] = useState(false);
  const [annotate, setAnnotate] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [adapter, setAdapter] = useState<"codex" | "cursor">("codex");
  const [change, setChange] = useState<
    Change & {
      affectedAcceptedResults?: {
        id: string;
        text: string;
        reason: string;
        files: string[];
      }[];
      acceptedResultsConfirmation?: string;
    }
  >();
  const [replaceAccepted, setReplaceAccepted] = useState(false);
  const [reviewRun, setReviewRun] = useState<Run>();
  const [undoDecision, setUndoDecision] = useState<{
    id: string;
    base: string;
    affected: { id: string; text: string; reason: string }[];
  }>();
  const [candidatePreview, setCandidatePreview] = useState<{
    id: string;
    url: string;
  }>();
  const frame = useRef<HTMLIFrameElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [canvasBox, setCanvasBox] = useState({ width: 864, height: 600 });
  const [canvasZoom, setCanvasZoom] = useState("fit");
  const previewScale =
    canvasZoom === "fit"
      ? Math.min(canvasBox.width / 1440, canvasBox.height / 1000, 1)
      : 1;
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0].contentRect;
      setCanvasBox({ width: box.width, height: box.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [data?.state.id]);
  const outline = data?.outline.find((p) => p.id === page) ?? data?.outline[0];
  const node = outline?.nodes.find((n) => n.id === selection);
  useEffect(
    () =>
      setInsertionSlot(
        node?.component && !node.component.children
          ? (node.component.slots[0] ?? "")
          : "",
      ),
    [
      node?.path,
      node?.tag,
      node?.component?.package,
      node?.component?.export,
      node?.component?.version,
    ],
  );
  const components =
    data?.snapshot.manifest.libraries.flatMap((l) => l.components) ?? [];
  const filtered = components.filter((c) =>
    query
      .toLowerCase()
      .split(/\s+/)
      .every((w) =>
        `${c.name} ${c.description} ${c.package}`.toLowerCase().includes(w),
      ),
  );
  function reconcileScenario(current: string, updated: Data) {
    return updated.scope.scenarios.some((item) => item.id === current) &&
      updated.snapshot.manifest.scenarios.some((binding) => binding.scenario === current) ? current : "";
  }
  function receiveData(updated: Data) {
    setData(updated);
    setScenario((current) => reconcileScenario(current, updated));
    setPage((current) => updated.outline.some((item) => item.id === current) ? current : updated.outline[0]?.id ?? "");
  }
  const load = async () => {
    setProjects(await api("/projects"));
    if (id) {
      const d = await api<Data>(`/projects/${id}`);
      receiveData(d);
      return d;
    }
  };
  async function act(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      const previousRevision = data?.snapshot.id;
      await action();
      const updated = await load();
      if (preview && updated && updated.snapshot.id !== previousRevision)
        await showPreview(undefined, 0, updated.outline.some((item) => item.id === page) ? page : updated.outline[0]?.id, reconcileScenario(scenario, updated));
    } catch (e) {
      setError(
        e instanceof RequestError
          ? e.message +
              (e.detail ? "\n" + JSON.stringify(e.detail, null, 2) : "")
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy("");
    }
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    localStorage.setItem("studio-project", id);
    previewRequest.current++;
    if (preview)
      void api(`/previews/${preview.id}`, undefined, "DELETE").catch(() => {});
    setPreview(undefined);
    setSelection("");
    return () => { previewRequest.current++; };
  }, [id]); // Project switch is the reload boundary.
  useEffect(() => () => {
    if (preview) void api(`/previews/${preview.id}`, undefined, "DELETE").catch(() => {});
  }, [preview]);
  useEffect(() => () => {
    if (candidatePreview) void api(`/previews/${candidatePreview.id}`, undefined, "DELETE").catch(() => {});
  }, [candidatePreview]);
  useEffect(() => {
    if (!id) return;
    const timer = setInterval(() => {
      void api<Data>(`/projects/${id}`)
        .then(receiveData)
        .catch(() => {});
    }, 1800);
    return () => clearInterval(timer);
  }, [id]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (
        !preview ||
        event.source !== frame.current?.contentWindow ||
        event.origin !== new URL(preview.url).origin
      )
        return;
      if (event.data?.type === "studio:selection") {
        const p = data?.outline.find((p) => p.file === event.data.file);
        if (p) {
          setPage(p.id);
          setSelection(event.data.id);
        }
      }
      if (event.data?.type === "studio:error")
        setError("Preview: " + event.data.message);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [preview, data]);
  function bridge() {
    if (preview) {
      const target = new URL(preview.url).origin;
      frame.current?.contentWindow?.postMessage(
        { type: "studio:capture", enabled: capture || annotate },
        target,
      );
      frame.current?.contentWindow?.postMessage(
        { type: "studio:highlight", id: selection },
        target,
      );
    }
  }
  useEffect(bridge, [selection, capture, annotate, preview]);
  async function showPreview(
    component?: Component,
    example = 0,
    pageId = outline?.id,
    scenarioId = scenario,
  ) {
    const request = ++previewRequest.current;
    const previous = preview;
    setPreview(undefined);
    try {
      if (previous) await api(`/previews/${previous.id}`, undefined, "DELETE");
      const next = await api(`/projects/${id}/preview`, {
        scenario: scenarioId,
        component,
        example,
        page: pageId,
      });
      if (request !== previewRequest.current) {
        await api(`/previews/${next.id}`, undefined, "DELETE");
        return;
      }
      setPreview({
        ...next,
        label: component
          ? `${component.name} · ${component.examples[example]?.name ?? "Common state"}`
          : undefined,
      });
    } catch (error) {
      if (request === previewRequest.current) throw error;
    }
  }
  async function edit(values: Partial<Edit>) {
    if (!outline || !selection || !data) return;
    const result = await api(`/projects/${id}/edit`, {
      base: data.snapshot.id,
      page: outline.id,
      edit: { anchor: selection, sourceHash: outline.hash, ...values },
    });
    const fresh = await api<Data>(`/projects/${id}`);
    receiveData(fresh);
    setSelection(result.selection ?? "");
  }
  async function undoAnnotation(result: string) {
    try {
      await api(`/projects/${id}/annotations/undo`, {
        id: result,
        base: data?.snapshot.id,
      });
    } catch (error) {
      if (
        error instanceof RequestError &&
        error.status === 409 &&
        Array.isArray(error.detail)
      )
        setUndoDecision({
          id: result,
          base: data!.snapshot.id,
          affected: error.detail,
        });
      else throw error;
    }
  }
  async function generate(text: string, annotation?: string) {
    await api(`/projects/${id}/generate`, {
      prompt: text,
      adapter,
      annotation,
      page: outline?.id,
    });
    setPrompt("");
  }
  async function review(run: Run) {
    setReplaceAccepted(false);
    if (candidatePreview) {
      await api(`/previews/${candidatePreview.id}`, undefined, "DELETE");
      setCandidatePreview(undefined);
    }
    setChange(await api(`/projects/${id}/runs/${run.id}/diff`));
    setReviewRun(run);
  }
  const currentRun =
    data?.state.runs.find((r) => r.status === "running") ??
    data?.state.runs.find((r) => r.status === "queued");
  return (
    <div className="studio">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Studio home">
          <span className="brand-mark">s</span>
          <span>
            Studio<span className="brand-sub">Design Prototype</span>
          </span>
        </a>
        <span className="divider" />
        <select
          aria-label="Current project"
          value={id}
          onChange={(e) => setId(e.target.value)}
        >
          <option value="">Your projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="save-state">
          <i /> Saved on this Mac
        </span>
        <div className="top-actions">
          <button onClick={() => setModal("import")}>Import source</button>
          <button disabled={!data} onClick={() => setModal("versions")}>
            Versions
          </button>
          <button disabled={!data} onClick={() => setModal("quality")}>
            Check delivery
          </button>
          <button
            className="primary"
            disabled={!data}
            onClick={() =>
              void act("Preparing download", async () => {
                const r = await fetch(`/api/projects/${id}/export`, {
                  headers: { "X-Studio-Session": secret },
                });
                if (!r.ok) throw new Error("Export failed.");
                const url = URL.createObjectURL(await r.blob());
                const a = document.createElement("a");
                a.href = url;
                a.download = "prototype.zip";
                a.click();
                URL.revokeObjectURL(url);
              })
            }
          >
            Export project ↗
          </button>
        </div>
      </header>
      {error && (
        <div className="error" role="alert">
          <div>
            <strong>This needs your attention</strong>
            <pre>{error}</pre>
          </div>
          <button onClick={() => setError("")} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}
      {busy && (
        <div className="progress" role="status">
          <span className="spinner" />
          {busy}. Your accepted work stays saved.
        </div>
      )}
      {!data ? (
        <main className="welcome">
          <div className="eyebrow">FROM REQUIREMENTS TO REAL COMPONENTS</div>
          <h1>
            A place to make
            <br />
            your next interface.
          </h1>
          <p>
            Bring your Gherkin and React design system.
            <br />
            Shape a working page, then hand off source engineers can keep.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = String(new FormData(e.currentTarget).get("name"));
              void act("Creating project", async () => {
                const p = await api("/projects", { name });
                setId(p.state.id);
              });
            }}
          >
            <label>
              Project name
              <input
                name="name"
                placeholder="e.g. Customer workspace"
                required
                maxLength={120}
              />
            </label>
            <button className="primary">Create blank project →</button>
            <button type="button" onClick={() => setModal("templates")}>
              Start from a saved template
            </button>
          </form>
          <div className="welcome-note">
            LOCAL WORKSPACE{" "}
            <span>Private projects. Genuine components. Runnable source.</span>
          </div>
        </main>
      ) : (
        <>
          {data.state.templateReconciliation && (
            <div className="template-review notice">
              This template is waiting to be adapted to your selected
              requirements. Preview its starting point, then review the proposed
              page and requirement changes together.{" "}
              <button
                onClick={() =>
                  setPrompt(
                    "Adapt this template to only my selected requirements. Keep applicable parts, explain conflicts, and ask about unclear business facts.",
                  )
                }
              >
                Prepare adaptation prompt
              </button>
            </div>
          )}
          <div className="workspace-bar">
            <div>
              <span className="eyebrow">WORKING SCOPE</span>
              <button
                className="scope-button"
                onClick={() => setModal("requirements")}
              >
                {data.scope.files.length
                  ? `${count(data.scope.files.length, "file")} · ${count(data.scope.scenarios.length, "scenario")}`
                  : "Choose requirements"}{" "}
                <span>⌄</span>
              </button>
            </div>
            <div className="canvas-actions">
              <button
                disabled={!data.history.length || data.history.length < 2}
                onClick={() =>
                  void act("Restoring previous edit", () =>
                    api(`/projects/${id}/history`, { action: "undo" }),
                  )
                }
              >
                ↶ Undo
              </button>
              <button
                disabled={!data.state.redo.length}
                onClick={() =>
                  void act("Restoring edit", () =>
                    api(`/projects/${id}/history`, { action: "redo" }),
                  )
                }
              >
                ↷ Redo
              </button>
              <span className="divider" />
              <button
                className={capture ? "active" : ""}
                onClick={() => {
                  setCapture(!capture);
                  setAnnotate(false);
                }}
              >
                ⌖ Select
              </button>
              <button
                className={annotate ? "active" : ""}
                onClick={() => {
                  setAnnotate(!annotate);
                  setCapture(false);
                  setTab("annotations");
                }}
              >
                ◌ Annotate {annotate ? "on" : "off"}
              </button>
            </div>
          </div>
          <div className="workspace">
            <aside className="library-panel">
              <nav className="tabs">
                {["components", "outline", "annotations"].map((t) => (
                  <button
                    key={t}
                    className={tab === t ? "selected" : ""}
                    onClick={() => setTab(t)}
                  >
                    {t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </nav>
              {tab === "components" && (
                <>
                  <div className="panel-heading">
                    <h2>Your libraries</h2>
                    <button
                      className="icon"
                      aria-label="Import npm library"
                      onClick={() => setModal("library")}
                    >
                      +
                    </button>
                  </div>
                  <input
                    className="search"
                    aria-label="Find components"
                    placeholder="Search name or purpose…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {!components.length && (
                    <div className="empty small">
                      <span className="empty-symbol">▦</span>
                      <h3>Use your design system</h3>
                      <p>
                        Import an npm library to explore its genuine components
                        and common states.
                      </p>
                      <button onClick={() => setModal("library")}>
                        Import a library
                      </button>
                    </div>
                  )}
                  <div className="component-list">
                    {filtered.map((c) => (
                      <article
                        className="component-card"
                        key={c.package + c.export}
                      >
                        <div className="component-sample">
                          <span>{c.name.slice(0, 1)}</span>
                          <button
                            onClick={() =>
                              void act("Starting component preview", () =>
                                showPreview(c),
                              )
                            }
                          >
                            Preview ↗
                          </button>
                        </div>
                        <h3>{c.name}</h3>
                        <p>{c.description}</p>
                        <small>
                          {c.package} · {c.version}
                        </small>
                        <div className="card-actions">
                          <select
                            aria-label={`${c.name} preview state`}
                            onChange={(e) =>
                              void act("Starting state preview", () =>
                                showPreview(c, Number(e.target.value)),
                              )
                            }
                          >
                            {c.examples.map((x, i) => (
                              <option key={i} value={i}>
                                {x.name}
                              </option>
                            ))}
                          </select>
                          <button
                            disabled={!node}
                            onClick={() =>
                              void act("Adding component", () =>
                                edit({
                                  operation: "insert",
                                  component: c,
                                  slot: insertionSlot || undefined,
                                }),
                              )
                            }
                          >
                            + Add
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                  <button
                    className="bottom-link"
                    onClick={() => setModal("templates")}
                  >
                    Saved page templates ↗
                  </button>
                </>
              )}
              {tab === "outline" && (
                <>
                  <div className="panel-heading">
                    <h2>Page structure</h2>
                  </div>
                  <select
                    className="full"
                    aria-label="Page"
                    value={outline?.id ?? ""}
                    onChange={(e) => {
                      const selected = e.target.value;
                      setPage(selected);
                      setScenario("");
                      setSelection("");
                      if (preview)
                        void act("Opening selected page", () =>
                          showPreview(undefined, 0, selected, ""),
                        );
                    }}
                  >
                    {data.outline.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                  <p className="hint">
                    Choose an item to adjust its layout or appearance.
                  </p>
                  <div className="outline">
                    {outline?.nodes.map((n) => (
                      <button
                        key={n.id}
                        className={selection === n.id ? "selected" : ""}
                        style={{ paddingLeft: n.parent ? 28 : 12 }}
                        onClick={() => setSelection(n.id)}
                      >
                        <span>◇</span> {n.component?.name ?? n.tag}
                        {n.dynamic && <small>repeated / conditional</small>}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {tab === "annotations" && (
                <>
                  <div className="panel-heading">
                    <h2>Annotation batch</h2>
                    <span className="badge">
                      {data.state.annotations.length}
                    </span>
                  </div>
                  <p className="hint">
                    Turn capture on, select a region, and describe the change.
                    Review the batch before submitting.
                  </p>
                  {annotate && (
                    <form
                      className="annotation-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const text = String(
                          new FormData(e.currentTarget).get("annotation"),
                        );
                        void act("Saving annotation", () =>
                          api(`/projects/${id}/annotations`, {
                            target: selection || "page",
                            page: outline?.id,
                            text,
                          }),
                        );
                        e.currentTarget.reset();
                      }}
                    >
                      <label>
                        Target:{" "}
                        {node?.component?.name ?? node?.tag ?? "Whole page"}
                        <textarea
                          name="annotation"
                          placeholder="What should change here?"
                          required
                        />
                      </label>
                      <button>Add draft</button>
                    </form>
                  )}
                  {data.state.annotations.map((a) => (
                    <article className="annotation-card" key={a.id}>
                      <span className={"status " + a.status}>{a.status}</span>
                      <p>{a.text}</p>
                      <small>
                        {a.target === "page"
                          ? "Whole page"
                          : "Selected component"}
                      </small>
                      {[
                        "draft",
                        "pending",
                        "failed",
                        "undone",
                        "approved",
                      ].includes(a.status) && (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            const form = new FormData(event.currentTarget);
                            void act("Revising annotation", () =>
                              api(
                                `/projects/${id}/annotations/${a.id}/revise`,
                                {
                                  base: data.snapshot.id,
                                  text: String(form.get("text")),
                                  page: form.get("retarget")
                                    ? outline?.id
                                    : a.page,
                                  target: form.get("retarget")
                                    ? selection || "page"
                                    : a.target,
                                },
                              ),
                            );
                          }}
                        >
                          <label>
                            Edit annotation
                            <textarea
                              name="text"
                              defaultValue={a.text}
                              required
                            />
                          </label>
                          <label className="checkbox">
                            <input name="retarget" type="checkbox" />
                            Use current selection:{" "}
                            {node?.component?.name ?? node?.tag ?? "Whole page"}
                          </label>
                          <button>Save and review again</button>
                        </form>
                      )}
                      {a.status === "accepted" && (
                        <button
                          onClick={() =>
                            void act("Undoing annotation result", () =>
                              undoAnnotation(a.id),
                            )
                          }
                        >
                          Undo result
                        </button>
                      )}
                      {["pending", "failed", "undone"].includes(a.status) && (
                        <button
                          onClick={() =>
                            void act("Reworking annotation", async () => {
                              await api(`/projects/${id}/annotations/approve`, {
                                ids: [a.id],
                              });
                              await generate(
                                `Annotation on ${a.target}: ${a.text}. Preserve all accepted independent edits.`,
                                a.id,
                              );
                            })
                          }
                        >
                          Rework
                        </button>
                      )}
                      {data.state.runs
                        .filter(
                          (result) =>
                            result.annotation === a.id &&
                            result.appliedRevision,
                        )
                        .map((result) => (
                          <div className="annotation-result" key={result.id}>
                            <small>
                              {data.snapshot.activeAnnotationResults?.includes(
                                result.id,
                              )
                                ? "Accepted result"
                                : "Undone result"}
                              :{" "}
                              {result.annotationText ??
                                result.proposal?.summary}
                            </small>
                            <button
                              onClick={() =>
                                void act("Inspecting saved result", () =>
                                  review(result),
                                )
                              }
                            >
                              Inspect saved result
                            </button>
                            {data.snapshot.activeAnnotationResults?.includes(
                              result.id,
                            ) && (
                              <button
                                onClick={() =>
                                  void act("Undoing this result", () =>
                                    undoAnnotation(result.id),
                                  )
                                }
                              >
                                Undo this result
                              </button>
                            )}
                          </div>
                        ))}
                      {a.run &&
                        data.state.runs.find((r) => r.id === a.run)?.status ===
                          "review" && (
                          <button
                            onClick={() =>
                              void act("Loading result", () =>
                                review(
                                  data.state.runs.find((r) => r.id === a.run)!,
                                ),
                              )
                            }
                          >
                            Inspect result
                          </button>
                        )}
                    </article>
                  ))}
                  <button
                    className="primary full"
                    disabled={
                      !data.state.annotations.some((a) => a.status === "draft")
                    }
                    onClick={() =>
                      void act("Approving annotation batch", () =>
                        api(`/projects/${id}/annotations/approve`, {
                          ids: data.state.annotations
                            .filter((a) => a.status === "draft")
                            .map((a) => a.id),
                        }),
                      )
                    }
                  >
                    Approve draft batch
                  </button>
                  <button
                    className="full"
                    disabled={
                      !!currentRun ||
                      !data.state.annotations.some(
                        (a) => a.status === "approved",
                      )
                    }
                    onClick={() =>
                      void act("Submitting approved batch", () =>
                        api(`/projects/${id}/annotations/submit`, { adapter }),
                      )
                    }
                  >
                    Submit approved batch
                  </button>
                </>
              )}
            </aside>
            <main className="canvas-panel">
              <div className="preview-toolbar">
                <div className="preview-mode">
                  <span className="desktop-icon">▱</span> Desktop preview{" "}
                  <span className="muted">1440</span>
                </div>
                <select
                  aria-label="Preview zoom"
                  value={canvasZoom}
                  onChange={(event) => setCanvasZoom(event.target.value)}
                >
                  <option value="fit">Fit desktop</option>
                  <option value="actual">100%</option>
                </select>
                <select
                  aria-label="Scenario preview"
                  value={scenario}
                  onChange={(e) => {
                    const selected = e.target.value;
                    const target =
                      data.snapshot.manifest.scenarios.find(
                        (binding) => binding.scenario === selected,
                      )?.page ?? outline?.id;
                    setScenario(selected);
                    setPage(target ?? "");
                    setSelection("");
                    if (preview)
                      void act("Opening selected scenario", () =>
                        showPreview(undefined, 0, target, selected),
                      );
                  }}
                >
                  <option value="">Current page</option>
                  {data.scope.scenarios.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.feature} / {s.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() =>
                    void act("Preparing genuine React preview", () =>
                      showPreview(),
                    )
                  }
                >
                  ↻ {preview ? "Reset preview" : "Open preview"}
                </button>
              </div>
              <div
                className="canvas-area"
                ref={canvas}
                style={{ overflow: "auto" }}
              >
                {preview ? (
                  <div
                    style={{
                      position: "relative",
                      flexShrink: 0,
                      width: 1440 * previewScale,
                      height: 1000 * previewScale,
                      margin: canvasZoom === "fit" ? "auto" : 0,
                    }}
                  >
                    <iframe
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: 1440,
                        height: 1000,
                        transform: `scale(${previewScale})`,
                        transformOrigin: "top left",
                      }}
                      ref={frame}
                      title="Live React preview"
                      src={preview.url}
                      sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
                      onLoad={bridge}
                    />
                  </div>
                ) : (
                  <div className="canvas-placeholder">
                    <div className="page-outline">
                      <div />
                      <div />
                      <div className="placeholder-grid">
                        <i />
                        <i />
                      </div>
                    </div>
                    <h2>Your page starts here</h2>
                    <p>
                      {data.scope.scenarios.length
                        ? "Import a library, then generate from your selected scenarios or arrange components in the page outline."
                        : "Choose the Gherkin files that describe this page. Studio will keep their business scope visible as you work."}
                    </p>
                    <button
                      onClick={() =>
                        data.scope.scenarios.length
                          ? setModal("library")
                          : setModal("requirements")
                      }
                    >
                      {data.scope.scenarios.length
                        ? "Explore a library"
                        : "Choose requirements"}{" "}
                      →
                    </button>
                  </div>
                )}
              </div>
              <div className="canvas-footer">
                <span>
                  {preview?.label
                    ? `Library example · ${preview.label}`
                    : preview && preview.revision !== data.snapshot.id
                      ? "Page changed · reset preview to see latest"
                      : preview
                        ? "Preview matches your saved page"
                        : "Open preview to see the saved page"}
                </span>
                <span>
                  {data.snapshot.manifest.libraries.length}{" "}
                  {data.snapshot.manifest.libraries.length === 1
                    ? "library"
                    : "libraries"}{" "}
                  · {count(data.snapshot.manifest.pages.length, "page")}
                </span>
              </div>
              <form
                className="prompt-bar"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act("Starting local AI request", () => generate(prompt));
                }}
              >
                <div className="prompt-label">
                  ✦ MAKE A CHANGE{" "}
                  <select
                    aria-label="AI tool"
                    value={adapter}
                    onChange={(e) =>
                      setAdapter(e.target.value as "codex" | "cursor")
                    }
                  >
                    <option value="codex">Codex</option>
                    <option value="cursor">Cursor</option>
                  </select>
                </div>
                <textarea
                  aria-label="Describe your change"
                  placeholder="Describe the page or change you want. Studio will ask about missing business details."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  required
                />
                <div className="prompt-footer">
                  <span>
                    Uses your installed, signed-in tool. Business changes
                    require Gherkin review.
                  </span>
                  <button
                    className="primary"
                    disabled={!!currentRun || !data.scope.scenarios.length}
                  >
                    Generate →
                  </button>
                </div>
              </form>
              {currentRun && (
                <div className="run-progress">
                  <span className="spinner" />
                  <span>
                    {currentRun.adapter} is preparing a proposal. You can leave
                    this page.
                  </span>
                  <button
                    onClick={() =>
                      void act("Cancelling request", () =>
                        api(`/projects/${id}/runs/${currentRun.id}/cancel`, {}),
                      )
                    }
                  >
                    Cancel
                  </button>
                </div>
              )}
              {data.state.runs
                .slice(-3)
                .reverse()
                .filter(
                  (r) => !["queued", "running", "applied"].includes(r.status),
                )
                .map((r) => (
                  <article className="run-result" key={r.id}>
                    <strong>{r.proposal?.summary ?? r.status}</strong>
                    {r.error && <p>{r.error}</p>}
                    {r.proposal?.questions.map((q) => (
                      <p key={q}>{q}</p>
                    ))}
                    {r.status === "review" &&
                      !["gap", "clarification"].includes(
                        r.proposal?.kind ?? "",
                      ) && (
                        <button
                          onClick={() =>
                            void act("Loading proposal", () => review(r))
                          }
                        >
                          Review changes
                        </button>
                      )}
                  </article>
                ))}
            </main>
            <aside className="inspector">
              <div className="panel-heading">
                <h2>Properties</h2>
                <span className="muted">◇</span>
              </div>
              {node ? (
                <>
                  <div className="selected-component">
                    <span className="eyebrow">SELECTED COMPONENT</span>
                    <h3>{node.component?.name ?? node.tag}</h3>
                    <small>
                      {node.component
                        ? `${node.component.package}@${node.component.version}`
                        : "Page layout"}
                    </small>
                    {node.dynamic && (
                      <p className="notice">
                        This item repeats across the page. Your changes apply to
                        all its appearances.
                      </p>
                    )}
                  </div>
                  {node.text !== undefined && (
                    <Field
                      label="Text"
                      initial={node.text}
                      save={(value) =>
                        act("Updating text", () =>
                          edit({ operation: "text", value }),
                        )
                      }
                    />
                  )}
                  {node.component &&
                    Object.entries(node.component.props).map(([key, spec]) => (
                      <PropertyControl
                        key={node.path + key}
                        label={
                          spec.label ?? key.replace(/([a-z])([A-Z])/g, "$1 $2")
                        }
                        spec={spec}
                        value={node.props[key] ?? spec.default}
                        controlled={
                          node.controlled.includes(key)
                        }
                        save={(value) =>
                          act("Updating property", () =>
                            edit({ operation: "prop", property: key, value }),
                          )
                        }
                      />
                    ))}
                  {node.component?.slots.length ? (
                    <label className="property">
                      Add new components into
                      <select
                        aria-label="Insertion slot"
                        value={insertionSlot}
                        onChange={(event) =>
                          setInsertionSlot(event.target.value)
                        }
                      >
                        {node.component.children && (
                          <option value="">Body</option>
                        )}
                        {node.component.slots.map((slot) => (
                          <option key={slot} value={slot}>
                            {slot.replace(/([a-z])([A-Z])/g, "$1 $2")}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {[
                    "main",
                    "div",
                    "section",
                    "article",
                    "aside",
                    "header",
                    "footer",
                  ].includes(node.tag) && (
                    <>
                      <h3 className="section-title">Layout</h3>
                      <div className="segmented">
                        {["flow", "stack", "grid"].map((layout) => (
                          <button
                            key={layout}
                            onClick={() =>
                              void act("Changing layout", () =>
                                edit({
                                  operation: "style",
                                  value:
                                    layout === "grid"
                                      ? {
                                          display: "grid",
                                          gridTemplateColumns: "1fr 1fr",
                                        }
                                      : layout === "stack"
                                        ? {
                                            display: "flex",
                                            flexDirection: "column",
                                          }
                                        : { display: "block" },
                                }),
                              )
                            }
                          >
                            {layout}
                          </button>
                        ))}
                      </div>
                      {[
                        "flexDirection",
                        "gridTemplateColumns",
                        "gap",
                        "padding",
                        "width",
                        "maxWidth",
                        "minHeight",
                        "alignItems",
                        "justifyContent",
                      ].map((k) => (
                        <Field
                          key={node.path + k}
                          label={k}
                          initial={String((node.props.style as any)?.[k] ?? "")}
                          save={(value) =>
                            act("Updating layout", () =>
                              edit({
                                operation: "style",
                                value: {
                                  [k]: /^\d+$/.test(value)
                                    ? Number(value)
                                    : value,
                                },
                              }),
                            )
                          }
                        />
                      ))}
                    </>
                  )}
                  {[
                    "main",
                    "div",
                    "section",
                    "article",
                    "aside",
                    "header",
                    "footer",
                    "h1",
                    "h2",
                    "h3",
                    "h4",
                    "h5",
                    "h6",
                    "p",
                    "span",
                    "strong",
                    "em",
                    "small",
                    "label",
                    "li",
                  ].includes(node.tag) && (
                    <>
                      <h3 className="section-title">Text and style</h3>
                      <p className="hint">
                        Use library tokens such as var(--text-color) or literal
                        styles. Imported components use their documented
                        settings above.
                      </p>
                      {[
                        "color",
                        "backgroundColor",
                        "fontFamily",
                        "fontSize",
                        "fontWeight",
                        "lineHeight",
                        "textAlign",
                        "borderRadius",
                      ].map((key) => (
                        <Field
                          key={node.path + key}
                          label={key.replace(/([a-z])([A-Z])/g, "$1 $2")}
                          initial={String(
                            (node.props.style as any)?.[key] ?? "",
                          )}
                          save={(value) =>
                            act("Updating text style", () =>
                              edit({
                                operation: "style",
                                value: {
                                  [key]: /^\d+(?:\.\d+)?$/.test(value)
                                    ? Number(value)
                                    : value,
                                },
                              }),
                            )
                          }
                        />
                      ))}
                    </>
                  )}
                  <h3 className="section-title">Arrange</h3>
                  <div className="arrange-buttons">
                    {[-1, 1].map((direction) => (
                      <button
                        key={direction}
                        disabled={
                          !node.parent ||
                          node.dynamic ||
                          (outline?.nodes
                            .filter(
                              (sibling) =>
                                sibling.parent === node.parent &&
                                sibling.slot === node.slot,
                            )
                            .findIndex((sibling) => sibling.id === node.id) ??
                            0) +
                            direction <
                            0 ||
                          (outline?.nodes
                            .filter(
                              (sibling) =>
                                sibling.parent === node.parent &&
                                sibling.slot === node.slot,
                            )
                            .findIndex((sibling) => sibling.id === node.id) ??
                            0) +
                            direction >=
                            (outline?.nodes.filter(
                              (sibling) =>
                                sibling.parent === node.parent &&
                                sibling.slot === node.slot,
                            ).length ?? 0)
                        }
                        onClick={() =>
                          void act("Reordering component", () =>
                            edit({
                              operation: "move",
                              parent: node.parent,
                              slot: node.slot,
                              index:
                                (outline?.nodes
                                  .filter(
                                    (sibling) =>
                                      sibling.parent === node.parent &&
                                      sibling.slot === node.slot,
                                  )
                                  .findIndex(
                                    (sibling) => sibling.id === node.id,
                                  ) ?? 0) + direction,
                            }),
                          )
                        }
                      >
                        {direction < 0 ? "Move earlier" : "Move later"}
                      </button>
                    ))}
                  </div>
                  <div className="arrange-buttons">
                    <button
                      onClick={() =>
                        void act("Duplicating component", () =>
                          edit({ operation: "duplicate" }),
                        )
                      }
                    >
                      Duplicate
                    </button>
                    <button
                      onClick={() =>
                        void act("Nesting in a stack", () =>
                          edit({ operation: "wrap", layout: "stack" }),
                        )
                      }
                    >
                      Wrap in stack
                    </button>
                  </div>
                  <label className="property">
                    Move into
                    <select
                      defaultValue=""
                      aria-label="Move component into"
                      onChange={(e) => {
                        if (e.target.value)
                          void act("Moving component", () =>
                            edit({
                              operation: "move",
                              parent: e.target.value.split("#")[0],
                              slot: e.target.value.split("#")[1] || undefined,
                            }),
                          );
                      }}
                    >
                      <option value="">Choose container</option>
                      {outline?.nodes
                        .filter(
                          (parent) =>
                            parent.id !== selection &&
                            (!parent.component ||
                              parent.component.children ||
                              parent.component.slots.length),
                        )
                        .flatMap((parent, index) =>
                          [
                            ...(!parent.component || parent.component.children
                              ? [{ slot: "", label: "Body" }]
                              : []),
                            ...(parent.component?.slots.map((slot) => ({
                              slot,
                              label: slot,
                            })) ?? []),
                          ].map(({ slot, label }) => (
                            <option
                              key={parent.id + slot}
                              value={parent.id + "#" + slot}
                            >
                              {parent.component?.name ?? parent.tag} {index + 1}{" "}
                              · {label}
                            </option>
                          )),
                        )}
                    </select>
                  </label>
                  <button
                    className="danger full"
                    onClick={() =>
                      void act("Removing component", () =>
                        edit({ operation: "remove" }),
                      )
                    }
                  >
                    Remove component
                  </button>
                </>
              ) : (
                <div className="empty small">
                  <span className="empty-symbol">⌖</span>
                  <h3>A closer look</h3>
                  <p>
                    Select a component on the page or in the outline to edit its
                    documented properties and layout.
                  </p>
                  <button
                    onClick={() => {
                      setTab("outline");
                      setCapture(true);
                    }}
                  >
                    Select a component
                  </button>
                </div>
              )}
              <div className="inspector-note">
                <strong>Keep shaping your page</strong>
                <p>
                  Arrange components here or describe a change below. Review
                  behavior changes before applying.
                </p>
              </div>
            </aside>
          </div>
        </>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <section
            className={"modal " + (modal === "requirements" ? "wide" : "")}
            role="dialog"
            aria-modal="true"
            aria-label={modal}
          >
            <header>
              <div>
                <span className="eyebrow">YOUR LOCAL WORKSPACE</span>
                <h2>
                  {
                    {
                      requirements: "Choose your working scope",
                      library: "Bring your React library",
                      versions: "Saved versions",
                      import: "Continue from source",
                      quality: "Ready for handoff?",
                      templates: "Complete page templates",
                    }[modal]
                  }
                </h2>
              </div>
              <button
                className="icon"
                aria-label="Close dialog"
                onClick={() => setModal(null)}
              >
                ×
              </button>
            </header>
            <div className="modal-body">
              {modal === "requirements" && data && (
                <Requirements
                  data={data}
                  save={(files, scope, confirmMarkdown) =>
                    act("Saving requirements scope", async () => {
                      await api(`/projects/${id}/requirements`, {
                        base: data.snapshot.id,
                        files,
                        scope,
                        confirmMarkdown,
                      });
                      setModal(null);
                    })
                  }
                />
              )}
              {modal === "library" && data && (
                <Library
                  base={data.snapshot.id}
                  project={id}
                  run={act}
                  finish={() => setModal(null)}
                />
              )}
              {modal === "versions" && data && (
                <>
                  <p>
                    Each version restores source, requirements, fixtures and
                    exact library versions together. An unavailable dependency
                    leaves your current page in place.
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = String(
                        new FormData(e.currentTarget).get("name"),
                      );
                      void act("Saving named version", () =>
                        api(`/projects/${id}/history`, {
                          action: "save",
                          name,
                        }),
                      );
                    }}
                  >
                    <label>
                      Version name
                      <input
                        name="name"
                        placeholder="Ready for design review"
                        required
                      />
                    </label>
                    <button className="primary">Save current version</button>
                  </form>
                  {data.state.versions.map((v, i) => (
                    <div className="version-row" key={i}>
                      <strong>{v.name}</strong>
                      <button
                        onClick={() =>
                          void act("Restoring complete version", () =>
                            api(`/projects/${id}/history`, {
                              action: "restore",
                              revision: v.snapshot,
                            }),
                          )
                        }
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                </>
              )}
              {modal === "import" && (
                <ImportSource
                  run={act}
                  finish={(project) => {
                    setId(project);
                    setModal(null);
                  }}
                />
              )}
              {modal === "quality" && data && (
                <Quality project={id} data={data} run={act} adapter={adapter} />
              )}
              {modal === "templates" && (
                <Templates
                  project={id}
                  run={act}
                  finish={(project) => {
                    setId(project);
                    setModal(null);
                  }}
                />
              )}
            </div>
          </section>
        </div>
      )}
      {undoDecision && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Review dependent changes"
          >
            <header>
              <h2>These changes need to be undone together</h2>
            </header>
            <div className="modal-body">
              <p>
                Studio cannot preserve these dependent results while removing
                the selected result. Choose to keep the page, or undo the listed
                changes together.
              </p>
              {undoDecision.affected.map((item) => (
                <article key={item.id}>
                  <strong>{item.text}</strong>
                  <p>{item.reason}</p>
                </article>
              ))}
              <div className="dialog-actions">
                <button onClick={() => setUndoDecision(undefined)}>
                  Keep the page
                </button>
                <button
                  className="danger"
                  onClick={() =>
                    void act("Undoing dependent changes together", async () => {
                      await api(`/projects/${id}/annotations/undo`, {
                        id: undoDecision.id,
                        base: undoDecision.base,
                        includeDependents: true,
                      });
                      setUndoDecision(undefined);
                    })
                  }
                >
                  Undo these changes together
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
      {change && reviewRun && (
        <div className="modal-backdrop">
          <section
            className="modal wide"
            role="dialog"
            aria-modal="true"
            aria-label="Review proposed changes"
          >
            <header>
              <div>
                <span className="eyebrow">REVIEW BEFORE APPLYING</span>
                <h2>{change.summary}</h2>
              </div>
              <button
                className="icon"
                aria-label="Leave proposal pending"
                onClick={() => setChange(undefined)}
              >
                ×
              </button>
            </header>
            <div className="modal-body">
              <p>
                {change.repair
                  ? "This repair passed the unchanged reviewed scenario checks. Inspect its experience before accepting it."
                  : change.requiresConfirmation
                    ? "This changes behavior. Confirm the corresponding Gherkin differences together with the implementation."
                    : change.behavior
                      ? "This implements the selected written requirements. Inspect the generated scenarios before accepting."
                      : "This presentation change preserves the selected business requirements."}
              </p>
              <button
                onClick={() =>
                  void act("Preparing proposed result preview", async () => {
                    if (candidatePreview)
                      await api(
                        `/previews/${candidatePreview.id}`,
                        undefined,
                        "DELETE",
                      );
                    const request = previewRequest.current;
                    const next = await api(`/projects/${id}/runs/${reviewRun.id}/preview`, { scenario });
                    if (request !== previewRequest.current) {
                      await api(`/previews/${next.id}`, undefined, "DELETE");
                      return;
                    }
                    setCandidatePreview(next);
                  })
                }
              >
                Preview this result
              </button>
              {candidatePreview && (
                <iframe
                  title="Proposed result preview"
                  className="candidate-preview"
                  src={candidatePreview.url}
                  sandbox="allow-scripts allow-same-origin allow-forms"
                />
              )}
              {change.diff.map((d) => (
                <details key={d.file} open={d.file.endsWith(".feature")}>
                  <summary>
                    {d.file}
                    {d.removed ? " · removed" : ""}
                  </summary>
                  <div className="diff">
                    <div>
                      <strong>Current</strong>
                      <pre>{d.before}</pre>
                    </div>
                    <div>
                      <strong>Proposed</strong>
                      <pre>{d.after}</pre>
                    </div>
                  </div>
                </details>
              ))}
              {!!change.affectedAcceptedResults?.length &&
                reviewRun.status === "review" && (
                  <div className="notice">
                    <strong>This rework affects accepted results</strong>
                    <p>
                      These results share changed source, requirements or
                      business scenarios. Leave the proposal pending to preserve
                      them, or approve replacing their acceptance. Their
                      annotations remain available.
                    </p>
                    <ul>
                      {change.affectedAcceptedResults.map((result) => (
                        <li key={result.id}>
                          <strong>{result.text}</strong>
                          <p>
                            {result.reason}
                            {result.files.length
                              ? `: ${result.files.join(", ")}`
                              : ""}
                          </p>
                        </li>
                      ))}
                    </ul>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={replaceAccepted}
                        onChange={(event) =>
                          setReplaceAccepted(event.target.checked)
                        }
                      />
                      I reviewed these affected results and choose to replace
                      them
                    </label>
                  </div>
                )}
              <div className="dialog-actions">
                <button onClick={() => setChange(undefined)}>
                  {reviewRun.status === "review"
                    ? "Leave pending"
                    : "Close result"}
                </button>
                {reviewRun.status === "review" && (
                  <button
                    className="primary"
                    disabled={
                      !!change.affectedAcceptedResults?.length &&
                      !replaceAccepted
                    }
                    onClick={() =>
                      void act("Applying validated proposal", async () => {
                        await api(
                          `/projects/${id}/runs/${reviewRun.id}/apply`,
                          {
                            confirmRequirements: change.hash,
                            confirmAcceptedResults: replaceAccepted
                              ? change.acceptedResultsConfirmation
                              : undefined,
                          },
                        );
                        setChange(undefined);
                        if (!preview) await showPreview();
                      })
                    }
                  >
                    {change.repair
                      ? "Accept verified repair"
                      : change.requiresConfirmation
                        ? "Confirm requirements and apply"
                        : change.behavior
                          ? "Accept generated implementation"
                          : "Accept presentation change"}
                  </button>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
function Field({
  label,
  initial,
  save,
}: {
  label: string;
  initial: string;
  save: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  return (
    <label className="property">
      {label}
      <input
        aria-label={label || "Property value"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (value !== initial) void save(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}
function PropertyControl({
  label,
  spec,
  value,
  controlled = false,
  save,
}: {
  label: string;
  spec: Property;
  value: unknown;
  controlled?: boolean;
  save: (value: unknown) => Promise<void>;
}) {
  if (controlled || spec.business)
    return (
      <div className="property">
        <strong>{label}</strong>
        <p className="hint">
          This setting belongs to the interaction. Describe its change in a
          prompt.
        </p>
      </div>
    );
  if (spec.type === "object")
    return (
      <fieldset className="property-group">
        <legend>{label}</legend>
        <p className="hint">{spec.description}</p>
        {spec.fields ? (
          Object.entries(spec.fields).map(([key, child]) => (
            <PropertyControl
              key={key}
              label={label + " · " + (child.label ?? child.description ?? key)}
              spec={child}
              value={
                (value as Record<string, unknown> | undefined)?.[key] ??
                child.default
              }
              save={(next) =>
                save({
                  ...(((value && typeof value === "object"
                    ? value
                    : spec.default) as Record<string, unknown>) ?? {}),
                  [key]: next,
                })
              }
            />
          ))
        ) : (
          <p className="hint">
            Use a prompt to preserve this structured setting.
          </p>
        )}
      </fieldset>
    );
  if (spec.type === "enum" || spec.type === "boolean")
    return (
      <label className="property">
        {label}
        <small>{spec.description}</small>
        <select
          value={value === undefined ? "" : String(value)}
          onChange={(event) =>
            void save(
              event.target.value === ""
                ? undefined
                : spec.type === "boolean"
                  ? event.target.value === "true"
                  : event.target.value,
            )
          }
        >
          {!spec.required && <option value="">Library default</option>}
          {(spec.type === "boolean"
            ? ["true", "false"]
            : (spec.options ?? [])
          ).map((option) => (
            <option key={option} value={option}>
              {spec.type === "boolean"
                ? option === "true"
                  ? "On"
                  : "Off"
                : option}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <div className="property">
      <Field
        label={label}
        initial={String(value ?? "")}
        save={(next) =>
          save(
            spec.type === "number"
              ? next === "" && !spec.required
                ? undefined
                : Number(next)
              : next,
          )
        }
      />
      <small className="hint">{spec.description}</small>
    </div>
  );
}
async function readUploads(files: FileList | null) {
  const out: Record<string, string> = {};
  for (const f of Array.from(files ?? []))
    out[
      (f as File & { webkitRelativePath: string }).webkitRelativePath ||
        "requirements/" + f.name
    ] = await f.text();
  return out;
}
function Requirements({
  data,
  save,
}: {
  data: Data;
  save: (
    files: Record<string, string>,
    scope: string[],
    confirm: boolean,
  ) => Promise<void>;
}) {
  const [files, setFiles] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(
        data.state.templateReconciliation?.requirements ?? data.snapshot.files,
      ).filter(([f]) => f.endsWith(".feature")),
    ),
  );
  const [chosen, setChosen] = useState(() => {
    const selected = data.state.templateReconciliation?.scope ?? data.snapshot.manifest.scope;
    return Object.keys(files).filter((file) => selected.some((scope) => file === scope || file.startsWith(scope.replace(/\/$/, "") + "/")));
  });
  const [active, setActive] = useState(
    Object.keys(files)[0] ?? "requirements/page.feature",
  );
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <p>
        Choose specific files or a folder. Only their scenarios belong to this
        work. Independent use cases stay independent.
      </p>
      <div className="upload-row">
        <label className="upload">
          Add requirement files
          <input
            type="file"
            multiple
            accept=".feature,.md"
            onChange={(e) =>
              void readUploads(e.target.files).then((added) => {
                setFiles({ ...files, ...added });
                setChosen([...chosen, ...Object.keys(added)]);
                setActive(Object.keys(added)[0]);
              })
            }
          />
        </label>
        <label className="upload">
          Add a folder
          <input
            type="file"
            multiple
            {...({ webkitdirectory: "" } as any)}
            onChange={(e) =>
              void readUploads(e.target.files).then((added) => {
                const supported = Object.fromEntries(
                  Object.entries(added).filter(([f]) =>
                    /\.(feature|md)$/.test(f),
                  ),
                );
                setFiles({ ...files, ...supported });
                setChosen([...chosen, ...Object.keys(supported)]);
                setActive(Object.keys(supported)[0]);
              })
            }
          />
        </label>
      </div>
      <div className="requirements-editor">
        <div>
          {Object.keys(files).map((f) => (
            <div className="requirement-file" key={f}>
              <input
                type="checkbox"
                aria-label={`Include ${f}`}
                checked={chosen.includes(f)}
                onChange={(e) =>
                  setChosen(
                    e.target.checked
                      ? [...chosen, f]
                      : chosen.filter((x) => x !== f),
                  )
                }
              />
              <button
                className={f === active ? "selected" : ""}
                onClick={() => setActive(f)}
              >
                {f}
              </button>
            </div>
          ))}
        </div>
        <div>
          <label>
            Requirement file
            <input value={active} onChange={(e) => setActive(e.target.value)} />
          </label>
          <textarea
            aria-label="Gherkin requirements"
            spellCheck={false}
            value={files[active] ?? ""}
            placeholder="Paste your already written Gherkin here"
            onChange={(e) => {
              setFiles({ ...files, [active]: e.target.value });
              if (!chosen.includes(active)) setChosen([...chosen, active]);
            }}
          />
        </div>
      </div>
      {Object.keys(files).some((f) => f.endsWith(".md")) && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={confirm}
            onChange={(e) => setConfirm(e.target.checked)}
          />
          I reviewed the extracted Markdown blocks against the original
          document. Parse gaps must be corrected.
        </label>
      )}
      <p className="hint">
        Currently included:{" "}
        {data.scope.scenarios.map((s) => s.name).join(", ") ||
          "No scenarios yet"}
      </p>
      <button
        className="primary"
        onClick={() => void save(files, chosen, confirm)}
      >
        Use selected requirements
      </button>
    </>
  );
}
function Library({
  base,
  project,
  run,
  finish,
}: {
  base: string;
  project: string;
  run: (s: string, f: () => Promise<unknown>) => Promise<void>;
  finish: () => void;
}) {
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [registry, setRegistry] = useState("");
  const [trust, setTrust] = useState(false);
  const [impact, setImpact] = useState<any>();
  useEffect(
    () => () => {
      for (const preview of [impact?.preview, ...(impact?.pages ?? [])])
        if (preview?.id)
          void api(`/previews/${preview.id}`, undefined, "DELETE").catch(() => {});
    },
    [impact],
  );
  const body = { base, name, version, registry: registry || undefined, trust };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run("Inspecting published library", async () =>
          setImpact(
            await api(`/projects/${project}/library`, {
              ...body,
              apply: false,
            }),
          ),
        );
      }}
    >
      <p>
        Use an existing React npm package. Studio reads its published types,
        documentation and examples, and keeps the exact release pinned.
      </p>
      <label>
        Package name
        <input
          required
          placeholder="@your-team/components"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setImpact(undefined);
          }}
        />
      </label>
      <div className="form-grid">
        <label>
          Exact version
          <input
            required
            placeholder="1.2.3"
            value={version}
            onChange={(e) => {
              setVersion(e.target.value);
              setImpact(undefined);
            }}
          />
        </label>
        <label>
          Registry URL <span className="muted">optional</span>
          <input
            placeholder="https://registry.npmjs.org/"
            value={registry}
            onChange={(e) => {
              setRegistry(e.target.value);
              setImpact(undefined);
            }}
          />
        </label>
      </div>
      <div className="notice">
        Private registry? Sign in using npm outside Studio. Your existing npm
        authentication is reused; tokens never belong in this form or your
        exported source.
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          required
          checked={trust}
          onChange={(e) => setTrust(e.target.checked)}
        />
        I trust this package to run in a local preview. Installation scripts
        stay disabled.
      </label>
      {impact && (
        <div className="admission">
          {impact.preview && (
            <iframe
              title="Library common states preview"
              className="candidate-preview"
              src={impact.preview.url}
              sandbox="allow-scripts allow-same-origin allow-forms"
            />
          )}
          {impact.pages?.map((page: { id: string; title: string; url: string }) => (
            <iframe key={page.id} title={`Upgrade impact: ${page.title}`} className="candidate-preview" src={page.url} sandbox="allow-scripts allow-same-origin allow-forms" />
          ))}
          {impact.quality?.results.map((result: { scenario: string; name: string; failures: string[] }) => (
            <p key={result.scenario}>{result.name}: {result.failures.join("; ") || "Scenario checks passed"}</p>
          ))}
          <strong>
            {impact.previous
              ? `Upgrade ${impact.previous} → ${impact.next}`
              : `Release ${impact.next}`}
          </strong>
          <p>{impact.components.map((c: Component) => c.name).join(", ")}</p>
          {impact.warnings.map((w: string) => (
            <p key={w}>{w}</p>
          ))}
          <button
            type="button"
            className="primary"
            disabled={impact.quality && !impact.quality.ready}
            onClick={() =>
              void run("Importing exact library release", async () => {
                await api(`/projects/${project}/library`, {
                  ...body,
                  confirmation: impact.confirmation,
                  apply: true,
                });
                finish();
              })
            }
          >
            Confirm and import release
          </button>
        </div>
      )}
      <button disabled={!trust}>Preview import impact</button>
    </form>
  );
}
function ImportSource({
  run,
  finish,
}: {
  run: (s: string, f: () => Promise<unknown>) => Promise<void>;
  finish: (id: string) => void;
}) {
  const [archive, setArchive] = useState("");
  const [markdownConfirmed, setMarkdownConfirmed] = useState(false);
  const [report, setReport] = useState<any>();
  const [previewStories, setPreviewStories] = useState<Record<string, string>>(
    {},
  );
  const [requirements, setRequirements] = useState<Record<string, string>>({});
  return (
    <>
      <p>
        Choose a complete Studio or supported React/Vite Storybook source ZIP,
        including dependencies, assets, styles and matching Gherkin. Static
        builds cannot be edited.
      </p>
      <label>
        Source archive
        <input
          type="file"
          accept=".zip"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f)
              void f.arrayBuffer().then((b) => {
                let text = "";
                for (const x of new Uint8Array(b))
                  text += String.fromCharCode(x);
                setArchive(btoa(text));
                setReport(undefined);
                setMarkdownConfirmed(false);
                setPreviewStories({});
              });
          }}
        />
      </label>
      <label>
        Supply missing Gherkin
        <input
          type="file"
          multiple
          accept=".feature,.md"
          onChange={(e) =>
            void readUploads(e.target.files).then((files) => {
              setRequirements(files);
              setReport(undefined);
              setMarkdownConfirmed(false);
              setPreviewStories({});
            })
          }
        />
      </label>
      <button
        disabled={!archive}
        onClick={() =>
          void run("Inspecting source compatibility", async () =>
            setReport(await api("/import", { archive, requirements })),
          )
        }
      >
        Inspect import
      </button>
      {report && (
        <div className="admission">
          <strong>
            {report.native
              ? "Native Studio source"
              : "Legacy source compatibility"}
          </strong>
          {!report.native &&
            report.manifest.pages.map(
              (page: Snapshot["manifest"]["pages"][number]) => (
                <label key={page.id}>
                  Editing preview for {page.title}
                  <select
                    value={previewStories[page.id] ?? page.previewStory ?? ""}
                    onChange={(event) =>
                      setPreviewStories({
                        ...previewStories,
                        [page.id]: event.target.value,
                      })
                    }
                  >
                    {report.stories
                      .filter(
                        (story: { page: string }) => story.page === page.id,
                      )
                      .map((story: { file: string; name: string }) => (
                        <option
                          key={story.file + "#" + story.name}
                          value={story.file + "#" + story.name}
                        >
                          {story.name} · {story.file}
                        </option>
                      ))}
                  </select>
                </label>
              ),
            )}
          {!!report.markdownProposals?.length && (
            <div className="notice">
              <strong>Review extracted Gherkin</strong>
              <p>
                Review every block against the supplied document. Prose is not
                executable requirements. These .feature files become the
                requirements Studio edits and exports.
              </p>
              {report.markdownProposals.map(
                (proposal: { file: string; source: string }) => (
                  <details key={proposal.file} open>
                    <summary>{proposal.file}</summary>
                    <pre>{proposal.source}</pre>
                  </details>
                ),
              )}
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={markdownConfirmed}
                  onChange={(event) =>
                    setMarkdownConfirmed(event.target.checked)
                  }
                />
                I reviewed the extracted blocks and resolved discrepancies
              </label>
            </div>
          )}
          {report.diagnostics.map((d: string) => (
            <p key={d}>{d}</p>
          ))}
          <p>
            Original pages, controllers, story render functions and decorators
            remain intact. Legacy scenarios need explicit story and test
            mappings before delivery.
          </p>
          <button
            className="primary"
            disabled={
              report.diagnostics.length > 0 ||
              (!!report.markdownProposals?.length && !markdownConfirmed)
            }
            onClick={() =>
              void run("Opening imported project", async () => {
                const p = await api("/import", {
                  archive,
                  requirements,
                  confirm: true,
                  previewStories,
                  confirmMarkdown: markdownConfirmed,
                });
                finish(p.state.id);
              })
            }
          >
            Confirm and open source
          </button>
        </div>
      )}
    </>
  );
}
function Quality({
  project,
  data,
  run,
  adapter,
}: {
  project: string;
  adapter: "codex" | "cursor";
  data: Data;
  run: (s: string, f: () => Promise<unknown>) => Promise<void>;
}) {
  const [report, setReport] = useState<any>();
  const [stories, setStories] = useState<{ story: string; name: string }[]>();
  return (
    <>
      <p>
        Studio builds React and Storybook, starts real previews, checks runtime
        errors, and exercises every mapped Gherkin step with scenario-specific
        state.
      </p>
      <div className="notice">
        Passing checks is necessary. Review the scenario-to-test interpretation
        and accept the visual experience before handing off. Failed reviewed
        scenarios trigger one bounded repair proposal using your selected AI
        tool; accepted source changes only after your review.
      </div>
      <button
        onClick={() =>
          void run("Reading original scenario stories", async () =>
            setStories(await api(`/projects/${project}/stories`)),
          )
        }
      >
        Choose existing scenario stories
      </button>
      {data.scope.scenarios.map((scenario) => {
        const binding = data.snapshot.manifest.scenarios.find(
          (b) => b.scenario === scenario.id,
        );
        return (
          <details className="scenario-plan" key={scenario.id}>
            <summary>
              {scenario.name} ·{" "}
              {binding?.accepted ? "Test plan reviewed" : "Review needed"}
            </summary>
            {stories && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const values = new FormData(event.currentTarget);
                  void run("Saving explicit scenario mapping", () =>
                    api(`/projects/${project}/scenarios/${scenario.id}/map`, {
                      base: data.snapshot.id,
                      story: values.get("story"),
                      page: values.get("page"),
                    }),
                  );
                }}
              >
                <label>
                  Original story
                  <select
                    name="story"
                    defaultValue={binding?.story ?? stories[0]?.story}
                  >
                    {stories.map((story) => (
                      <option key={story.story} value={story.story}>
                        {story.name} · {story.story.split("#")[0]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Page
                  <select
                    name="page"
                    defaultValue={
                      binding?.page ?? data.snapshot.manifest.pages[0]?.id
                    }
                  >
                    {data.snapshot.manifest.pages.map((page) => (
                      <option key={page.id} value={page.id}>
                        {page.title}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="hint">
                  Use the original story's mock state, arguments and decorators.
                  Mapping never adds business scope. Ask Studio for executable
                  checks, then review each requirement step below.
                </p>
                <button>Map this scenario to this story</button>
              </form>
            )}
            {scenario.steps.map((step) => (
              <div className="scenario-step" key={step.id}>
                <strong>{step.text}</strong>
                {(
                  binding?.steps.filter((test) => test.step === step.id) ?? []
                ).map((test, i) => (
                  <p key={i}>
                    {test.action} {test.role} “{test.name}”
                    {test.action === "count" ? `: ${test.count === undefined ? "Missing count" : test.count}` :
                      ["text", "value", "fill"].includes(test.action) ? `: ${test.value === undefined ? "Missing value" : JSON.stringify(test.value)}` : ""}
                  </p>
                ))}
                {!binding?.steps.some((test) => test.step === step.id) && (
                  <p>
                    No check yet. Ask Studio to implement and check this
                    requirement.
                  </p>
                )}
              </div>
            ))}
            <button
              disabled={!binding}
              onClick={() =>
                void run("Saving scenario review", () =>
                  api(`/projects/${project}/scenarios/${scenario.id}/review`, {
                    base: data.snapshot.id,
                    accept: !binding?.accepted,
                  }),
                )
              }
            >
              {binding?.accepted
                ? "Reopen test plan review"
                : "These checks match the scenario"}
            </button>
          </details>
        );
      })}
      <button
        className="primary"
        onClick={() =>
          void run("Checking startup and scenario interactions", async () =>
            setReport(await api(`/projects/${project}/quality`, { adapter })),
          )
        }
      >
        Run deliverability checks
      </button>
      {report?.repairRun && (
        <p className="notice">
          Studio is attempting one bounded repair of the failed reviewed
          scenarios. Your saved page stays unchanged. Review the result in Make
          a change; unresolved failures remain listed here.
        </p>
      )}
      {report && (
        <>
          <h3>
            {report.ready
              ? "Automatic checks passed. Designer review remains."
              : "Some scenarios need work"}
          </h3>
          {report.results.map((r: any) => (
            <article className="quality-row" key={r.scenario}>
              <strong>
                {r.passed ? "✓" : "!"} {r.name}
              </strong>
              {r.failures.map((f: string, i: number) => (
                <p key={i}>{f}</p>
              ))}
            </article>
          ))}
        </>
      )}
    </>
  );
}
function Templates({
  project,
  run,
  finish,
}: {
  project: string;
  run: (s: string, f: () => Promise<unknown>) => Promise<void>;
  finish: (id: string) => void;
}) {
  const [templates, setTemplates] = useState<any[]>([]);
  const [requirements, setRequirements] = useState<Record<string, string>>({});
  const [reconciliation, setReconciliation] = useState<{
    id: string;
    report: any;
  }>();
  useEffect(() => {
    void api<any[]>("/templates").then(setTemplates);
  }, []);
  return (
    <>
      <p>
        A template keeps real source, behavior, mocks, styles and Gherkin. Reuse
        compares its behavior with your new selected requirements.
      </p>
      {project && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get("name"));
            void run("Saving complete page template", async () => {
              await api(`/projects/${project}/template`, { name });
              setTemplates(await api("/templates"));
            });
          }}
        >
          <label>
            Save current page as
            <input name="name" required placeholder="Template name" />
          </label>
          <button>Save complete template</button>
        </form>
      )}
      <label>
        New selected requirements
        <input
          type="file"
          accept=".feature"
          multiple
          onChange={(e) =>
            void readUploads(e.target.files).then(setRequirements)
          }
        />
      </label>
      {!templates.length && (
        <div className="empty small">
          No saved templates yet. Save a page after arranging its real library
          components.
        </div>
      )}
      {reconciliation && (
        <div className="admission">
          <strong>Review the business scope before adapting</strong>
          <p>{reconciliation.report.message}</p>
          <p>
            Template:{" "}
            {reconciliation.report.prior.scenarios
              .map((s: Scenario) => s.name)
              .join(", ")}
          </p>
          <p>
            Selected scope:{" "}
            {reconciliation.report.next.scenarios
              .map((s: Scenario) => s.name)
              .join(", ")}
          </p>
          <button
            className="primary"
            onClick={() =>
              void run("Creating template adaptation draft", async () => {
                const p = await api(`/templates/${reconciliation.id}/reuse`, {
                  requirements,
                  scope: Object.keys(requirements),
                  confirm: true,
                });
                finish(p.state.id);
              })
            }
          >
            Create adaptation draft
          </button>
        </div>
      )}
      {templates.map((t) => (
        <div className="version-row" key={t.id}>
          <div>
            <strong>{t.name}</strong>
            <p>{count(t.scenarios.length, "scenario")}</p>
          </div>
          <button
            disabled={!Object.keys(requirements).length}
            onClick={() =>
              void run("Comparing template scope", async () => {
                const p = await api(`/templates/${t.id}/reuse`, {
                  requirements,
                  scope: Object.keys(requirements),
                });
                if (p.requiresReconciliation)
                  setReconciliation({ id: t.id, report: p });
                else finish(p.state.id);
              })
            }
          >
            Compare and reuse
          </button>
        </div>
      ))}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Studio />
  </React.StrictMode>,
);
