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

import { runCircle, runCircleJson } from './cli';
import { getBalance } from './wallet';
import {
  CHAIN_PREFERENCE,
  chainCli,
  chainFromNetwork,
  chainLabel,
  DEFAULT_CHAIN,
  type Chain,
} from './chains';
import type {
  AcceptOption,
  FetchServiceResult,
  PaymentResult,
  Service,
  ServiceAccepts,
  ServiceInspection,
} from './types';
import { bindUrl, findPathPlaceholders, unfilledPlaceholderMessage } from './paths';
import {
  buildResponseVocab,
  declaredQueryParams,
  findFieldViolations,
  preSpendErrorMessage,
  requestSchemaShape,
} from './validate';

const TX_HASH_REGEX = /0x[a-fA-F0-9]{64}/;
/**
 * Request timeout for a paid call, in seconds. The CLI defaults to 30s, which is
 * too tight for slower x402 endpoints: under x402 the payment is submitted
 * *before* the upstream request resolves, so a timeout still spends USDC. A
 * larger ceiling lets a slow-but-valid endpoint answer instead of wasting a
 * charged call.
 */
const PAY_TIMEOUT_SECONDS = 60;
/** Extra attempts for idempotent read commands when the network blips. */
const READ_RETRIES = 3;
/** USDC has 6 decimals; the marketplace quotes payment amounts in atomic units. */
const USDC_DECIMALS = 6;

export interface SearchServicesInput {
  keyword: string;
}

export interface InspectServiceInput {
  url: string;
}

export interface FetchServiceInput {
  url: string;
}

export interface PayServiceInput {
  url: string;
  address: string;
  data: Record<string, unknown>;
  /**
   * HTTP method the service expects, from its inspection. Defaults to GET.
   * GET/DELETE send `data` as URL query parameters; POST/PUT/PATCH send it as a
   * JSON request body.
   */
  method?: string;
  /**
   * Chain to settle the payment on. Must be a chain the seller offers (see
   * preferredChain). Defaults to Base.
   */
  chain?: Chain;
}

/**
 * Loose shape of one item in `circle services search` JSON output (CLI 0.0.3).
 * Every field is optional so a CLI shape change degrades gracefully instead of
 * throwing.
 */
interface RawSearchItem {
  resource?: string;
  accepts?: Array<{ amount?: string; network?: string }>;
  metadata?: {
    provider?: { name?: string; description?: string };
    description?: string;
    path?: string;
    method?: string;
  };
}

/** Loose shape of the `circle services inspect` JSON `data` object. */
interface RawInspection {
  url?: string;
  status?: string;
  httpStatus?: number;
  description?: string;
  provider?: {
    name?: string;
    description?: string;
    openApiUrl?: string;
    docsUrl?: string;
  };
  price?: { amount?: string; formatted?: string };
  input?: unknown;
  method?: string;
}

/** Convert an atomic USDC amount (e.g. "4000") to whole USDC (0.004). */
function atomicToUsdc(atomic: string | undefined): number | undefined {
  if (!atomic) return undefined;
  const n = Number(atomic);
  return Number.isFinite(n) ? n / 10 ** USDC_DECIMALS : undefined;
}

/** Format an atomic USDC amount (e.g. "4000") as a human string ("0.004 USDC"). */
function formatUsdc(atomic: string | undefined): string | undefined {
  const n = atomicToUsdc(atomic);
  return n === undefined ? undefined : `${n} USDC`;
}

/**
 * Pull the result array out of `circle services search` output. The CLI (0.0.3)
 * wraps results as `{ data: { items: [...] } }`; a bare `{ items: [...] }` is
 * also tolerated so a minor CLI change does not silently zero out results.
 */
function extractSearchItems(raw: unknown): RawSearchItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  const data = o.data as Record<string, unknown> | undefined;
  if (data && Array.isArray(data.items)) return data.items as RawSearchItem[];
  if (Array.isArray(o.items)) return o.items as RawSearchItem[];
  return [];
}

/**
 * Pick the payment option the kit would actually settle on, in CHAIN_PREFERENCE
 * order. Quoting `accepts[0]` blindly misprices any listing whose first option
 * is a network the kit cannot pay (Solana leads several marketplace entries), so
 * unsupported networks are skipped rather than reported as the price.
 */
function preferredAccept(
  accepts: Array<{ amount?: string; network?: string }> | undefined,
): { amount?: string; chain: Chain } | null {
  if (!accepts?.length) return null;
  for (const chain of CHAIN_PREFERENCE) {
    const match = accepts.find((a) => a.network && chainFromNetwork(a.network) === chain);
    if (match) return { amount: match.amount, chain };
  }
  return null;
}

function mapSearchItem(item: RawSearchItem): Service {
  const meta = item.metadata ?? {};
  const provider = meta.provider ?? {};
  const accept = preferredAccept(item.accepts);
  return {
    url: item.resource ?? '',
    name: provider.name ?? meta.path ?? item.resource ?? 'unknown service',
    description: meta.description ?? provider.description,
    price: formatUsdc(accept?.amount),
    chain: accept?.chain,
    method: meta.method ? meta.method.toUpperCase() : undefined,
  };
}

/** Unwrap the `{ data: ... }` envelope the CLI puts around inspect output. */
function unwrapData(raw: unknown): RawInspection {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  if (o.data && typeof o.data === 'object') return o.data as RawInspection;
  return o as RawInspection;
}

/** `circle services search "<keyword>" --output json` */
export async function searchServices(input: SearchServicesInput): Promise<Service[]> {
  const raw = runCircleJson<unknown>(['services', 'search', input.keyword, '--output', 'json'], {
    retries: READ_RETRIES,
  });
  return extractSearchItems(raw).map(mapSearchItem);
}

/** `circle services inspect "<url>" --output json` */
export async function inspectService(input: InspectServiceInput): Promise<ServiceInspection> {
  const raw = runCircleJson<unknown>(['services', 'inspect', input.url, '--output', 'json'], {
    retries: READ_RETRIES,
  });
  const data = unwrapData(raw);
  const provider = data.provider ?? {};
  return {
    url: data.url ?? input.url,
    name: provider.name ?? data.description ?? data.url ?? input.url,
    description: data.description ?? provider.description,
    price: data.price?.formatted ?? formatUsdc(data.price?.amount),
    priceUsdc: atomicToUsdc(data.price?.amount),
    schema: data.input,
    health: data.status,
    httpStatus: typeof data.httpStatus === 'number' ? data.httpStatus : undefined,
    method: data.method ? data.method.toUpperCase() : undefined,
    openApiUrl: provider.openApiUrl,
    docsUrl: provider.docsUrl,
  };
}

/**
 * Plain, unpaid HTTP GET of a service endpoint: the free-tier path.
 *
 * x402 semantics: an unpaid GET of a paid resource answers HTTP 402 with a
 * payment challenge; a free endpoint answers 200 with the data itself. The kit's
 * payService path only handles the 402 case, so a free endpoint (e.g. a catalog
 * or index that publishes no `accepts[]`) has no payment to make and must be
 * read with this helper instead.
 *
 * Returns the body for the free case and flags `paymentRequired` for the 402
 * case so the caller can route to inspectService / payService.
 */
export async function fetchService(input: FetchServiceInput): Promise<FetchServiceResult> {
  let res: Response;
  try {
    res = await fetch(input.url, { method: 'GET' });
  } catch (e) {
    throw new Error(`Could not reach ${input.url}: ${(e as Error).message}`);
  }
  const contentType = res.headers.get('content-type') ?? undefined;
  const raw = await res.text();
  // Re-stringify JSON compact so the agent gets a valid, dense payload; leave
  // any other content type exactly as the server sent it.
  let body = raw;
  if (contentType?.includes('application/json')) {
    try {
      body = JSON.stringify(JSON.parse(raw));
    } catch {
      // Header claims JSON but the body is not, so return the raw text.
    }
  }
  return {
    url: input.url,
    status: res.status,
    paymentRequired: res.status === 402,
    contentType,
    body,
  };
}

/** Loose shape of one entry in an x402 402-challenge `accepts[]` array. */
interface Raw402Accept {
  network?: string;
  amount?: string;
  extra?: { name?: string };
}

/**
 * Decode a base64 (or base64url) JSON string into an object, or null if it is
 * not valid base64-encoded JSON. Used for the x402 v2 `payment-required` header.
 */
function decodeBase64Json(value: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(value, 'base64').toString('utf8');
    const obj = JSON.parse(json) as unknown;
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Extract the x402 `accepts[]` from a 402 response. The challenge travels one of
 * two ways depending on the x402 version a seller speaks:
 *   - v1: a JSON response *body* `{ accepts: [...] }`.
 *   - v2: an empty body plus a base64-encoded JSON `payment-required` *header*
 *     `{ x402Version: 2, accepts: [...] }`.
 * Both must be handled: a v2 seller (e.g. StableEnrich) sends an empty body, so
 * a body-only reader sees no challenge and wrongly rejects a payable service.
 * Returns the accepts array, or null when neither transport carries a challenge
 * (e.g. a 405 to a wrong-method probe).
 */
async function readAccepts(res: Response): Promise<Raw402Accept[] | null> {
  // Header transport (x402 v2) first: it is present even when the body is empty.
  const header = res.headers.get('payment-required');
  if (header) {
    const decoded = decodeBase64Json(header.trim());
    if (decoded && Array.isArray(decoded.accepts)) return decoded.accepts as Raw402Accept[];
  }
  // Body transport (x402 v1).
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return null;
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { accepts?: unknown }).accepts)) {
    return (parsed as { accepts: Raw402Accept[] }).accepts;
  }
  return null;
}

/**
 * Fetch a service's x402 payment challenge and normalise its `accepts[]` into
 * the chains and schemes the kit can act on.
 *
 * An unpaid GET to an x402 resource returns HTTP 402 with an `accepts` array.
 * Each entry is either vanilla x402 or Gateway-batched. The Gateway scheme is
 * identified by `extra.name === 'GatewayWalletBatched'`, NOT the top-level
 * `scheme` field (which reads `exact` for both). Entries on a supported chain
 * (Base or Polygon, matched by CAIP-2 id or x402 short name) are kept and
 * tagged with their chain; any other network is reported as unsupported.
 */
export async function getServiceAccepts(url: string, method = 'GET'): Promise<ServiceAccepts> {
  // Probe with the SAME method the payment will use. An x402 challenge is bound
  // to the route's method: a POST-only endpoint answers 405 (not 402) to a GET,
  // so a GET probe would miss the challenge entirely. The 402 is returned before
  // the request body is read, so the probe needs no body to see the options.
  const probeMethod = method.toUpperCase();
  // A body method needs a body on the probe. x402 middleware normally answers
  // 402 before the handler runs, but a seller that parses or schema-validates
  // the body first answers 400/422 to a bodyless POST — which reads here as "no
  // challenge" and wrongly marks a payable service unpayable. An empty JSON
  // object is the cheapest body that survives that parse; it is never charged,
  // because the 402 precedes any handling.
  const probeInit: RequestInit = BODY_METHODS.has(probeMethod)
    ? { method: probeMethod, headers: { 'content-type': 'application/json' }, body: '{}' }
    : { method: probeMethod };
  let res: Response;
  try {
    res = await fetch(url, probeInit);
  } catch (e) {
    throw new Error(
      `Could not reach ${url} to read its x402 payment options: ${(e as Error).message}`,
    );
  }
  // Read the challenge from either transport (v2 header or v1 body). A null
  // result means no challenge was returned at all, and the right guidance
  // depends on the status: a 2xx is a free endpoint that served data without
  // demanding payment (so it should be read, not paid), whereas a non-2xx
  // (typically 405) is most often a wrong-method probe missing the challenge.
  const accepts = await readAccepts(res);
  if (accepts === null) {
    if (res.ok) {
      throw new Error(
        `${url} returned data without requiring payment (HTTP ${res.status}), so it is a free ` +
          'endpoint, not a paid x402 resource. Read it with fetch_service instead of pay_service.',
      );
    }
    throw new Error(
      `${url} did not return an x402 challenge to a ${probeMethod} request (HTTP ${res.status}). ` +
        'If the service expects a different HTTP method, pass the `method` from ' +
        'circle_inspect_service so the payment options are read with that method.',
    );
  }
  if (accepts.length === 0) {
    throw new Error(
      `${url} published no x402 payment options, so it is not a paid x402 resource. ` +
        'If it is a free endpoint, read it with fetch_service instead of pay_service.',
    );
  }
  const options: AcceptOption[] = [];
  const unsupported = new Set<string>();
  for (const a of accepts) {
    const network = a.network ?? '';
    const chain = network ? chainFromNetwork(network) : null;
    if (!chain) {
      if (network) unsupported.add(network);
      continue;
    }
    options.push({
      kind: a.extra?.name === 'GatewayWalletBatched' ? 'gateway' : 'vanilla',
      chain,
      amountAtomic: a.amount ?? '',
    });
  }
  return { url, options, unsupportedNetworks: [...unsupported] };
}

/**
 * Pick the chain to pay a service on: the first chain in CHAIN_PREFERENCE the
 * seller offers, so Base wins when available and Polygon is the fallback.
 * Returns null when the seller offers no supported chain.
 */
export function preferredChain(accepts: ServiceAccepts): Chain | null {
  for (const chain of CHAIN_PREFERENCE) {
    if (accepts.options.some((o) => o.chain === chain)) return chain;
  }
  return null;
}

/** A wallet's USDC on a chain, or null when the balance cannot be read. */
async function usdcOn(address: string, chain: Chain): Promise<number | null> {
  try {
    const balance = await getBalance({ address, chain });
    const usdc = balance.tokens.find((t) => t.symbol === 'USDC')?.amount;
    const n = Number(usdc ?? '0');
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** The cheapest price the seller quotes on a chain, in whole USDC. */
function priceOn(accepts: ServiceAccepts, chain: Chain): number | null {
  const amounts = accepts.options
    .filter((o) => o.chain === chain)
    .map((o) => atomicToUsdc(o.amountAtomic))
    .filter((n): n is number => n !== undefined);
  return amounts.length ? Math.min(...amounts) : null;
}

/**
 * Pick the chain to pay a service on, preferring one the wallet can actually
 * afford.
 *
 * `preferredChain` answers only "which chains does the seller offer", so a
 * wallet funded on Polygon paying a seller that offers both chains would be sent
 * to Base and fail for want of funds. This walks CHAIN_PREFERENCE and returns
 * the first chain that is both offered *and* covered by the wallet's balance
 * there, so Base still wins whenever it is funded and Polygon is used when it is
 * the only chain with money on it.
 *
 * Falls back to `preferredChain` when no chain is affordable (or when balances
 * cannot be read), leaving the pre-spend price guard to report the shortfall
 * against a concrete chain rather than silently picking nothing.
 */
export async function chooseChain(
  accepts: ServiceAccepts,
  address: string,
): Promise<Chain | null> {
  const offered = CHAIN_PREFERENCE.filter((c) => accepts.options.some((o) => o.chain === c));
  if (offered.length <= 1) return offered[0] ?? null;
  for (const chain of offered) {
    const [balance, price] = await Promise.all([
      usdcOn(address, chain),
      Promise.resolve(priceOn(accepts, chain)),
    ]);
    if (balance !== null && price !== null && balance >= price) return chain;
  }
  return preferredChain(accepts);
}

/**
 * Whether the service requires a Circle Gateway (batched) payment on the given
 * chain. The CLI auto-routes to Gateway whenever the seller advertises it on
 * the chain being paid, so a single Gateway option is enough to require it.
 */
export function sellerRequiresGateway(accepts: ServiceAccepts, chain: Chain): boolean {
  return accepts.options.some((o) => o.chain === chain && o.kind === 'gateway');
}

/**
 * CLI failure substrings that mean the x402 payment was already submitted (the
 * USDC moved) but the upstream request failed afterwards: a server-side reject,
 * a timeout, or a dropped response. Under x402 the charge happens before the
 * request resolves, so these are non-refundable and MUST NOT be retried with a
 * fresh payment to the same URL.
 */
const PAYMENT_SUBMITTED_PATTERNS = [
  'payment submitted',
  'payment was submitted',
  'payment may have been submitted',
  'funds may have moved',
];

function paymentAlreadySubmitted(detail: string): boolean {
  return PAYMENT_SUBMITTED_PATTERNS.some((p) => detail.includes(p));
}

/**
 * Translate a raw `circle services pay` failure into an actionable error.
 *
 * Two cases get rewritten:
 *
 * 1. Gateway routing: the CLI auto-routes to Circle Gateway whenever a seller
 *    advertises it, even when the wallet holds only vanilla USDC, and there is
 *    no flag to force vanilla (CLI 0.0.3). The resulting "No/Insufficient
 *    Gateway balance" message is opaque; rewrite it into the concrete next step.
 *
 * 2. Payment-submitted-but-request-failed: the USDC already moved but the
 *    upstream answered an error (e.g. a 400 from a service whose published
 *    schema is inaccurate) or timed out. This is a terminal, non-retryable
 *    failure: re-paying the same URL just spends more USDC for the same result.
 *    Rewrite it so the agent stops retrying and chooses a different service.
 */
function explainPayError(e: unknown, url: string): Error {
  const message = e instanceof Error ? e.message : String(e);
  const lower = message.toLowerCase();
  if (
    lower.includes('no gateway balance found') ||
    lower.includes('insufficient gateway balance')
  ) {
    return new Error(
      'This seller requires a Circle Gateway (batched) payment and the wallet has no ' +
        'Gateway balance on the chain the seller settles on. Call gateway_deposit for ' +
        `this service URL, then retry the payment.\n\nUnderlying CLI error: ${message}`,
    );
  }
  if (paymentAlreadySubmitted(lower)) {
    return new Error(
      `The USDC payment for ${url} was already submitted and has been spent, but the ` +
        'request failed afterwards (the server rejected it or it timed out). This is ' +
        'NOT a payload problem you can fix by retrying: x402 charges before the request ' +
        'resolves, so re-paying this URL just spends more USDC for the same failure. ' +
        "Do not pay this URL again. The service's published input schema may be " +
        'inaccurate, or the endpoint may be unhealthy. Choose a different service, or ' +
        `report this one as broken.\n\nUnderlying CLI error: ${message}`,
    );
  }
  return e instanceof Error ? e : new Error(message);
}

/**
 * HTTP methods that carry a request body. Everything else (GET, DELETE) takes
 * its input as URL query parameters instead.
 */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Best-effort tx-hash extraction. A bare 64-hex hash in the text wins; failing
 * that, x402 settle receipts (the `x-payment-response` header surfaced as
 * `payment.receipt`) are base64-encoded JSON like `{"transaction":"0x..."}`, so
 * decode and look inside. Never throws: a missing hash is not an error.
 */
function extractTxHash(source: string | undefined): string | undefined {
  if (!source) return undefined;
  const direct = source.match(TX_HASH_REGEX)?.[0];
  if (direct) return direct;
  try {
    const decoded = Buffer.from(source, 'base64').toString('utf8');
    return decoded.match(TX_HASH_REGEX)?.[0];
  } catch {
    return undefined;
  }
}

/** The `{ response, payment }` envelope `circle services pay --output json` prints. */
interface RawPayEnvelope {
  response?: unknown;
  payment?: { amount?: string; receipt?: string };
}

/**
 * `circle services pay "<url>" --address <addr> --chain BASE -X <method> [-d '<json>'] --output json`
 *
 * The CLI's `-d/--data` flag implies POST and sends a JSON request body. A GET
 * service reads its input from the URL query string, so for GET/DELETE the
 * payload is encoded onto the URL and `-d` is omitted; sending a body to a GET
 * endpoint makes the server see no input (and still spends USDC, since the x402
 * payment is submitted before the request resolves).
 *
 * Ahead of that split, path parameters are bound: a marketplace resource is a
 * *template* (`/flights/{ident}`), and a field belonging to its path has to be
 * substituted into the path rather than appended to the query, where the server
 * would never read it. See `./paths`.
 *
 * `--output json` is required. The CLI's default `table` output for a paid call
 * prints *only the service response body, with no tx hash* — so a hash-presence
 * check there fails on every successful payment whose body has no 0x… hash,
 * making the caller re-pay in a loop. With JSON the result is wrapped as
 * `{ response, payment: { amount, receipt } }`, and success is the CLI exit code
 * (a real failure throws), never whether a hash was found.
 */
/**
 * Reject a payload the seller is guaranteed to refuse, BEFORE any USDC is spent.
 *
 * x402 submits payment before the server validates the body, so a bad field name
 * or an out-of-enum value costs money for a certain 422. This re-reads the
 * service's published constraints (its inline input schema for enums, and its
 * OpenAPI response schema for the field names it can return) and throws if the
 * payload provably violates them — a free failure the caller can fix and retry.
 *
 * It FAILS OPEN: any error reading or parsing those constraints is swallowed and
 * the payment proceeds, so a flaky spec fetch never blocks an otherwise valid
 * call. Only a positively-proven-invalid value stops the payment.
 */
/**
 * `health` values that mean the marketplace could not get a payable answer out
 * of the endpoint. Anything else — including the unknown-to-us — is treated as
 * fine, so a new status string never blocks a working service.
 */
const DEAD_HEALTH = new Set(['down', 'offline', 'unreachable', 'unhealthy', 'error', 'unpayable']);

/**
 * Refuse to pay a service the marketplace has already observed to be broken.
 *
 * The kit surfaces `health` on every inspect and its tool descriptions promise
 * the agent it means something, but nothing acted on it: a service the
 * marketplace last saw returning 500s was paid anyway, and x402 charges before
 * the upstream answers, so the USDC went to buy an error.
 *
 * Only positively-bad signals block: a `health` in {@link DEAD_HEALTH}, or a
 * probe `httpStatus` of 5xx. A missing or unrecognised status proceeds.
 */
function assertServiceHealthy(url: string, inspection: ServiceInspection | null): void {
  if (!inspection) return;
  const health = inspection.health?.toLowerCase();
  const dead = (health && DEAD_HEALTH.has(health)) || (inspection.httpStatus ?? 0) >= 500;
  if (!dead) return;
  const detail = [
    health ? `status \`${inspection.health}\`` : null,
    inspection.httpStatus ? `last probe returned HTTP ${inspection.httpStatus}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  throw new Error(
    `Not paying ${url}: the marketplace reports this service as not working (${detail}). ` +
      'x402 charges before the upstream request resolves, so paying a service that is down ' +
      'buys an error. NO PAYMENT WAS MADE. Choose a different service.',
  );
}

/**
 * Refuse to pay when the wallet cannot cover the price, before the CLI is
 * invoked. Nothing previously compared the two, so an underfunded wallet reached
 * the payment path and failed there with a CLI-level error. Fails open: an
 * unknown price or an unreadable balance proceeds untouched.
 */
async function assertCanAfford(
  input: PayServiceInput,
  chain: Chain,
  inspection: ServiceInspection | null,
): Promise<void> {
  const price = inspection?.priceUsdc;
  if (price === undefined || !Number.isFinite(price)) return;
  const balance = await usdcOn(input.address, chain);
  if (balance === null || balance >= price) return;
  throw new Error(
    `Not paying ${input.url}: it costs ${price} USDC but wallet ${input.address} holds only ` +
      `${balance} USDC on ${chainLabel(chain)}. NO PAYMENT WAS MADE. Fund the wallet on ` +
      `${chainLabel(chain)} (circle_wallet_fund on testnet, or circle_fund_fiat) and retry, ` +
      'or use a wallet that already holds enough there.',
  );
}

async function assertPayloadValid(
  input: PayServiceInput,
  method: string,
  inspection: ServiceInspection | null,
): Promise<void> {
  if (!inspection) return; // Cannot read constraints; do not block the payment.
  const shape = requestSchemaShape(inspection.schema);
  if (!shape) return;
  let vocab: Set<string> | null = null;
  try {
    vocab = await buildResponseVocab(inspection.openApiUrl, input.url, method);
  } catch {
    vocab = null;
  }
  const problems = findFieldViolations(input.data, { ...shape, vocab });
  if (problems.length) {
    throw new Error(preSpendErrorMessage(input.url, problems));
  }
}

export async function payService(input: PayServiceInput): Promise<PaymentResult> {
  const method = (input.method ?? 'GET').toUpperCase();
  // Read the seller's published contract once; both guards below rely on it, and
  // neither is worth a second CLI round trip. A failure here means "unknown", and
  // every check downstream treats unknown as permission to proceed.
  let inspection: ServiceInspection | null = null;
  try {
    inspection = await inspectService({ url: input.url });
  } catch {
    inspection = null;
  }

  // Every guard below runs before the CLI is invoked, so each one that fires
  // costs nothing. Cheapest and most decisive first: a dead service, then a
  // balance that cannot cover the price, then the payload itself.
  assertServiceHealthy(input.url, inspection);
  await assertCanAfford(input, input.chain ?? DEFAULT_CHAIN, inspection);
  // x402 charges before the server validates, so a provably-bad field must be
  // caught here, not after the USDC is gone.
  await assertPayloadValid(input, method, inspection);

  // Bind path parameters before spending. A marketplace resource is a template,
  // so a payload field belonging to the path has to be substituted into it: left
  // on the query string it is ignored and the server reads the placeholder itself
  // as the value, which is a paid failure every time.
  const sendsBody = BODY_METHODS.has(method);
  // The payload is handed to the probe as well: a placeholder the caller renamed
  // after one of its own fields (`/flights/ident` under the route `[id]`) reads
  // as a filled segment without it, and would be paid for.
  const placeholders = await findPathPlaceholders(input.url, method, input.data);
  const declaredQuery = declaredQueryParams(inspection?.schema);
  // A body method still needs its path bound, but its payload belongs in the body,
  // so only path-eligible fields are offered to the binder.
  const bindable = sendsBody
    ? Object.fromEntries(
        Object.entries(input.data).filter(([k]) =>
          placeholders.some((p) => p.name.toLowerCase() === k.toLowerCase()),
        ),
      )
    : input.data;
  const bound = bindUrl(input.url, bindable, placeholders, declaredQuery);
  if (bound.unfilled.length) {
    throw new Error(unfilledPlaceholderMessage(input.url, bound.unfilled, input.data));
  }
  const url = bound.url;
  // Fields consumed by the path must not be repeated in the body.
  const body = sendsBody
    ? Object.fromEntries(
        Object.entries(input.data).filter(([k]) => !bound.boundKeys.includes(k)),
      )
    : null;
  const args = [
    'services',
    'pay',
    url,
    '--address',
    input.address,
    '--chain',
    chainCli(input.chain ?? DEFAULT_CHAIN),
    '--method',
    method,
    '--timeout',
    String(PAY_TIMEOUT_SECONDS),
    '--output',
    'json',
  ];
  if (body) {
    args.push('--data', JSON.stringify(body));
  }

  let out: string;
  try {
    out = runCircle(args);
  } catch (e) {
    throw explainPayError(e, input.url);
  }

  // The call settled the moment runCircle returned without throwing; from here
  // we only shape the body for the caller, never re-derive success.
  const trimmed = out.trim();
  let envelope: RawPayEnvelope;
  try {
    envelope = JSON.parse(trimmed) as RawPayEnvelope;
  } catch {
    // Non-JSON stdout (a quiet-mode plain-text body, say): hand it back as-is.
    return {
      response: trimmed,
      txHash: extractTxHash(trimmed),
      serviceUrl: input.url,
      amount: '',
    };
  }

  const response =
    envelope.response === undefined
      ? trimmed
      : typeof envelope.response === 'string'
        ? envelope.response
        : JSON.stringify(envelope.response);

  return {
    response,
    txHash: extractTxHash(envelope.payment?.receipt) ?? extractTxHash(trimmed),
    serviceUrl: input.url,
    amount: envelope.payment?.amount ?? '',
  };
}
