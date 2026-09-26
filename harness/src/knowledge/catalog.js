// Channel/propagation catalog loader (campaign content, generic mechanics).
import path from "node:path";
import { readJson, exists } from "../lib/fsx.js";
import { schemas } from "../lib/schema.js";

export const EMPTY_CATALOG = Object.freeze({ channels: {}, scopes: {}, rules: [] });

export function loadCatalog(store) {
  const rel = store.manifest.propagation?.catalog;
  if (!rel) return EMPTY_CATALOG;
  const p = store.packagePath(rel);
  if (!exists(p)) return EMPTY_CATALOG;
  const cat = schemas.validate("channel-catalog", readJson(p));
  return { channels: cat.channels || {}, scopes: cat.scopes || {}, rules: cat.rules || [] };
}

export function catalogPath(store) {
  return path.join(store.root, store.manifest.propagation?.catalog || "channels.json");
}
