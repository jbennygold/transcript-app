import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProposalFields } from './generate-proposals';

const CURRENT = {
  film: 'Barton Fink (1991)',
  kevsQuestion: 'N/A',
  tildaH: 'N/A',
  tildaJason: 'N/A',
  tildaGuest: null,
  tildaCorey: null,
  thatsGreatCount: 0,
};

const EMPTY_TILDA = { tildaH: null, tildaJason: null, tildaGuest: null, tildaCorey: null };

test('a Kev question becomes a high-confidence proposal carrying its evidence', () => {
  const f = buildProposalFields({
    current: CURRENT,
    kev: { question: 'What is your favourite?', evidence: 'Kev at 12:45' },
    tilda: EMPTY_TILDA,
    thatsGreat: null,
    canonicalFilm: null,
  });
  const kev = f.find(p => p.column === 'Kevs_Question');
  assert.equal(kev?.proposed, 'What is your favourite?');
  assert.equal(kev?.confidence, 'high');
  assert.equal(kev?.evidence, 'Kev at 12:45');
  assert.equal(kev?.current, null, 'sheet "N/A" is surfaced as null, not the literal string');
});

test('a null extraction produces no proposal for that column', () => {
  const f = buildProposalFields({
    current: CURRENT,
    kev: { question: null, evidence: null },
    tilda: EMPTY_TILDA,
    thatsGreat: null,
    canonicalFilm: null,
  });
  assert.equal(f.length, 0);
});

test('Tilda guest and Corey are low confidence; hosts are high', () => {
  const f = buildProposalFields({
    current: CURRENT,
    kev: { question: null, evidence: null },
    tilda: { tildaH: 'Audrey', tildaJason: 'Barton', tildaGuest: 'Charlie', tildaCorey: null },
    thatsGreat: null,
    canonicalFilm: null,
  });
  assert.equal(f.find(p => p.column === 'TildaH')?.confidence, 'high');
  assert.equal(f.find(p => p.column === 'TildaJason')?.confidence, 'high');
  assert.equal(f.find(p => p.column === 'TildaGuest')?.confidence, 'low');
  assert.equal(f.find(p => p.column === 'TildaCorey'), undefined);
});

test('MMM_Count is never proposed — it is not derivable from a transcript', () => {
  const f = buildProposalFields({
    current: CURRENT,
    kev: { question: 'Q', evidence: null },
    tilda: { tildaH: 'A', tildaJason: 'B', tildaGuest: 'C', tildaCorey: 'D' },
    thatsGreat: 9,
    canonicalFilm: 'Different (2000)',
  });
  assert.equal(f.find(p => p.column === 'MMM_Count'), undefined);
});

test("That's Great proposes as low confidence", () => {
  const f = buildProposalFields({
    current: CURRENT,
    kev: { question: null, evidence: null },
    tilda: EMPTY_TILDA,
    thatsGreat: 3,
    canonicalFilm: null,
  });
  assert.equal(f.find(p => p.column === 'Thats_Great_Count')?.proposed, '3');
  assert.equal(f.find(p => p.column === 'Thats_Great_Count')?.confidence, 'low');
});

test('a canonical film title matching the sheet produces no proposal', () => {
  const f = buildProposalFields({
    current: CURRENT,
    kev: { question: null, evidence: null },
    tilda: EMPTY_TILDA,
    thatsGreat: null,
    canonicalFilm: 'Barton Fink (1991)',
  });
  assert.equal(f.find(p => p.column === 'Film'), undefined);
});

test('a differing canonical film title proposes the correction with the current value', () => {
  const f = buildProposalFields({
    current: { ...CURRENT, film: 'Barton Fink' },
    kev: { question: null, evidence: null },
    tilda: EMPTY_TILDA,
    thatsGreat: null,
    canonicalFilm: 'Barton Fink (1991)',
  });
  const film = f.find(p => p.column === 'Film');
  assert.equal(film?.proposed, 'Barton Fink (1991)');
  assert.equal(film?.current, 'Barton Fink');
});

test('an extraction identical to the existing sheet value produces no proposal', () => {
  const f = buildProposalFields({
    current: { ...CURRENT, kevsQuestion: 'What is your favourite?' },
    kev: { question: 'What is your favourite?', evidence: null },
    tilda: EMPTY_TILDA,
    thatsGreat: null,
    canonicalFilm: null,
  });
  assert.equal(f.find(p => p.column === 'Kevs_Question'), undefined);
});

test('every proposed column is one Tier 2 is permitted to touch', () => {
  const f = buildProposalFields({
    current: CURRENT,
    kev: { question: 'Q', evidence: null },
    tilda: { tildaH: 'A', tildaJason: 'B', tildaGuest: 'C', tildaCorey: 'D' },
    thatsGreat: 2,
    canonicalFilm: 'Different (2000)',
  });
  const allowed = ['Film', 'Thats_Great_Count', 'Kevs_Question', 'TildaH', 'TildaJason', 'TildaGuest', 'TildaCorey'];
  for (const p of f) assert.ok(allowed.includes(p.column), `${p.column} is not a Tier 2 column`);
});
