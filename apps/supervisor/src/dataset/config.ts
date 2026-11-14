/**
 * What the dataset process reads from its environment. It is a separate schema from the supervisor's on purpose: the
 * dataset process signs nothing and pays nothing, so it is given no signing key, no admin key, no session key and no
 * service key, and would not start asking for one (docker-compose.coolify.yml strips them from its environment).
 */
import { z } from 'zod';

const int = (def: number, min = 0) => z.preprocess((v) => (v === '' || v === undefined ? def : v), z.coerce.number().int().min(min));

export const datasetConfigSchema = z.object({
  /**
   * The one switch. On only when set to exactly `true`; unset, empty or anything else is off, and never an error. Off,
   * the process starts, answers its health check and reads nothing, so a deploy changes nothing until the owner turns
   * it on. Turning it off again (and restarting the service) stops every read; what is stored stays.
   */
  DATASET_ENABLED: z.preprocess((v) => v === 'true', z.boolean()),
  DATABASE_URL: z.string().min(1),
  /** The indexer's REST and GraphQL (layer a). No key: only its public reads are used. */
  INDEXER_URL: z.string().url(),
  /** Where the health check listens. */
  DATASET_PORT: int(3005, 1),
  /** How often a pass runs. A pass reads the sources that are due and nothing else. */
  DATASET_PASS_MS: int(60_000, 5_000),
  /** How often layer a (the chain and Bootr's own tables) is read. */
  DATASET_CHAIN_EVERY_MS: int(600_000, 60_000),
  /** Open sources read in one pass at most. */
  DATASET_SOURCES_PER_PASS: int(12, 1),
  /** New records kept per UTC day (store.ts); 0 = no cap. */
  DATASET_RECORDS_PER_DAY: int(400, 0),
  LOG_LEVEL: z.preprocess((v) => (v === '' || v === undefined ? 'info' : v), z.string()),
});

export type DatasetConfig = z.infer<typeof datasetConfigSchema>;

export function loadDatasetConfig(env: NodeJS.ProcessEnv = process.env): DatasetConfig {
  return datasetConfigSchema.parse(env);
}
