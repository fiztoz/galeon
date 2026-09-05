import React, { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { GaleonObject } from '../types';

export function useObjectListing(sessionId: string) {
  const [prefix, setPrefix] = useState('');
  const [objects, setObjects] = useState<GaleonObject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Distinct from `error`, which any action (delete, rename…) can set: this means the
  // current listing failed, so the rows we show are unknown rather than empty.
  const [listFailed, setListFailed] = useState(false);

  const listNonceRef = useRef(0);

  const fetchDirectory = async (currentPrefix: string) => {
    // Listings race: prefix changes, Refresh, and create/delete/rename all fire one.
    // Only the most recent request may touch state, otherwise a slow failure for a
    // folder we already navigated away from wipes the rows we are actually showing.
    const nonce = ++listNonceRef.current;
    setLoading(true);
    setError('');
    setListFailed(false);
    try {
      const res = await invoke<GaleonObject[]>('list_directory', {
        sessionId,
        prefix: currentPrefix,
      });
      if (nonce !== listNonceRef.current) return;
      setObjects(res);
    } catch (err: unknown) {
      if (nonce !== listNonceRef.current) return;
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      setError(msg.replace(/^Error:\s*/i, '') || 'Failed to list directory.');
      setListFailed(true);
      setObjects([]);
    } finally {
      // A newer request owns the spinner from here on.
      if (nonce === listNonceRef.current) setLoading(false);
    }
  };

  return { prefix, setPrefix, objects, loading, error, setError, listFailed, fetchDirectory };
}

export function useObjectSorting(objects: GaleonObject[], folderSizes: Record<string, { totalBytes?: number }>) {
  // Search, Filter, Sort states
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'folders' | 'files'>('all');
  const [sortKey, setSortKey] = useState<'name' | 'size' | 'date'>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  
  // Filtered and sorted objects
  const filteredObjects = React.useMemo(() => {
    let result = [...objects];
    
    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(obj => obj.name.toLowerCase().includes(query));
    }
    
    // Apply type filter
    if (filterType === 'folders') {
      result = result.filter(obj => obj.objectType === 'folder');
    } else if (filterType === 'files') {
      result = result.filter(obj => obj.objectType === 'file');
    }
    
    // Apply sorting
    result.sort((a, b) => {
      // Folders always come first
      if (a.objectType === 'folder' && b.objectType !== 'folder') return -1;
      if (a.objectType !== 'folder' && b.objectType === 'folder') return 1;
      
      let comparison = 0;
      switch (sortKey) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'size': {
          const sizeOf = (obj: GaleonObject) => {
            if (obj.objectType === 'file') return obj.sizeBytes || 0;
            return folderSizes[obj.fullKey]?.totalBytes || 0;
          };
          comparison = sizeOf(a) - sizeOf(b);
          break;
        }
        case 'date':
          const dateA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
          const dateB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
          comparison = dateA - dateB;
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    
    return result;
  }, [objects, searchQuery, filterType, sortKey, sortDirection, folderSizes]);

  const handleSort = (key: 'name' | 'size' | 'date') => {
    if (sortKey === key) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  return { searchQuery, setSearchQuery, filterType, setFilterType, sortKey, sortDirection, filteredObjects, handleSort };
}
