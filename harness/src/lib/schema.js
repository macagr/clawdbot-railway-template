// Minimal JSON Schema validator (subset) so the harness has no runtime dependencies.
// Supported: type (incl. arrays), enum, const, required, properties, additionalProperties,
// items, minItems, maxItems, minLength, maxLength, pattern, minimum, maximum, oneOf, anyOf,
// allOf, not, $ref (registry "name.json" and local "#/$defs/x"), nullable via type arrays,
// propertyNames.pattern, uniqueItems.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_DIR = fileURLToPath(new URL("../../schemas/", import.meta.url));

export class SchemaError extends Error {
  constructor(schemaName, errors) {
    super(`${schemaName}: ${errors.slice(0, 8).join("; ")}${errors.length > 8 ? ` (+${errors.length - 8} more)` : ""}`);
    this.name = "SchemaError";
    this.schemaName = schemaName;
    this.errors = errors;
  }
}

export class SchemaRegistry {
  constructor(dir = SCHEMA_DIR) {
    this.dir = dir;
    this.cache = new Map();
  }

  get(name) {
    const key = name.endsWith(".json") ? name : `${name}.json`;
    if (!this.cache.has(key)) {
      const p = path.join(this.dir, key);
      if (!fs.existsSync(p)) throw new Error(`schema not found: ${key}`);
      this.cache.set(key, JSON.parse(fs.readFileSync(p, "utf8")));
    }
    return this.cache.get(key);
  }

  list() {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  }

  /** Returns an array of error strings (empty when valid). */
  errors(name, value) {
    const root = this.get(name);
    const errs = [];
    this.#check(root, root, value, "$", errs, name);
    return errs;
  }

  validate(name, value) {
    const errs = this.errors(name, value);
    if (errs.length) throw new SchemaError(name, errs);
    return value;
  }

  isValid(name, value) {
    return this.errors(name, value).length === 0;
  }

  #resolve(ref, root, rootName) {
    if (ref.startsWith("#/")) {
      let node = root;
      for (const seg of ref.slice(2).split("/")) {
        node = node?.[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
        if (node === undefined) throw new Error(`bad $ref ${ref} in ${rootName}`);
      }
      return { schema: node, root, rootName };
    }
    const [file, frag] = ref.split("#");
    const other = this.get(file);
    if (frag) return this.#resolve(`#${frag}`, other, file);
    return { schema: other, root: other, rootName: file };
  }

  #check(schema, root, value, at, errs, rootName) {
    if (schema === true) return;
    if (schema === false) { errs.push(`${at}: schema false`); return; }
    if (schema.$ref) {
      const r = this.#resolve(schema.$ref, root, rootName);
      this.#check(r.schema, r.root, value, at, errs, r.rootName);
      // siblings of $ref are ignored (draft-07 semantics), except we continue with nothing else.
      return;
    }
    if (schema.const !== undefined && !deepEqual(value, schema.const)) errs.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
    if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) errs.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((t) => typeMatches(t, value))) {
        errs.push(`${at}: expected ${types.join("|")}, got ${describe(value)}`);
        return;
      }
    }
    if (typeof value === "string") {
      if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: does not match ${schema.pattern}`);
    }
    if (typeof value === "number") {
      if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${at}: above ${schema.maximum}`);
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
      if (schema.uniqueItems) {
        const seen = new Set();
        for (const v of value) {
          const k = JSON.stringify(v);
          if (seen.has(k)) { errs.push(`${at}: duplicate item ${k}`); break; }
          seen.add(k);
        }
      }
      if (schema.items) value.forEach((v, i) => this.#check(schema.items, root, v, `${at}[${i}]`, errs, rootName));
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const props = schema.properties || {};
      for (const req of schema.required || []) {
        if (!(req in value)) errs.push(`${at}: missing required '${req}'`);
      }
      for (const [k, v] of Object.entries(value)) {
        if (k in props) this.#check(props[k], root, v, `${at}.${k}`, errs, rootName);
        else if (schema.additionalProperties === false) errs.push(`${at}: unexpected property '${k}'`);
        else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          this.#check(schema.additionalProperties, root, v, `${at}.${k}`, errs, rootName);
        }
        if (schema.propertyNames?.pattern && !new RegExp(schema.propertyNames.pattern).test(k)) {
          errs.push(`${at}: property name '${k}' does not match ${schema.propertyNames.pattern}`);
        }
      }
    }
    if (schema.allOf) for (const s of schema.allOf) this.#check(s, root, value, at, errs, rootName);
    if (schema.anyOf) {
      const ok = schema.anyOf.some((s) => { const e = []; this.#check(s, root, value, at, e, rootName); return e.length === 0; });
      if (!ok) errs.push(`${at}: matches none of anyOf`);
    }
    if (schema.oneOf) {
      const n = schema.oneOf.filter((s) => { const e = []; this.#check(s, root, value, at, e, rootName); return e.length === 0; }).length;
      if (n !== 1) errs.push(`${at}: matches ${n} of oneOf (need exactly 1)`);
    }
    if (schema.not) {
      const e = [];
      this.#check(schema.not, root, value, at, e, rootName);
      if (e.length === 0) errs.push(`${at}: must not match 'not' schema`);
    }
  }
}

function typeMatches(t, v) {
  switch (t) {
    case "null": return v === null;
    case "boolean": return typeof v === "boolean";
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return Number.isInteger(v);
    case "array": return Array.isArray(v);
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    default: return false;
  }
}

function describe(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

export const schemas = new SchemaRegistry();
