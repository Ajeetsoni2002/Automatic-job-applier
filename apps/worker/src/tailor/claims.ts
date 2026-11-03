// Deterministic checks that generated text claims nothing the profile doesn't support.
// Two kinds of claims are checked: technologies and numbers. Anything else (tone, wording) is left
// to human review in approve mode.

/** Technologies we look for in generated text, in addition to the profile's own skills. */
const COMMON_TECH = [
  'JavaScript',
  'TypeScript',
  'Python',
  'Java',
  'Go',
  'Golang',
  'Rust',
  'C#',
  'C++',
  'Kotlin',
  'Swift',
  'PHP',
  'Ruby',
  'Scala',
  'Dart',
  'SQL',
  'NoSQL',
  'HTML',
  'CSS',
  'Sass',
  'React',
  'Next.js',
  'Angular',
  'Vue',
  'Svelte',
  'Redux',
  'Zustand',
  'jQuery',
  'Bootstrap',
  'Tailwind CSS',
  'Material UI',
  'Vite',
  'Webpack',
  'React Native',
  'Flutter',
  'Electron',
  'Node.js',
  'Express',
  'NestJS',
  'Fastify',
  'Django',
  'Flask',
  'FastAPI',
  'Spring',
  'Spring Boot',
  'Laravel',
  'Rails',
  '.NET',
  'ASP.NET',
  'GraphQL',
  'gRPC',
  'REST',
  'WebSockets',
  'Socket.io',
  'MongoDB',
  'Mongoose',
  'PostgreSQL',
  'MySQL',
  'SQLite',
  'Redis',
  'Elasticsearch',
  'DynamoDB',
  'Cassandra',
  'Firebase',
  'Supabase',
  'Prisma',
  'Sequelize',
  'AWS',
  'Azure',
  'GCP',
  'Docker',
  'Kubernetes',
  'Terraform',
  'Jenkins',
  'GitHub Actions',
  'GitLab CI',
  'Nginx',
  'PM2',
  'Linux',
  'Kafka',
  'RabbitMQ',
  'Microservices',
  'Serverless',
  'Lambda',
  'Vercel',
  'Jest',
  'Mocha',
  'Vitest',
  'Cypress',
  'Playwright',
  'Selenium',
  'JWT',
  'OAuth',
  'TensorFlow',
  'PyTorch',
  'Pandas',
  'Spark',
  'Hadoop',
  'Figma',
  'Git',
  'Android',
  'iOS',
];

/** Canonical key so "Node.js", "NodeJS" and "node" compare equal. */
export function techKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.?js\b/g, '')
    .replace(/[^a-z0-9+#.]/g, '')
    .replace(/\.$/, '');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function variants(name: string): string[] {
  const base = name.replace(/\.js$/i, '').replace(/js$/i, '');
  const out = new Set([name, base]);
  if (base !== name || /^(node|express|react|next|vue|nest)$/i.test(base)) {
    out.add(`${base}.js`);
    out.add(`${base}js`);
  }
  return [...out].filter((v) => v.length > 1);
}

export interface TechVocabulary {
  /** Finds technologies mentioned in a text; returns their canonical keys. */
  find(text: string): Set<string>;
  label(key: string): string;
}

export function buildVocabulary(extra: string[]): TechVocabulary {
  const entries = new Map<string, { label: string; re: RegExp }>();
  for (const name of [...COMMON_TECH, ...extra]) {
    const key = techKey(name);
    if (!key || entries.has(key)) continue;
    const alts = variants(name)
      .sort((a, b) => b.length - a.length)
      .map((v) => escapeRe(v));
    entries.set(key, {
      label: name,
      re: new RegExp(`(?<![A-Za-z0-9])(?:${alts.join('|')})(?![A-Za-z0-9+#])`, 'i'),
    });
  }
  return {
    find(text) {
      const found = new Set<string>();
      for (const [key, { re }] of entries) if (re.test(text)) found.add(key);
      // "Go" as a word is too ambiguous in prose; only count it when written as Golang.
      found.delete(techKey('Go'));
      return found;
    },
    label: (key) => entries.get(key)?.label ?? key,
  };
}

/** Numbers that read as claims: 450, 70+, 7.6, 30%, 3x, 10k. Years like 2025 are excluded. */
export function findNumbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?:\s*%|[%+xkm])?(?!\w)/gi)) {
    const n = m[1]!;
    if (/^(19|20)\d{2}$/.test(n)) continue; // years
    out.add(n);
  }
  return out;
}

export interface ClaimCheck {
  ok: boolean;
  newTech: string[];
  newNumbers: string[];
}

/**
 * Compares a generated text with the source text it may rely on. Every technology and number in
 * `generated` must appear in `allowedText` (or among `allowedTech` keys).
 */
export function checkClaims(
  vocab: TechVocabulary,
  generated: string,
  allowedText: string,
  allowedTech: Set<string> = new Set(),
): ClaimCheck {
  const allowedKeys = new Set([...vocab.find(allowedText), ...allowedTech]);
  const newTech = [...vocab.find(generated)]
    .filter((k) => !allowedKeys.has(k))
    .map((k) => vocab.label(k));
  const allowedNums = findNumbers(allowedText);
  const newNumbers = [...findNumbers(generated)].filter((n) => !allowedNums.has(n));
  return { ok: newTech.length === 0 && newNumbers.length === 0, newTech, newNumbers };
}
