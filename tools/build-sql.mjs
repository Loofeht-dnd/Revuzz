/* Build supabase/ALL.sql from the numbered migration files.
 *
 * The deploy story is: run ONE file in the Supabase SQL Editor. To keep that
 * file honest, it is generated here from the four sources rather than edited
 * by hand.
 *
 *   node tools/build-sql.mjs          # write ALL.sql
 *   node tools/build-sql.mjs --check  # fail if ALL.sql is out of date
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'supabase');
const FILES = ['01_schema.sql', '02_functions.sql', '03_policies.sql', '04_seed.sql'];
const OUT = join(dir, 'ALL.sql');

const parts = FILES.map((name) => {
  const body = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return `-- ########## ${name} ##########\n${body}\n`;
});

const next = parts.join('\n') + '\n';
const prev = existsSync(OUT) ? readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';

if (process.argv.includes('--check')) {
  if (prev !== next) {
    console.error('ALL.sql is out of date - run: node tools/build-sql.mjs');
    process.exit(1);
  }
  console.log('ALL.sql is up to date (' + next.length + ' bytes)');
  process.exit(0);
}

writeFileSync(OUT, next);
console.log(`ALL.sql ${prev.length} -> ${next.length} bytes (${FILES.length} files)`);
