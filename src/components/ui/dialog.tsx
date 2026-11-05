"use client";

import { useEffect, useRef, useId, type ReactNode } from "react";
import { X } from "lucide-react";
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  busy = false,
  role,
  describedBy,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  busy?: boolean;
  role?: "alertdialog";
  describedBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? "dialog-wide" : ""}`}
      role={role}
      aria-labelledby={heading}
      aria-describedby={describedBy}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        // React bubbles cancel to enclosing dialogs; Escape closes only this one.
        event.stopPropagation();
        if (!busy) onClose();
      }}
    >
      <header className="dialog-header">
        <h2 id={heading}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          disabled={busy}
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X aria-hidden="true" size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
