import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('migrations harness', () => {
  const migrationsDir = join(import.meta.dirname, '..', 'migrations');

  it('migrations directory exists and contains at least one migration', () => {
    const files = readdirSync(migrationsDir);
    const sqlFiles = files.filter((f) => f.endsWith('.sql') || f.endsWith('.js') || f.endsWith('.ts'));
    expect(sqlFiles.length).toBeGreaterThan(0);
  });

  it('first migration contains valid SQL', () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);

    const firstMigration = readFileSync(join(migrationsDir, files[0]!), 'utf-8');
    expect(firstMigration).toContain('CREATE');
  });
});
