// Validates data/*.yaml and prints a short summary. Exit code 1 on any error.
import {
  allSkills,
  ConfigFileError,
  loadProfile,
  loadQaBank,
  loadTargetCompanies,
} from '@ja/shared';

let ok = true;

function check<T>(
  label: string,
  load: () => { data: T; file: string; isExample: boolean },
  describe: (d: T) => string,
) {
  try {
    const { data, file, isExample } = load();
    console.log(
      `✔ ${label}: ${file}${isExample ? '  (EXAMPLE FILE — copy it without ".example" and fill it in)' : ''}`,
    );
    console.log(`    ${describe(data)}`);
    const placeholders = JSON.stringify(data).match(/<[A-Z][^<>]{2,}>/g);
    if (placeholders?.length)
      console.log(
        `    ⚠ ${placeholders.length} placeholder(s) left, e.g. ${[...new Set(placeholders)].slice(0, 3).join(', ')}`,
      );
  } catch (err) {
    ok = false;
    console.error(
      `✘ ${label}: ${err instanceof ConfigFileError ? err.message : (err as Error).stack}`,
    );
  }
}

check('profile', loadProfile, (p) =>
  [
    `${p.personal.name} · ${p.totalExperienceYears} yr(s) · ${allSkills(p).length} skills`,
    `${p.experience.length} experience entries · ${p.projects.length} projects`,
    `roles: ${p.preferences.roles.join(', ')}`,
  ].join('\n    '),
);
check('qa_bank', loadQaBank, (q) => `${q.answers.length} answers`);
check('target_companies', loadTargetCompanies, (t) => {
  const by = t.companies.reduce<Record<string, number>>(
    (acc, c) => ({ ...acc, [c.ats]: (acc[c.ats] ?? 0) + 1 }),
    {},
  );
  return `${t.companies.length} companies (${
    Object.entries(by)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || 'none'
  })`;
});

// Bullet ids must be unique: tailoring (Phase 2) selects bullets by id.
try {
  const p = loadProfile().data;
  const ids = [
    ...p.experience.flatMap((e) => e.bullets),
    ...p.projects.flatMap((x) => x.bullets),
  ].map((b) => b.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) {
    ok = false;
    console.error(`✘ duplicate bullet ids in profile: ${[...new Set(dupes)].join(', ')}`);
  }
} catch {
  /* already reported */
}

process.exit(ok ? 0 : 1);
