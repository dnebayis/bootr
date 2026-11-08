import { readConfig } from '@/lib/server/admin-config';
import { CATALOG_IMAGE_MODELS, CATALOG_MODELS, filterAllowedModels, THOUGHT, type ImageModelOption, type ModelOption, type ModelsResponse } from '@/lib/models';

/**
 * The model list `GET /api/models` and `GET /api/catalog` answer with: the catalog of the models BlockRun serves
 * (`@bootr/agent-core` `MODEL_CATALOG`), priced per thought or per picture the way the agent pays for them. No service
 * is asked at request time: the catalog is the source of truth and the supervisor checks it against BlockRun at start.
 */

export type ModelLists = { source: ModelsResponse['source']; models: ModelOption[]; imageModels: ImageModelOption[] };

export async function relayModels(): Promise<ModelLists> {
  return { source: 'blockrun', models: [...CATALOG_MODELS], imageModels: [...CATALOG_IMAGE_MODELS] };
}

/** The models a new agent may use: the catalog filtered by the admin's `allowedModels`, one thought priced for each. */
export async function currentModels(): Promise<ModelsResponse> {
  const [{ source, models }, cfg] = await Promise.all([relayModels(), readConfig()]);
  return { source, thought: THOUGHT, models: filterAllowedModels(models, cfg.allowedModels) };
}
