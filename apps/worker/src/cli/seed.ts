// Inserts sample jobs (through the real normalize -> filter -> dedup path) and scores them with the
// mock scorer, so the dashboard has data before any real source is configured.
//   npm run seed            add sample data (safe to run repeatedly)
//   npm run seed '--' --clear remove sample data
import { parseArgs } from 'node:util';
import { connectDb, disconnectDb, getEnv, JobModel, JobScoreModel, loadProfile } from '@ja/shared';
import { createMockScorer } from '../llm/scorer.js';
import { applyHardFilters, batchMatch } from '../pipeline/filter.js';
import { normalizeJob } from '../pipeline/normalize.js';
import { scorePendingJobs } from '../pipeline/score.js';
import { upsertJob } from '../pipeline/upsert.js';
import type { RawJob } from '../sources/types.js';

const { values } = parseArgs({ options: { clear: { type: 'boolean', default: false } } });

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
const MERN_JD = `We are looking for a MERN Stack Developer with 1-3 years of experience.
You will build features end to end using React, Node.js, Express and MongoDB, write REST APIs secured with JWT,
and deploy to Linux servers with Nginx and PM2. Experience with GitHub Actions is a plus. TypeScript preferred.
Responsibilities: own features from design to deployment, review code, write tests, collaborate with design and product.
Requirements: strong JavaScript, React hooks, Node.js/Express, MongoDB schema design, Git. Nice to have: Redis, Docker, AWS.`;

const SAMPLES: RawJob[] = [
  {
    source: 'greenhouse',
    sourceJobId: 'seed:gh-1',
    url: 'https://example.com/jobs/gh-1',
    company: 'Acme Fintech Pvt Ltd',
    title: 'MERN Stack Developer',
    location: 'Bengaluru, India',
    description: MERN_JD,
    postedAt: daysAgo(1),
  },
  {
    source: 'gmail',
    sourceJobId: 'seed:linkedin-1',
    url: 'https://www.linkedin.com/jobs/view/1000000001',
    company: 'Acme Fintech',
    title: 'MERN Stack Developer',
    location: 'Bangalore, Karnataka, India',
    description: '',
    postedAt: daysAgo(1),
  },
  {
    source: 'lever',
    sourceJobId: 'seed:lv-1',
    url: 'https://example.com/jobs/lv-1',
    company: 'ShopKart',
    title: 'Software Engineer I - Backend (Node.js)',
    location: 'Pune',
    workModeHint: 'hybrid',
    description: `Backend engineer, 0-2 years experience. Node.js, Express, MongoDB, REST APIs, JWT, Docker. ${MERN_JD}`,
    postedAt: daysAgo(2),
  },
  {
    source: 'ashby',
    sourceJobId: 'seed:ab-1',
    url: 'https://example.com/jobs/ab-1',
    company: 'CloudNine Labs',
    title: 'Frontend Engineer (React)',
    location: 'Remote - Worldwide',
    workModeHint: 'remote',
    description:
      'React, TypeScript, Vite, Tailwind CSS. 1+ years of experience building SPAs. Testing with Vitest. GraphQL is a plus.',
    postedAt: daysAgo(3),
  },
  {
    source: 'adzuna',
    sourceJobId: 'seed:az-1',
    url: 'https://example.com/jobs/az-1',
    company: 'Infotech Solutions',
    title: 'Full Stack Developer',
    location: 'Noida, Uttar Pradesh',
    description:
      'Full stack developer (React + Node.js) with 1-3 years of experience. MongoDB, Express...',
    descriptionTruncated: true,
    postedAt: daysAgo(2),
  },
  {
    source: 'remotive',
    sourceJobId: 'seed:rm-1',
    url: 'https://example.com/jobs/rm-1',
    company: 'DataPipe',
    title: 'Backend Developer (Node.js)',
    location: 'USA only',
    workModeHint: 'remote',
    description: 'Node.js, PostgreSQL, AWS. 2+ years of experience.',
    postedAt: daysAgo(1),
  },
  {
    source: 'greenhouse',
    sourceJobId: 'seed:gh-2',
    url: 'https://example.com/jobs/gh-2',
    company: 'Acme Fintech',
    title: 'Senior Full Stack Engineer',
    location: 'Bengaluru',
    description: '6+ years of experience with React and Node.js.',
    postedAt: daysAgo(1),
  },
  {
    source: 'greenhouse',
    sourceJobId: 'seed:gh-3',
    url: 'https://example.com/jobs/gh-3',
    company: 'Acme Fintech',
    title: 'Java Developer',
    location: 'Bengaluru',
    description: 'Spring Boot, Microservices, 2-4 years.',
    postedAt: daysAgo(1),
  },
  {
    source: 'greenhouse',
    sourceJobId: 'seed:gh-4',
    url: 'https://example.com/jobs/gh-4',
    company: 'Acme Fintech',
    title: 'Account Executive',
    location: 'Mumbai',
    description: 'Sales role.',
    postedAt: daysAgo(1),
  },
  {
    source: 'lever',
    sourceJobId: 'seed:lv-2',
    url: 'https://example.com/jobs/lv-2',
    company: 'GlobalSoft',
    title: 'Software Engineer',
    location: 'San Francisco, CA',
    description: 'Python, Go, Kubernetes.',
    postedAt: daysAgo(4),
  },
  {
    source: 'gmail',
    sourceJobId: 'seed:naukri-1',
    url: 'https://www.naukri.com/job-listings-react-developer-zenith-tech-hyderabad-1-to-3-years-071025000001',
    company: 'Globex Tech',
    title: 'React.js Developer',
    location: 'Hyderabad',
    description: '',
    postedAt: daysAgo(0),
  },
  {
    source: 'adzuna',
    sourceJobId: 'seed:az-2',
    url: 'https://example.com/jobs/az-2',
    company: 'OldCo',
    title: 'Node.js Developer',
    location: 'Chennai',
    description: 'Node.js developer, 1-2 years of experience...',
    descriptionTruncated: true,
    postedAt: daysAgo(40),
  },
  {
    source: 'ashby',
    sourceJobId: 'seed:ab-2',
    url: 'https://example.com/jobs/ab-2',
    company: 'Kolkata Kode',
    title: 'Web Developer',
    location: 'Kolkata',
    description: 'PHP and WordPress developer, HTML, CSS, jQuery. 1-3 years of experience.',
    postedAt: daysAgo(5),
  },
  {
    source: 'lever',
    sourceJobId: 'seed:lv-3',
    url: 'https://example.com/jobs/lv-3',
    company: 'PayStream',
    title: 'Associate Software Engineer - Full Stack',
    location: 'Gurugram, Haryana',
    workModeHint: 'onsite',
    description: `0-1 years of experience. React, Node.js, Express, MongoDB, AWS, Docker, Redis. ${MERN_JD}`,
    postedAt: daysAgo(1),
  },
];

await connectDb();
try {
  if (values.clear) {
    const jobs = await JobModel.find({ 'seenOn.sourceJobId': /^seed:/ }, { _id: 1 }).lean();
    const ids = jobs.map((j) => j._id);
    await JobScoreModel.deleteMany({ jobId: { $in: ids } });
    const res = await JobModel.deleteMany({ _id: { $in: ids } });
    console.log(`Removed ${res.deletedCount} sample job(s).`);
  } else {
    const profile = loadProfile().data;
    const counts = { inserted: 0, filtered: 0, duplicate: 0 };
    for (const raw of SAMPLES) {
      const job = normalizeJob(raw);
      job.batchMatch = batchMatch(job, profile.preferences);
      const filter = applyHardFilters(job, profile.preferences, {
        maxJobAgeDays: getEnv().MAX_JOB_AGE_DAYS,
      });
      counts[await upsertJob(job, filter)]++;
    }
    const s = await scorePendingJobs(createMockScorer(profile), {
      filter: { 'seenOn.sourceJobId': /^seed:/ },
    });
    console.log(
      `Sample data: ${counts.inserted} new, ${counts.filtered} filtered out, ${counts.duplicate} duplicate(s). Scored ${s.scored} with the mock scorer.`,
    );
  }
} finally {
  await disconnectDb();
}
