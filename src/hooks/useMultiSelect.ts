import { useState } from 'react';

/**
 * How a row was picked.
 *
 * - plain click replaces the selection (file-manager behaviour),
 * - `toggle` (Cmd/Ctrl-click) adds or removes one row,
 * - `shift` extends from the anchor to the clicked row.
 */
export type SelectGesture = { shift?: boolean; toggle?: boolean };

/**
 * Resolve a selection gesture into the next selection and anchor.
 *
 * Pure so both file panes share one definition of "what does this click
 * select" — and so the rules can be unit-tested without a DOM.
 */
export function applySelection(
  selected: ReadonlySet<string>,
  anchor: number | null,
  items: readonly { fullKey: string }[],
  key: string,
  index: number,
  gesture: SelectGesture,
): { selected: Set<string>; anchor: number } {
  if (gesture.shift && anchor !== null && items.length > 0) {
    const next = new Set(selected);
    const start = Math.min(anchor, index);
    const end = Math.max(anchor, index);
    for (let i = start; i <= end; i++) {
      if (items[i]) next.add(items[i].fullKey);
    }
    // The anchor stays where it was: a shift range always grows from the last
    // plain click, so a second shift-click replaces the range instead of
    // piling a second range on top of it.
    return { selected: next, anchor };
  }
  if (gesture.toggle) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return { selected: next, anchor: index };
  }
  return { selected: new Set([key]), anchor: index };
}

export function useMultiSelect(filteredObjects: readonly { fullKey: string }[]) {
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  /** The row the keyboard cursor sits on. Independent of the selection. */
  const [cursorIndex, setCursorIndex] = useState<number | null>(null);

  const handleSelectItem = (key: string, index: number, gesture: SelectGesture = {}) => {
    const { selected, anchor } = applySelection(
      selectedItems,
      lastSelectedIndex,
      filteredObjects,
      key,
      index,
      gesture,
    );

    setSelectedItems(selected);
    setLastSelectedIndex(anchor);
    setCursorIndex(index);
  };

  const handleSelectAll = () => {
    if (selectedItems.size === filteredObjects.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(filteredObjects.map(obj => obj.fullKey)));
    }
  };

  const clearSelection = () => {
    setSelectedItems(new Set());
    setLastSelectedIndex(null);
    setCursorIndex(null);
  };

  return {
    selectedItems,
    setSelectedItems,
    lastSelectedIndex,
    setLastSelectedIndex,
    cursorIndex,
    setCursorIndex,
    handleSelectItem,
    handleSelectAll,
    clearSelection,
  };
}
