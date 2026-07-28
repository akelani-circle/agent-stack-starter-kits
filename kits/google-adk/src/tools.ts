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

import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import * as circle from '@agent-stack-starter-kits/circle-tools';
import {
  ensureDeployed,
  fetchSetupSkill,
  fetchSubSkill,
  parsePayload,
  preview,
  selectDepositMethod,
  selectGatewayChain,
  selectPayChain,
  CHAIN_VALUES,
  HTTP_METHOD_VALUES,
  PARAM_DESCRIPTIONS,
  SETUP_SKILL_URL,
  SPEND_TOOL_NAMES,
  SUB_SKILL_NAMES,
  TOOL_DESCRIPTIONS,
  type SubSkillName,
} from '@agent-stack-starter-kits/kit-core';
import { bold, toolLine } from './theme';

/** How the kits prompt a human; shared so prompt options (e.g. the OTP's
 * `echo: false`) survive the trip from a tool down to the chat UI. */
export type AskFn = circle.AskFn;

/**
 * The two tools that move USDC. The agent routes these through human approval
 * via its `beforeToolCallback`; every other tool runs without a pause.
 */
export const SPEND_TOOLS = SPEND_TOOL_NAMES;

function log(line: string): void {
  console.log(toolLine(line));
}

/** ADK tool results are plain values the SDK serialises for the model. */
function ok(value: unknown): unknown {
  return value;
}

/**
 * Encode a failure as a tool result rather than throwing it, so the model reads
 * the failure and can recover instead of the run aborting.
 */
function err(e: unknown): { error: string } {
  return { error: e instanceof Error ? e.message : String(e) };
}

const subSkillEnum = z.enum(SUB_SKILL_NAMES as [SubSkillName, ...SubSkillName[]]);
const chainEnum = z.enum(CHAIN_VALUES);
const methodEnum = z.enum(HTTP_METHOD_VALUES);

// ── Skill fetchers ──────────────────────────────────────────────────────────

const fetchSetupSkillTool = new FunctionTool({
  name: 'fetch_setup_skill',
  description: TOOL_DESCRIPTIONS.fetch_setup_skill,
  parameters: z.object({}),
  execute: async () => {
    log(`fetch_setup_skill → ${SETUP_SKILL_URL}`);
    try {
      const body = await fetchSetupSkill();
      log(`fetch_setup_skill ← ${body.length} bytes`);
      return { markdown: body };
    } catch (e) {
      log(`fetch_setup_skill ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
});

const fetchSubSkillTool = new FunctionTool({
  name: 'fetch_sub_skill',
  description: TOOL_DESCRIPTIONS.fetch_sub_skill,
  parameters: z.object({
    name: subSkillEnum.describe(PARAM_DESCRIPTIONS.subSkillName),
  }),
  execute: async ({ name }) => {
    log(`fetch_sub_skill name=${name}`);
    try {
      const body = await fetchSubSkill(name);
      log(`fetch_sub_skill ← ${body.length} bytes`);
      return { markdown: body };
    } catch (e) {
      log(`fetch_sub_skill ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
});

// ── Wallet tools ────────────────────────────────────────────────────────────

const listAgentWallets = new FunctionTool({
  name: 'circle_list_wallets',
  description: TOOL_DESCRIPTIONS.circle_list_wallets,
  parameters: z.object({}),
  execute: async () => {
    log('circle_list_wallets');
    try {
      const result = await circle.listWallets();
      log(`circle_list_wallets ← ${result.length} wallet(s)`);
      // Wrapped, not a bare array: Gemini's `function_response.response` proto
      // field is a Struct (object), not a repeating field, so replaying an
      // array-shaped tool result back as conversation history 400s with
      // "Proto field is not repeating, cannot start list" on the very next turn.
      return ok({ wallets: result });
    } catch (e) {
      log(`circle_list_wallets ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
});

const createAgentWallet = new FunctionTool({
  name: 'circle_create_wallet',
  description: TOOL_DESCRIPTIONS.circle_create_wallet,
  parameters: z.object({}),
  execute: async () => {
    log('circle_create_wallet');
    try {
      const result = await circle.createWallet();
      log(`circle_create_wallet ← ${result.address}`);
      return ok(result);
    } catch (e) {
      log(`circle_create_wallet ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
});

const getWalletBalance = new FunctionTool({
  name: 'circle_get_balance',
  description: TOOL_DESCRIPTIONS.circle_get_balance,
  parameters: z.object({
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
  }),
  execute: async ({ address, chain }) => {
    log(`circle_get_balance address=${address} chain=${chain ?? circle.DEFAULT_CHAIN}`);
    try {
      const result = await circle.getBalance({ address, chain });
      const usdc = result.tokens.find((t) => t.symbol?.toUpperCase() === 'USDC');
      log(`circle_get_balance ← USDC=${usdc?.amount ?? '0'} (${result.tokens.length} token(s))`);
      return ok(result);
    } catch (e) {
      log(`circle_get_balance ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
});

const fundWalletTool = new FunctionTool({
  name: 'circle_wallet_fund',
  description: TOOL_DESCRIPTIONS.circle_wallet_fund,
  parameters: z.object({
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    method: z
      .enum(['crypto', 'fiat'])
      .optional()
      .describe('"crypto" draws from the testnet faucet; "fiat" runs the test card flow.'),
  }),
  execute: async ({ address, method }) => {
    log(`circle_wallet_fund address=${address} method=${method ?? 'crypto'}`);
    try {
      const out = await circle.fundWallet({ address, method });
      log('circle_wallet_fund ← done');
      return { output: out };
    } catch (e) {
      log(`circle_wallet_fund ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
});

const deployWalletTool = new FunctionTool({
  name: 'circle_deploy_wallet',
  description: TOOL_DESCRIPTIONS.circle_deploy_wallet,
  parameters: z.object({
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
  }),
  execute: async ({ address, chain }) => {
    log(`circle_deploy_wallet address=${address} chain=${chain ?? circle.DEFAULT_CHAIN}`);
    try {
      const result = await circle.deployWallet({ address, chain });
      if (result.alreadyDeployed) {
        log('circle_deploy_wallet ← already deployed');
      } else if (result.deployed) {
        log(`circle_deploy_wallet ← deployed tx=${result.txId ?? 'n/a'}`);
      } else {
        log(
          `circle_deploy_wallet ← submitted, on-chain confirmation pending tx=${result.txId ?? 'n/a'}`,
        );
      }
      return ok(result);
    } catch (e) {
      log(`circle_deploy_wallet ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
});

const fundFiatTool = new FunctionTool({
  name: 'circle_fund_fiat',
  description: TOOL_DESCRIPTIONS.circle_fund_fiat,
  parameters: z.object({
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    // Not `.positive()`: zod's JSON-schema conversion renders that as a numeric
    // `exclusiveMinimum`, which Gemini's function-calling schema parser rejects
    // outright ("Unknown name exclusiveMinimum"), failing every turn before the
    // agent runs at all. `.refine` validates the same constraint at runtime
    // without emitting anything into the generated schema.
    amount: z
      .number()
      .refine((v) => v > 0, 'amount must be greater than 0')
      .describe(PARAM_DESCRIPTIONS.fiatAmount),
    chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
    token: z
      .enum(['usdc', 'eurc', 'eth', 'native'])
      .optional()
      .describe('Token to buy. Defaults to usdc.'),
  }),
  execute: async ({ address, amount, chain, token }) => {
    log(
      `circle_fund_fiat address=${address} amount=${amount} chain=${chain ?? circle.DEFAULT_CHAIN} token=${token ?? 'usdc'}`,
    );
    try {
      // Local interactive demo: open the Transak page in the user's browser so
      // they can complete the purchase. Best-effort, a no-op on headless.
      const result = await circle.fundWalletFiat({ address, amount, chain, token, open: true });
      log(`circle_fund_fiat ← ${preview(result.url, 80)}`);
      return ok(result);
    } catch (e) {
      log(`circle_fund_fiat ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
});

// ── Service discovery tools ─────────────────────────────────────────────────

const searchServices = new FunctionTool({
  name: 'circle_search_services',
  description: TOOL_DESCRIPTIONS.circle_search_services,
  parameters: z.object({
    keyword: z.string().describe('Search keyword.'),
  }),
  execute: async ({ keyword }) => {
    log(`circle_search_services keyword="${keyword}"`);
    try {
      const result = await circle.searchServices({ keyword });
      log(`circle_search_services ← ${result.length} hit(s)`);
      // See the matching note on circle_list_wallets: a bare array response
      // crashes the next turn against Gemini, so it's wrapped in an object.
      return ok({ services: result });
    } catch (e) {
      log(`circle_search_services ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
});

const inspectService = new FunctionTool({
  name: 'circle_inspect_service',
  description: TOOL_DESCRIPTIONS.circle_inspect_service,
  parameters: z.object({
    url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
  }),
  execute: async ({ url }) => {
    log(`circle_inspect_service url=${url}`);
    try {
      const result = await circle.inspectService({ url });
      log(`circle_inspect_service ← ${preview(JSON.stringify(result))}`);
      return ok(result);
    } catch (e) {
      log(`circle_inspect_service ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
});

const fetchServiceTool = new FunctionTool({
  name: 'fetch_service',
  description: TOOL_DESCRIPTIONS.fetch_service,
  parameters: z.object({
    url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
  }),
  execute: async ({ url }) => {
    log(`fetch_service url=${url}`);
    try {
      const result = await circle.fetchService({ url });
      if (result.paymentRequired) {
        log('fetch_service ← HTTP 402, payment required');
      } else {
        log(`fetch_service ← HTTP ${result.status} ${result.body.length} bytes`);
      }
      return ok(result);
    } catch (e) {
      log(`fetch_service ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
});

const getGatewayBalance = new FunctionTool({
  name: 'circle_get_gateway_balance',
  description: TOOL_DESCRIPTIONS.circle_get_gateway_balance,
  parameters: z.object({
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
  }),
  execute: async ({ address, chain }) => {
    log(`circle_get_gateway_balance address=${address} chain=${chain ?? circle.DEFAULT_CHAIN}`);
    try {
      const result = await circle.gatewayBalance({ address, chain });
      log(`circle_get_gateway_balance ← total=${result.total} USDC`);
      return ok(result);
    } catch (e) {
      log(`circle_get_gateway_balance ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
});

// ── Spend tools ─────────────────────────────────────────────────────────────
//
// No approval prompt in here: the agent's `beforeToolCallback` (see agent.ts)
// is ADK's native permission hook and pauses before either of these runs, so by
// the time `execute` is entered the human has already approved.

const payService = new FunctionTool({
  name: 'circle_pay_service',
  description: TOOL_DESCRIPTIONS.circle_pay_service,
  parameters: z.object({
    url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    method: methodEnum.optional().describe(PARAM_DESCRIPTIONS.httpMethod),
    dataJson: z.string().describe(PARAM_DESCRIPTIONS.dataJson),
  }),
  execute: async ({ url, address, dataJson, method }) => {
    const httpMethod = (method ?? 'GET').toUpperCase();
    log(
      `circle_pay_service url=${url} from=${address} method=${httpMethod} data=${preview(dataJson, 80)}`,
    );

    const payload = parsePayload(dataJson);
    if (!payload.ok) {
      log('circle_pay_service ✗ invalid dataJson');
      return { error: payload.message };
    }

    const chain = await selectPayChain(url, httpMethod, address, log);
    if (!chain.ok) return { error: chain.message };

    const deployed = await ensureDeployed(address, chain.chain, log);
    if (!deployed.ok) return { error: deployed.message };

    try {
      const result = await circle.payService({
        url,
        address,
        data: payload.data,
        method: httpMethod,
        chain: chain.chain,
      });
      const tx = result.txHash ? ` txHash=${result.txHash}` : '';
      log(
        `circle_pay_service ← paid on ${circle.chainLabel(chain.chain)}${tx} ${result.response.length} bytes`,
      );
      return ok(result);
    } catch (e) {
      log(`circle_pay_service ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
});

const gatewayDepositTool = new FunctionTool({
  name: 'circle_gateway_deposit',
  description: TOOL_DESCRIPTIONS.circle_gateway_deposit,
  parameters: z.object({
    url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    method: methodEnum.optional().describe(PARAM_DESCRIPTIONS.httpMethod),
    // See the matching note on circle_fund_fiat's `amount` above: `.positive()`
    // breaks Gemini's function-calling schema, so the constraint is a runtime
    // refine instead.
    amount: z
      .number()
      .refine((v) => v > 0, 'amount must be greater than 0')
      .describe(PARAM_DESCRIPTIONS.depositAmount),
  }),
  execute: async ({ url, address, amount, method }) => {
    const httpMethod = (method ?? 'GET').toUpperCase();
    log(`circle_gateway_deposit url=${url} address=${address} amount=${amount}`);

    const chain = await selectGatewayChain(url, httpMethod, log);
    if (!chain.ok) return { error: chain.message };

    const depositMethod = selectDepositMethod(chain.chain);
    try {
      const result = await circle.gatewayDeposit({
        address,
        amount,
        chain: chain.chain,
        method: depositMethod,
      });
      log(
        `circle_gateway_deposit ← ${result.amount} USDC on ${circle.chainLabel(chain.chain)} via ${depositMethod} tx=${result.txId ?? 'n/a'}`,
      );
      return ok(result);
    } catch (e) {
      log(`circle_gateway_deposit ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
});

// ── Auth tools ──────────────────────────────────────────────────────────────

/**
 * Build the ADK tool list.
 *
 * `ask` is needed only by the login tool, which prompts for the email + OTP
 * inline (the kit stores neither), letting the agent recover an expired session
 * mid-conversation instead of dead-ending on "run it yourself".
 */
export function buildTools(ask: AskFn) {
  const loginTool = new FunctionTool({
    name: 'circle_login',
    description: TOOL_DESCRIPTIONS.circle_login,
    parameters: z.object({}),
    execute: async () => {
      log('circle_login');
      try {
        const result = await circle.ensureSession({ ask, log, bold });
        log(`circle_login ← ${result.status}`);
        return ok({ status: result.status });
      } catch (e) {
        log(`circle_login ✗ ${(e as Error).message}`);
        return err(e);
      }
    },
  });

  const logoutTool = new FunctionTool({
    name: 'circle_logout',
    description: TOOL_DESCRIPTIONS.circle_logout,
    parameters: z.object({}),
    execute: async () => {
      log('circle_logout');
      try {
        await circle.logout(log);
        return ok({ loggedOut: true });
      } catch (e) {
        log(`circle_logout ✗ ${(e as Error).message}`);
        return err(e);
      }
    },
  });

  return [
    loginTool,
    logoutTool,
    fetchSetupSkillTool,
    fetchSubSkillTool,
    listAgentWallets,
    createAgentWallet,
    getWalletBalance,
    fundWalletTool,
    deployWalletTool,
    fundFiatTool,
    searchServices,
    inspectService,
    fetchServiceTool,
    getGatewayBalance,
    payService,
    gatewayDepositTool,
  ];
}
