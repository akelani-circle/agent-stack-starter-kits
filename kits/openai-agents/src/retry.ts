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

import { kitLine, yellow } from './theme';

export const MAX_RETRIES = 4;

interface MaybeStatusError {
  status?: number;
  headers?: Record<string, string>;
  cause?: unknown;
}

/**
 * Walk the error cause chain to find an HTTP status code. The OpenAI Agents
 * SDK wraps the original API error; unwrapping one level is usually enough.
 */
function statusOf(error: unknown): number | undefined {
  const e = error as MaybeStatusError;
  if (typeof e?.status === 'number') return e.status;
  if (e?.cause !== undefined) return statusOf(e.cause);
  return undefined;
}

/**
 * Parse how long the provider wants us to wait from a 429 response.
 * Checks response headers first (most accurate), then falls back to
 * the "Please try again in X.Xs" text in the error message.
 */
function retryAfterMs(error: unknown): number | undefined {
  const e = error as MaybeStatusError;
  const headers = e?.headers;
  if (headers) {
    const raw = headers['retry-after'] ?? headers['x-ratelimit-reset-tokens'];
    if (raw !== undefined) {
      const secs = parseFloat(raw);
      if (!isNaN(secs)) return Math.ceil(secs) * 1_000;
    }
  }
  const msg = error instanceof Error ? error.message : '';
  const m = /try again in ([\d.]+)s/i.exec(msg);
  if (m?.[1]) return Math.ceil(parseFloat(m[1])) * 1_000;
  if (e?.cause !== undefined) return retryAfterMs(e.cause);
  return undefined;
}

/**
 * True when the error is worth retrying: 429 (rate limit), 5xx (server errors
 * including 529 overloaded), or network-level failures with no status code.
 * Fails fast on 4xx client errors (bad key, bad request) so a broken call
 * does not burn all retry budget.
 */
function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (typeof status === 'number') return status === 429 || status >= 500;
  const msg = error instanceof Error ? error.message.toLowerCase() : '';
  return msg.includes('overloaded') || msg.includes('529') || msg.includes('econnreset');
}

/**
 * Run `fn`, retrying up to MAX_RETRIES times on transient provider errors.
 * Logs each retry in yellow so the user knows the app is not frozen.
 * Delay: the provider's retry-after hint when available (parsed from headers
 * or error message), otherwise exponential backoff (1 s, 2 s, 4 s, 8 s).
 * ±25% jitter is applied in both cases to avoid synchronized retries.
 */
export async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error) || attempt >= MAX_RETRIES) throw error;
      attempt++;
      const status = statusOf(error);
      const reason =
        status === 529 ? 'overloaded' : status !== undefined ? `HTTP ${status}` : 'unreachable';
      const last = attempt >= MAX_RETRIES;
      const tail = last ? 'giving up' : `retrying (${attempt}/${MAX_RETRIES}) …`;
      console.log(kitLine(yellow(`${label}: model ${reason} — ${tail}`)));
      if (last) throw error;
      const base = retryAfterMs(error) ?? 1_000 * 2 ** (attempt - 1);
      const jitter = base * 0.25 * (Math.random() * 2 - 1);
      await new Promise((r) => setTimeout(r, Math.max(0, Math.round(base + jitter))));
    }
  }
}
