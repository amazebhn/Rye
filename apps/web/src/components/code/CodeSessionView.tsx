import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, SquareCode, Square } from "lucide-react";
import type { ChangesSince, CodeReposResponse } from "@rye/shared";
import type { ChatRecord } from "../../utils/types";
import { readyRefs, type ContextRef, type PendingAttachment, type QuoteContextRef } from "../../utils/attachments";
import { addContextToChat } from "../../utils/contextRefs";
import { useIsMobile } from "../../utils/viewport";
import SidebarButton from "../shell/SidebarButton";
import MessageList from "../chat/MessageList";
import MessageInput from "../chat/MessageInput";
import { codeApi, useCodeEngines } from "../../utils/codeApi";
import { useCodeSession } from "./useCodeSession";
import BranchChip from "./BranchChip";
import BranchActions from "./BranchActions";
import ChangesView from "./ChangesView";
import ChangesSummaryCard from "./ChangesSummaryCard";
import { ChecksPanel, CommandLog, useCommandLog } from "./RunLog";
import { ACTIVITY_LABEL, engineTitle } from "./codeFormat";

/** The composer's draft, owned by App.tsx (per chat, like any chat's). */
export interface ComposerBinding {
  input: string;
  onInput: (text: string) => void;
  attachments: PendingAttachment[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (key: string) => void;
  /** Empties the picked files once they are sent. */
  clearAttachments: () => void;
  /** The chat's draft references (`refDrafts`): quotes of the diff or of replies, shown as chips. */
  references?: ContextRef[];
  onRemoveReference?: (key: string) => void;
  /** Empties the draft references once they are sent. */
  clearReferences?: () => void;
}

export interface CodeSessionViewProps {
  chat: ChatRecord;
  composer: ComposerBinding;
  onNewChat: (opts: { display: string; context: string }) => void;
}

type CodeTab = "chat" | "changes" | "log" | "checks";
/** Below this width the view's tabs leave the header for a row of their own. */
const NARROW_VIEW = 720;
const TABS: readonly CodeTab[] = ["chat", "changes", "log", "checks"];
const tabKey = (chatId: string) => `rye.code-tab.${chatId}`;

/** The tab a chat was left on in this browser tab (sessionStorage); Chat by default. */
function readTab(chatId: string): CodeTab {
  try {
    const v = window.sessionStorage.getItem(tabKey(chatId));
    return TABS.includes(v as CodeTab) ? (v as CodeTab) : "chat";
  } catch {
    return "chat";
  }
}
function writeTab(chatId: string, tab: CodeTab) {
  try {
    window.sessionStorage.setItem(tabKey(chatId), tab);
  } catch {
    // Remembered for this page only.
  }
}

let reposCache: Promise<CodeReposResponse> | null = null;
/** Whether the repo has checks configured (`checks` in `[[code.repos]]`); read once per page. */
function useRepoHasChecks(repo: string | undefined): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    if (!repo) return;
    let live = true;
    if (!reposCache) {
      reposCache = codeApi.repos();
      reposCache.catch(() => { reposCache = null; });
    }
    reposCache.then((r) => { if (live) setHas((r.repos.find((x) => x.name === repo)?.checks.length ?? 0) > 0); }, () => {});
    return () => { live = false; };
  }, [repo]);
  return has;
}

/**
 * A chat of kind `code`. One header row (code icon, title, status pill, the Chat · Changes · Log tabs,
 * then the branch chip, Stop and Create branch ▾) over the chosen tab, full width:
 * - **Chat**: the conversation (the same MessageList and composer as any chat, fed from the session's
 *   event log), with live approvals in it and the changes card under the latest reply.
 * - **Changes**: the changed files beside the chosen file's diff (ChangesView).
 * - **Log**: the commands the agent ran; **Checks** only when the repo has checks or a result exists.
 *
 * The tab is remembered per chat for this browser tab and never switches by itself: an approval waiting
 * while another tab is shown puts a banner under the header and a dot on Chat. On a phone the same tabs
 * sit in a row of their own, review only (no merge, discard or stage).
 */
export default function CodeSessionView({ chat, composer, onNewChat }: CodeSessionViewProps) {
  const session = useCodeSession(chat);
  const { detail, status, messages, prompt, running, version } = session;
  const isMobile = useIsMobile();
  const engines = useCodeEngines();
  const [tab, setTabState] = useState<CodeTab>(() => readTab(chat.id));
  const [file, setFile] = useState<string | null>(null);
  const [since, setSince] = useState<ChangesSince>("base");
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const tabsRef = useRef<HTMLDivElement>(null);
  // The view's own width (the sidebar may take part of the window): too narrow for one header row, the
  // tabs get a row of their own under it, as on a phone.
  const [narrow, setNarrow] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  const viewRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setNarrow(el.getBoundingClientRect().width < NARROW_VIEW);
    const ro = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_VIEW));
    ro.observe(el);
    observer.current = ro;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  const tabsBelow = isMobile || narrow;

  // Another code chat: its own remembered tab, its own file.
  const shownChat = useRef(chat.id);
  useEffect(() => {
    if (shownChat.current === chat.id) return;
    shownChat.current = chat.id;
    setTabState(readTab(chat.id));
    setFile(null);
    setSince("base");
  }, [chat.id]);

  const setTab = (next: CodeTab) => {
    setTabState(next);
    writeTab(chat.id, next);
  };

  const archived = detail?.state === "archived";
  const titles = new Map((engines?.engines ?? []).map((e) => [e.id, e.title]));
  const stat = status?.branch?.stat ?? detail?.stat;
  const repoChecks = useRepoHasChecks(detail?.repo);
  const showChecks = repoChecks || (status?.checks?.results.length ?? 0) > 0;
  const shownTab: CodeTab = tab === "checks" && !showChecks ? "chat" : tab;
  const log = useCommandLog(detail?.id, version, running, shownTab === "log");
  // The agent waits on a live approval, answered in the conversation.
  const waiting = !!prompt;

  const send = () => {
    const text = composer.input.trim();
    const files = composer.attachments;
    if (files.some((a) => a.status === "uploading")) return;
    const refs = readyRefs(files);
    // A code session takes quotes only (no SOPs or tool groups); the composer offers nothing else.
    const quotes = (composer.references ?? []).filter((r) => r.type === "quote");
    if (!text && refs.length === 0 && quotes.length === 0) return;
    composer.onInput("");
    composer.clearAttachments();
    composer.clearReferences?.();
    void session.send(text, refs, quotes).catch(() => {
      // Put the text back so nothing typed is lost; the error shows above the composer.
      composer.onInput(text);
    });
  };

  // "Add to chat" on a diff selection: the quote goes in this chat's draft, and the view goes to Chat
  // (the user asked for it, so this is the one place the app changes the tab), where App focuses the composer.
  const quoteToChat = useCallback((ref: QuoteContextRef) => {
    setTabState("chat");
    writeTab(chat.id, "chat");
    addContextToChat(ref, { chatId: chat.id });
  }, [chat.id]);

  const answer = (value: string) => {
    setAnswerError(null);
    void session.answer(value).catch((e: unknown) => {
      setAnswerError(e instanceof Error ? e.message : String(e));
      // A fresh widget, so the choice can be made again.
      setAttempt((n) => n + 1);
    });
  };
  const shownPrompt = prompt ? { ...prompt, id: attempt ? `${prompt.id}#${attempt}` : prompt.id } : undefined;
  const streaming = running && !prompt && status?.activity !== "needs_approval";

  // The changes card goes under the latest reply, once its run is over and the branch has changes.
  let lastReply = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastReply = i;
      break;
    }
  }
  const showCard = !running && !archived && !!detail && !!stat && stat.files > 0 && lastReply !== -1;
  const afterReply = (index: number) =>
    showCard && index === lastReply && detail && stat ? <ChangesSummaryCard stat={stat} base={detail.base} onReview={() => setTab("changes")} /> : null;

  const ready = session.load.state === "ready" && !!detail;
  const tabList: Array<[CodeTab, string, number | undefined]> = [
    ["chat", "Chat", undefined],
    ["changes", "Changes", stat && stat.files > 0 ? stat.files : undefined],
    ["log", "Log", log.commands && log.commands.length > 0 ? log.commands.length : undefined],
    ...(showChecks ? [["checks", "Checks", undefined] as [CodeTab, string, undefined]] : []),
  ];
  // Arrow keys move between the tabs (and choose), as a tab list does.
  const onTabsKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const keys = tabList.map(([k]) => k);
    const at = keys.indexOf(shownTab);
    const next = e.key === "Home" ? 0 : e.key === "End" ? keys.length - 1 : (at + (e.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length;
    setTab(keys[next]);
    tabsRef.current?.querySelector<HTMLButtonElement>(`#code-tab-${keys[next]}`)?.focus();
  };
  const tabs = ready ? (
    <div ref={tabsRef} className={`sop-diff-tabs code-tabs${tabsBelow ? " code-tabs--phone" : ""}`} role="tablist" aria-label="Code session" onKeyDown={onTabsKey}>
      {tabList.map(([key, label, count]) => (
        <button
          key={key}
          type="button"
          role="tab"
          id={`code-tab-${key}`}
          aria-selected={shownTab === key}
          aria-controls="code-tabpanel"
          tabIndex={shownTab === key ? 0 : -1}
          className={`sop-diff-tab${shownTab === key ? " active" : ""}`}
          onClick={() => setTab(key)}
        >
          {label}
          {key === "chat" && waiting && (
            <span className="code-tab-dot" title="Waiting for your approval">
              <span className="diff-sr">, waiting for your approval</span>
            </span>
          )}
          {count !== undefined && <span className="code-tab-count">{count}</span>}
        </button>
      ))}
    </div>
  ) : null;

  const activity = status && status.activity !== "idle" ? status.activity : null;
  const header = (
    <header className="chat-header code-head">
      <SidebarButton />
      <span className="code-head-icon" aria-hidden="true"><SquareCode size={16} /></span>
      <span className="chat-header-title code-head-title">
        <span className="code-head-name" title={chat.title}>{chat.title}</span>
        {activity && (
          <span className={`code-activity code-activity--${activity}`} title={ACTIVITY_LABEL[activity]}>
            <span className="code-activity-dot" aria-hidden="true" />
            <span className="code-activity-label">{ACTIVITY_LABEL[activity]}</span>
          </span>
        )}
      </span>
      {!tabsBelow && tabs}
      <span className="code-head-spacer" />
      {detail && <BranchChip detail={detail} status={status} phone={isMobile} />}
      {running && detail && !archived && (
        <button type="button" className="code-btn" onClick={() => void session.stop()} title="Stop the run">
          <Square size={9} fill="currentColor" strokeWidth={0} aria-hidden="true" />
          Stop
        </button>
      )}
      {detail && !isMobile && <BranchActions detail={detail} status={status} running={running} onChanged={session.refresh} />}
    </header>
  );

  if (!ready) {
    return (
      <div className="code-view" ref={viewRef}>
        {header}
        <div className="chat-loading" role="status">
          {session.load.state === "missing" ? (
            <span>This code session can’t be found. It may have been deleted from Settings → Code.</span>
          ) : session.load.state === "error" ? (
            <>
              <span>Couldn’t load this code session.</span>
              <button type="button" className="btn btn--sm btn--ghost" onClick={session.refresh}>Try again</button>
            </>
          ) : (
            <span>Loading code session…</span>
          )}
        </div>
      </div>
    );
  }

  const conversation = (
    <div className="code-convo">
      <div className="chat-stage">
        <MessageList
          messages={messages}
          chatId={chat.id}
          enableQuoteActions={!archived}
          quoteLabel="Agent's reply"
          sessionId={chat.sessionId}
          // While a live prompt waits, the reply isn't streaming: no cursor, no typing dots.
          loading={streaming}
          isViewingInflight={streaming}
          onNewChat={onNewChat}
          onOpenArtifact={() => {}}
          onContinue={() => {}}
          canResubmit={false}
          onResubmit={() => {}}
          pendingPrompt={shownPrompt}
          onPromptAnswer={answer}
          afterReply={afterReply}
        />
      </div>
      {(session.sendError || answerError || session.reconnecting) && (
        <div className="code-convo-note" role={session.reconnecting ? "status" : "alert"}>
          {session.reconnecting ? "Reconnecting to the session…" : session.sendError ?? answerError}
        </div>
      )}
      {archived ? (
        <p className="code-archived-note">This session is archived. Restore it from Settings → Code to keep working on it.</p>
      ) : (
        <MessageInput
          input={composer.input}
          // Sending while a run goes steers it, so the composer never queues; Stop is in the header.
          loading={false}
          isViewingInflight={false}
          onStop={() => void session.stop()}
          onModelChange={() => {}}
          modelSlot={
            <span className="code-engine-chip" title="The coding engine and model this session runs on">
              <SquareCode size={13} aria-hidden="true" />
              {engineTitle(detail.engine, titles)}
              {detail.model && <span className="code-engine-model">{detail.model}</span>}
            </span>
          }
          placeholder={running ? "Steer the agent while it works…" : "Message the agent…"}
          onInput={composer.onInput}
          onSend={send}
          attachments={composer.attachments}
          onAddFiles={composer.onAddFiles}
          onRemoveAttachment={composer.onRemoveAttachment}
          // Chips for the quotes added from the diff or a reply; no + ▸ SOP / tool pickers here.
          references={composer.references}
          onRemoveReference={composer.onRemoveReference}
        />
      )}
    </div>
  );

  return (
    <div className={`code-view${isMobile ? " code-view--phone" : ""}`} ref={viewRef}>
      {header}
      {tabsBelow && tabs}
      {waiting && shownTab !== "chat" && (
        <div className="code-approval-banner" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>The agent is waiting for your approval.</span>
          <button type="button" className="code-btn" onClick={() => setTab("chat")}>Go to chat</button>
        </div>
      )}
      <div className="code-body">
        <div className="code-tabpanel" id="code-tabpanel" role="tabpanel" aria-labelledby={`code-tab-${shownTab}`}>
          {shownTab === "chat" ? (
            conversation
          ) : shownTab === "changes" ? (
            <ChangesView
              sessionId={detail.id}
              version={version}
              base={detail.base}
              editorUrl={archived || isMobile ? undefined : detail.workspacePath ? detail.editorUrl : undefined}
              phone={isMobile}
              archived={archived}
              since={since}
              onSince={setSince}
              selected={file}
              onSelect={setFile}
              onQuote={quoteToChat}
            />
          ) : shownTab === "log" ? (
            <CommandLog commands={log.commands} error={log.error} archived={archived} />
          ) : (
            <ChecksPanel checks={status?.checks} />
          )}
        </div>
      </div>
    </div>
  );
}
