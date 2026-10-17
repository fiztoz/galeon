import { expect, test } from 'bun:test';
import { manualRunAttribution } from '../../src/components/SyncPanel';

/**
 * The case the history must not lie about: a run is attributed to a saved
 * profile only while the settings it executed still match that profile.
 */
const profile = {
  id: 'sp-1',
  name: 'Nightly backup',
  connectionProfileId: 'conn-1',
  localPath: '/src',
  remotePrefix: 'backup',
  direction: 'localToRemote' as const,
  verifyChecksum: false,
  deleteExtraneous: true,
  maxScheduledDeletes: 5,
  lastRunMs: null,
};

const matchingInputs = {
  connectionProfileId: profile.connectionProfileId,
  localPath: profile.localPath,
  remotePrefix: profile.remotePrefix,
  direction: profile.direction,
  verifyChecksum: profile.verifyChecksum,
  deleteExtraneous: profile.deleteExtraneous,
};

test('untouched form after a profile load attributes the run to that profile', () => {
  expect(manualRunAttribution(profile, matchingInputs)).toEqual({
    profileId: 'sp-1',
    profileName: 'Nightly backup',
  });
});

test('any edited execution input turns the run ad-hoc', () => {
  for (const edit of [
    { connectionProfileId: 'conn-2' },
    { localPath: '/elsewhere' },
    { remotePrefix: 'other' },
    { direction: 'remoteToLocal' as const },
    { verifyChecksum: true },
    { deleteExtraneous: false },
  ]) {
    const inputs = { ...matchingInputs, ...edit };
    expect(manualRunAttribution(profile, inputs), JSON.stringify(edit)).toBeNull();
  }
});

test('a run with no loaded profile is ad-hoc, without needing an edit', () => {
  expect(manualRunAttribution(null, matchingInputs)).toBeNull();
});

test('irrelevant edits do not break attribution: name, schedule, budget', () => {
  // The display name retyped, the schedule adjusted, the scheduled-delete
  // budget raised — none of these change what a manual run executes (manual
  // runs never consult the budget), so the run is still the loaded profile's.
  const renamed = { ...profile, name: 'Renamed', maxScheduledDeletes: 9 };
  expect(manualRunAttribution(renamed, matchingInputs)).toEqual({
    profileId: 'sp-1',
    profileName: 'Renamed',
  });
});
