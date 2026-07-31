import { InboxView } from "./InboxView.jsx";
import { PaperChatView } from "./PaperChatView.jsx";
import { PaperLibraryView } from "./PaperLibraryView.jsx";
import "../styles/PapersWorkspaceView.css";

const PAPER_SECTIONS = {
  inbox: {
    component: InboxView
  },
  library: {
    component: PaperLibraryView
  },
  chat: {
    component: PaperChatView
  }
};

export function PapersWorkspaceView({
  importOpen,
  notify,
  onClosePaperImport,
  onOpenChat,
  onOpenLibraryPaper,
  onSelectPaper,
  section = "inbox",
  selectedPaperId,
  setStatusMessage
}) {
  const currentSection = PAPER_SECTIONS[section] || PAPER_SECTIONS.inbox;
  const ActiveView = currentSection.component;
  const workspaceClassName = [
    "view",
    "papers-workspace-view",
    section === "inbox" ? "inbox-workspace-shell" : "",
    section === "library" ? "library-workspace-shell" : "",
    section === "chat" ? "chat-workspace-shell" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={workspaceClassName}>
      <ActiveView
        importOpen={importOpen}
        notify={notify}
        onClosePaperImport={onClosePaperImport}
        onOpenChat={onOpenChat}
        onOpenLibraryPaper={onOpenLibraryPaper}
        onSelectPaper={onSelectPaper}
        selectedPaperId={selectedPaperId}
        setStatusMessage={setStatusMessage}
        targetPaperId={section === "chat" ? selectedPaperId : null}
        targetPaperKey={section === "chat" ? selectedPaperId : ""}
      />
    </section>
  );
}
