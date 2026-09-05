import { useState, type Dispatch, type SetStateAction } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { BandwidthRule } from '../../types';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const formatRuleDays = (days: number[]) => {
  if (days.length === 0) return 'No days';
  if (days.length === 7) return 'Every day';
  const sorted = [...days].sort((a, b) => a - b);
  return sorted.map((d) => DAY_LABELS[d] ?? '?').join(', ');
};

const formatRuleLimit = (limitKbps: number) =>
  limitKbps === 0 ? 'Unlimited' : `${limitKbps} KB/s`;

interface BandwidthRulesEditorProps {
  bandwidthRules: BandwidthRule[];
  setBandwidthRules: Dispatch<SetStateAction<BandwidthRule[]>>;
  setError: Dispatch<SetStateAction<string>>;
}

export function useBandwidthRuleDraft() {
  const [newRuleDays, setNewRuleDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [newRuleStartTime, setNewRuleStartTime] = useState('22:00');
  const [newRuleEndTime, setNewRuleEndTime] = useState('06:00');
  const [newRuleLimitKbps, setNewRuleLimitKbps] = useState<number | ''>(512);
  return { newRuleDays, setNewRuleDays, newRuleStartTime, setNewRuleStartTime,
    newRuleEndTime, setNewRuleEndTime, newRuleLimitKbps, setNewRuleLimitKbps };
}

export function BandwidthRulesEditor({ bandwidthRules, setBandwidthRules, setError, draft }: BandwidthRulesEditorProps & { draft: ReturnType<typeof useBandwidthRuleDraft> }) {
  const { newRuleDays, setNewRuleDays, newRuleStartTime, setNewRuleStartTime,
    newRuleEndTime, setNewRuleEndTime, newRuleLimitKbps, setNewRuleLimitKbps } = draft;
  const toggleNewRuleDay = (day: number) => {
    setNewRuleDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)
    );
  };

  const handleAddBandwidthRule = () => {
    if (newRuleDays.length === 0) {
      setError('Select at least one day for the bandwidth rule.');
      return;
    }
    const limitKbps = newRuleLimitKbps === '' ? 0 : Number(newRuleLimitKbps);
    setBandwidthRules((prev) => [
      ...prev,
      {
        enabled: true,
        startTime: newRuleStartTime,
        endTime: newRuleEndTime,
        days: [...newRuleDays],
        limitKbps,
      },
    ]);
    setError('');
  };

  const handleDeleteBandwidthRule = (index: number) => {
    setBandwidthRules((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="pt-3 border-t border-zinc-700 space-y-3">
      <div>
        <label className="block text-sm font-medium text-zinc-200">Bandwidth rules</label>
        <p className="mt-1 text-xs text-zinc-500">
          Matching rule overrides static limit. 0 KB/s = unlimited in that window.
        </p>
      </div>

      {bandwidthRules.length > 0 ? (
        <div className="space-y-2">
          {bandwidthRules.map((rule, index) => (
            <div
              key={`${rule.startTime}-${rule.endTime}-${index}`}
              className="flex items-start justify-between gap-2 p-2 rounded-lg bg-zinc-900/60 border border-zinc-700"
            >
              <div className="min-w-0 text-xs text-zinc-300">
                <div className="font-medium text-zinc-200">
                  {rule.startTime} – {rule.endTime}
                </div>
                <div className="text-zinc-500">{formatRuleDays(rule.days)}</div>
                <div className="text-zinc-400">{formatRuleLimit(rule.limitKbps)}</div>
              </div>
              <button
                type="button"
                onClick={() => handleDeleteBandwidthRule(index)}
                className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-red-400 flex-shrink-0"
                title="Delete rule"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-zinc-500">No bandwidth rules configured.</p>
      )}

      <div className="space-y-3 p-3 rounded-lg bg-zinc-900/40 border border-zinc-700/80">
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Add rule</p>
        <div className="flex flex-wrap gap-2">
          {DAY_LABELS.map((label, day) => (
            <label key={label} className="flex items-center space-x-1 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={newRuleDays.includes(day)}
                onChange={() => toggleNewRuleDay(day)}
                className="w-3.5 h-3.5 text-gale-teal bg-zinc-800 border-zinc-600 rounded focus:ring-gale-teal"
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Start</label>
            <input
              type="time"
              value={newRuleStartTime}
              onChange={(e) => setNewRuleStartTime(e.target.value)}
              className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">End</label>
            <input
              type="time"
              value={newRuleEndTime}
              onChange={(e) => setNewRuleEndTime(e.target.value)}
              className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Limit (KB/s)</label>
          <input
            type="number"
            min="0"
            placeholder="0 = unlimited"
            value={newRuleLimitKbps}
            onChange={(e) => setNewRuleLimitKbps(e.target.value ? Number(e.target.value) : '')}
            className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal placeholder:text-zinc-500"
          />
        </div>
        <button
          type="button"
          onClick={handleAddBandwidthRule}
          className="flex items-center space-x-1 text-xs text-gale-teal hover:text-deep-current transition-colors"
        >
          <Plus className="w-3 h-3" />
          <span>Add bandwidth rule</span>
        </button>
      </div>
    </div>
  );

}
