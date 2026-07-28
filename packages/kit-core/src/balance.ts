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
 * The pinned USDC balance readout, shared by every kit.
 *
 * Each kit used to carry its own copy of this, all identical, all awaited at the
 * end of a turn. That await is the reason the "Working…" indicator outlived the
 * agent's reply: reading the balance means shelling out to the Circle CLI, and
 * the input only re-enables on the next `ask()`, so the user watched a spinner
 * for a readout they had not asked to wait for.
 *
 * So there are two ways to refresh, and the distinction is the point:
 *   - `refresh()` — awaited, for startup, where the readout should be on screen
 *     before the first prompt.
 *   - `refreshSoon()` — fire-and-forget, for the end of a turn, so the prompt
 *     comes back immediately and the readout catches up a moment later.
 */
import { formatUsdcBalance, walletUsdcBalance } from '@agent-stack-starter-kits/circle-tools';

/** The slice of the chat UI a readout needs; kits pass their `ChatUi`. */
export interface BalanceTarget {
  setBalance(text: string | null): void;
}

export interface BalanceReadout {
  /** Update the readout and resolve once it is current. */
  refresh(): Promise<void>;
  /**
   * Start an update and return immediately, so a caller never makes the user
   * wait on it. Concurrent calls collapse: a refresh already in flight is
   * followed by exactly one more, never a queue of them.
   */
  refreshSoon(): void;
}

/**
 * Build a readout bound to a chat UI.
 *
 * `target` is read lazily (via a getter) because the kits create their UI inside
 * `main()`, after this is constructed at module scope — and because the readout
 * must simply do nothing before the UI exists, rather than crash.
 */
export function createBalanceReadout(
  target: () => BalanceTarget | null | undefined,
): BalanceReadout {
  let inFlight: Promise<void> | null = null;
  let repeat = false;

  // Best-effort by contract: a balance read must never break the session (no
  // wallet yet, an RPC blip, a logged-out session), so a failure leaves the last
  // shown value in place rather than propagating or blanking the line.
  const update = async (): Promise<void> => {
    try {
      const summary = await walletUsdcBalance();
      target()?.setBalance(summary ? formatUsdcBalance(summary) : null);
    } catch {
      // Leave the last shown balance in place.
    }
  };

  const run = (): Promise<void> => {
    if (inFlight) {
      repeat = true;
      return inFlight;
    }
    inFlight = (async () => {
      await update();
      // Collapse everything that arrived mid-flight into one trailing pass, so
      // the readout still ends up current without one refresh per caller.
      while (repeat) {
        repeat = false;
        await update();
      }
      inFlight = null;
    })();
    return inFlight;
  };

  return {
    refresh: run,
    refreshSoon: () => {
      // `update` swallows its own failures, so there is no rejection to handle;
      // `void` documents that the result is deliberately not awaited.
      void run();
    },
  };
}
