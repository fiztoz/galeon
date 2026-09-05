import { mock } from 'bun:test';
import * as React from 'react';
const actualReact = { ...React };
// Minimal deterministic hook runner: rerenders are explicit; effects run after render.
export function hookHarness() {
  let slots: any[] = [], cursor = 0, pending: (() => void)[] = [];
  const react = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useMemo(fn: () => any) { return fn(); },
    useEffect(fn: () => any, deps: any[]) {
      const index = cursor++, old = slots[index];
      if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) {
        pending.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: fn() }; });
      }
    },
  };
  mock.module('react', () => ({ ...actualReact, ...react, default: { ...actualReact, ...react } }));
  return {
    render<T>(fn: () => T): T { cursor = 0; const result = fn(); const effects = pending; pending = []; effects.forEach(fn => fn()); return result; },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); slots = []; },
  };
}
export const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
