import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Shared positioning and dismissal for select and editable suggestion menus. */
export function useChoicePopup(anchor: RefObject<HTMLElement | null>, open: boolean, count: number, active: number, setOpen: (open: boolean) => void) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 280 });
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const height = Math.min(280, count * 36 + 12);
    const upward = below < height && above > below;
    const maxHeight = Math.max(36, Math.min(height, upward ? above : below));
    const width = Math.min(Math.max(rect.width, 200), window.innerWidth - 24);
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: upward ? rect.top - maxHeight - 6 : rect.bottom + 6, width, maxHeight });
  }, [open, count]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismiss = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', dismiss, true);
    };
  }, [open]);

  return { menu, position };
}
