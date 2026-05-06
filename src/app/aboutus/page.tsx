import type { Metadata } from 'next';
import Link from 'next/link';
import { episodeMetadata } from '@/lib/metadata-data';
import type { EpisodeMetadata } from '@/types/episode-metadata';

export const metadata: Metadata = {
  title: 'About · Escape Hatch Podcast',
  description:
    'Press kit and show information for Escape Hatch. Your portal into cinematic pocket universes. For prospective guests, PR teams, and media inquiries.',
};

const CONTACT_EMAIL = 'hello@escapehatchpod.com';
const DISCORD_URL = 'https://discord.gg/escapehatch';
const SOCIAL_HANDLE = '@escapehatchpod';

const SOCIALS: { label: string; href: string }[] = [
  { label: 'Twitter / X', href: 'https://twitter.com/escapehatchpod' },
  { label: 'Threads', href: 'https://www.threads.net/@escapehatchpod' },
  { label: 'Instagram', href: 'https://instagram.com/escapehatchpod' },
  { label: 'YouTube', href: 'https://youtube.com/@escapehatchpod' },
];

const ehEpisodes = episodeMetadata.filter((ep) => ep.pod === 'EH');

const totalEpisodes = ehEpisodes.length;

const uniqueGuestSet = new Set<string>();
for (const ep of ehEpisodes) {
  const g = (ep.guest ?? '').trim();
  if (g && g.toUpperCase() !== 'N/A' && !/no guest/i.test(g)) {
    uniqueGuestSet.add(g);
  }
}
const totalGuests = uniqueGuestSet.size;

const directorSet = new Set<string>();
for (const ep of ehEpisodes) {
  for (const d of ep.directors ?? []) directorSet.add(d);
}
const totalDirectors = directorSet.size;

const filmYears = ehEpisodes
  .map((ep) => ep.filmYear)
  .filter((y): y is number => typeof y === 'number' && y > 0);
const oldestFilmYear = filmYears.length ? Math.min(...filmYears) : 0;
const newestFilmYear = filmYears.length ? Math.max(...filmYears) : 0;

function parseReleaseDate(s: string): Date | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}
const releaseDates = ehEpisodes
  .map((ep) => parseReleaseDate(ep.releaseDate ?? ''))
  .filter((d): d is Date => d !== null)
  .sort((a, b) => a.getTime() - b.getTime());
const firstYear = releaseDates.length ? releaseDates[0].getFullYear() : 0;
const yearsRunning = firstYear ? new Date().getFullYear() - firstYear : 0;

function episodesByGuest(name: string): EpisodeMetadata[] {
  const needle = name.toLowerCase();
  return ehEpisodes
    .filter((ep) => (ep.guest ?? '').toLowerCase().includes(needle))
    .sort(
      (a, b) =>
        (parseReleaseDate(b.releaseDate)?.getTime() ?? 0) -
        (parseReleaseDate(a.releaseDate)?.getTime() ?? 0),
    );
}

type FeaturedGuest = {
  name: string;
  credit: string;
  blurb: string;
};

const FEATURED_GUESTS: FeaturedGuest[] = [
  {
    name: 'Ryan Condal',
    credit: 'Co-creator & showrunner, House of the Dragon',
    blurb:
      'Frequent guest known for genre and action picks: Aliens, Predator, the Terminator films, Mad Max: Fury Road.',
  },
  {
    name: 'Dave Mandel',
    credit: 'Showrunner, Veep & Curb Your Enthusiasm',
    blurb:
      'Brings the comedy-writer’s eye to action-thrillers and crime classics like The Last Boy Scout, Manhunter, and The Godfather Part II.',
  },
  {
    name: 'Rosie Knight',
    credit: 'Co-host, X-Ray Vision; critic at IGN',
    blurb:
      'Critic and podcaster who anchors deep dives on horror, sci-fi, and the romantic-cinematic margins (Twilight, Constantine, Panic Room).',
  },
  {
    name: 'Ben Rhodes',
    credit: 'Former Deputy National Security Advisor; co-host, Pod Save the World',
    blurb:
      'The show’s spy-thriller specialist: Hunt for Red October, Tinker Tailor Soldier Spy, Three Days of the Condor, Argo, Casablanca.',
  },
];

const NOTABLE_EPISODE_NUMBERS = [293, 299, 226, 189, 159, 267];
const notableEpisodes = NOTABLE_EPISODE_NUMBERS.map((num) =>
  ehEpisodes.find((ep) => Number(ep.episode) === num),
).filter((ep): ep is EpisodeMetadata => ep !== undefined);

const HOSTS = [
  {
    name: 'Jason',
    role: 'Co-host',
    initials: 'J',
    bio: 'Former executive at Blogger, Google, and Twitter, and Chief Digital Officer of the Obama White House. Brings a tech-and-policy lens to the rewatch, with a particular soft spot for spycraft, founder myth-making, and the political subtext of a Fincher third act.',
  },
  {
    name: 'Haitch',
    role: 'Co-host',
    initials: 'H',
    bio: 'The show’s in-house cinephile and resident historian. Catalogs the canon (and the apocrypha), runs the Letters segment, and reliably finds the structural beat or production-design detail nobody else clocked. Opens every episode with the words you already know by heart.',
  },
];

const PRESS_ASSETS: { label: string; href: string; sub: string }[] = [
  {
    label: 'Show cover (square)',
    href: '/aboutus/cover.jpg',
    sub: 'Official artwork · 1500 × 1500 JPG',
  },
  {
    label: 'Wordmark · gold',
    href: '/aboutus/wordmark-gold.png',
    sub: 'Transparent PNG · for dark backgrounds',
  },
  {
    label: 'Wordmark · white',
    href: '/aboutus/wordmark-white-transparent.png',
    sub: 'Transparent PNG · for dark backgrounds',
  },
  {
    label: 'Wordmark · black',
    href: '/aboutus/wordmark-black.png',
    sub: 'Transparent PNG · for light backgrounds',
  },
  {
    label: 'Wordmark · grey',
    href: '/aboutus/wordmark-grey.png',
    sub: 'Transparent PNG · neutral lockup',
  },
  {
    label: 'Banner (flat orange)',
    href: '/aboutus/banner-flat.jpg',
    sub: 'Twitter / X header · 1500 × 500 JPG',
  },
];

export default function AboutPage() {
  return (
    <main className="min-h-screen bg-eh-cream text-brand-dark">
      {/* Dark hero, full-bleed */}
      <div className="bg-brand-dark text-eh-cream">
        <div className="mx-auto max-w-5xl px-6 pt-8 pb-16 md:pt-10 md:pb-24">
          <nav className="mb-12 flex items-center justify-between text-sm">
            <Link
              href="/"
              className="text-eh-cream/70 hover:text-eh-gold transition-colors"
            >
              ← Escape Hatch Search
            </Link>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-eh-cream/70 hover:text-eh-gold transition-colors"
            >
              {CONTACT_EMAIL}
            </a>
          </nav>

          <Hero />
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-6 py-12 md:py-16">
        <Stats />

        <Section title="What is Escape Hatch?">
          <p className="text-lg leading-relaxed">
            <strong className="font-semibold text-brand-dark">Escape Hatch</strong> is a
            weekly film podcast hosted by{' '}
            <strong className="font-semibold text-brand-dark">Jason</strong> and{' '}
            <strong className="font-semibold text-brand-dark">Haitch</strong>, built around
            the rewatch. Each week, Jason and Haitch sit down with a rotating guest to
            revisit a single film: sometimes a marquee classic, sometimes a cult oddity,
            often something the culture has misjudged. They pick it apart with cinephile
            rigor and curiosity about how and why things work.
          </p>
          <p className="mt-4 text-lg leading-relaxed">
            What started as a pod focused on Dune has grown into a {yearsRunning}-year-running,{' '}
            {totalEpisodes}-episode catalog spanning{' '}
            {oldestFilmYear || 'pre-war classics'} to today, with films from{' '}
            {totalDirectors}+ directors and {totalGuests}+ guests from film, television,
            comics, journalism, politics, and tech. The conversations are long and full of
            running gags: Kev&rsquo;s Question, the Tildas, Haitch&rsquo;s notes on craft,
            Jason&rsquo;s tangents into systems and power. Every episode is a portal into
            a single cinematic pocket universe.
          </p>
        </Section>

        <Section title="Who Listens?">
          <p className="text-lg leading-relaxed">
            Escape Hatch&rsquo;s audience is a particular kind of culture lover: film
            nerds who care about craft and history, tech-industry veterans who came for
            the hosts and stayed for the criticism, journalists, screenwriters, and
            founders. They&rsquo;re the kind of listeners who&rsquo;ll text you a
            700-word reaction to a single line of dialogue.
          </p>
          <div className="mt-6 rounded-xl border border-brand-dark/10 bg-white p-6 shadow-sm">
            <p className="text-xs uppercase tracking-[0.2em] text-eh-orange">
              Community
            </p>
            <p className="mt-2 text-lg leading-relaxed">
              The most engaged listeners gather in the{' '}
              <a
                href={DISCORD_URL}
                className="font-semibold text-eh-orange underline decoration-eh-orange/40 underline-offset-4 hover:decoration-eh-orange"
                target="_blank"
                rel="noopener noreferrer"
              >
                Escape Hatch Discord
              </a>
              , a vibrant community. Weekly episode threads run alongside the show, and
              many recurring bits and Letters started there.
            </p>
          </div>
        </Section>

        <Section title="The Hosts">
          <div className="grid gap-6 md:grid-cols-2">
            {HOSTS.map((h) => (
              <article
                key={h.name}
                className="rounded-xl border border-brand-dark/10 bg-white p-6 shadow-sm"
              >
                <div className="flex items-start gap-4">
                  <div
                    aria-hidden
                    className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-brand-dark font-eh text-3xl text-eh-gold"
                    title="Headshot placeholder"
                  >
                    {h.initials}
                  </div>
                  <div>
                    <h3 className="font-eh text-2xl text-brand-dark">{h.name}</h3>
                    <p className="text-sm uppercase tracking-wider text-brand-dark/50">
                      {h.role}
                    </p>
                  </div>
                </div>
                <p className="mt-4 text-base leading-relaxed">{h.bio}</p>
              </article>
            ))}
          </div>
          <p className="mt-4 text-xs text-brand-dark/60">
            High-resolution host photography available on request. Email{' '}
            <a
              href={`mailto:${CONTACT_EMAIL}?subject=Press%20Kit%20Assets`}
              className="underline"
            >
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </Section>

        <Section title="Notable Recurring Guests">
          <div className="grid gap-6 md:grid-cols-2">
            {FEATURED_GUESTS.map((g) => {
              const eps = episodesByGuest(g.name);
              const marqueeFilms = eps.slice(0, 3).map((ep) => ep.film);
              return (
                <article
                  key={g.name}
                  className="rounded-xl border border-brand-dark/10 bg-white p-6 shadow-sm"
                >
                  <h3 className="font-eh text-2xl text-brand-dark">{g.name}</h3>
                  <p className="mt-1 text-sm uppercase tracking-wider text-eh-orange">
                    {g.credit}
                  </p>
                  <p className="mt-3 text-base leading-relaxed">{g.blurb}</p>
                  <p className="mt-4 text-sm text-brand-dark/80">
                    <span className="font-semibold text-brand-dark">{eps.length}</span>{' '}
                    {eps.length === 1 ? 'appearance' : 'appearances'}
                    {marqueeFilms.length > 0 && (
                      <>
                        , including{' '}
                        <span className="italic">{marqueeFilms.join(', ')}</span>
                      </>
                    )}
                    .
                  </p>
                </article>
              );
            })}
          </div>
        </Section>

        <Section title="Notable Episodes">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {notableEpisodes.map((ep) => (
              <a
                key={String(ep.episode)}
                href={ep.showLink || '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="group block rounded-xl border border-brand-dark/10 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-eh-orange hover:shadow-md"
              >
                <p className="text-xs uppercase tracking-[0.2em] text-eh-orange">
                  Episode {String(ep.episode)} · {ep.releaseDate}
                </p>
                <h3 className="mt-2 font-eh text-xl leading-tight text-brand-dark">
                  {ep.film}
                </h3>
                {ep.guest && (
                  <p className="mt-2 text-sm text-brand-dark">
                    with <span className="font-medium">{ep.guest}</span>
                  </p>
                )}
                {ep.directors && ep.directors.length > 0 && (
                  <p className="mt-2 text-xs text-brand-dark/60">
                    dir. {ep.directors.join(', ')}
                  </p>
                )}
              </a>
            ))}
          </div>
          <p className="mt-4 text-sm text-brand-dark/60">
            The full back catalog of {totalEpisodes} episodes is searchable at{' '}
            <Link href="/" className="underline hover:text-eh-orange">
              search.escapehatchpod.com
            </Link>
            .
          </p>
        </Section>

        <Section title="Get in touch">
          <div className="rounded-xl border border-brand-dark/10 bg-white p-6 shadow-sm md:p-8">
            <p className="text-lg leading-relaxed text-brand-dark">
              Guest pitches, host bookings, media inquiries, listener letters.
              Whatever it is, send it to us at{' '}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="font-semibold text-eh-orange underline decoration-eh-orange/40 underline-offset-4 hover:decoration-eh-orange"
              >
                {CONTACT_EMAIL}
              </a>
              .
            </p>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="mt-5 inline-flex items-center rounded-full bg-brand-dark px-6 py-2.5 text-sm font-semibold text-eh-gold transition-colors hover:bg-brand-dark/90"
            >
              Email {CONTACT_EMAIL}
            </a>
          </div>

          <PressKit />

          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <span className="text-brand-dark/60">Follow {SOCIAL_HANDLE}:</span>
            {SOCIALS.map((s) => (
              <a
                key={s.label}
                href={s.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-dark underline decoration-brand-dark/30 underline-offset-4 hover:text-eh-orange hover:decoration-eh-orange"
              >
                {s.label}
              </a>
            ))}
          </div>
        </Section>

        <footer className="mt-16 border-t border-brand-dark/15 pt-6 text-sm text-brand-dark/60">
          <p>
            Escape Hatch Podcast · {SOCIAL_HANDLE} ·{' '}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline hover:text-eh-orange">
              {CONTACT_EMAIL}
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}

function Hero() {
  return (
    <header className="grid items-center gap-10 md:grid-cols-[1.1fr_1fr]">
      <div>
        <p className="mb-5 text-xs uppercase tracking-[0.3em] text-eh-gold">
          Press kit · About
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/aboutus/wordmark-gold.png"
          alt="Escape Hatch"
          className="h-auto w-full max-w-md"
        />
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-eh-cream/90 md:text-xl">
          Your portal into cinematic pocket universes.
        </p>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-eh-cream/70">
          A long running GenX dad movie podcast.
        </p>
        <div className="mt-7">
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="inline-flex items-center rounded-full bg-eh-gold px-6 py-2.5 text-sm font-semibold text-brand-dark transition-colors hover:bg-eh-gold-bright"
          >
            Contact us · {CONTACT_EMAIL}
          </a>
        </div>
      </div>
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/aboutus/cover.jpg"
          alt="Escape Hatch Podcast cover art: a porthole opening into a cosmic landscape"
          className="aspect-square w-full rounded-2xl shadow-2xl shadow-black/40"
        />
      </div>
    </header>
  );
}

function Stats() {
  const items: { label: string; value: string }[] = [
    { label: 'Episodes', value: `${totalEpisodes}+` },
    { label: 'Years running', value: `${yearsRunning}` },
    { label: 'Unique guests', value: `${totalGuests}+` },
    { label: 'Directors covered', value: `${totalDirectors}+` },
    {
      label: 'Films span',
      value:
        oldestFilmYear && newestFilmYear ? `${oldestFilmYear}–${newestFilmYear}` : 'n/a',
    },
  ];
  return (
    <section className="mb-16 grid grid-cols-2 gap-4 rounded-2xl border border-brand-dark/10 bg-white p-6 shadow-sm md:grid-cols-5">
      {items.map((s) => (
        <div key={s.label} className="text-center">
          <p className="font-eh text-3xl text-eh-orange md:text-4xl">{s.value}</p>
          <p className="mt-1 text-xs uppercase tracking-wider text-brand-dark/60">
            {s.label}
          </p>
        </div>
      ))}
    </section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-14">
      <h2 className="mb-5 font-eh text-3xl text-brand-dark md:text-4xl">{title}</h2>
      {children}
    </section>
  );
}

function PressKit() {
  return (
    <div className="mt-8 rounded-xl border border-brand-dark/10 bg-white p-6 shadow-sm">
      <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-eh-orange">
        Press kit · downloads
      </h3>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {PRESS_ASSETS.map((a) => (
          <li key={a.href}>
            <a
              href={a.href}
              target="_blank"
              rel="noreferrer"
              download
              className="group block rounded-lg border border-brand-dark/10 bg-eh-cream/40 px-4 py-3 transition-colors hover:border-eh-orange hover:bg-eh-cream"
            >
              <p className="text-sm font-semibold text-brand-dark group-hover:text-eh-orange">
                {a.label} ↓
              </p>
              <p className="mt-0.5 text-xs text-brand-dark/60">{a.sub}</p>
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-brand-dark/60">
        Host headshots and one-sheet PDF: email{' '}
        <a
          href={`mailto:${CONTACT_EMAIL}?subject=Press%20Kit%20Assets`}
          className="underline hover:text-eh-orange"
        >
          {CONTACT_EMAIL}
        </a>
        .
      </p>
    </div>
  );
}
