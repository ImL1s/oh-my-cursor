export {
  DEFAULT_CURSOR_MODELS,
  resolveAgentRoute,
  explainAgentRoute,
  defaultModelForProvider,
  type RouteOptions,
} from '../agents/routing.js';

export {
  PRESET_CATEGORIES,
  resolveCategoryPolicy,
  type CategoryPolicy,
} from './categories.js';

export {
  discoverCursorModels,
  listCursorModels,
  isCursorModelAvailable,
  DEFAULT_CURSOR_MODELS_CATALOG,
  getCursorSdkVersion,
  toDiscoveredModel,
  readModelCache,
  writeModelCache,
  clearModelCache,
  type DiscoveredModel,
  type ModelCatalogCache,
  type ModelDiscoveryOptions,
  type ModelListFilter,
  type ModelRuntimeTarget,
  type ModelCapabilities,
} from '../cursor-sdk/models/index.js';
