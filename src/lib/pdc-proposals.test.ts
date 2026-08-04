import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIER2_COLUMNS,
  isTier2Column,
  buildProposals,
  applyDecisions,
  acceptedRow,
} from './pdc-proposals';

const FIELDS = [
  { column: 'Kevs_Question' as const, proposed: 'What is your favourite?', current: null, confidence: 'high' as const },
  { column: 'TildaH' as const, proposed: 'Audrey', current: 'N/A', confidence: 'low' as const },
];

test('TIER2_COLUMNS contains exactly the eight proposable columns', () => {
  assert.deepEqual([...TIER2_COLUMNS].sort(), [
    'Film', 'Kevs_Question', 'MMM_Count', 'Thats_Great_Count',
    'TildaCorey', 'TildaGuest', 'TildaH', 'TildaJason',
  ]);
});

test('isTier2Column rejects columns Tier 2 must never touch', () => {
  assert.equal(isTier2Column('Kevs_Question'), true);
  assert.equal(isTier2Column('Notable_Moments'), false);
  assert.equal(isTier2Column('H_Flex'), false);
  assert.equal(isTier2Column('Reviewer'), false);
  assert.equal(isTier2Column('Length'), false);
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
