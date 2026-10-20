/** Disconnect must warn only when an external editor watch is still open. */
export function disconnectNeedsConfirm(openEditorCount: number): boolean {
  return openEditorCount > 0;
}
