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
 * URL path-parameter binding for paid service calls.
 *
 * Marketplace resources are published as *templates*, not concrete URLs: the
 * route `GET /flights/{ident}` is listed as a resource whose path still carries
 * the placeholder. A payload field that belongs in the path must therefore be
 * substituted into it, not appended to the query string — the server reads the
 * path segment, and a value left in the query is simply ignored.
 *
 * Getting this wrong always costs money. Under x402 the USDC is submitted before
 * the upstream request resolves, so an unbound placeholder is a *paid* failure:
 *
 *   - `.../coingecko/coins/{id}?id=bitcoin` → the server looks up a coin literally
 *     named `{id}` and 404s, after charging.
 *   - `.../flights/id?ident=WN2417` → the server reads the segment `id` as the
 *     flight ident and 400s ("ident id is not a valid designator"), after charging.
 *
 * Placeholders reach us in two shapes, and both are handled:
 *
 *   1. **Explicit** — the published URL keeps the delimiters (`{id}`, `[id]`,
 *      `:id`). Self-describing and authoritative.
 *   2. **Bare** — the publisher stripped the delimiters, leaving the parameter
 *      name as an ordinary-looking segment (`/flights/id`). Indistinguishable
 *      from a literal segment by inspection alone, so the true template is
 *      recovered from the origin's own routing metadata (the `x-matched-path`
 *      response header, which reports the matched route as `/flights/[id]`).
 *
 * A bare placeholder does not always arrive under the route's own parameter
 * name. A caller that knows the field as `ident` will write `/flights/ident`
 * where the route declares `[id]`, and that segment is a placeholder just as
 * surely as `/flights/id` is — so a segment matching any field name the call
 * itself carries counts as unfilled too (see `placeholdersFromTemplate`).
 *
 * The value to bind is likewise taken from wherever the caller put it: the
 * payload first, and failing that the URL's own query string, since
 * `/flights/id?ident=WN2417` carries the value the path is missing.
 *
 * Recovery is best-effort and FAILS OPEN: when no template can be recovered, the
 * URL is left exactly as published and the payload goes to the query string, the
 * historical behaviour. Nothing here blocks a call it cannot prove is broken.
 */

/** Ceiling on the template probe; a slow origin must not stall a payment. */
const TEMPLATE_PROBE_TIMEOUT_MS = 8_000;

/** Delimited placeholder segments: `{id}`, `[id]`, `<id>`, `:id`. */
const EXPLICIT_SEGMENT = /^(?:\{(.+)\}|\[(.+)\]|<(.+)>|:(.+))$/;

/** One parameter placeholder located in a URL path. */
export interface PathPlaceholder {
  /** Parameter name, e.g. `id`. */
  name: string;
  /** Index of the segment within the split pathname. */
  index: number;
}

/** Outcome of binding a payload onto a URL's path and query string. */
export interface BoundUrl {
  /** The URL to call, with every bound placeholder substituted. */
  url: string;
  /** Placeholders still carrying their template value; calling would 4xx. */
  unfilled: PathPlaceholder[];
  /** Payload keys consumed by the path and therefore kept out of the query. */
  boundKeys: string[];
  /** Query keys already on the URL that were moved into the path. */
  boundQueryKeys: string[];
}

/** Split a pathname into its non-empty segments. */
function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0);
}

/** The parameter name a delimited segment declares, or null if it is literal. */
function explicitName(segment: string): string | null {
  const m = EXPLICIT_SEGMENT.exec(decodeURIComponent(segment));
  if (!m) return null;
  const name = m[1] ?? m[2] ?? m[3] ?? m[4];
  return name && !name.includes('/') ? name : null;
}

/**
 * Placeholders the published URL declares outright. These are unfilled by
 * definition: a delimiter that survived into the request is never a real value.
 */
export function explicitPlaceholders(pathname: string): PathPlaceholder[] {
  const out: PathPlaceholder[] = [];
  segmentsOf(pathname).forEach((segment, index) => {
    const name = explicitName(segment);
    if (name) out.push({ name, index });
  });
  return out;
}

const templateCache = new Map<string, Promise<string | null>>();

/**
 * Ask the origin which route a URL matched, via the `x-matched-path` response
 * header. Frameworks that emit it (Next.js on Vercel, among others) report the
 * matched route with its placeholders intact — `/api/flightaware/flights/[id]`
 * for a request to `/api/flightaware/flights/id` — which is the only
 * authoritative way to recover a template whose delimiters were stripped before
 * publication.
 *
 * The probe is unpaid: a paid x402 route answers 402 with its challenge and
 * charges nothing, so this costs a round trip and no USDC. Never throws; a
 * missing header, an unreachable origin, or a timeout all yield null.
 */
async function probeMatchedPath(url: string, method: string): Promise<string | null> {
  const key = `${method} ${url}`;
  let pending = templateCache.get(key);
  if (!pending) {
    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TEMPLATE_PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(url, { method, signal: controller.signal });
        return res.headers.get('x-matched-path');
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();
    templateCache.set(key, pending);
  }
  return pending;
}

/**
 * The names a call refers to its own inputs by: its payload keys plus the query
 * keys already on its URL, lower-cased for comparison.
 *
 * These are what a bare placeholder can masquerade as when it does not arrive
 * under the route's own parameter name, so they are collected from the call
 * rather than from the service's published schema — a caller that writes
 * `/flights/ident` is naming the field it holds, whether or not the seller
 * declares it.
 */
export function requestFieldNames(url: string, data: Record<string, unknown>): Set<string> {
  const names = new Set(Object.keys(data).map((k) => k.toLowerCase()));
  try {
    for (const key of new URL(url).searchParams.keys()) names.add(key.toLowerCase());
  } catch {
    // An unparseable URL contributes no names; the payload's still count.
  }
  return names;
}

/**
 * Align a recovered route template against the URL's own segments to find which
 * of them are parameters that are still carrying their template value.
 *
 * A recovered placeholder counts as unfilled when the URL segment sitting in
 * that position is delimited, *is* the parameter's name (`id` under `[id]`), or
 * is the name of a field the call itself carries (`ident` under `[id]`, on a
 * call whose payload or query string has an `ident`). That last case is the one
 * a caller reaches by renaming the segment rather than filling it: the route
 * says the position is a parameter, and a segment spelled exactly like one of
 * the call's own field names is that field's label, not its value.
 *
 * Any other value is a real one the caller already substituted, so a URL that
 * has been bound once is never re-bound — re-running this over
 * `/flights/WN2417` finds nothing to fill, which is what makes a retry safe.
 *
 * Templates whose segment count differs from the URL's are ignored: the header
 * described some rewrite or fallback route, not this path.
 */
export function placeholdersFromTemplate(
  pathname: string,
  template: string,
  fieldNames: Set<string> = new Set(),
): PathPlaceholder[] {
  const actual = segmentsOf(pathname);
  const declared = segmentsOf(template.split('?')[0] ?? '');
  if (declared.length !== actual.length) return [];
  const out: PathPlaceholder[] = [];
  declared.forEach((segment, index) => {
    const name = explicitName(segment);
    if (!name) return;
    const value = decodeURIComponent(actual[index] ?? '');
    const stillTemplate =
      value.toLowerCase() === name.toLowerCase() ||
      fieldNames.has(value.toLowerCase()) ||
      explicitName(value) !== null;
    if (stillTemplate) out.push({ name, index });
  });
  return out;
}

/**
 * Locate every unfilled path parameter in a URL, preferring what the URL states
 * outright and falling back to the origin's routing metadata.
 *
 * `data` is the payload the call would send; together with the URL's query keys
 * it supplies the field names a bare placeholder may be wearing.
 */
export async function findPathPlaceholders(
  url: string,
  method: string,
  data: Record<string, unknown> = {},
): Promise<PathPlaceholder[]> {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return [];
  }
  const explicit = explicitPlaceholders(pathname);
  if (explicit.length) return explicit;
  const template = await probeMatchedPath(url, method);
  return template ? placeholdersFromTemplate(pathname, template, requestFieldNames(url, data)) : [];
}

/**
 * Choose the payload field that fills a placeholder.
 *
 * Preference order is strictest first: an exact name match (`id` → `id`), then a
 * case-insensitive one, then — only when a single placeholder and a single
 * plausible field remain — the sole leftover field. That last step is what binds
 * a field the service names differently from its own route parameter (`ident`
 * into `/flights/[id]`), and it is deliberately restricted to the unambiguous
 * case: with one placeholder left, leaving it unbound is a *certain* paid
 * failure, so the only candidate is strictly the better call.
 *
 * `declaredQuery` keeps that last step honest. When the service publishes its
 * query parameters, a field among them is a query value and is never pulled into
 * the path; only genuinely undeclared fields are eligible.
 */
function pickField(
  placeholder: PathPlaceholder,
  remaining: Map<string, unknown>,
  soleRemainingPlaceholder: boolean,
  declaredQuery: Set<string> | null,
): string | null {
  if (remaining.has(placeholder.name)) return placeholder.name;
  const lower = placeholder.name.toLowerCase();
  for (const key of remaining.keys()) {
    if (key.toLowerCase() === lower) return key;
  }
  if (!soleRemainingPlaceholder) return null;
  const eligible = [...remaining.keys()].filter((k) => !declaredQuery?.has(k));
  return eligible.length === 1 ? (eligible[0] ?? null) : null;
}

/**
 * The URL's own query parameters, as binding candidates of last resort.
 *
 * A caller that encodes the service's input into the URL itself rather than
 * handing it over as a payload leaves the value one place away from where it
 * belongs: `/flights/id?ident=WN2417` holds `WN2417`, just on the query string.
 * Offering those keys to the binder turns that into a call that works instead of
 * one that is refused, without relaxing what counts as a placeholder.
 *
 * Repeated keys are skipped: a key that appears more than once is an
 * array-valued query parameter, which is never one path segment.
 */
function queryCandidates(u: URL): Map<string, unknown> {
  const counts = new Map<string, number>();
  for (const key of u.searchParams.keys()) counts.set(key, (counts.get(key) ?? 0) + 1);
  const out = new Map<string, unknown>();
  for (const [key, value] of u.searchParams) {
    if (counts.get(key) === 1) out.set(key, value);
  }
  return out;
}

/** Render a payload value as a single path segment. */
function asSegment(value: unknown): string {
  const raw = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  return encodeURIComponent(raw);
}

/**
 * Encode a payload onto a URL: path parameters into their segments, everything
 * else onto the query string.
 *
 * Array values become repeated query keys (`symbols=ETH&symbols=BTC`), matching
 * how x402 GET services publish their input. Non-string scalars are stringified;
 * nested objects are JSON-encoded so nothing is silently dropped. Query
 * parameters already present on the URL are preserved, except for one moved into
 * the path, which would otherwise be sent twice.
 *
 * The payload is always preferred over the query string: it is what the caller
 * declared as the service's input, whereas a query key is where a value merely
 * ended up.
 */
export function bindUrl(
  url: string,
  data: Record<string, unknown>,
  placeholders: PathPlaceholder[],
  declaredQuery: Set<string> | null,
): BoundUrl {
  const u = new URL(url);
  const segments = segmentsOf(u.pathname);
  const remaining = new Map(Object.entries(data).filter(([, v]) => v !== undefined && v !== null));
  const fromQuery = queryCandidates(u);
  const boundKeys: string[] = [];
  const boundQueryKeys: string[] = [];
  const unfilled: PathPlaceholder[] = [];

  placeholders.forEach((placeholder, i) => {
    const sole = i === placeholders.length - 1;
    const key = pickField(placeholder, remaining, sole, declaredQuery);
    if (key !== null) {
      segments[placeholder.index] = asSegment(remaining.get(key));
      remaining.delete(key);
      boundKeys.push(key);
      return;
    }
    const queryKey = pickField(placeholder, fromQuery, sole, declaredQuery);
    if (queryKey !== null) {
      segments[placeholder.index] = asSegment(fromQuery.get(queryKey));
      fromQuery.delete(queryKey);
      u.searchParams.delete(queryKey);
      boundQueryKeys.push(queryKey);
      return;
    }
    unfilled.push(placeholder);
  });

  u.pathname = `/${segments.join('/')}`;
  for (const [key, value] of remaining) {
    if (Array.isArray(value)) {
      for (const item of value) u.searchParams.append(key, String(item));
    } else if (typeof value === 'object') {
      u.searchParams.append(key, JSON.stringify(value));
    } else {
      u.searchParams.append(key, String(value));
    }
  }
  return { url: u.toString(), unfilled, boundKeys, boundQueryKeys };
}

/**
 * Message thrown when a placeholder cannot be bound. Like the payload guard,
 * this fires *before* any USDC moves, so it states plainly that nothing was
 * spent and the call is safe to retry once the value is supplied.
 */
export function unfilledPlaceholderMessage(
  url: string,
  unfilled: PathPlaceholder[],
  data: Record<string, unknown>,
): string {
  const names = unfilled.map((p) => `\`${p.name}\``).join(', ');
  let queryKeys: string[] = [];
  try {
    queryKeys = [...new URL(url).searchParams.keys()];
  } catch {
    queryKeys = [];
  }
  // Count what the URL carries as supplied too: a value put on the query string
  // was still supplied, and reporting "none" for a URL the reader can see holds
  // parameters makes the whole message look wrong.
  const supplied = [...new Set([...Object.keys(data), ...queryKeys])];
  const suppliedList = supplied.length
    ? supplied.map((k) => `\`${k}\``).join(', ')
    : 'none';
  return (
    `Not paying ${url}: its path still contains the unfilled parameter ${names}, which is a ` +
    'template placeholder rather than a real value. The server would read the placeholder ' +
    'literally and reject the request, and x402 charges before that happens, so submitting it ' +
    'as-is would spend USDC on a guaranteed failure. NO PAYMENT WAS MADE and none is needed to ' +
    `fix this.\n\nSupply a value for ${names} in the request data (fields supplied: ` +
    `${suppliedList}), or call the URL with the value already substituted into the path. ` +
    "Check the service's description and input schema for what the parameter means."
  );
}
