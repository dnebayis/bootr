/**
 * What the dataset process reads from its environment. It is a separate schema from the supervisor's on purpose: the
 * dataset process signs nothing and pays nothing, so it is given no signing key, no admin key, no session key and no
 * service key, and would not start asking for one (docker-compose.coolify.yml strips them from its environment). The
 * one key it may hold, `DATASET_SENDER_KEY`, opens the sender's four X reads for the dataset and nothing else.
 */
import { z } from 'zod';
import { capOf } from './x-budget.js';

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
  /** One open source's share of a day: new records it may start, and sightings it may add (store.ts); 0 = no cap. */
  DATASET_SOURCE_RECORDS_PER_DAY: int(40, 0),
  DATASET_SOURCE_SIGHTINGS_PER_DAY: int(120, 0),
  /**
   * Layer c, the X accounts (layer-c.ts). `DATASET_X_POSTS_PER_DAY` is the day's cap in units of one post read (a post
   * 1, a user read 2; 0.005 USD a unit): unset, empty, 0 or anything that is not a whole number = OFF, nothing is read
   * and nothing is spent; above 700 it is 700 (x-budget.ts `capOf`). The sender holds the same cap where the money is
   * spent, and the smaller of the two is in force. `SENDER_URL` and `DATASET_SENDER_KEY` are the door to the sender's
   * `/dataset/x/*` reads: the key opens those reads and nothing else (apps/sender/src/dataset-x.ts). None of the three
   * can stop the process from starting: a value that is not what it should be reads as unset.
   */
  DATASET_X_POSTS_PER_DAY: z.preprocess((v) => capOf(v), z.number().int().nonnegative()),
  SENDER_URL: z.preprocess((v) => (typeof v === 'string' && /^https?:\/\/\S+$/.test(v) ? v : undefined), z.string().optional()),
  DATASET_SENDER_KEY: z.preprocess((v) => (typeof v === 'string' && v.length >= 32 ? v : undefined), z.string().optional()),
  LOG_LEVEL: z.preprocess((v) => (v === '' || v === undefined ? 'info' : v), z.string()),
});

export type DatasetConfig = z.infer<typeof datasetConfigSchema>;

export function loadDatasetConfig(env: NodeJS.ProcessEnv = process.env): DatasetConfig {
  return datasetConfigSchema.parse(env);
}
