import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  RefreshCw,
  Search,
  LayoutGrid,
  List,
  ArrowLeft,
  Zap,
  ChevronUp,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  FilePlus,
  Upload,
  Download,
  Trash2,
  Copy,
  FileText,
  Terminal,
  ExternalLink,
} from "lucide-react";
import AiMark from "../shared/AiMark";
import Modal, { ModalCancelButton } from "../shared/Modal";
import { useSkills, skillApi, jsonInit, type Skill } from "../../contexts/SkillContext";
import SkillChatSheet from "./SkillChatSheet";
import NewSkillModal from "./NewSkillModal";
import InstallSkillModal from "./InstallSkillModal";

type ViewMode = "card" | "list";
type SortField = "title" | "source" | "updatedAt";
type SortDir = "asc" | "desc";

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Strip leading headings that repeat the Skill title from rendered markdown */
function stripLeadingTitle(content: string, title: string): string {
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const headingText = line.replace(/^#+\s+/, "").trim();
    if (headingText === title.trim()) { i++; continue; }
    break;
  }
  return lines.slice(i).join("\n").trimStart();
}

function formatDate(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtSize(n: number) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Single-line frontmatter fields of an imported SKILL.md; block scalars are ignored. */
function parseImportedMarkdown(text: string): { name?: string; title?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { body: text };
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):[ \t]*(.*)$/.exec(line);
    if (!kv || /^[|>]/.test(kv[2])) continue;
    fields[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { name: fields.name, title: fields.title, description: fields.description, body: text.slice(m[0].length) };
}

function toSkillMd(skill: Skill): string {
  const head = ["---", `name: ${skill.name}`, `description: ${JSON.stringify(skill.description)}`];
  if (skill.title) head.push(`title: ${JSON.stringify(skill.title)}`);
  return `${head.join("\n")}\n---\n\n${(skill.body ?? "").trimStart()}`;
}

function SkillBadges({ skill }: { skill: Skill }) {
  return (
    <>
      {skill.source === "installed" && (
        <span
          className="skill-badge"
          title={skill.installedFrom?.source ? `Installed from ${skill.installedFrom.source} (read-only)` : "Installed skill (read-only)"}
        >
          Installed
        </span>
      )}
      {skill.hasScripts && (
        <span className="skill-badge skill-badge--muted" title="Has bundled scripts. Each run asks for your approval.">
          <Terminal size={10} /> {skill.scripts.length}
        </span>
      )}
    </>
  );
}

// ── Three-dot context menu ────────────────────────────────────────────────
interface SkillMenuProps {
  skill: Skill;
  onRename: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

function SkillMenu({ skill, onRename, onDelete, onDuplicate }: SkillMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div
      ref={ref}
      className="sop-menu-wrap"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="icon-btn sop-menu-btn"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title="Options"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="sop-menu-dropdown">
          {skill.editable && (
            <button className="sop-menu-item" onClick={() => { setOpen(false); onRename(); }}>
              <Pencil size={12} /> Rename
            </button>
          )}
          <button className="sop-menu-item" onClick={() => { setOpen(false); onDuplicate(); }}>
            <Copy size={12} /> {skill.editable ? "Duplicate" : "Copy to Rye"}
          </button>
          <button className="sop-menu-item sop-menu-item--danger" onClick={() => { setOpen(false); onDelete(); }}>
            <Trash2 size={12} /> {skill.editable ? "Delete" : "Uninstall"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────
/**
 * `embedded` draws the list as a section of another page (the Settings tab) instead of a panel of its own;
 * an opened skill then covers that page's panel.
 */
export default function SkillPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const { skills, skillsLoading, refreshSkills, getSkill, deleteSkill, renameSkill, duplicateSkill } = useSkills();
  const [query, setQuery] = useState("");
  // A list by default: skills are scanned by name, and the list fits far more of them on a page than cards do.
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [activeSkill, setActiveSkill] = useState<Skill | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [sortField, setSortField] = useState<SortField>("title");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [installing, setInstalling] = useState(false);
  // True when one modal replaced the other, so the swap doesn't replay the enter animation.
  const [handoff, setHandoff] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Skill | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<{ path: string; content?: string; error?: string } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  // Ignores a slow detail fetch that finishes after the user opened another skill.
  const openSeq = useRef(0);

  useEffect(() => {
    if (skills === null) void refreshSkills();
  }, []);

  useEffect(() => {
    if (renamingName !== null) renameRef.current?.focus();
  }, [renamingName]);

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
  }

  async function openSkill(skill: Skill) {
    const seq = ++openSeq.current;
    setActiveSkill(skill);
    setChatOpen(false);
    setOpenFile(null);
    setNotice(null);
    if (skill.body !== undefined) return;
    try {
      const full = await getSkill(skill.name);
      if (openSeq.current === seq) setActiveSkill(full);
    } catch (err) {
      if (openSeq.current === seq) setNotice(errMessage(err));
    }
  }

  function closeDetail() {
    openSeq.current++;
    setActiveSkill(null);
    setChatOpen(false);
    setOpenFile(null);
    setNotice(null);
  }

  function handleCreated(skill: Skill) {
    void refreshSkills();
    setCreating(false);
    void openSkill(skill);
  }

  async function run(action: () => Promise<void>) {
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setNotice(errMessage(err));
    }
  }

  function duplicate(skill: Skill) {
    void run(async () => openSkill(await duplicateSkill(skill.name)));
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await deleteSkill(pendingDelete);
      if (activeSkill?.name === pendingDelete.name) closeDetail();
    } catch (err) {
      setNotice(errMessage(err));
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

  function exportSkill(skill: Skill) {
    if (skill.body === undefined) return;
    const blob = new Blob([toSkillMd(skill)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${skill.name}-SKILL.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = () => void run(async () => {
      const text = reader.result as string;
      let title: string | undefined = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
      let name: string | undefined;
      let description: string | undefined;
      let content = text;
      if (file.name.endsWith(".json")) {
        try {
          const parsed = JSON.parse(text) as { title?: string; description?: string; content?: string };
          if (parsed.title) title = parsed.title;
          if (parsed.description) description = parsed.description;
          if (parsed.content) content = parsed.content;
        } catch { /* use raw text */ }
      } else {
        const fm = parseImportedMarkdown(text);
        content = fm.body;
        description = fm.description;
        const nameFree = fm.name && SKILL_NAME_RE.test(fm.name) && !skills?.some((s) => s.name === fm.name);
        if (nameFree) {
          name = fm.name;
          title = fm.title;
        } else if (fm.title || fm.name) {
          title = fm.title ?? fm.name!.replace(/[_-]+/g, " ");
        }
      }
      const skill = await skillApi<Skill>("/skill/", jsonInit("POST", { name, title, description, content }));
      await refreshSkills();
      await openSkill(skill);
    });
    reader.readAsText(file);
  }

  function startRename(skill: Skill) { setRenamingName(skill.name); setRenameValue(skill.title); }

  async function commitRename() {
    const name = renamingName;
    setRenamingName(null);
    if (name !== null && renameValue.trim()) await run(() => renameSkill(name, renameValue.trim()));
  }

  async function toggleFile(skill: Skill, path: string) {
    if (openFile?.path === path) { setOpenFile(null); return; }
    setOpenFile({ path });
    try {
      const r = await skillApi<{ content: string }>(
        `/skill/${encodeURIComponent(skill.name)}/file?path=${encodeURIComponent(path)}`,
      );
      setOpenFile((cur) => (cur?.path === path ? { path, content: r.content } : cur));
    } catch (err) {
      setOpenFile((cur) => (cur?.path === path ? { path, error: errMessage(err) } : cur));
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = (skills ?? []).filter(
    (s) =>
      q === "" ||
      s.title.toLowerCase().includes(q) ||
      s.name.includes(q) ||
      s.description.toLowerCase().includes(q)
  ).sort((a, b) => {
    let cmp = 0;
    if (sortField === "title") cmp = a.title.localeCompare(b.title);
    else if (sortField === "source") cmp = a.source.localeCompare(b.source) || a.title.localeCompare(b.title);
    else cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    return sortDir === "asc" ? cmp : -cmp;
  });

  function sortHeader(field: SortField, label: string, extra = "") {
    return (
      <th className={`sop-table-th${extra}`} onClick={() => toggleSort(field)}>
        <span>{label}</span>
        <span className="sop-table-sort-icon">
          {sortField === field
            ? (sortDir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)
            : <ChevronUp size={11} className="sop-table-sort-idle" />}
        </span>
      </th>
    );
  }

  function renameInput(extra = "") {
    return (
      <input
        ref={renameRef}
        className={`sop-inline-rename${extra}`}
        value={renameValue}
        onChange={(e) => setRenameValue(e.target.value)}
        onBlur={() => void commitRename()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commitRename();
          if (e.key === "Escape") setRenamingName(null);
          e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  const deleteModal = pendingDelete && (
    <Modal
      title={pendingDelete.editable ? `Delete "${pendingDelete.title}"?` : `Uninstall "${pendingDelete.title}"?`}
      onClose={() => { if (!deleting) setPendingDelete(null); }}
      lockBackdrop={deleting}
      footer={
        <>
          <ModalCancelButton />
          <button className="btn btn--danger btn--sm" disabled={deleting} onClick={() => void confirmDelete()}>
            {pendingDelete.editable ? (deleting ? "Deleting…" : "Delete") : (deleting ? "Uninstalling…" : "Uninstall")}
          </button>
        </>
      }
    >
      <p className="skill-confirm-text">
        {pendingDelete.editable ? (
          <>This deletes the folder <code>{pendingDelete.path}</code> and every file in it.</>
        ) : (
          <>
            Runs <code>bunx skills remove {pendingDelete.name} -g</code>. It is removed for every agent that reads{" "}
            <code>~/.agents/skills</code>, not just Rye.
          </>
        )}
      </p>
    </Modal>
  );

  const noticeBar = notice && (
    <div className="skill-notice" role="alert">
      <span>{notice}</span>
      <button className="icon-btn faint" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
    </div>
  );

  // ── Detail view ───────────────────────────────────────────────────────
  const renderDetail = (s: Skill) => {
    const files = s.files.filter((f) => f.path !== "SKILL.md");
    const from = s.installedFrom;
    return (
      <div className={`sop-panel${embedded ? " settings-skill-detail" : ""}`}>
        {deleteModal}
        <div className="sop-panel-header sop-panel-header--detail">
          <button
            className="sop-header-icon-btn"
            onClick={closeDetail}
            title="Back to Skills"
            aria-label="Back to Skills"
          >
            <ArrowLeft size={17} />
          </button>
          <h2 className="sop-panel-title sop-detail-title skill-detail-title">{s.title}</h2>
          <SkillBadges skill={s} />
          <span className="skill-header-spacer" />
          <button
            className="sop-header-icon-btn"
            onClick={() => exportSkill(s)}
            disabled={s.body === undefined}
            title="Export SKILL.md"
            aria-label="Export SKILL.md"
          >
            <Download size={16} />
          </button>
          {s.editable ? (
            <button
              className={`sop-ai-btn${chatOpen ? " sop-ai-btn--active" : ""}`}
              onClick={() => setChatOpen((v) => !v)}
              disabled={s.body === undefined}
              title="Chat with Skill creator agent"
            >
              <AiMark size={14} />
              {chatOpen ? "Hide AI Editor" : "Edit with AI"}
            </button>
          ) : (
            <button
              className="sop-ai-btn"
              onClick={() => duplicate(s)}
              title="Installed skills are read-only. Copy this one into Rye to edit it."
            >
              <Copy size={14} />
              Copy to Rye to edit
            </button>
          )}
        </div>
        {noticeBar}

        <div className="sop-detail-split">
          <div className="sop-detail-body">
            <div className="skill-meta">
              {s.description && <p className="skill-meta-desc">{s.description}</p>}
              <dl className="skill-meta-list">
                <dt>Name</dt>
                <dd><code>{s.name}</code></dd>
                {from?.source && (
                  <>
                    <dt>Source</dt>
                    <dd>
                      {from.sourceUrl && /^https:\/\//.test(from.sourceUrl) ? (
                        <a href={from.sourceUrl} target="_blank" rel="noreferrer noopener" className="skill-meta-link">
                          {from.source} <ExternalLink size={11} />
                        </a>
                      ) : (
                        from.source
                      )}
                    </dd>
                  </>
                )}
                <dt>Folder</dt>
                <dd><code>{s.path}</code></dd>
                {s.shadows && (
                  <>
                    <dt>Overrides</dt>
                    <dd>An installed skill with the same name at <code>{s.shadows}</code></dd>
                  </>
                )}
              </dl>
            </div>
            <div className="sop-detail-md">
              {s.body === undefined ? (
                <p className="sop-panel-empty">Loading…</p>
              ) : (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {stripLeadingTitle(s.body, s.title)}
                </ReactMarkdown>
              )}
            </div>
            {files.length > 0 && (
              <section className="skill-files">
                <h3 className="skill-files-title">Bundled files</h3>
                {s.hasScripts && (
                  <p className="skill-files-hint">The agent can run scripts only after you approve each run.</p>
                )}
                <ul className="skill-files-list">
                  {files.map((f) => (
                    <li key={f.path}>
                      <button
                        className={`skill-file${openFile?.path === f.path ? " active" : ""}`}
                        onClick={() => void toggleFile(s, f.path)}
                        aria-expanded={openFile?.path === f.path}
                      >
                        {f.path.startsWith("scripts/") ? <Terminal size={12} /> : <FileText size={12} />}
                        <span className="skill-file-path">{f.path}</span>
                        <span className="skill-file-size">{fmtSize(f.size)}</span>
                      </button>
                      {openFile?.path === f.path && (
                        openFile.error
                          ? <p className="skill-form-error">{openFile.error}</p>
                          : <pre className="skill-file-content">{openFile.content ?? "Loading…"}</pre>
                      )}
                    </li>
                  ))}
                </ul>
                {s.filesTruncated && <p className="skill-files-hint">Some files aren't listed.</p>}
              </section>
            )}
          </div>

          {chatOpen && s.editable && s.body !== undefined && (
            <SkillChatSheet
              skill={s}
              onClose={() => setChatOpen(false)}
              onSaved={(updated) => {
                setActiveSkill(updated);
                void refreshSkills();
              }}
            />
          )}
        </div>
      </div>
    );
  };
  if (activeSkill && !embedded) return renderDetail(activeSkill);

  // ── List / Card view ──────────────────────────────────────────────────
  const modals = (
    <>
      {creating && (
        <NewSkillModal
          onCreated={handleCreated}
          onInstall={() => { setHandoff(true); setCreating(false); setInstalling(true); }}
          onClose={() => setCreating(false)}
          animateIn={!handoff}
        />
      )}
      {installing && (
        <InstallSkillModal
          onInstalled={() => void refreshSkills()}
          onBack={() => { setHandoff(true); setInstalling(false); setCreating(true); }}
          onClose={() => setInstalling(false)}
          animateIn={!handoff}
        />
      )}
      {/* With a skill open, its detail view draws this modal instead. */}
      {!activeSkill && deleteModal}
    </>
  );

  const toolbar = (
        <div className="sop-panel-toolbar">
          <div className="sop-search-wrap">
            <Search size={13} className="sop-search-icon" />
            <input
              className="sop-search-input"
              placeholder="Search Skills…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            className={`icon-btn sop-view-btn${viewMode === "card" ? " active" : " faint"}`}
            onClick={() => setViewMode("card")}
            title="Card view"
          >
            <LayoutGrid size={14} />
          </button>
          <button
            className={`icon-btn sop-view-btn${viewMode === "list" ? " active" : " faint"}`}
            onClick={() => setViewMode("list")}
            title="List view"
          >
            <List size={14} />
          </button>
          <button
            className="icon-btn faint"
            onClick={() => void refreshSkills()}
            disabled={skillsLoading}
            title="Refresh"
          >
            <RefreshCw size={13} className={skillsLoading ? "spin" : ""} />
          </button>
          <div className="sop-toolbar-divider" />
          <button
            className="icon-btn faint"
            onClick={() => importRef.current?.click()}
            title="Import Skill (.md or .json)"
          >
            <Upload size={14} />
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".md,.json"
            style={{ display: "none" }}
            onChange={handleImport}
          />
          <button
            className="sop-new-btn"
            onClick={() => { setHandoff(false); setCreating(true); }}
          >
            <FilePlus size={13} />
            New Skill
          </button>
        </div>
  );

  const results = (
      <>
        {skillsLoading && <div className="sop-panel-empty">Loading…</div>}

        {!skillsLoading && (skills?.length ?? 0) === 0 && (
          <div className="sop-panel-zero">
            <Zap size={32} className="sop-panel-zero-icon" />
            <p>No Skills yet.</p>
            <p className="sop-panel-zero-sub">
              Use New Skill to write one, generate it with AI, or install skills from GitHub.
            </p>
          </div>
        )}

        {!skillsLoading && (skills?.length ?? 0) > 0 && filtered.length === 0 && (
          <div className="sop-panel-empty">No Skills match "{query}".</div>
        )}

        {!skillsLoading && filtered.length > 0 && (
          viewMode === "card" ? (
            <div className="sop-card-grid">
              {filtered.map((skill) => (
                <div key={skill.name} className="sop-card" onClick={() => void openSkill(skill)}>
                  <div className="sop-card-header">
                    {renamingName === skill.name ? renameInput() : <div className="sop-card-title">{skill.title}</div>}
                    <SkillMenu
                      skill={skill}
                      onRename={() => startRename(skill)}
                      onDelete={() => setPendingDelete(skill)}
                      onDuplicate={() => duplicate(skill)}
                    />
                  </div>
                  <div className="sop-card-preview">
                    {skill.description.trim() || <span className="skill-card-empty">No description</span>}
                  </div>
                  <div className="sop-card-footer">
                    <span className="skill-card-meta">
                      <SkillBadges skill={skill} />
                      <span className="sop-card-date">{formatDate(skill.updatedAt)}</span>
                    </span>
                    {skill.editable && (
                      <span className="sop-card-ai-hint">
                        <AiMark size={12} className="sop-card-ai-icon" />
                        Edit with AI
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <table className="sop-table">
              <thead>
                <tr>
                  {sortHeader("title", "Name", " sop-table-th--name")}
                  {sortHeader("source", "Source")}
                  {sortHeader("updatedAt", "Updated")}
                  <th className="sop-table-th sop-table-th--action" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((skill) => (
                  <tr key={skill.name} className="sop-table-row" onClick={() => void openSkill(skill)}>
                    <td className="sop-table-td sop-table-td--name">
                      <Zap size={12} className="sop-table-icon" />
                      {renamingName === skill.name ? renameInput(" sop-inline-rename--table") : skill.title}
                    </td>
                    <td className="sop-table-td">
                      <span className="skill-card-meta">
                        {skill.source === "installed" ? <SkillBadges skill={skill} /> : <>Rye <SkillBadges skill={skill} /></>}
                      </span>
                    </td>
                    <td className="sop-table-td">{formatDate(skill.updatedAt)}</td>
                    <td className="sop-table-td sop-table-td--action" onClick={(e) => e.stopPropagation()}>
                      <SkillMenu
                        skill={skill}
                        onRename={() => startRename(skill)}
                        onDelete={() => setPendingDelete(skill)}
                        onDuplicate={() => duplicate(skill)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </>
  );

  if (embedded) {
    return (
      <>
        <section
          className={`settings-section settings-skills${activeSkill ? " is-covered" : ""}`}
          aria-labelledby="settings-skills-title"
          aria-hidden={activeSkill ? true : undefined}
        >
          {modals}
          <div className="settings-section-bar">
            <div className="settings-section-head">
              <h3 className="settings-section-title" id="settings-skills-title">Skills</h3>
              <p className="settings-section-desc">
                Reusable instructions and scripts the agent loads when a task calls for them.
              </p>
            </div>
            {toolbar}
          </div>
          {!activeSkill && noticeBar}
          {results}
        </section>
        {activeSkill && renderDetail(activeSkill)}
      </>
    );
  }

  return (
    <div className="sop-panel">
      {modals}
      <div className="sop-panel-header">
        <h2 className="sop-panel-title">Skills</h2>
        {toolbar}
      </div>
      {noticeBar}

      <div className="sop-panel-body">
        {results}
      </div>
    </div>
  );
}
