import { InboxView } from "./InboxView.jsx";
import { PaperLibraryView } from "./PaperLibraryView.jsx";
import { ReportQueueView } from "./ReportQueueView.jsx";

const PAPER_SECTIONS = {
  inbox: {
    component: InboxView
  },
  library: {
    component: PaperLibraryView
  },
  reports: {
    component: ReportQueueView
  }
};

export function PapersWorkspaceView({
  onOpenReportQueue,
  onSelectPaper,
  section = "inbox",
  selectedPaperId,
  setStatusMessage
}) {
  const currentSection = PAPER_SECTIONS[section] || PAPER_SECTIONS.inbox;
  const ActiveView = currentSection.component;

  return (
    <section className="view papers-workspace-view">
      <ActiveView
        onOpenReportQueue={onOpenReportQueue}
        onSelectPaper={onSelectPaper}
        selectedPaperId={selectedPaperId}
        setStatusMessage={setStatusMessage}
        targetPaperId={section === "reports" ? selectedPaperId : null}
        targetPaperKey={section === "reports" ? selectedPaperId : ""}
      />
    </section>
  );
}
