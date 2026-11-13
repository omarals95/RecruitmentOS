"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Dialog } from "./dialog";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
}
/** Escape and the close button cancel; focus starts on Cancel and returns to the opener. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  const messageId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  // Runs after Dialog has opened, so focus lands inside the modal.
  useEffect(() => cancel.current?.focus(), []);
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      role="alertdialog"
      describedBy={messageId}
    >
      <div className="dialog-body">
        <p id={messageId}>{message}</p>
      </div>
      <footer className="dialog-footer">
        <button
          ref={cancel}
          type="button"
          className="button secondary"
          autoFocus
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={destructive ? "button danger" : "button"}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </footer>
    </Dialog>
  );
}
/** `await confirm({...})` resolves true on confirm and false on cancel; render `dialog`. */
export function useConfirm() {
  const [request, setRequest] = useState<
    (ConfirmOptions & { resolve: (value: boolean) => void }) | null
  >(null);
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setRequest({ ...options, resolve })),
    [],
  );
  const settle = (value: boolean) => {
    request?.resolve(value);
    setRequest(null);
  };
  const dialog = request ? (
    <ConfirmDialog
      {...request}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;
  return { confirm, dialog };
}
