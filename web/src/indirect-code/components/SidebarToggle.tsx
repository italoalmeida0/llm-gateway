import { Icon } from "../../components/icon";
import { useUI } from "../ctx";

/** One control shared by the sidebar brand row and the collapsed workspace. */
export function SidebarToggle() {
  const ui = useUI();
  const label = () => ui.sidebarOpen()
    ? ui.isMobile() ? "Close sidebar" : "Collapse sidebar"
    : "Expand sidebar";
  return (
    <button
      onClick={() => ui.setSidebarOpen(!ui.sidebarOpen())}
      class="rc-sidebar-toggle flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-400 hover:bg-ink-800/60 hover:text-ink-100 transition-colors cursor-pointer"
      data-rc-tip={label()}
      aria-label={label()}
    >
      <Icon icon={ui.sidebarOpen() ? ui.isMobile() ? "lucide:x" : "lucide:panel-left-close" : "lucide:panel-left-open"} size={16} />
    </button>
  );
}
