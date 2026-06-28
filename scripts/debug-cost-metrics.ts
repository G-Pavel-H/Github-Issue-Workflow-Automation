import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { PgStore } from '../src/store/pg-store.js';
import { formatUsd } from '../src/llm/pricing.js';

/**
 * Phase 11 observability: print the measured average cost per issue across all
 * runs — the real figure that replaces the planning estimate.
 *
 * Usage:
 *   npm run debug:cost-metrics
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const store = new PgStore(pool);

  const { runCount, totalNanoUsd, avgCostNanoUsd } = await store.getCostMetrics();
  console.log(`Runs:           ${runCount}`);
  console.log(`Total spend:    ${formatUsd(totalNanoUsd)}`);
  console.log(`Avg cost/issue: ${formatUsd(avgCostNanoUsd)}`);

  await pool.end();
}

main().catch((err) => {
  console.error('debug:cost-metrics failed:', err);
  process.exit(1);
});
