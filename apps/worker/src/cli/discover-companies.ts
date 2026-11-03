// Finds companies whose public Greenhouse / Lever / Ashby boards exist and currently list roles
// that pass your profile's title filters, and optionally adds them to data/target_companies.yaml.
//   npm run discover                      report only
//   npm run discover '--' --add           also append the hits to target_companies.yaml
//   npm run discover '--' --names="Acme,Foo Bar"   probe your own list instead of the built-in one
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { DATA_DIR, loadProfile, loadTargetCompanies, logger, type AtsType } from '@ja/shared';
import { createHttpClient, HttpError } from '../http.js';
import { containsKeyword } from '../pipeline/filter.js';
import { titleSeniority } from '../pipeline/normalize.js';

/** Indian product companies and startups known to hire developers; slugs are guessed from names. */
const CANDIDATES = [
  'Zepto',
  'Swiggy',
  'Zomato',
  'PhonePe',
  'Paytm',
  'Meesho',
  'CRED',
  'Razorpay',
  'Groww',
  'BrowserStack',
  'Freshworks',
  'Chargebee',
  'Hasura',
  'ShareChat',
  'Dream11',
  'Unacademy',
  'upGrad',
  'Physics Wallah',
  'Vedantu',
  'Khatabook',
  'Jar',
  'Slice',
  'FamPay',
  'Jupiter',
  'Fi Money',
  'Niyo',
  'smallcase',
  'Zerodha',
  'Upstox',
  'CoinDCX',
  'CoinSwitch',
  'Juspay',
  'Setu',
  'M2P Fintech',
  'Perfios',
  'Darwinbox',
  'LeadSquared',
  'Mindtickle',
  'Whatfix',
  'Innovaccer',
  'Druva',
  'Icertis',
  'Uniphore',
  'Yellow.ai',
  'Haptik',
  'Gupshup',
  'Exotel',
  'ixigo',
  'Cleartrip',
  'OYO',
  'Rapido',
  'Dunzo',
  'Licious',
  'Nykaa',
  'Lenskart',
  'Urban Company',
  'Cars24',
  'Spinny',
  'CarDekho',
  'Acko',
  'Digit Insurance',
  'Ditto Insurance',
  'Pristyn Care',
  'Practo',
  'HealthifyMe',
  'Cult.fit',
  'Zeta',
  'Atlan',
  'Rocketlane',
  'Sprinto',
  'Scaler',
  'Masai School',
  'Coding Ninjas',
  'Testbook',
  'Classplus',
  'Teachmint',
  'Leap',
  'Simplilearn',
  'GreyOrange',
  'Delhivery',
  'Shiprocket',
  'Rebel Foods',
  'Pine Labs',
  'MobiKwik',
  'BharatPe',
  'Ola',
  'Navi',
  'Spotdraft',
  'Plum',
  'Chaayos',
  'Bizongo',
  'OfBusiness',
  'Infra.Market',
  'Udaan',
  'Moglix',
  'Zetwerk',
  'Postman',
  'Sarvam AI',
  'Krutrim',
  'Gameskraft',
  'MPL',
  'WinZO',
  'Zupee',
  'Kuku FM',
  'Pocket FM',
  'Eloelo',
  'Apna',
  'WorkIndia',
  'Instahyre',
  'Cutshort',
  'Turing',
  'Toplyne',
  'Signzy',
  'Hyperverge',
  'IDfy',
  'Credgenics',
  'Kissflow',
  'Zoho',
  'Wingify',
  'Hevo Data',
  'Nanonets',
  'Observe.AI',
  'Ema',
  'Glean',
  'Rippling',
  'Deel',
  'Remote',
];

const ATS: AtsType[] = ['greenhouse', 'lever', 'ashby'];

function slugVariants(name: string): string[] {
  const base = name.toLowerCase().replace(/&/g, 'and');
  const compact = base.replace(/[^a-z0-9]/g, '');
  const dashed = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [
    ...new Set([compact, dashed, `${compact}india`, `${compact}technologies`, `${compact}hq`]),
  ];
}

const boardUrl = (ats: AtsType, slug: string) =>
  ats === 'greenhouse'
    ? `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`
    : ats === 'lever'
      ? `https://api.lever.co/v0/postings/${slug}?mode=json`
      : `https://api.ashbyhq.com/posting-api/job-board/${slug}`;

function titlesOf(ats: AtsType, body: unknown): string[] {
  if (ats === 'lever') return (body as Array<{ text: string }>).map((p) => p.text);
  return ((body as { jobs?: Array<{ title: string }> }).jobs ?? []).map((j) => j.title);
}

const { values } = parseArgs({
  options: { add: { type: 'boolean', default: false }, names: { type: 'string' } },
});

const prefs = loadProfile().data.preferences;
const relevant = (title: string) =>
  prefs.titleKeywords.some((k) => containsKeyword(title, k)) &&
  !prefs.excludeKeywords.some((k) => containsKeyword(title, k)) &&
  titleSeniority(title) !== 'senior';

let existing: Array<{ name: string; ats: AtsType; slug: string }> = [];
try {
  existing = loadTargetCompanies().data.companies;
} catch {
  /* no file yet */
}
const known = new Set(existing.map((c) => `${c.ats}:${c.slug}`));

const names = values.names
  ? values.names
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : CANDIDATES;
const http = createHttpClient({ retries: 1, minIntervalMs: 250, timeoutMs: 15_000 });
const hits: Array<{ name: string; ats: AtsType; slug: string; open: number; relevant: string[] }> =
  [];

console.log(`Probing ${names.length} companies on ${ATS.join(', ')}…`);
await Promise.all(
  ATS.map(async (ats) => {
    for (const name of names) {
      for (const slug of slugVariants(name)) {
        try {
          const body = await http.getJson(boardUrl(ats, slug));
          const titles = titlesOf(ats, body);
          if (!titles.length) continue;
          hits.push({ name, ats, slug, open: titles.length, relevant: titles.filter(relevant) });
          break; // first matching slug per company/ATS is enough
        } catch (err) {
          if (!(err instanceof HttpError && err.status === 404))
            logger.debug({ ats, slug, err: (err as Error).message }, 'probe failed');
        }
      }
    }
  }),
);

hits.sort((a, b) => b.relevant.length - a.relevant.length || a.name.localeCompare(b.name));
console.log(`\nFound ${hits.length} boards:`);
console.table(
  hits.map((h) => ({
    company: h.name,
    ats: h.ats,
    slug: h.slug,
    open: h.open,
    'your roles now': h.relevant.length,
    example: h.relevant[0]?.slice(0, 45) ?? '',
    tracked: known.has(`${h.ats}:${h.slug}`) ? 'yes' : '',
  })),
);

if (values.add) {
  const toAdd = hits.filter((h) => !known.has(`${h.ats}:${h.slug}`));
  const file = path.join(DATA_DIR, 'target_companies.yaml');
  // parseDocument keeps the file's comments, which plain parse + stringify would drop.
  const doc = YAML.parseDocument(
    fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'companies: []',
  );
  if (!doc.has('companies')) doc.set('companies', doc.createNode([]));
  const list = doc.get('companies') as YAML.YAMLSeq;
  for (const h of toAdd)
    list.add(
      doc.createNode({
        name: h.name,
        ats: h.ats,
        slug: h.slug,
        priority: h.relevant.length >= 3 ? 'high' : h.relevant.length ? 'medium' : 'low',
      }),
    );
  fs.writeFileSync(file, doc.toString());
  console.log(`\nAdded ${toAdd.length} companies to ${file}`);
}
