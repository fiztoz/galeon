import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { GaleonObject } from '../components/Explorer';

interface PrefixSizeProgress {
  jobId: string;
  prefix: string;
  totalBytes: number;
  fileCount: number;
  complete: boolean;
  cancelled: boolean;
  error?: string;
}

interface ComputePrefixSizeResponse {
  jobId: string;
  cached: boolean;
  totalBytes?: number;
  fileCount?: number;
}

type FolderSizeEntry = {
  status: 'loading' | 'ready' | 'error';
  totalBytes?: number;
  fileCount?: number;
};

const FOLDER_SIZE_CONCURRENCY = 2;

export function useFolderSizes(sessionId: string, prefix: string, isS3: boolean, loading: boolean, objects: GaleonObject[]) {
  // Prefix / folder size state (computed in background)
  const [prefixSizeBytes, setPrefixSizeBytes] = useState<number | null>(null);
  const [prefixFileCount, setPrefixFileCount] = useState<number | null>(null);
  const [prefixSizeLoading, setPrefixSizeLoading] = useState(false);
  const [prefixSizeError, setPrefixSizeError] = useState('');
  const [folderSizes, setFolderSizes] = useState<Record<string, FolderSizeEntry>>({});
  const prefixSizeJobRef = useRef<string | null>(null);
  const prefixSizeLocalCache = useRef<Record<string, { totalBytes: number; fileCount: number }>>({});
  const folderJobRefs = useRef<Map<string, string>>(new Map());
  const folderQueueRef = useRef<string[]>([]);
  const folderRunningRef = useRef(0);
  const folderSizesRef = useRef(folderSizes);
  folderSizesRef.current = folderSizes;
  const prefixSizeCacheKey = (targetPrefix: string) => `${sessionId}:${targetPrefix}`;

  const savePrefixSizeToLocalCache = (targetPrefix: string, totalBytes: number, fileCount: number) => {
    prefixSizeLocalCache.current[prefixSizeCacheKey(targetPrefix)] = { totalBytes, fileCount };
  };

  const cancelPrefixSizeJob = (jobId: string | null) => {
    if (!jobId) return;
    invoke('cancel_prefix_size', { jobId }).catch(() => {});
  };

  const applyComputePrefixSizeResponse = (
    res: ComputePrefixSizeResponse,
    targetPrefix: string,
    onCached: (totalBytes: number, fileCount: number) => void,
  ) => {
    if (res.cached && res.totalBytes != null) {
      const fileCount = res.fileCount ?? 0;
      savePrefixSizeToLocalCache(targetPrefix, res.totalBytes, fileCount);
      onCached(res.totalBytes, fileCount);
    }
  };

  const startFolderSizeScan = (folderKey: string) => {
    invoke<ComputePrefixSizeResponse>('compute_prefix_size', { sessionId, prefix: folderKey })
      .then((res) => {
        folderJobRefs.current.set(res.jobId, folderKey);
        if (res.cached && res.totalBytes != null) {
          folderJobRefs.current.delete(res.jobId);
          folderRunningRef.current = Math.max(0, folderRunningRef.current - 1);
          applyComputePrefixSizeResponse(res, folderKey, (totalBytes, fileCount) => {
            setFolderSizes((prev) => ({
              ...prev,
              [folderKey]: { status: 'ready', totalBytes, fileCount },
            }));
          });
          drainFolderSizeQueue();
          return;
        }
        setFolderSizes((prev) => ({
          ...prev,
          [folderKey]: { status: 'loading' },
        }));
      })
      .catch(() => {
        setFolderSizes((prev) => ({
          ...prev,
          [folderKey]: { status: 'error' },
        }));
        folderRunningRef.current = Math.max(0, folderRunningRef.current - 1);
        drainFolderSizeQueue();
      });
  };

  const drainFolderSizeQueue = () => {
    while (
      folderRunningRef.current < FOLDER_SIZE_CONCURRENCY &&
      folderQueueRef.current.length > 0
    ) {
      const folderKey = folderQueueRef.current.shift();
      if (!folderKey) break;
      const existing = folderSizesRef.current[folderKey];
      if (existing?.status === 'ready' || existing?.status === 'loading') {
        continue;
      }
      folderRunningRef.current += 1;
      startFolderSizeScan(folderKey);
    }
  };

  const cancelInFlightFolderSizeJobs = () => {
    for (const jobId of folderJobRefs.current.keys()) {
      cancelPrefixSizeJob(jobId);
    }
    folderJobRefs.current.clear();
    folderQueueRef.current = [];
    folderRunningRef.current = 0;
  };

  useEffect(() => {
    const unsub = listen<PrefixSizeProgress>('prefix-size-progress', (ev) => {
      const {
        jobId,
        totalBytes,
        fileCount,
        complete,
        cancelled,
        error,
      } = ev.payload;

      if (jobId === prefixSizeJobRef.current) {
        if (!complete) {
          setPrefixSizeLoading(true);
          setPrefixSizeBytes(totalBytes);
          setPrefixFileCount(fileCount);
          return;
        }
        if (cancelled) return;
        setPrefixSizeLoading(false);
        if (error) {
          setPrefixSizeError(error);
          setPrefixSizeBytes(null);
          setPrefixFileCount(null);
        } else {
          setPrefixSizeError('');
          setPrefixSizeBytes(totalBytes);
          setPrefixFileCount(fileCount);
          savePrefixSizeToLocalCache(ev.payload.prefix, totalBytes, fileCount);
        }
        return;
      }

      const folderKey = folderJobRefs.current.get(jobId);
      if (!folderKey) return;

      if (!complete) {
        setFolderSizes((prev) => ({
          ...prev,
          [folderKey]: { status: 'loading', totalBytes, fileCount },
        }));
        return;
      }

      folderJobRefs.current.delete(jobId);
      folderRunningRef.current = Math.max(0, folderRunningRef.current - 1);

      if (cancelled) {
        drainFolderSizeQueue();
        return;
      }

      if (!error) {
        savePrefixSizeToLocalCache(folderKey, totalBytes, fileCount);
      }
      setFolderSizes((prev) => ({
        ...prev,
        [folderKey]: error
          ? { status: 'error' }
          : { status: 'ready', totalBytes, fileCount },
      }));
      drainFolderSizeQueue();
    });

    return () => {
      unsub.then((fn) => fn()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!isS3) {
      cancelPrefixSizeJob(prefixSizeJobRef.current);
      prefixSizeJobRef.current = null;
      setPrefixSizeLoading(false);
      setPrefixSizeBytes(null);
      setPrefixFileCount(null);
      setPrefixSizeError('');
      return;
    }
    if (loading) return;

    cancelPrefixSizeJob(prefixSizeJobRef.current);
    prefixSizeJobRef.current = null;
    setPrefixSizeError('');

    const localCached = prefixSizeLocalCache.current[prefixSizeCacheKey(prefix)];
    if (localCached) {
      setPrefixSizeBytes(localCached.totalBytes);
      setPrefixFileCount(localCached.fileCount);
      setPrefixSizeLoading(false);
    } else {
      setPrefixSizeLoading(true);
      setPrefixSizeBytes(null);
      setPrefixFileCount(null);
    }

    invoke<ComputePrefixSizeResponse>('compute_prefix_size', { sessionId, prefix })
      .then((res) => {
        prefixSizeJobRef.current = res.jobId;
        applyComputePrefixSizeResponse(res, prefix, (totalBytes, fileCount) => {
          setPrefixSizeLoading(false);
          setPrefixSizeBytes(totalBytes);
          setPrefixFileCount(fileCount);
        });
      })
      .catch((err) => {
        setPrefixSizeLoading(false);
        setPrefixSizeError(String(err));
      });
  }, [prefix, loading, sessionId, isS3]);

  useEffect(() => {
    if (!isS3) {
      cancelInFlightFolderSizeJobs();
      setFolderSizes({});
      return;
    }
    if (loading) return;

    cancelInFlightFolderSizeJobs();

    const folders = objects
      .filter((obj) => obj.objectType === 'folder')
      .map((obj) => obj.fullKey);

    const restoredFromCache: Record<string, FolderSizeEntry> = {};
    const toScan: string[] = [];

    for (const folderKey of folders) {
      if (folderSizesRef.current[folderKey]?.status === 'ready') {
        continue;
      }
      const cached = prefixSizeLocalCache.current[prefixSizeCacheKey(folderKey)];
      if (cached) {
        restoredFromCache[folderKey] = {
          status: 'ready',
          totalBytes: cached.totalBytes,
          fileCount: cached.fileCount,
        };
      } else {
        toScan.push(folderKey);
      }
    }

    if (Object.keys(restoredFromCache).length > 0) {
      setFolderSizes((prev) => ({ ...prev, ...restoredFromCache }));
    }

    folderQueueRef.current = toScan;
    drainFolderSizeQueue();
  }, [objects, loading, sessionId, isS3]);

  useEffect(() => {
    return () => {
      cancelPrefixSizeJob(prefixSizeJobRef.current);
      for (const jobId of folderJobRefs.current.keys()) {
        cancelPrefixSizeJob(jobId);
      }
    };
  }, []);

  return { prefixSizeBytes, prefixFileCount, prefixSizeLoading, prefixSizeError, folderSizes };
}
