import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIER2_COLUMNS,
  isTier2Column,
  buildProposals,
  applyDecisions,
  acceptedRow,
  isEpisodeProposals,
  isFieldProposal,
} from './pdc-proposals';

const FIELDS = [
  { column: 'Kevs_Question' as const, proposed: 'What is your favourite?', current: null, confidence: 'high' as const },
  { column: 'TildaH' as const, proposed: 'Audrey', current: 'N/A', confidence: 'low' as const },
];

test('TIER2_COLUMNS contains exactly the seven proposable columns', () => {
  assert.deepEqual([...TIER2_COLUMNS].sort(), [
    'Film', 'Kevs_Question', 'Thats_Great_Count',
    'TildaCorey', 'TildaGuest', 'TildaH', 'TildaJason',
  ]);
});

test('isTier2Column rejects columns Tier 2 must never touch', () => {
  assert.equal(isTier2Column('Kevs_Question'), true);
  assert.equal(isTier2Column('Notable_Moments'), false);
  assert.equal(isTier2Column('H_Flex'), false);
  assert.equal(isTier2Column('Reviewer'), false);
  assert.equal(isTier2Column('Length'), false);
  assert.equal(isTier2Column('MMM_Count'), false, 'dropped: not derivable from a transcript');
});

test('buildProposals stamps every field pending', () => {
  const doc = buildProposals('317', 'Barton Fink (1991)', '2026-08-03T00:00:00.000Z', FIELDS);
  assert.equal(doc.episode, '317');
  assert.equal(doc.film, 'Barton Fink (1991)');
  assert.equal(doc.createdAt, '2026-08-03T00:00:00.000Z');
  assert.equal(doc.proposals.length, 2);
  assert.ok(doc.proposals.every(p => p.status === 'pending'));
});

test('applyDecisions updates only the named columns', () => {
  const doc = buildProposals('317', 'Barton Fink (1991)', '2026-08-03T00:00:00.000Z', FIELDS);
  const next = applyDecisions(doc, { Kevs_Question: 'accepted' });
  assert.equal(next.proposals.find(p => p.column === 'Kevs_Question')?.status, 'accepted');
  assert.equal(next.proposals.find(p => p.column === 'TildaH')?.status, 'pending');
});

test('applyDecisions does not mutate the input document', () => {
  const doc = buildProposals('317', 'Barton Fink (1991)', '2026-08-03T00:00:00.000Z', FIELDS);
  applyDecisions(doc, { Kevs_Question: 'rejected' });
  assert.equal(doc.proposals[0].status, 'pending');
});

test('applyDecisions ignores a column not present in the document', () => {
  const doc = buildProposals('317', 'Barton Fink (1991)', '2026-08-03T00:00:00.000Z', FIELDS);
  const next = applyDecisions(doc, { MMM_Count: 'accepted' });
  assert.equal(next.proposals.length, 2);
  assert.ok(next.proposals.every(p => p.status === 'pending'));
});

test('acceptedRow returns only accepted fields', () => {
  const doc = buildProposals('317', 'Barton Fink (1991)', '2026-08-03T00:00:00.000Z', FIELDS);
  const decided = applyDecisions(doc, { Kevs_Question: 'accepted', TildaH: 'rejected' });
  assert.deepEqual(acceptedRow(decided), { Kevs_Question: 'What is your favourite?' });
});

test('acceptedRow is empty when nothing was accepted', () => {
  const doc = buildProposals('317', 'Barton Fink (1991)', '2026-08-03T00:00:00.000Z', FIELDS);
  assert.deepEqual(acceptedRow(doc), {});
});

test('acceptedRow includes only the accepted field among accepted/rejected/pending', () => {
  const threeFields = [
    { column: 'Kevs_Question' as const, proposed: 'What is your favourite?', current: null, confidence: 'high' as const },
    { column: 'TildaH' as const, proposed: 'Audrey', current: 'N/A', confidence: 'low' as const },
    { column: 'Film' as const, proposed: 'Barton Fink (1991)', current: null, confidence: 'high' as const },
  ];
  const doc = buildProposals('317', 'Barton Fink (1991)', '2026-08-03T00:00:00.000Z', threeFields);
  const decided = applyDecisions(doc, { Kevs_Question: 'accepted', TildaH: 'rejected' });
  assert.deepEqual(acceptedRow(decided), { Kevs_Question: 'What is your favourite?' });
});

test('isEpisodeProposals accepts a well-formed document', () => {
  assert.equal(
    isEpisodeProposals({
      episode: '317',
      film: 'Barton Fink (1991)',
      createdAt: '2026-08-03T00:00:00.000Z',
      proposals: [{ column: 'Kevs_Question', proposed: 'Q', current: null, confidence: 'high', status: 'pending' }],
    }),
    true
  );
});

test('isEpisodeProposals accepts an empty proposals array', () => {
  assert.equal(
    isEpisodeProposals({ episode: '317', createdAt: '2026-08-03T00:00:00.000Z', proposals: [] }),
    true
  );
});

test('isEpisodeProposals rejects a null element that would crash the listing', () => {
  // The exact shape that threw past the previous guard.
  assert.equal(
    isEpisodeProposals({ episode: '317', createdAt: '2026-08-03T00:00:00.000Z', proposals: [null] }),
    false
  );
});

test('isEpisodeProposals rejects an element missing status', () => {
  assert.equal(
    isEpisodeProposals({
      episode: '317',
      createdAt: '2026-08-03T00:00:00.000Z',
      proposals: [{ column: 'Kevs_Question', proposed: 'Q' }],
    }),
    false
  );
});

test('isEpisodeProposals rejects a missing or non-array proposals field', () => {
  assert.equal(isEpisodeProposals({ episode: '317', createdAt: 'x' }), false);
  assert.equal(isEpisodeProposals({ episode: '317', createdAt: 'x', proposals: 'nope' }), false);
});

test('isEpisodeProposals rejects a missing createdAt', () => {
  assert.equal(isEpisodeProposals({ episode: '317', proposals: [] }), false);
});

test('isEpisodeProposals rejects non-objects', () => {
  assert.equal(isEpisodeProposals(null), false);
  assert.equal(isEpisodeProposals('doc'), false);
  assert.equal(isEpisodeProposals(42), false);
});

test('isFieldProposal rejects null and non-objects', () => {
  assert.equal(isFieldProposal(null), false);
  assert.equal(isFieldProposal(undefined), false);
  assert.equal(isFieldProposal('x'), false);
});

test('isFieldProposal rejects a column Tier 2 is not permitted to touch', () => {
  // Enforces the TIER2_COLUMNS invariant at the Blob trust boundary, not
  // just at compile time — a corrupt or hand-edited blob entry naming a
  // foreign column (e.g. one that reaches the sheet) must not parse as valid.
  assert.equal(
    isFieldProposal({ column: 'Reviewer', proposed: 'Someone', status: 'pending' }),
    false
  );
  assert.equal(
    isFieldProposal({ column: 'Notable_Moments', proposed: 'x', status: 'pending' }),
    false
  );
});
