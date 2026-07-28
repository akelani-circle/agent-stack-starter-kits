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
 * Slash commands and numbered service quick-picks for the chat prompt.
 *
 * Read-only lookups (balance, wallets, gateway, discover) are common enough
 * that routing them through the LLM on every turn is pure latency: they map
 * 1:1 onto a `circle-tools` call the kit already makes for its own tools.
 * These commands call `circle-tools` directly and print the result, without
 * spending a model turn. `/discover` additionally remembers its results so a
 * bare number ("2") at the next prompt can stand in for retyping a service
 * name/URL; that still goes to the agent as a normal turn (it may inspect or
 * pay, subject to the existing approval gate), it just saves the typing.
 */
import * as circle from '@agent-stack-starter-kits/circle-tools';

import { bold, dim, red, yellow } from './theme';

export interface CommandContext {
  /** Emit a namespaced `[adk-kit]` framework line to the scrollback. */
  log: (line: string) => void;
  /** Emit an already-formatted line (JSON, listings) verbatim. */
  out: (line: string) => void;
  /** Refresh the pinned USDC balance readout after a balance-affecting command. */
  refreshBalance: () => Promise<void>;
}

export interface CommandOutcome {
  /** True when the input was a command/quick-pick and must not reach the agent as-is. */
  handled: boolean;
  /** When set (only for a numbered quick-pick), feed this text to the agent as the next turn. */
  forward?: string;
}

const HELP = [
  `${bold('/help')}              show this list`,
  `${bold('/wallets')}           list agent wallet addresses`,
  `${bold('/balance')}           per-wallet USDC balances`,
  `${bold('/gateway')}           Circle Gateway balance for the primary wallet`,
  `${bold('/discover')} <keyword>  search the marketplace; reply with a number to use a result`,
].join('\n');

/** Routes `/command` input and numbered service picks. One instance per session
 * (it remembers the last `/discover` results for the numbered follow-up). */
export function createCommandRouter(ctx: CommandContext) {
  let lastServices: circle.Service[] = [];

  async function showWallets(): Promise<void> {
    const wallets = await circle.listWallets();
    if (wallets.length === 0) {
      ctx.out(dim('  no agent wallet yet — the agent creates one during setup.'));
      return;
    }
    for (const w of wallets) ctx.out(`  ${w.address}`);
  }

  async function showBalance(): Promise<void> {
    const wallets = await circle.listWallets();
    if (wallets.length === 0) {
      ctx.out(dim('  no agent wallet yet — the agent creates one during setup.'));
      return;
    }
    for (const w of wallets) {
      try {
        const balance = await circle.getBalance({ address: w.address });
        const usdc = balance.tokens.find((t) => t.symbol === 'USDC')?.amount ?? '0';
        ctx.out(`  ${circle.shortAddress(w.address)}  $${usdc} USDC`);
      } catch {
        ctx.out(`  ${circle.shortAddress(w.address)}  ${dim('(balance read failed)')}`);
      }
    }
    await ctx.refreshBalance();
  }

  async function showGateway(): Promise<void> {
    const summary = await circle.walletUsdcBalance();
    if (!summary) {
      ctx.out(dim('  no agent wallet yet — the agent creates one during setup.'));
      return;
    }
    const gw = await circle.gatewayBalance({ address: summary.address });
    ctx.out(`  $${gw.total} USDC · ${circle.shortAddress(gw.address)}`);
  }

  async function discover(keyword: string): Promise<void> {
    const results = await circle.searchServices({ keyword });
    lastServices = results;
    if (results.length === 0) {
      // The marketplace search matches on a single term, not a phrase, so a
      // multi-word keyword ("flight services") commonly misses where the
      // shorter one ("flight") hits.
      ctx.out(dim('  no matching services — try a shorter, single-word keyword.'));
      return;
    }
    results.forEach((s, i) => {
      const price = s.price ? ` — ${s.price}` : '';
      ctx.out(`  ${bold(String(i + 1))}. ${s.name}${price}`);
      ctx.out(`     ${dim(s.url)}`);
    });
    ctx.out(dim('  reply with a number (e.g. "1") to use one'));
  }

  async function handleSlash(input: string): Promise<CommandOutcome> {
    const [cmdRaw, ...rest] = input.slice(1).split(/\s+/);
    const cmd = (cmdRaw ?? '').toLowerCase();
    const arg = rest.join(' ').trim();

    try {
      switch (cmd) {
        case 'help':
          ctx.out(HELP);
          break;
        case 'wallets':
          ctx.log('circle_list_wallets');
          await showWallets();
          break;
        case 'balance':
          ctx.log('circle_get_balance (all wallets)');
          await showBalance();
          break;
        case 'gateway':
          ctx.log('circle_get_gateway_balance');
          await showGateway();
          break;
        case 'discover':
          if (!arg) {
            ctx.log(yellow('usage: /discover <keyword>'));
            break;
          }
          ctx.log(`circle_search_services keyword="${arg}"`);
          await discover(arg);
          break;
        default:
          ctx.log(yellow(`unknown command: /${cmd || ''}. Type /help for the list.`));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.log(red(`/${cmd} failed: ${message}`));
    }
    return { handled: true };
  }

  /** A bare number, valid only while a `/discover` result list is in scope. */
  function tryNumberedPick(input: string): string | null {
    if (!/^\d+$/.test(input)) return null;
    const service = lastServices[Number(input) - 1];
    if (!service) return null;
    // Echo the resolution before the agent acts on it: the `/discover` list
    // that gave this number its meaning may have already scrolled out of view,
    // and an approval prompt is coming up that needs to be judged against the
    // right service.
    ctx.log(`picked #${input}: ${service.name} — ${service.url}`);
    // A marketplace search hit is often a path template (a literal "id" or
    // similar segment standing in for a real value), not a callable URL as-is.
    // Under x402 the payment settles BEFORE the request is validated, so paying
    // against an unresolved placeholder burns real USDC on a guaranteed-bad
    // call. Tell the agent to check for that instead of paying on the raw pick.
    return (
      `Use the service "${service.name}" at ${service.url}. Inspect it first. If the URL or its ` +
      'input needs a real value in place of a placeholder (e.g. a literal "id" segment) or any ' +
      'other required parameter, ask me for it before paying — do not pay against a placeholder ' +
      'or a guessed value.'
    );
  }

  return {
    async run(rawInput: string): Promise<CommandOutcome> {
      const input = rawInput.trim();
      if (input.startsWith('/')) return handleSlash(input);
      const forward = tryNumberedPick(input);
      return forward ? { handled: true, forward } : { handled: false };
    },
    /**
     * Keep the numbered quick-pick in sync with searches the agent runs on its
     * own (its `circle_search_services` tool, not just `/discover`). Without
     * this, a bare number after an agent-initiated search would either resolve
     * against a stale `/discover` list (silently picking the wrong service) or
     * fall through as a literal chat message. The caller feeds this from the
     * runner's event stream; the most recent search, from either source, wins.
     */
    setLastServices(services: circle.Service[]): void {
      lastServices = services;
    },
  };
}
