import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { usePageTransitionLayerState } from "../../components/PageTransition";

export function ReviewBoardDialog({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const layer = usePageTransitionLayerState();
  useEffect(() => {
    if (!open || layer !== "entered") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    const back = (event: Event) => { event.preventDefault(); closeRef.current(); };
    window.addEventListener("review-card-overlay-back", back);
    return () => {
      window.removeEventListener("review-card-overlay-back", back);
      dialog.close();
      document.body.style.overflow = overflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [open, layer]);
  return <dialog ref={dialogRef} className="review-board-dialog" aria-label="复习看板" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>
    <header className="review-board-title"><h2>复习看板</h2><button type="button" className="icon-button" aria-label="关闭复习看板" onClick={onClose}><X size={20} /></button></header>
    {children}
  </dialog>;
}
