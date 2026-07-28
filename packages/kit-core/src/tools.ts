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

import {
  chainLabel,
  chooseChain,
  getServiceAccepts,
  isWalletDeployed,
  preferredChain,
  sellerRequiresGateway,
  type Chain,
  type GatewayDepositMethod,
} from '@agent-stack-starter-kits/circle-tools';

import { SETUP_SKILL_URL, SUB_SKILL_CATALOG } from './skill';
import { bold, colorizeJson, green, red, yellow } from './theme';

/**
 * The two tools that move USDC. Each kit gates these behind human approval —
 * via its framework's own hook where one exists, otherwise via `approveSpend`
 * inside the tool. Named here so the list is single-sourced.
 */
export const SPEND_TOOL_NAMES = ['circle_pay_service', 'circle_gateway_deposit'] as const;

/** The chains the kits can pay on, in preference order. Kits wrap this in their own zod enum. */
export const CHAIN_VALUES = ['BASE', 'POLYGON'] as const;

/** HTTP methods a service endpoint may expect. Kits wrap this in their own zod enum. */
export const HTTP_METHOD_VALUES = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

/** Collapse a value to one line and cap its length, for compact log lines. */
export function preview(value: string, max = 120): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * The model-facing description of every tool, single-sourced so the six kits
 * cannot drift apart on wording.
 *
 * These describe *what each tool does and what its arguments mean* — nothing
 * about when to call it, in what order, or what to do afterwards. That guidance
 * belongs to the marketplace's own skill markdown (see `skill.ts`), which is the
 * only thing in these kits that instructs the agent. Ordering and safety are
 * enforced in code instead: the preflight helpers below refuse an unpayable
 * call and return an actionable message the model reads back as a tool result.
 */
export const TOOL_DESCRIPTIONS = {
  fetch_setup_skill: `Fetch the Circle Agent setup skill from ${SETUP_SKILL_URL}. Equivalent to "curl -sL ${SETUP_SKILL_URL}". Returns its raw markdown.`,

  fetch_sub_skill: `Fetch a Circle Agent sub-skill markdown by name. Available sub-skills:\n${SUB_SKILL_CATALOG}`,

  circle_list_wallets: 'List existing Circle agent wallets on Base. Returns an array of { address }.',

  circle_create_wallet: 'Create a new Circle agent wallet on Base. Returns { address }.',

  circle_get_balance:
    'Read the USDC and token balances held by a wallet address on a chain. Defaults to Base.',

  circle_deploy_wallet:
    `Deploy an agent wallet's Smart Contract Account on-chain via a one-time, ` +
    'zero-value self-transfer. A newly created wallet is counterfactual: it can receive USDC ' +
    'but cannot sign x402 payments until deployed, and deployment is per-chain. Idempotent and ' +
    'gas-abstracted: it spends nothing, and on an already-deployed wallet it sends no transaction.',

  circle_wallet_fund:
    'Fund an agent wallet with testnet USDC on Base. method="crypto" draws from the testnet ' +
    'faucet; method="fiat" runs the test card flow.',

  circle_fund_fiat:
    'Generate a Transak on-ramp URL for buying tokens with fiat (card or bank). Returns a `url` ' +
    'the user opens to complete the purchase, after which the tokens deposit into the wallet on ' +
    'the chosen chain. This tool only builds the URL and moves no USDC itself. Mainnet only.',

  circle_search_services:
    'Search the Circle Agent Marketplace for x402-compatible services matching a keyword.',

  circle_inspect_service:
    'Inspect an x402 service. Returns its price, input schema, HTTP method, and health.',

  fetch_service:
    'GET a service endpoint without paying. Returns the response status and body, plus ' +
    '`paymentRequired`, which is true when the endpoint answered HTTP 402 rather than serving ' +
    'its data for free.',

  circle_get_gateway_balance:
    "Read the wallet's Circle Gateway balance on a chain: the off-chain batched-payment pool, " +
    'which is separate from the on-chain balance reported by circle_get_balance. Defaults to Base.',

  circle_pay_service:
    'Pay for an x402 service with a Circle USDC payment and return the response bought. Settles ' +
    'on Base or Polygon, picked from the payment options the seller publishes and the wallet ' +
    "balance on each, and pays under whichever scheme the seller requires — vanilla x402 or " +
    'Circle Gateway.',

  circle_gateway_deposit:
    "Move USDC into the wallet's Circle Gateway balance, the pool a seller draws from when it " +
    "requires Gateway (batched) x402 payments. The chain comes from the service's published " +
    'Gateway options, Base preferred and Polygon otherwise, and the deposit method follows from ' +
    'it: Polygon uses eco (~30s, sourced from the wallet\'s Base USDC), Base uses direct (13-19 ' +
    'min, consumes gas on Base). Spends the deposit amount plus a fee.',

  circle_login:
    'Log in to the Circle agent wallet with email + OTP, or confirm an existing session. Prompts ' +
    'in the terminal for the email address and the OTP from the inbox, neither of which is ' +
    "stored, and never accepts Circle's Terms of Use on the user's behalf. When a session is " +
    'already valid it changes nothing and reports so.',

  circle_logout:
    'Log out of the Circle agent wallet and clear its stored credentials. Safe to call when no ' +
    'session exists, in which case it reports that nothing was logged out.',
} as const;

/** Model-facing descriptions of the arguments shared by more than one tool. */
export const PARAM_DESCRIPTIONS = {
  address: 'Agent wallet address (0x...).',

  chain: 'Chain to act on, BASE or POLYGON. Defaults to BASE.',

  serviceUrl: 'The service URL, exactly as the marketplace publishes it.',

  subSkillName: 'Sub-skill name, without the .md extension.',

  httpMethod:
    'HTTP method the service expects. A GET service reads the payload as URL query parameters; ' +
    'POST, PUT and PATCH read it as a JSON request body. Defaults to GET.',

  // A JSON string rather than an object: an open payload object collapses to a
  // closed, propertyless `{}` under the strict tool schemas these SDKs generate,
  // so the model could never fill it and every paid call would send an empty
  // body. A string carries the payload verbatim instead.
  //
  // It also states that this argument is where *all* the input goes. That is a
  // fact about the argument, not sequencing advice, and it has to be here: a
  // caller that encodes the input into the URL itself leaves this empty, and the
  // kit then has nothing to substitute into a templated path.
  dataJson:
    'JSON-encoded payload object matching the service input schema, e.g. \'{"city":"NYC"}\'. ' +
    'Every input the service takes belongs here, whatever its HTTP method — do not append ' +
    'parameters to the URL instead. The kit encodes this onto the request: fields naming a path ' +
    'parameter are substituted into the URL path, and the rest travel as query parameters on a ' +
    'GET or as a JSON body on POST, PUT and PATCH. Pass "{}" when the service takes no input.',

  depositAmount:
    'USDC amount to move into Gateway. A Gateway minimum deposit may apply, and a fee of about ' +
    '$0.03 is charged on top.',

  fiatAmount: 'Amount of the token to buy, in whole units (e.g. 10 for $10 of USDC).',
} as const;

/** Discriminated result of a preflight step: a chosen chain, or an error to surface. */
export type ChainSelection = { ok: true; chain: Chain } | { ok: false; message: string };

/** Discriminated result of a check that either passes or yields an error to surface. */
export type PreflightCheck = { ok: true } | { ok: false; message: string };

/**
 * Parse a `dataJson` argument into the payload object.
 *
 * Returns the parse failure as a message rather than throwing, so a malformed
 * payload reaches the model as a readable tool result it can correct, instead of
 * crashing the turn.
 */
export function parsePayload(
  dataJson: string,
): { ok: true; data: Record<string, unknown> } | { ok: false; message: string } {
  try {
    return { ok: true, data: JSON.parse(dataJson) as Record<string, unknown> };
  } catch (e) {
    return {
      ok: false,
      message:
        `dataJson is not valid JSON: ${(e as Error).message}. ` +
        'Re-check the service input schema reported by circle_inspect_service.',
    };
  }
}

/**
 * Confirm the seller publishes a payment option on a chain the kit can pay, and
 * pick which one to use.
 *
 * Prefers Base but defers to whichever offered chain the wallet can actually
 * afford, so a Polygon-funded wallet is not sent to Base to fail for want of
 * funds. A Solana- or Ethereum-only service is rejected, naming the networks it
 * does offer. Logs its own failure line; the caller decides whether to return or
 * throw the message.
 */
export async function selectPayChain(
  url: string,
  method: string,
  address: string,
  log: (line: string) => void,
): Promise<ChainSelection> {
  try {
    const accepts = await getServiceAccepts(url, method);
    const picked = await chooseChain(accepts, address);
    if (!picked) {
      const offered = accepts.unsupportedNetworks.join(', ') || 'none';
      log(`circle_pay_service ✗ no supported pay option (seller offers: ${offered})`);
      return {
        ok: false,
        message:
          'This service offers no payment option on a chain the kit supports (Base or Polygon). ' +
          `Seller networks: ${offered}.`,
      };
    }
    return { ok: true, chain: picked };
  } catch (e) {
    log(`circle_pay_service ✗ could not read the seller's payment options: ${(e as Error).message}`);
    return { ok: false, message: (e as Error).message };
  }
}

/**
 * Confirm the seller requires a Gateway payment on a chain the kit can pay, and
 * pick which chain to deposit on. A vanilla-x402 seller is rejected, since a
 * Gateway deposit would not help it. Logs its own failure line.
 */
export async function selectGatewayChain(
  url: string,
  method: string,
  log: (line: string) => void,
): Promise<ChainSelection> {
  try {
    const accepts = await getServiceAccepts(url, method);
    const picked = preferredChain(accepts);
    if (!picked || !sellerRequiresGateway(accepts, picked)) {
      log('circle_gateway_deposit ✗ seller offers no Gateway option on a supported chain');
      return {
        ok: false,
        message:
          `${url} does not require a Circle Gateway payment on a chain the kit supports, so a ` +
          'Gateway deposit would not help it. It can be paid with circle_pay_service directly.',
      };
    }
    return { ok: true, chain: picked };
  } catch (e) {
    log(`circle_gateway_deposit ✗ ${(e as Error).message}`);
    return { ok: false, message: (e as Error).message };
  }
}

/**
 * Preflight a payment: a counterfactual (undeployed) SCA cannot sign an x402
 * payment, and deployment is per-chain, so check the chain being paid.
 *
 * Surfaces an actionable message instead of the CLI's opaque "Could not sign
 * payment authorization" failure. Detection is best-effort — a flaky RPC must
 * not block a real payment — so a detection error is logged and treated as a pass.
 */
export async function ensureDeployed(
  address: string,
  chain: Chain,
  log: (line: string) => void,
): Promise<PreflightCheck> {
  try {
    if (!(await isWalletDeployed({ address, chain }))) {
      log(`circle_pay_service ✗ wallet not deployed on ${chain}`);
      return {
        ok: false,
        message:
          `Wallet ${address} is not deployed on-chain on ${chainLabel(chain)} yet, so it cannot ` +
          `sign x402 payments there. circle_deploy_wallet with this address and chain "${chain}" ` +
          'deploys it, after which this payment can go through.',
      };
    }
    return { ok: true };
  } catch (e) {
    log(`circle_pay_service: deployment check skipped (${(e as Error).message})`);
    return { ok: true };
  }
}

/**
 * Pick the Gateway deposit method for a chain. Polygon Gateway sellers get the
 * fast (~30s) eco method, which sources Base USDC and lands on Polygon. Base
 * Gateway sellers must use direct (13-19 min) because eco's destination is
 * hardcoded to Polygon by the CLI.
 */
export function selectDepositMethod(chain: Chain): GatewayDepositMethod {
  return chain === 'POLYGON' ? 'eco' : 'direct';
}

/**
 * Prompt the user to approve or reject a spend tool before it touches USDC.
 *
 * For the frameworks whose tool API has no external approval hook, so the
 * human-in-the-loop has to live inside the spend tool itself: the agent calls
 * the tool normally, execution pauses on `await ask(...)`, and only proceeds
 * once the human approves. Returns true when approved.
 */
export async function approveSpend(
  ask: (q: string) => Promise<string>,
  name: string,
  args: Record<string, unknown>,
  log: (line: string) => void,
): Promise<boolean> {
  log(yellow(`approval required for tool: ${bold(name)}`));
  console.log(colorizeJson(args));
  const answer = (await ask(bold('Approve? [y/N] '))).trim().toLowerCase();
  const approved = answer === 'y' || answer === 'yes';
  log(approved ? green('approved by user') : red('rejected by user'));
  return approved;
}
