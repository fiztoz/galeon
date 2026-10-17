import { describe, expect, test } from 'bun:test';
import { queueDrain, formatEta, type TransferState } from '../../src/components/TransferManager';

/**
 * The drawer header's queue readout: bytes remaining across every transfer
 * that still owes work, and an ETA divided by ACTIVE throughput only. The
 * header is the one place the user reads "how long will this take", so the
 * math must survive the awkward mixes a real queue produces.
 */
const transfer = (overrides: Partial<TransferState> & Pick<TransferState, 'id'>): TransferState => ({
  remoteKey: 'bucket/' + overrides.id,
  bytesTransferred: 0,
  totalBytes: 0,
  percentage: 0,
  bytesPerSecond: 0,
  status: 'queued',
  direction: 'upload',
  ...overrides,
});

const KiB = 1024;

describe('queueDrain remaining', () => {
  test('counts queued, active, paused, retrying, and verifying — never terminal', () => {
    const queue = [
      transfer({ id: 'a', status: 'queued', totalBytes: 3 * KiB, bytesTransferred: KiB }),
      transfer({ id: 'b', status: 'active', totalBytes: 2 * KiB, bytesTransferred: KiB }),
      transfer({ id: 'c', status: 'paused', totalBytes: 2 * KiB, bytesTransferred: KiB }),
      transfer({ id: 'd', status: 'retrying', totalBytes: 2 * KiB, bytesTransferred: 0 }),
      transfer({ id: 'e', status: 'verifying', totalBytes: KiB, bytesTransferred: KiB }),
      transfer({ id: 'f', status: 'completed', totalBytes: 9 * KiB, bytesTransferred: 9 * KiB }),
      transfer({ id: 'g', status: 'failed' }),
      transfer({ id: 'h', status: 'cancelled' }),
    ];
    // 2 + 1 + 1 + 2 + 0; completed/failed/cancelled owe nothing.
    expect(queueDrain(queue).remainingBytes).toBe(6 * KiB);
  });

  test('never reports negative work from a retried counter', () => {
    const queue = [
      transfer({ id: 'a', status: 'active', totalBytes: 100, bytesTransferred: 150 }),
    ];
    expect(queueDrain(queue).remainingBytes).toBe(0);
  });
});

describe('queueDrain eta', () => {
  test('divides by ACTIVE throughput only; paused and idle rows contribute nothing', () => {
    const queue = [
      transfer({ id: 'a', status: 'active', totalBytes: 2000, bytesTransferred: 0, bytesPerSecond: 100 }),
      transfer({ id: 'b', status: 'active', totalBytes: 2000, bytesTransferred: 1000, bytesPerSecond: 100 }),
      transfer({ id: 'c', status: 'paused', totalBytes: 5000, bytesTransferred: 0, bytesPerSecond: 999 }),
      transfer({ id: 'd', status: 'queued', totalBytes: 1000, bytesTransferred: 0 }),
    ];
    const drain = queueDrain(queue);
    expect(drain.remainingBytes).toBe(9000);
    expect(drain.throughputBytes).toBe(200);
    expect(drain.etaSeconds).toBe(45);
  });

  test('a queue with work but nothing moving answers "left" without an eta', () => {
    const queue = [
      transfer({ id: 'a', status: 'paused', totalBytes: 1000, bytesTransferred: 0 }),
    ];
    const drain = queueDrain(queue);
    expect(drain.remainingBytes).toBe(1000);
    expect(drain.etaSeconds).toBeNull();
  });

  test('a fully drained queue has no eta to show', () => {
    const queue = [
      transfer({ id: 'a', status: 'completed', totalBytes: 1000, bytesTransferred: 1000 }),
      transfer({ id: 'b', status: 'failed', totalBytes: 1000, bytesTransferred: 500 }),
    ];
    const drain = queueDrain(queue);
    expect(drain.remainingBytes).toBe(0);
    expect(drain.etaSeconds).toBeNull();
  });
});

describe('formatEta', () => {
  test('seconds', () => {
    expect(formatEta(0.5)).toBe('1s'); // a live queue never says "0 s"
    expect(formatEta(45)).toBe('45s');
  });

  test('minutes, rolling 119.9s up to the next minute', () => {
    expect(formatEta(60)).toBe('1m 0s');
    expect(formatEta(119.9)).toBe('2m 0s');
    expect(formatEta(125)).toBe('2m 5s');
  });

  test('hours', () => {
    expect(formatEta(3601)).toBe('1h 0m');
    expect(formatEta(7200)).toBe('2h 0m');
  });
});
