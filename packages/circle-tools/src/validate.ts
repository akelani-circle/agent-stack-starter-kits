/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pre-payment payload guard.
 *
 * Under x402 the USDC is spent *before* the seller validates the request body,
 * so a payload the server will reject (a made-up field name, a value outside an
 * enum) still costs money for a guaranteed 422. This module catches those cases
 * for free — before any payment is submitted — using only what the seller has
 * already published:
 *
 *   1. Declared `enum`s in the service's own input schema (authoritative).
 *   2. For "field selector" inputs (e.g. `return_fields`, `columns`, `include`)
 *      that publish no enum, the vocabulary of field names the service's OpenAPI
 *      response schema actually defines. A value that is not among the fields the
 *      service can ever return is not a value it will accept.
 *
 * Everything here is best-effort and FAILS OPEN: if a spec cannot be fetched or
 * parsed, or a field cannot be checked, the payload passes untouched. The guard
 * only ever blocks a value it can positively prove the seller does not accept, so
 * it never turns a payable call into a false rejection because of its own limits.
 */

/** Names that mark an input as a selector over the service's own output fields. */
const SELECTOR_NAME = /(^|[._-])(return[._-]?)?(fields?|columns?|includes?|select)$/i;
/** Descriptions that mark a field as an output-field selector. */
const SELECTOR_DESCRIPTION = /fields to (return|include)|return(ed)? fields|which fields/i;
/** How many valid values to spell out in an error before truncating. */
const MAX_LISTED = 40;
/** Ceiling on OpenAPI fetch time; a slow spec must not stall a payment. */
const SPEC_FETCH_TIMEOUT_MS = 15_000;
/** Guards against pathological / cyclic schemas while collecting field names. */
const MAX_SCHEMA_DEPTH = 12;

/** The slice of a service's input schema this guard validates a payload against. */
export interface FieldValidation {
  /** Top-level input properties, keyed by field name (from the inline schema). */
  properties: Record<string, unknown>;
  /** Required field names; these are never treated as omittable. */
  required: string[];
  /**
   * Field names the service's OpenAPI response can contain, used to validate
   * enum-less field-selector inputs. Null when no spec was available.
   */
  vocab: Set<string> | null;
}

/**
 * Locate the request-input properties in an inspect schema. POST/PUT/PATCH put
 * them under `body`; GET/DELETE under `query`. The container key varies across
 * CLI versions, so several are tried before falling back to the schema root.
 */
export function requestSchemaShape(
  schema: unknown,
): { properties: Record<string, unknown>; required: string[] } | null {
  if (!schema || typeof schema !== 'object') return null;
  const s = schema as Record<string, unknown>;
  const containers = [s.body, s.query, s.querystring, s.params, s];
  for (const c of containers) {
    if (c && typeof c === 'object') {
      const props = (c as Record<string, unknown>).properties;
      if (props && typeof props === 'object') {
        const req = (c as Record<string, unknown>).required;
        return {
          properties: props as Record<string, unknown>,
          required: Array.isArray(req) ? req.map(String) : [],
        };
      }
    }
  }
  return null;
}

const specCache = new Map<string, Promise<Record<string, unknown> | null>>();

/** Fetch and JSON-parse an OpenAPI document, memoised per URL. Never throws. */
async function fetchOpenApi(url: string): Promise<Record<string, unknown> | null> {
  let pending = specCache.get(url);
  if (!pending) {
    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SPEC_FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return null;
        const doc = (await res.json()) as unknown;
        return doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();
    specCache.set(url, pending);
  }
  return pending;
}

/** Resolve a local `#/...` `$ref`, following chains, guarding against cycles. */
function resolveRef(spec: Record<string, unknown>, node: unknown, seen = new Set<string>()): unknown {
  if (node && typeof node === 'object' && typeof (node as { $ref?: unknown }).$ref === 'string') {
    const ref = (node as { $ref: string }).$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) return {};
    seen.add(ref);
    let cur: unknown = spec;
    for (const part of ref.slice(2).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined;
    }
    return resolveRef(spec, cur, seen);
  }
  return node;
}

/**
 * Collect every property name reachable under a schema node, resolving `$ref`s
 * and descending through `items`, `additionalProperties`, and the composition
 * keywords. The result is a *superset* of a response's field names, which only
 * makes the guard more permissive (fewer false rejections), never stricter.
 */
function collectPropertyNames(
  spec: Record<string, unknown>,
  node: unknown,
  out: Set<string>,
  depth = 0,
  seen = new Set<unknown>(),
): void {
  if (depth > MAX_SCHEMA_DEPTH) return;
  const n = resolveRef(spec, node);
  if (!n || typeof n !== 'object' || seen.has(n)) return;
  seen.add(n);
  const obj = n as Record<string, unknown>;
  const props = obj.properties;
  if (props && typeof props === 'object') {
    for (const [name, child] of Object.entries(props as Record<string, unknown>)) {
      out.add(name);
      collectPropertyNames(spec, child, out, depth + 1, seen);
    }
  }
  for (const key of ['items', 'additionalProperties']) {
    if (obj[key]) collectPropertyNames(spec, obj[key], out, depth + 1, seen);
  }
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    const branch = obj[key];
    if (Array.isArray(branch)) {
      for (const b of branch) collectPropertyNames(spec, b, out, depth + 1, seen);
    }
  }
}

/** Escape a string for safe interpolation into a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find the operation object for a service URL + method within an OpenAPI doc. */
function findOperation(
  spec: Record<string, unknown>,
  url: string,
  method: string,
): Record<string, unknown> | null {
  const paths = spec.paths;
  if (!paths || typeof paths !== 'object') return null;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const keys = Object.keys(paths as Record<string, unknown>);
  const templated = (k: string): boolean => {
    if (!k.includes('{')) return false;
    const re = new RegExp(`(^|/)${escapeRegExp(k).replace(/\\\{[^/]+\\\}/g, '[^/]+')}$`);
    return re.test(pathname);
  };
  const key =
    keys.find((k) => k === pathname) ??
    keys.find((k) => pathname.endsWith(k)) ??
    keys.find(templated);
  if (!key) return null;
  const item = (paths as Record<string, unknown>)[key];
  if (!item || typeof item !== 'object') return null;
  const op = (item as Record<string, unknown>)[method.toLowerCase()];
  return op && typeof op === 'object' ? (op as Record<string, unknown>) : null;
}

/** Build the set of field names a service's 2xx JSON responses can contain. */
function responseFieldVocab(
  spec: Record<string, unknown>,
  op: Record<string, unknown>,
): Set<string> {
  const out = new Set<string>();
  const responses = op.responses;
  if (!responses || typeof responses !== 'object') return out;
  for (const [code, resp] of Object.entries(responses as Record<string, unknown>)) {
    if (!code.startsWith('2')) continue;
    const content = (resp as { content?: Record<string, unknown> } | null)?.content;
    const schema = content?.['application/json'] as { schema?: unknown } | undefined;
    if (schema?.schema) collectPropertyNames(spec, schema.schema, out);
  }
  return out;
}

/**
 * Derive the response-field vocabulary for a paid call, or null when the seller
 * advertises no OpenAPI spec, the spec is unreachable, or the operation/response
 * cannot be located. A null result disables field-selector checking (fail-open).
 */
export async function buildResponseVocab(
  openApiUrl: string | undefined,
  url: string,
  method: string,
): Promise<Set<string> | null> {
  if (!openApiUrl) return null;
  const spec = await fetchOpenApi(openApiUrl);
  if (!spec) return null;
  const op = findOperation(spec, url, method);
  if (!op) return null;
  const vocab = responseFieldVocab(spec, op);
  return vocab.size ? vocab : null;
}

/** True when a field is a selector over the service's own output fields. */
function isFieldSelector(name: string, fieldSchema: Record<string, unknown>): boolean {
  if (SELECTOR_NAME.test(name)) return true;
  const desc = typeof fieldSchema.description === 'string' ? fieldSchema.description : '';
  return SELECTOR_DESCRIPTION.test(desc);
}

/** The enum a field constrains its values to, from the field or its `items`. */
function fieldEnum(fieldSchema: Record<string, unknown>): string[] | null {
  if (Array.isArray(fieldSchema.enum)) return fieldSchema.enum.map(String);
  const items = fieldSchema.items;
  if (items && typeof items === 'object' && Array.isArray((items as { enum?: unknown }).enum)) {
    return ((items as { enum: unknown[] }).enum).map(String);
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** Render a value list for an error, truncating long vocabularies. */
function formatList(values: string[]): string {
  const shown = values.slice(0, MAX_LISTED).map((v) => `\`${v}\``).join(', ');
  const extra = values.length - MAX_LISTED;
  return extra > 0 ? `${shown}, … (+${extra} more)` : shown;
}

/**
 * Inspect a payload against a service's published input constraints and return a
 * human-readable list of values the service will reject. An empty list means
 * nothing provably invalid was found (which is NOT a promise the call succeeds —
 * only that this guard found no reason to block it).
 */
export function findFieldViolations(
  data: Record<string, unknown>,
  validation: FieldValidation,
): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    const fieldSchema = validation.properties[key];
    if (!fieldSchema || typeof fieldSchema !== 'object') continue;
    const fs = fieldSchema as Record<string, unknown>;

    // 1. Authoritative enum: reject any value the schema does not list.
    const allowed = fieldEnum(fs);
    if (allowed) {
      const bad = asArray(value)
        .map(String)
        .filter((v) => !allowed.includes(v));
      if (bad.length) {
        problems.push(
          `\`${key}\`: ${formatList(bad)} ${bad.length > 1 ? 'are' : 'is'} not among the ` +
            `allowed values ${formatList(allowed)}`,
        );
      }
      continue;
    }

    // 2. Enum-less field selector: reject values the service can never return.
    if (validation.vocab && validation.vocab.size && Array.isArray(value) && isFieldSelector(key, fs)) {
      const vocab = validation.vocab;
      const bad = value.map(String).filter((v) => !vocab.has(v));
      if (bad.length) {
        problems.push(
          `\`${key}\`: ${formatList(bad)} ${bad.length > 1 ? 'are' : 'is'} not a field this ` +
            `service returns. Valid fields: ${formatList([...vocab])}. This is an optional ` +
            `selector — omit it entirely to return all fields.`,
        );
      }
    }
  }
  return problems;
}

/**
 * Build the message thrown when a payload is blocked before payment. It states
 * plainly that NO money moved (the opposite of the post-charge failure) so the
 * caller knows it is safe to fix the values and retry, not a spent-and-lost call.
 */
export function preSpendErrorMessage(url: string, problems: string[]): string {
  return (
    `Not paying ${url}: the payload contains values this service will reject, and x402 ` +
    'charges before the server validates, so submitting it as-is would spend USDC on a ' +
    'guaranteed rejection. NO PAYMENT WAS MADE and none is needed to fix this. Correct or ' +
    'omit the following, then retry:\n- ' +
    problems.join('\n- ')
  );
}
