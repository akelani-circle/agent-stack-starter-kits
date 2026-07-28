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

import { tool } from '@openai/agents';
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
  SUB_SKILL_NAMES,
  TOOL_DESCRIPTIONS,
  type SubSkillName,
} from '@agent-stack-starter-kits/kit-core';
import { bold, toolLine } from './theme';

const subSkillEnum = z.enum(SUB_SKILL_NAMES as [SubSkillName, ...SubSkillName[]]);
const chainEnum = z.enum(CHAIN_VALUES);
const methodEnum = z.enum(HTTP_METHOD_VALUES);

function log(line: string): void {
  console.log(toolLine(line));
}

// ── Skill fetchers ──────────────────────────────────────────────────────────

export const fetchSetupSkillTool = tool({
  name: 'fetch_setup_skill',
  description: TOOL_DESCRIPTIONS.fetch_setup_skill,
  parameters: z.object({}),
  execute: async () => {
    log(`fetch_setup_skill → ${SETUP_SKILL_URL}`);
    try {
      const body = await fetchSetupSkill();
      log(`fetch_setup_skill ← ${body.length} bytes`);
      return body;
    } catch (e) {
      log(`fetch_setup_skill ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const fetchSubSkillTool = tool({
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
      return body;
    } catch (e) {
      log(`fetch_sub_skill ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

// ── Wallet tools ────────────────────────────────────────────────────────────

export const circleCreateWallet = tool({
  name: 'circle_create_wallet',
  description: TOOL_DESCRIPTIONS.circle_create_wallet,
  parameters: z.object({}),
  execute: async () => {
    log('circle_create_wallet');
    try {
      const result = await circle.createWallet();
      log(`circle_create_wallet ← ${result.address}`);
      return JSON.stringify(result);
    } catch (e) {
      log(`circle_create_wallet ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleListWallets = tool({
  name: 'circle_list_wallets',
  description: TOOL_DESCRIPTIONS.circle_list_wallets,
  parameters: z.object({}),
  execute: async () => {
    log('circle_list_wallets');
    try {
      const result = await circle.listWallets();
      log(`circle_list_wallets ← ${result.length} wallet(s)`);
      return JSON.stringify(result);
    } catch (e) {
      log(`circle_list_wallets ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleGetBalance = tool({
  name: 'circle_get_balance',
  description: TOOL_DESCRIPTIONS.circle_get_balance,
  parameters: z.object({
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
  }),
  execute: async ({ address, chain }) => {
    log(`circle_get_balance address=${address} chain=${chain ?? circle.DEFAULT_CHAIN}`);
    try {
      const result = await circle.getBalance({ address, chain: chain ?? undefined });
      const usdc = result.tokens.find((t) => t.symbol?.toUpperCase() === 'USDC');
      log(`circle_get_balance ← USDC=${usdc?.amount ?? '0'} (${result.tokens.length} token(s))`);
      return JSON.stringify(result);
    } catch (e) {
      log(`circle_get_balance ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleWalletFund = tool({
  name: 'circle_wallet_fund',
  description: TOOL_DESCRIPTIONS.circle_wallet_fund,
  parameters: z.object({
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    method: z
      .enum(['crypto', 'fiat'])
      .default('crypto')
      .describe('"crypto" draws from the testnet faucet; "fiat" runs the test card flow.'),
  }),
  execute: async ({ address, method }) => {
    log(`circle_wallet_fund address=${address} method=${method}`);
    try {
      const out = await circle.fundWallet({ address, method: method ?? 'crypto' });
      log('circle_wallet_fund ← done');
      return out;
    } catch (e) {
      log(`circle_wallet_fund ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleDeployWallet = tool({
  name: 'circle_deploy_wallet',
  description: TOOL_DESCRIPTIONS.circle_deploy_wallet,
  parameters: z.object({
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
  }),
  execute: async ({ address, chain }) => {
    log(`circle_deploy_wallet address=${address} chain=${chain ?? circle.DEFAULT_CHAIN}`);
    try {
      const result = await circle.deployWallet({ address, chain: chain ?? undefined });
      if (result.alreadyDeployed) {
        log('circle_deploy_wallet ← already deployed');
      } else if (result.deployed) {
        log(`circle_deploy_wallet ← deployed tx=${result.txId ?? 'n/a'}`);
      } else {
        log(
          `circle_deploy_wallet ← submitted, on-chain confirmation pending tx=${result.txId ?? 'n/a'}`,
        );
      }
      return JSON.stringify(result);
    } catch (e) {
      log(`circle_deploy_wallet ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const fundFiatTool = tool({
  name: 'circle_fund_fiat',
  description: TOOL_DESCRIPTIONS.circle_fund_fiat,
  parameters: z.object({
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    amount: z.number().positive().describe(PARAM_DESCRIPTIONS.fiatAmount),
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
      const result = await circle.fundWalletFiat({
        address,
        amount,
        chain: chain ?? undefined,
        token: token ?? undefined,
        open: true,
      });
      log(`circle_fund_fiat ← ${preview(result.url, 80)}`);
      return JSON.stringify(result);
    } catch (e) {
      log(`circle_fund_fiat ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

// ── Service discovery tools ─────────────────────────────────────────────────

export const fetchServiceTool = tool({
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
      return JSON.stringify(result);
    } catch (e) {
      log(`fetch_service ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleSearchServices = tool({
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
      return JSON.stringify(result);
    } catch (e) {
      log(`circle_search_services ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleInspectService = tool({
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
      return JSON.stringify(result);
    } catch (e) {
      log(`circle_inspect_service ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleGetGatewayBalance = tool({
  name: 'circle_get_gateway_balance',
  description: TOOL_DESCRIPTIONS.circle_get_gateway_balance,
  parameters: z.object({
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
  }),
  execute: async ({ address, chain }) => {
    log(`circle_get_gateway_balance address=${address} chain=${chain ?? circle.DEFAULT_CHAIN}`);
    try {
      const result = await circle.gatewayBalance({ address, chain: chain ?? undefined });
      log(`circle_get_gateway_balance ← total=${result.total} USDC`);
      return JSON.stringify(result);
    } catch (e) {
      log(`circle_get_gateway_balance ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

// ── Spend tools ─────────────────────────────────────────────────────────────
//
// `needsApproval: true` is the OpenAI Agents SDK's native human-in-the-loop
// hook: the run interrupts before the tool executes and the entry point drives
// the y/N prompt, so unlike the Vercel AI kit no approval logic lives in here.
//
// These throw rather than return errors: the SDK surfaces a thrown tool error
// back to the model as the tool result, so the model can still recover.

export const circlePayService = tool({
  name: 'circle_pay_service',
  description: TOOL_DESCRIPTIONS.circle_pay_service,
  needsApproval: true,
  parameters: z.object({
    url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    method: methodEnum.optional().describe(PARAM_DESCRIPTIONS.httpMethod),
    dataJson: z.string().describe(PARAM_DESCRIPTIONS.dataJson),
  }),
  execute: async ({ url, address, method, dataJson }) => {
    const httpMethod = (method ?? 'GET').toUpperCase();
    log(
      `circle_pay_service url=${url} from=${address} method=${httpMethod} data=${preview(dataJson, 80)}`,
    );

    const payload = parsePayload(dataJson);
    if (!payload.ok) {
      log('circle_pay_service ✗ invalid dataJson');
      throw new Error(payload.message);
    }

    const chain = await selectPayChain(url, httpMethod, address, log);
    if (!chain.ok) throw new Error(chain.message);

    const deployed = await ensureDeployed(address, chain.chain, log);
    if (!deployed.ok) throw new Error(deployed.message);

    try {
      const result = await circle.payService({
        url,
        address,
        data: payload.data,
        method: httpMethod,
        chain: chain.chain,
      });
      const tx = result.txHash ? ` txHash=${result.txHash}` : '';
      log(`circle_pay_service ← paid on ${circle.chainLabel(chain.chain)}${tx}`);
      return JSON.stringify(result);
    } catch (e) {
      log(`circle_pay_service ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

export const circleGatewayDeposit = tool({
  name: 'circle_gateway_deposit',
  description: TOOL_DESCRIPTIONS.circle_gateway_deposit,
  needsApproval: true,
  parameters: z.object({
    url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    method: methodEnum.optional().describe(PARAM_DESCRIPTIONS.httpMethod),
    amount: z.number().positive().describe(PARAM_DESCRIPTIONS.depositAmount),
  }),
  execute: async ({ url, address, method, amount }) => {
    const httpMethod = (method ?? 'GET').toUpperCase();
    log(`circle_gateway_deposit url=${url} address=${address} amount=${amount}`);

    const chain = await selectGatewayChain(url, httpMethod, log);
    if (!chain.ok) throw new Error(chain.message);

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
      return JSON.stringify(result);
    } catch (e) {
      log(`circle_gateway_deposit ✗ ${(e as Error).message}`);
      throw e;
    }
  },
});

// ── Auth tools ──────────────────────────────────────────────────────────────

export function buildAuthTools(ask: (q: string) => Promise<string>) {
  const loginTool = tool({
    name: 'circle_login',
    description: TOOL_DESCRIPTIONS.circle_login,
    parameters: z.object({}),
    execute: async () => {
      log('circle_login');
      try {
        const result = await circle.ensureSession({ ask, log, bold });
        log(`circle_login ← ${result.status}`);
        return JSON.stringify({ status: result.status });
      } catch (e) {
        log(`circle_login ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  const logoutTool = tool({
    name: 'circle_logout',
    description: TOOL_DESCRIPTIONS.circle_logout,
    parameters: z.object({}),
    execute: async () => {
      log('circle_logout');
      try {
        circle.logout(log);
        return JSON.stringify({ loggedOut: true });
      } catch (e) {
        log(`circle_logout ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  return { loginTool, logoutTool };
}
