import { useState } from 'react';

export function useMultiSelect(filteredObjects: readonly { fullKey: string }[]) {
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  // Multi-select handlers
  const handleSelectItem = (key: string, index: number, shiftKey: boolean = false) => {
    const newSelected = new Set(selectedItems);
    
    if (shiftKey && lastSelectedIndex !== null) {
      // Range select
      const startIndex = Math.min(lastSelectedIndex, index);
      const endIndex = Math.max(lastSelectedIndex, index);
      for (let i = startIndex; i <= endIndex; i++) {
        if (filteredObjects[i]) {
          newSelected.add(filteredObjects[i].fullKey);
        }
      }
    } else {
      // Toggle select
      if (newSelected.has(key)) {
        newSelected.delete(key);
      } else {
        newSelected.add(key);
      }
    }
    
    setSelectedItems(newSelected);
    setLastSelectedIndex(index);
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
  };

  return { selectedItems, setSelectedItems, setLastSelectedIndex, handleSelectItem, handleSelectAll, clearSelection };
}
