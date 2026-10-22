/**
 * Labels for the connection switcher in the titlebar.
 *
 * The rule lives here rather than in the component so it can be tested without
 * a DOM — and so the connected shell does not have to import the connection
 * screen just to format a line of text.
 *
 * Never render credentials here: no password, no key path, no tunnel host.
 */

export type SwitcherProfile = {
  id: string;
  name: string;
  protocol?: string;
  username?: string;
  host?: string;
  port?: string;
  bucket?: string;
  endpoint?: string;
};

/** One line that says where a saved connection points. */
export function switcherSubtitle(profile: SwitcherProfile): string {
  const protocol = profile.protocol ?? 's3';
  if (protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps') {
    const host = profile.host || 'host';
    const user = profile.username ? `${profile.username}@` : '';
    const port = profile.port ? `:${profile.port}` : '';
    return `${protocol.toUpperCase()} · ${user}${host}${port}`;
  }
  const target = profile.bucket || profile.endpoint || protocol.toUpperCase();
  return `${protocol.toUpperCase()} · ${target}`;
}

/** Is this the profile the open session came from? */
export function isCurrentProfile(profileId: string, sessionProfileId: string | undefined): boolean {
  return sessionProfileId !== undefined && profileId === sessionProfileId;
}
