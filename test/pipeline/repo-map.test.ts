import { describe, it, expect } from 'vitest';
import { renderRepoMap } from '../../src/pipeline/repo-map.js';

describe('renderRepoMap', () => {
  it('lists files sorted with a count header', () => {
    const map = renderRepoMap(['src/b.ts', 'src/a.ts', 'test/a.test.ts']);
    expect(map).toContain('## Repository file map (3 files)');
    const files = map.slice(map.indexOf('### Files'));
    expect(files.indexOf('src/a.ts')).toBeLessThan(files.indexOf('src/b.ts'));
    expect(files).toContain('test/a.test.ts');
  });

  it('excludes node_modules / dist / coverage noise', () => {
    const map = renderRepoMap(['src/a.ts', 'node_modules/x/index.js', 'dist/a.js', 'coverage/lcov.info']);
    expect(map).toContain('src/a.ts');
    expect(map).not.toContain('node_modules');
    expect(map).not.toContain('dist/a.js');
    expect(map).not.toContain('coverage/');
    expect(map).toContain('(1 files)');
  });

  it('summarizes package.json to name/scripts/dependency names (not full dep tree)', () => {
    const pkg = JSON.stringify({
      name: 'demo',
      scripts: { test: 'vitest run' },
      dependencies: { pg: '^8.0.0' },
      devDependencies: { vitest: '^3.0.0' },
    });
    const map = renderRepoMap(['src/a.ts'], pkg);
    expect(map).toContain('"name": "demo"');
    expect(map).toContain('vitest run');
    expect(map).toContain('"pg"'); // dep name kept
    expect(map).not.toContain('^8.0.0'); // version dropped (names only)
  });

  it('caps the file list and notes how many were omitted', () => {
    const files = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
    const map = renderRepoMap(files, undefined, { maxFiles: 4 });
    expect(map).toContain('(6 more files omitted)');
  });

  it('handles invalid package.json without throwing', () => {
    const map = renderRepoMap(['src/a.ts'], '{not json');
    expect(map).toContain('src/a.ts');
  });
});
