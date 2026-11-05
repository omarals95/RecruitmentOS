import { Kanban, LayoutGrid, List } from "lucide-react";

export type DisplayMode = "table" | "cards" | "board";

export function DisplayModeToggle({
  board,
  mode,
  onChange,
}: {
  board: boolean;
  mode: DisplayMode;
  onChange: (mode: DisplayMode) => void;
}) {
  return (
    <div className="view-toggle" aria-label="Display mode">
      {board && (
        <button
          aria-label="Board view"
          aria-pressed={mode === "board"}
          onClick={() => onChange("board")}
        >
          <Kanban size={17} aria-hidden="true" />
        </button>
      )}
      <button
        aria-label="Table view"
        aria-pressed={mode === "table"}
        onClick={() => onChange("table")}
      >
        <List size={18} aria-hidden="true" />
      </button>
      <button
        aria-label="Card view"
        aria-pressed={mode === "cards"}
        onClick={() => onChange("cards")}
      >
        <LayoutGrid size={17} aria-hidden="true" />
      </button>
    </div>
  );
}
