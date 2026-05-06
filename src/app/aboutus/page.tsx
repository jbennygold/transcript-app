import type { Metadata } from 'next';
import Link from 'next/link';
import { episodeMetadata } from '@/lib/metadata-data';
import type { EpisodeMetadata } from '@/types/episode-metadata';

export const metadata: Metadata = {
  title: 'About — Escape Hatch Podcast',
  description:
    'Press kit and show information for Escape Hatch — your portal into cinematic pocket universes. For prospective guests, PR teams, and media inquiries.',
};

const CONTACT_EMAIL = 'letters@escapehatchpod.com';
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
      'Frequent guest known for genre and action picks — Aliens, Predator, the Terminator films, Mad Max: Fury Road.',
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
      'A pop-culture polymath — anchors recurring deep dives on horror, sci-fi, and the romantic-cinematic margins (Twilight, Constantine, Panic Room).',
  },
  {
    name: 'Ben Rhodes',
    credit: 'Former Deputy National Security Advisor; co-host, Pod Save the World',
    blurb:
      'The show’s spy-thriller specialist — Hunt for Red October, Tinker Tailor Soldier Spy, Three Days of the Condor, Argo, Casablanca.',
  },
];

const NOTABLE_EPISODE_NUMBERS = [293, 299, 226, 189, 159, 267];
const notableEpisodes = NOTABLE_EPISODE_NUMBERS.map((num) =>
  ehEpisodes.find((ep) => Number(ep.episode) === num),
).filter((ep): ep is EpisodeMetadata => ep !== undefined);

const HOSTS = [
  {
    name: 'Jason Goldman',
    role: 'Co-host',
    initials: 'JG',
    bio: 'Former executive at Blogger, Google, and Twitter, and Chief Digital Officer of the Obama White House. Brings a tech-and-policy lens to the rewatch — equally at ease talking spycraft, founder myth-making, and the political subtext of a Fincher third act.',
  },
  {
    name: 'Matt "H" Haitch',
    role: 'Co-host',
    initials: 'H',
    bio: 'The show’s in-house cinephile and resident historian. Catalogs the canon (and the apocrypha), runs the Letters segment, and reliably finds the structural beat or production-design detail nobody else clocked. Opens every episode with the words you already know by heart.',
  },
];

export default function AboutPage() {
  return (
    <main className="min-h-screen bg-brand-plum-lighter text-brand-dark">
      <div className="mx-auto max-w-5xl px-6 py-12 md:py-20">
        <nav className="mb-10 flex items-center justify-between text-sm">
          <Link
            href="/"
            className="text-brand-plum-muted hover:text-brand-plum transition-colors"
          >
            ← Escape Hatch Search
          </Link>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-brand-plum-muted hover:text-brand-plum transition-colors"
          >
            {CONTACT_EMAIL}
          </a>
        </nav>

        <Hero />

        <Stats />

        <Section title="What is Escape Hatch?">
          <p className="text-lg leading-relaxed">
            <strong className="font-semibold text-brand-plum">Escape Hatch</strong> is a
            weekly film podcast hosted by{' '}
            <strong className="font-semibold text-brand-plum">Jason Goldman</strong> and{' '}
            <strong className="font-semibold text-brand-plum">Matt &ldquo;H&rdquo; Haitch</strong>,
            built around the rewatch. Each week, Jason and H sit down with a rotating
            guest to revisit a single film — sometimes a marquee classic, sometimes
            a cult oddity, often something the culture has misjudged — and pick it
            apart with equal parts cinephile rigor and Silicon Valley curiosity.
          </p>
          <p className="mt-4 text-lg leading-relaxed">
            What started as a Dune-only pod has grown into a {yearsRunning}-year-running,{' '}
            {totalEpisodes}-episode catalog spanning{' '}
            {oldestFilmYear || 'pre-war classics'} to today, with films from{' '}
            {totalDirectors}+ directors and {totalGuests}+ guests from film, television,
            comics, journalism, politics, and tech. The conversations are long, generous,
            and full of running gags — Kev&rsquo;s Question, the Tildas, H&rsquo;s notes on
            craft, Jason&rsquo;s tangents into systems and power. Every episode is a
            portal into a single cinematic pocket universe.
          </p>
        </Section>

        <Section title="Who Listens?">
          <p className="text-lg leading-relaxed">
            Escape Hatch&rsquo;s audience is a particular kind of cinephile — film nerds
            who care about craft and history, tech-industry veterans who came for the
            hosts and stayed for the criticism, journalists, screenwriters, founders,
            and a pleasingly large contingent of the AI-curious. They&rsquo;re the
            kind of listeners who&rsquo;ll text you a 700-word reaction to a single
            line of dialogue.
          </p>
          <div className="mt-6 rounded-xl border border-brand-plum-muted/30 bg-white p-6">
            <p className="text-sm uppercase tracking-wider text-brand-plum-muted">
              Community
            </p>
            <p className="mt-2 text-lg">
              The most engaged listeners gather in the{' '}
              <a
                href={DISCORD_URL}
                className="text-brand-plum underline decoration-brand-plum-muted/50 underline-offset-4 hover:decoration-brand-plum"
                target="_blank"
                rel="noopener noreferrer"
              >
                Escape Hatch Discord
              </a>{' '}
              — a vibrant, decade-deep community where weekly episode threads run
              parallel to the show, and where many recurring bits and Letters
              originate.
            </p>
          </div>
        </Section>

        <Section title="The Hosts">
          <div className="grid gap-6 md:grid-cols-2">
            {HOSTS.map((h) => (
              <article
                key={h.name}
                className="rounded-xl border border-brand-plum-muted/30 bg-white p-6"
              >
                <div className="flex items-start gap-4">
                  <div
                    aria-hidden
                    className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-brand-plum text-2xl font-semibold text-brand-plum-lighter"
                    title="Headshot placeholder"
                  >
                    {h.initials}
                  </div>
                  <div>
                    <h3 className="text-xl font-semibold text-brand-plum">{h.name}</h3>
                    <p className="text-sm text-brand-plum-muted">{h.role}</p>
                  </div>
                </div>
                <p className="mt-4 text-base leading-relaxed">{h.bio}</p>
              </article>
            ))}
          </div>
          <p className="mt-4 text-xs text-brand-plum-muted">
            High-resolution host photography available on request — email{' '}
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
                  className="rounded-xl border border-brand-plum-muted/30 bg-white p-6"
                >
                  <h3 className="text-xl font-semibold text-brand-plum">{g.name}</h3>
                  <p className="mt-1 text-sm text-brand-plum-muted">{g.credit}</p>
                  <p className="mt-3 text-base leading-relaxed">{g.blurb}</p>
                  <p className="mt-4 text-sm">
                    <span className="font-semibold">{eps.length}</span>{' '}
                    {eps.length === 1 ? 'appearance' : 'appearances'}
                    {marqueeFilms.length > 0 && (
                      <>
                        {' '}— including{' '}
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
                className="group block rounded-xl border border-brand-plum-muted/30 bg-white p-5 transition-colors hover:border-brand-plum"
              >
                <p className="text-xs uppercase tracking-wider text-brand-plum-muted">
                  Episode {String(ep.episode)} · {ep.releaseDate}
                </p>
                <h3 className="mt-2 text-lg font-semibold text-brand-plum group-hover:underline">
                  {ep.film}
                </h3>
                {ep.guest && (
                  <p className="mt-1 text-sm text-brand-dark">
                    with <span className="font-medium">{ep.guest}</span>
                  </p>
                )}
                {ep.directors && ep.directors.length > 0 && (
                  <p className="mt-2 text-xs text-brand-plum-muted">
                    dir. {ep.directors.join(', ')}
                  </p>
                )}
              </a>
            ))}
          </div>
          <p className="mt-4 text-sm text-brand-plum-muted">
            The full back catalog of {totalEpisodes} episodes is searchable at{' '}
            <Link href="/" className="underline">
              search.escapehatchpod.com
            </Link>
            .
          </p>
        </Section>

        <Section title="Press & Booking">
          <div className="grid gap-4 md:grid-cols-3">
            <ContactCard
              label="Pitch a guest"
              subject="Guest pitch"
              description="Publicists, agents, and authors with a film tie-in: send a one-paragraph pitch and we’ll get back to you."
            />
            <ContactCard
              label="Book the hosts"
              subject="Host booking"
              description="Jason and H are available for podcast guest spots, panel moderation, and live appearances."
            />
            <ContactCard
              label="Media inquiries"
              subject="Media inquiry"
              description="Press, interviews, and editorial requests. Press kit and high-res assets available on request."
            />
          </div>

          <div className="mt-8 rounded-xl border border-brand-plum-muted/30 bg-white p-6">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-brand-plum">
              Press kit
            </h3>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                <span className="font-medium">Show logo:</span>{' '}
                <a href="/logo.jpg" className="underline" target="_blank" rel="noreferrer">
                  /logo.jpg
                </a>
              </li>
              <li className="text-brand-plum-muted">
                Host headshots, one-sheet PDF, and additional artwork: email{' '}
                <a
                  href={`mailto:${CONTACT_EMAIL}?subject=Press%20Kit%20Assets`}
                  className="underline"
                >
                  {CONTACT_EMAIL}
                </a>
                .
              </li>
            </ul>
          </div>

          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <span className="text-brand-plum-muted">Follow {SOCIAL_HANDLE}:</span>
            {SOCIALS.map((s) => (
              <a
                key={s.label}
                href={s.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-plum underline decoration-brand-plum-muted/50 underline-offset-4 hover:decoration-brand-plum"
              >
                {s.label}
              </a>
            ))}
          </div>
        </Section>

        <footer className="mt-16 border-t border-brand-plum-muted/30 pt-6 text-sm text-brand-plum-muted">
          <p>
            Escape Hatch Podcast · {SOCIAL_HANDLE} ·{' '}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
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
    <header className="mb-16 flex flex-col items-start gap-6 md:flex-row md:items-center">
      <img
        src="/logo.jpg"
        alt="Escape Hatch Podcast logo"
        className="h-28 w-28 rounded-2xl shadow-md md:h-32 md:w-32"
      />
      <div>
        <p className="text-sm uppercase tracking-[0.2em] text-brand-plum-muted">
          Press kit · About
        </p>
        <h1 className="mt-2 text-4xl font-bold text-brand-plum md:text-5xl">
          Escape Hatch
        </h1>
        <p className="mt-3 max-w-2xl text-lg text-brand-dark md:text-xl">
          Your portal into cinematic pocket universes — a long-running rewatch
          podcast hosted by Jason Goldman and Matt &ldquo;H&rdquo; Haitch.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <a
            href={`mailto:${CONTACT_EMAIL}?subject=Guest%20pitch`}
            className="inline-flex items-center rounded-full bg-brand-plum px-5 py-2 text-sm font-medium text-brand-plum-lighter transition-colors hover:bg-brand-plum-light"
          >
            Pitch a guest
          </a>
          <a
            href={`mailto:${CONTACT_EMAIL}?subject=Media%20inquiry`}
            className="inline-flex items-center rounded-full border border-brand-plum px-5 py-2 text-sm font-medium text-brand-plum transition-colors hover:bg-white"
          >
            Media inquiries
          </a>
        </div>
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
      value: oldestFilmYear && newestFilmYear ? `${oldestFilmYear}–${newestFilmYear}` : '—',
    },
  ];
  return (
    <section className="mb-16 grid grid-cols-2 gap-4 rounded-2xl border border-brand-plum-muted/30 bg-white p-6 md:grid-cols-5">
      {items.map((s) => (
        <div key={s.label} className="text-center">
          <p className="text-3xl font-bold text-brand-plum md:text-4xl">{s.value}</p>
          <p className="mt-1 text-xs uppercase tracking-wider text-brand-plum-muted">
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
      <h2 className="mb-5 text-2xl font-bold text-brand-plum md:text-3xl">{title}</h2>
      {children}
    </section>
  );
}

function ContactCard({
  label,
  subject,
  description,
}: {
  label: string;
  subject: string;
  description: string;
}) {
  const href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
  return (
    <a
      href={href}
      className="group block rounded-xl border border-brand-plum-muted/30 bg-white p-5 transition-colors hover:border-brand-plum"
    >
      <h3 className="text-base font-semibold text-brand-plum group-hover:underline">
        {label} →
      </h3>
      <p className="mt-2 text-sm text-brand-dark">{description}</p>
    </a>
  );
}
