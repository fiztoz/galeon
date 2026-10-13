import { ArrowRight, Loader2, Save } from 'lucide-react';

interface ConnectionActionsProps {
  loading: boolean;
  credsLoading: boolean;
  hasProfile: boolean;
  canSave: boolean;
  onSave: () => void;
  onSaveAsNew: () => void;
  onClear: () => void;
}

export function ConnectionActions({ loading, credsLoading, hasProfile, canSave, onSave, onSaveAsNew, onClear }: ConnectionActionsProps) {
  return (
    <footer className="connection-footer">
      <div className="connection-footer-inner">
        <div className="connection-action-row">
          <button type="button" onClick={onClear} disabled={loading || credsLoading} className="ui-button ui-button-ghost">
            Clear fields
          </button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {hasProfile && (
              <button type="button" onClick={onSaveAsNew} disabled={!canSave || loading || credsLoading} className="ui-button ui-button-ghost">
                Save as new
              </button>
            )}
            <button type="button" onClick={hasProfile ? onSave : onSaveAsNew} disabled={!canSave || loading || credsLoading} className="ui-button ui-button-secondary">
              <Save size={14} aria-hidden="true" />
              {hasProfile ? 'Save changes' : 'Save profile'}
            </button>
            <button type="submit" form="connection-form" disabled={loading || credsLoading} className="ui-button ui-button-primary">
              {loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
              {loading ? 'Connecting…' : 'Connect'}
              {!loading && <ArrowRight size={14} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}
