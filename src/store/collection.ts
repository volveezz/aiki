import zvec from "@zvec/zvec";
const {
  ZVecInitialize,
  ZVecCreateAndOpen,
  ZVecOpen,
  ZVecCollectionSchema,
  ZVecDataType,
  ZVecIndexType,
  ZVecMetricType,
  ZVecLogType,
  ZVecLogLevel,
} = zvec;
import { config, log } from "../utils/config.js";
import { projectCollectionPath } from "../utils/paths.js";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

type Collection = ReturnType<typeof ZVecOpen>;

let initialized = false;
const cache = new Map<string, Collection>();

function ensureInitialized() {
  if (initialized) return;

  mkdirSync(config.paths.logDir, { recursive: true });

  ZVecInitialize({
    logType: ZVecLogType.FILE,
    logLevel: ZVecLogLevel.WARN,
    logDir: config.paths.logDir,
    logBaseName: "zvec.log",
  });

  initialized = true;
  log("info", "Zvec initialized (file logging)");
}

const PROJECT_SCHEMA = {
  fields: [
    { name: "file_path", dataType: ZVecDataType.STRING },
    { name: "chunk_type", dataType: ZVecDataType.STRING },
    { name: "language", dataType: ZVecDataType.STRING },
    { name: "content", dataType: ZVecDataType.STRING },
    { name: "summary", dataType: ZVecDataType.STRING },
    { name: "tags", dataType: ZVecDataType.ARRAY_STRING },
    { name: "last_modified", dataType: ZVecDataType.INT64 },
  ],
  vectors: {
    name: "embedding",
    dataType: ZVecDataType.VECTOR_FP32,
    dimension: config.mistral.dimension,
    indexParams: {
      indexType: ZVecIndexType.HNSW,
      metricType: ZVecMetricType.COSINE,
      m: 16,
      efConstruction: 200,
    },
  },
};

const GLOBAL_SCHEMA = {
  fields: [
    { name: "category", dataType: ZVecDataType.STRING },
    { name: "topic", dataType: ZVecDataType.STRING },
    { name: "content", dataType: ZVecDataType.STRING },
    { name: "confidence", dataType: ZVecDataType.INT32 },
    { name: "source_project", dataType: ZVecDataType.STRING},
  ],
  vectors: {
    name: "embedding",
    dataType: ZVecDataType.VECTOR_FP32,
    dimension: config.mistral.dimension,
    indexParams: {
      indexType: ZVecIndexType.HNSW,
      metricType: ZVecMetricType.COSINE,
      m: 16,
      efConstruction: 200,
    },
  },
};

function openOrCreate(
  path: string,
  schemaName: string,
  schemaDef: typeof PROJECT_SCHEMA | typeof GLOBAL_SCHEMA,
) {
  ensureInitialized();

  if (existsSync(path)) {
    const collection = ZVecOpen(path);
    log("info", `Opened collection: ${path}`);
    return collection;
  }

  mkdirSync(dirname(path), { recursive: true });
  const schema = new ZVecCollectionSchema({ name: schemaName, ...schemaDef });
  const collection = ZVecCreateAndOpen(path, schema);
  log("info", `Created collection: ${path}`);
  return collection;
}

export function collectionPath(projectPath: string) {
  return projectCollectionPath(config.paths.collectionsBase, projectPath);
}

export function getProjectCollection(projectPath: string) {
  const path = collectionPath(projectPath);

  if (cache.has(path)) return cache.get(path)!;

  const collection = openOrCreate(path, "project", PROJECT_SCHEMA);
  cache.set(path, collection);
  return collection;
}

export function getGlobalCollection() {
  const path = config.paths.globalBase;

  if (cache.has(path)) return cache.get(path)!;

  const collection = openOrCreate(path, "global", GLOBAL_SCHEMA);
  cache.set(path, collection);
  return collection;
}

export function closeAll() {
  for (const [path, collection] of cache) {
    try {
      collection.closeSync();
      log("info", `Closed: ${path}`);
    } catch (err) {
      log("error", `Failed to close ${path}: ${(err as Error).message}`);
    }
  }
  cache.clear();
}
