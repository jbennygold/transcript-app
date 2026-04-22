import { detectQueryIntent, QueryIntentType } from '../src/lib/query-intent';
import { buildMetadataAggregateResponse, collectTildaContext, getTildaEpisodePicks } from '../src/lib/metadata-aggregates';
import { extractNotableMomentsFilm } from '../src/lib/notable-moments-query';

type RegressionCase = {
  name: string;
  query: string;
  expectIntent: QueryIntentType;
  expectAnswerIncludes?: string[];
  expectTildaContext?: boolean;
  expectTildaEpisode?: number;
  expectTildaEpisodePickIncludes?: string[];
  expectNotableMomentsFilm?: string;
};

const cases: RegressionCase[] = [
  {
    name: 'Current season',
    query: 'what season is the pod on now with their episodes',
    expectIntent: 'metadata_current_season',
    expectAnswerIncludes: ['season'],
  },
  {
    name: 'Discord join (transcript)',
    query: 'when did zolidus join the discord',
    expectIntent: 'transcript_only',
  },
  {
    name: 'Latest episode',
    query: 'what was the last episode',
    expectIntent: 'metadata_latest',
    expectAnswerIncludes: ['latest episode'],
  },
  {
    name: 'MMM count latest',
    query: "how many mmm’s in the last episode",
    expectIntent: 'metadata_field_latest',
    expectAnswerIncludes: ['MMM count'],
  },
  {
    name: 'That’s great max',
    query: 'what is the episode in which there is the greatest number of instances of Jason saying "That’s Great"',
    expectIntent: 'metadata_field_max',
    expectAnswerIncludes: ["That\'s Great"],
  },
  {
    name: 'Total episodes',
    query: 'how many episodes are there in total of this podcast',
    expectIntent: 'metadata_total_episodes',
    expectAnswerIncludes: ['episodes'],
  },
  {
    name: 'Rosie job (transcript)',
    query: 'What does Rosie do for a living?',
    expectIntent: 'transcript_only',
  },
  {
    name: 'Year range count',
    query: 'how many films has the pod reviewed from the decade 1980-1990?',
    expectIntent: 'metadata_year_range_count',
    expectAnswerIncludes: ['1980', '1990'],
  },
  {
    name: 'Year range list one per year (no aggregate)',
    query: 'list one movie from each year 1980-1990 that the pod has covered and give year with each',
    expectIntent: 'metadata_year_range_sample',
    expectAnswerIncludes: ['movies covered by year', '1980', '1990'],
  },
  {
    name: 'Tilda metadata aggregate',
    query: 'who would tilda play',
    expectIntent: 'metadata_tilda',
    expectTildaContext: true,
  },
  {
    name: 'Tilda casting analysis',
    query: 'are the hosts of Escape Hatch more likely to cast Tilda as a woman, a man, or an unanimate object',
    expectIntent: 'metadata_tilda',
    expectTildaContext: true,
  },
  {
    name: 'Tilda episode lookup',
    query: 'who did Corey say he would cast Tilda Swinton as in episode 204',
    expectIntent: 'metadata_tilda',
    expectTildaEpisode: 204,
    expectTildaEpisodePickIncludes: ['Corey', 'Charlie Sheen'],
  },
  {
    name: 'Notable moments intent',
    query: 'what are Notable Moments from the Dune Messiah episode',
    expectIntent: 'metadata_notable_moments',
    expectNotableMomentsFilm: 'Dune Messiah',
  },
  {
    name: 'Episode credits by film',
    query: 'who was the guest and reviewer for No Country for Old Men',
    expectIntent: 'metadata_episode_fields',
    expectAnswerIncludes: ['credits for', 'reviewer', 'guest', 'no country for old men'],
  },
  {
    name: 'Release date by film',
    query: 'When did the No Country for Old Men episode release?',
    expectIntent: 'metadata_episode_fields',
    expectAnswerIncludes: ['release date', '7/6/2020'],
  },
  {
    name: 'Kev question by film',
    query: "What was Kev's question for Dune (1965) Part 1?",
    expectIntent: 'metadata_episode_fields',
    expectAnswerIncludes: ['kev', 'question', 'kev recorded 2 questions'],
  },
  {
    name: 'Moments film extraction',
    query: 'what are the most interesting moments in the 2001 episode',
    expectIntent: 'none',
    expectNotableMomentsFilm: '2001',
  },
  {
    name: 'Episode lookup by number',
    query: 'what is episode 283',
    expectIntent: 'metadata_episode_lookup',
    expectAnswerIncludes: ['episode 283'],
  },
  {
    name: 'Episode lookup bare',
    query: 'episode 204',
    expectIntent: 'metadata_episode_lookup',
    expectAnswerIncludes: ['episode 204'],
  },
  {
    name: 'Episode lookup tell me about',
    query: 'tell me about episode 150',
    expectIntent: 'metadata_episode_lookup',
    expectAnswerIncludes: ['episode 150'],
  },
  {
    name: 'Aggregate rank — most featured actor',
    query: 'which actor has been featured the most in the movies reviewed on the podcast',
    expectIntent: 'metadata_aggregate_rank',
    expectAnswerIncludes: ['actors', 'films'],
  },
  {
    name: 'Aggregate rank — most common genre',
    query: 'what is the most common genre',
    expectIntent: 'metadata_aggregate_rank',
    expectAnswerIncludes: ['genres', 'episodes'],
  },
  {
    name: 'Aggregate rank — top N directors',
    query: 'top 10 directors',
    expectIntent: 'metadata_aggregate_rank',
    expectAnswerIncludes: ['directors', 'films'],
  },
  {
    name: 'Aggregate rank — cinematographers',
    query: 'which cinematographer has the most films covered',
    expectIntent: 'metadata_aggregate_rank',
    expectAnswerIncludes: ['cinematographers', 'films'],
  },
  {
    name: 'Aggregate rank — composers',
    query: 'who is the most featured composer',
    expectIntent: 'metadata_aggregate_rank',
    expectAnswerIncludes: ['composers', 'films'],
  },
  {
    name: 'Aggregate rank — does NOT hijack notable moments',
    query: 'notable moments for The Godfather',
    expectIntent: 'metadata_notable_moments',
  },
  {
    name: 'Aggregate rank — does NOT trigger on specific director',
    query: 'which David Fincher movies have been reviewed',
    expectIntent: 'metadata_director_films',
  },
];

function runCase(testCase: RegressionCase): string | null {
  const intent = detectQueryIntent(testCase.query);
  if (intent.type !== testCase.expectIntent) {
    return `Expected intent ${testCase.expectIntent} but got ${intent.type}`;
  }

  // Tilda intent is handled by LLM synthesis in routes, not buildMetadataAggregateResponse
  if (testCase.expectTildaContext) {
    const tildaCtx = collectTildaContext();
    if (!tildaCtx) {
      return 'Expected Tilda context but collectTildaContext returned null';
    }
    if (tildaCtx.totalPicks === 0) {
      return 'Expected Tilda picks but got 0';
    }
  }

  if (testCase.expectTildaEpisode !== undefined) {
    const episodeResult = getTildaEpisodePicks(testCase.expectTildaEpisode);
    if (!episodeResult) {
      return `Expected episode ${testCase.expectTildaEpisode} but it was not found`;
    }
    if (testCase.expectTildaEpisodePickIncludes) {
      const pickText = episodeResult.picks.map((pick) => `${pick.label}: ${pick.value}`).join(' ').toLowerCase();
      for (const fragment of testCase.expectTildaEpisodePickIncludes) {
        if (!pickText.includes(fragment.toLowerCase())) {
          return `Episode picks missing "${fragment}"`;
        }
      }
    }
  } else if (
    intent.type.startsWith('metadata_')
    && intent.type !== 'metadata_tilda'
    && intent.type !== 'metadata_notable_moments'
  ) {
    const aggregate = buildMetadataAggregateResponse(intent);
    if (!aggregate) {
      return 'Expected metadata aggregate response but got null';
    }
    if (testCase.expectAnswerIncludes) {
      const answerLower = aggregate.answer.toLowerCase();
      for (const fragment of testCase.expectAnswerIncludes) {
        if (!answerLower.includes(fragment.toLowerCase())) {
          return `Answer missing "${fragment}"`;
        }
      }
    }
  }

  if (testCase.expectNotableMomentsFilm) {
    const film = extractNotableMomentsFilm(testCase.query);
    if (!film || !film.toLowerCase().includes(testCase.expectNotableMomentsFilm.toLowerCase())) {
      return `Expected notable moments film "${testCase.expectNotableMomentsFilm}" but got "${film ?? 'null'}"`;
    }
  }

  return null;
}

const failures: string[] = [];

for (const testCase of cases) {
  const error = runCase(testCase);
  if (error) {
    failures.push(`${testCase.name}: ${error}`);
  } else {
    console.log(`✓ ${testCase.name}`);
  }
}

if (failures.length > 0) {
  console.error('\nRegression failures:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('\nAll regression checks passed.');
