import React from 'react';

/**
 * One chrome row for a file pane.
 *
 * A layout shell, not a data hook: the callers pass the buttons they already
 * have, and this only decides where they sit. The order is fixed so both
 * panes read the same — navigation, path, search, actions, filters.
 *
 * The search and the action/filter groups are passed through unwrapped: they
 * are already the elements the stylesheet sizes.
 */
export function PaneChrome({
  navigation,
  path,
  search,
  actions,
  filters,
}: {
  navigation: React.ReactNode;
  path: React.ReactNode;
  search: React.ReactNode;
  actions: React.ReactNode;
  filters?: React.ReactNode;
}) {
  return (
    <div className="pane-chrome">
      <div className="pane-chrome-nav">{navigation}</div>
      <div className="pane-chrome-path">{path}</div>
      {search}
      {actions}
      {filters}
    </div>
  );
}
