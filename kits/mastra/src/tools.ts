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

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import * as circle from '@agent-stack-starter-kits/circle-tools';
import {
  approveSpend,
  ensureDeployed,
  fetchSetupSkill,
  fetchSubSkill,
  parsePayload,
  preview,
  recordServiceSearch,
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

/** How the kits prompt a human; shared so prompt options (e.g. the OTP's
 * `echo: false`) survive the trip from a tool down to the chat UI. */
export type AskFn = circle.AskFn;

const subSkillEnum = z.enum(SUB_SKILL_NAMES as [SubSkillName, ...SubSkillName[]]);
const chainEnum = z.enum(CHAIN_VALUES);
const methodEnum = z.enum(HTTP_METHOD_VALUES);

function log(line: string): void {
  console.log(toolLine(line));
}

/**
 * Build the Mastra tool set.
 *
 * `ask` is threaded in so the tools that need the human — login, and the two
 * that move USDC — can pause for terminal input. Mastra's `Agent` has no
 * external per-tool approval hook (no `interruptOn`, no `canUseTool`), so like
 * the Vercel AI kit the approval gate lives inside the spend tool's `execute`
 * and runs before any USDC moves.
 */
export function buildTools(ask: AskFn) {
  // ── Auth tools ────────────────────────────────────────────────────────────

  const loginTool = createTool({
    id: 'circle_login',
    description: TOOL_DESCRIPTIONS.circle_login,
    inputSchema: z.object({}),
    execute: async () => {
      log('circle_login');
      try {
        const result = await circle.ensureSession({ ask, log, bold });
        log(`circle_login ← ${result.status}`);
        return { status: result.status };
      } catch (e) {
        log(`circle_login ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  const logoutTool = createTool({
    id: 'circle_logout',
    description: TOOL_DESCRIPTIONS.circle_logout,
    inputSchema: z.object({}),
    execute: async () => {
      log('circle_logout');
      try {
        await circle.logout(log);
        return { loggedOut: true };
      } catch (e) {
        log(`circle_logout ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  // ── Skill fetchers ────────────────────────────────────────────────────────

  const fetchSetupSkillTool = createTool({
    id: 'fetch_setup_skill',
    description: TOOL_DESCRIPTIONS.fetch_setup_skill,
    inputSchema: z.object({}),
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

  const fetchSubSkillTool = createTool({
    id: 'fetch_sub_skill',
    description: TOOL_DESCRIPTIONS.fetch_sub_skill,
    inputSchema: z.object({
      name: subSkillEnum.describe(PARAM_DESCRIPTIONS.subSkillName),
    }),
    execute: async (input) => {
      log(`fetch_sub_skill name=${input.name}`);
      try {
        const body = await fetchSubSkill(input.name);
        log(`fetch_sub_skill ← ${body.length} bytes`);
        return body;
      } catch (e) {
        log(`fetch_sub_skill ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  // ── Wallet tools ──────────────────────────────────────────────────────────

  const circleCreateWallet = createTool({
    id: 'circle_create_wallet',
    description: TOOL_DESCRIPTIONS.circle_create_wallet,
    inputSchema: z.object({}),
    execute: async () => {
      log('circle_create_wallet');
      try {
        const result = await circle.createWallet();
        log(`circle_create_wallet ← ${result.address}`);
        return result;
      } catch (e) {
        log(`circle_create_wallet ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  const circleListWallets = createTool({
    id: 'circle_list_wallets',
    description: TOOL_DESCRIPTIONS.circle_list_wallets,
    inputSchema: z.object({}),
    execute: async () => {
      log('circle_list_wallets');
      try {
        const result = await circle.listWallets();
        log(`circle_list_wallets ← ${result.length} wallet(s)`);
        return result;
      } catch (e) {
        log(`circle_list_wallets ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  const circleGetBalance = createTool({
    id: 'circle_get_balance',
    description: TOOL_DESCRIPTIONS.circle_get_balance,
    inputSchema: z.object({
      address: z.string().describe(PARAM_DESCRIPTIONS.address),
      chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
    }),
    execute: async (input) => {
      log(`circle_get_balance address=${input.address} chain=${input.chain ?? circle.DEFAULT_CHAIN}`);
      try {
        const result = await circle.getBalance({ address: input.address, chain: input.chain });
        const usdc = result.tokens.find((t) => t.symbol?.toUpperCase() === 'USDC');
        log(`circle_get_balance ← USDC=${usdc?.amount ?? '0'} (${result.tokens.length} token(s))`);
        return result;
      } catch (e) {
        log(`circle_get_balance ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  const circleWalletFund = createTool({
    id: 'circle_wallet_fund',
    description: TOOL_DESCRIPTIONS.circle_wallet_fund,
    inputSchema: z.object({
      address: z.string().describe(PARAM_DESCRIPTIONS.address),
      method: z
        .enum(['crypto', 'fiat'])
        .default('crypto')
        .describe('"crypto" draws from the testnet faucet; "fiat" runs the test card flow.'),
    }),
    execute: async (input) => {
      log(`circle_wallet_fund address=${input.address} method=${input.method}`);
      try {
        const out = await circle.fundWallet({ address: input.address, method: input.method });
        log('circle_wallet_fund ← done');
        return out;
      } catch (e) {
        log(`circle_wallet_fund ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  const circleDeployWallet = createTool({
    id: 'circle_deploy_wallet',
    description: TOOL_DESCRIPTIONS.circle_deploy_wallet,
    inputSchema: z.object({
      address: z.string().describe(PARAM_DESCRIPTIONS.address),
      chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
    }),
    execute: async (input) => {
      log(
        `circle_deploy_wallet address=${input.address} chain=${input.chain ?? circle.DEFAULT_CHAIN}`,
      );
      try {
        const result = await circle.deployWallet({ address: input.address, chain: input.chain });
        if (result.alreadyDeployed) {
          log('circle_deploy_wallet ← already deployed');
        } else if (result.deployed) {
          log(`circle_deploy_wallet ← deployed tx=${result.txId ?? 'n/a'}`);
        } else {
          log(
            `circle_deploy_wallet ← submitted, on-chain confirmation pending tx=${result.txId ?? 'n/a'}`,
          );
        }
        return result;
      } catch (e) {
        log(`circle_deploy_wallet ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  const fundFiatTool = createTool({
    id: 'circle_fund_fiat',
    description: TOOL_DESCRIPTIONS.circle_fund_fiat,
    inputSchema: z.object({
      address: z.string().describe(PARAM_DESCRIPTIONS.address),
      amount: z.number().positive().describe(PARAM_DESCRIPTIONS.fiatAmount),
      chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
      token: z
        .enum(['usdc', 'eurc', 'eth', 'native'])
        .optional()
        .describe('Token to buy. Defaults to usdc.'),
    }),
    execute: async (input) => {
      log(
        `circle_fund_fiat address=${input.address} amount=${input.amount} chain=${input.chain ?? circle.DEFAULT_CHAIN} token=${input.token ?? 'usdc'}`,
      );
      try {
        // Local interactive demo: open the Transak page in the user's browser so
        // they can complete the purchase. Best-effort, a no-op on headless.
        const result = await circle.fundWalletFiat({
          address: input.address,
          amount: input.amount,
          chain: input.chain,
          token: input.token,
          open: true,
        });
        log(`circle_fund_fiat ← ${preview(result.url, 80)}`);
        return result;
      } catch (e) {
        log(`circle_fund_fiat ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  // ── Service discovery tools ───────────────────────────────────────────────

  const fetchServiceTool = createTool({
    id: 'fetch_service',
    description: TOOL_DESCRIPTIONS.fetch_service,
    inputSchema: z.object({
      url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
    }),
    execute: async (input) => {
      log(`fetch_service url=${input.url}`);
      try {
        const result = await circle.fetchService({ url: input.url });
        if (result.paymentRequired) {
          log('fetch_service ← HTTP 402, payment required');
        } else {
          log(`fetch_service ← HTTP ${result.status} ${result.body.length} bytes`);
        }
        return result;
      } catch (e) {
        log(`fetch_service ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  const circleSearchServices = createTool({
    id: 'circle_search_services',
    description: TOOL_DESCRIPTIONS.circle_search_services,
    inputSchema: z.object({
      keyword: z.string().describe('Search keyword.'),
    }),
    execute: async (input) => {
      log(`circle_search_services keyword="${input.keyword}"`);
      try {
        const result = await circle.searchServices({ keyword: input.keyword });
        log(`circle_search_services ← ${result.length} hit(s)`);
        // Makes these hits addressable by number at the next prompt, exactly as
        // if the user had run `/discover` themselves.
        recordServiceSearch(result);
        return result;
      } catch (e) {
        log(`circle_search_services ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  const circleInspectService = createTool({
    id: 'circle_inspect_service',
    description: TOOL_DESCRIPTIONS.circle_inspect_service,
    inputSchema: z.object({
      url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
    }),
    execute: async (input) => {
      log(`circle_inspect_service url=${input.url}`);
      try {
        const result = await circle.inspectService({ url: input.url });
        log(`circle_inspect_service ← ${preview(JSON.stringify(result))}`);
        return result;
      } catch (e) {
        log(`circle_inspect_service ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  const circleGetGatewayBalance = createTool({
    id: 'circle_get_gateway_balance',
    description: TOOL_DESCRIPTIONS.circle_get_gateway_balance,
    inputSchema: z.object({
      address: z.string().describe(PARAM_DESCRIPTIONS.address),
      chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
    }),
    execute: async (input) => {
      log(
        `circle_get_gateway_balance address=${input.address} chain=${input.chain ?? circle.DEFAULT_CHAIN}`,
      );
      try {
        const result = await circle.gatewayBalance({ address: input.address, chain: input.chain });
        log(`circle_get_gateway_balance ← total=${result.total} USDC`);
        return result;
      } catch (e) {
        log(`circle_get_gateway_balance ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  // ── Spend tools — require human approval before executing ─────────────────
  //
  // Mastra's Agent exposes no external per-tool approval hook, so the
  // human-in-the-loop lives inside `execute`, exactly as in the Vercel AI kit:
  // the agent calls the tool normally, execution pauses on `await ask(...)`
  // inside `approveSpend`, and no USDC moves unless the human approves.

  const circlePayService = createTool({
    id: 'circle_pay_service',
    description: TOOL_DESCRIPTIONS.circle_pay_service,
    inputSchema: z.object({
      url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
      address: z.string().describe(PARAM_DESCRIPTIONS.address),
      method: methodEnum.optional().describe(PARAM_DESCRIPTIONS.httpMethod),
      dataJson: z.string().describe(PARAM_DESCRIPTIONS.dataJson),
    }),
    execute: async (input) => {
      const httpMethod = (input.method ?? 'GET').toUpperCase();
      log(
        `circle_pay_service url=${input.url} from=${input.address} method=${httpMethod} data=${preview(input.dataJson, 80)}`,
      );

      const payload = parsePayload(input.dataJson);
      if (!payload.ok) {
        log('circle_pay_service ✗ invalid dataJson');
        throw new Error(payload.message);
      }

      const args = {
        url: input.url,
        address: input.address,
        method: httpMethod,
        data: payload.data,
      };
      if (!(await approveSpend(ask, 'circle_pay_service', args, log))) {
        return { denied: true };
      }

      const chain = await selectPayChain(input.url, httpMethod, input.address, log);
      if (!chain.ok) throw new Error(chain.message);

      const deployed = await ensureDeployed(input.address, chain.chain, log);
      if (!deployed.ok) throw new Error(deployed.message);

      try {
        const result = await circle.payService({
          url: input.url,
          address: input.address,
          data: payload.data,
          method: httpMethod,
          chain: chain.chain,
        });
        const tx = result.txHash ? ` txHash=${result.txHash}` : '';
        log(`circle_pay_service ← paid on ${circle.chainLabel(chain.chain)}${tx}`);
        return result;
      } catch (e) {
        log(`circle_pay_service ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  const circleGatewayDeposit = createTool({
    id: 'circle_gateway_deposit',
    description: TOOL_DESCRIPTIONS.circle_gateway_deposit,
    inputSchema: z.object({
      url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
      address: z.string().describe(PARAM_DESCRIPTIONS.address),
      method: methodEnum.optional().describe(PARAM_DESCRIPTIONS.httpMethod),
      amount: z.number().positive().describe(PARAM_DESCRIPTIONS.depositAmount),
    }),
    execute: async (input) => {
      const httpMethod = (input.method ?? 'GET').toUpperCase();
      log(
        `circle_gateway_deposit url=${input.url} address=${input.address} amount=${input.amount}`,
      );

      const args = {
        url: input.url,
        address: input.address,
        method: httpMethod,
        amount: input.amount,
      };
      if (!(await approveSpend(ask, 'circle_gateway_deposit', args, log))) {
        return { denied: true };
      }

      const chain = await selectGatewayChain(input.url, httpMethod, log);
      if (!chain.ok) throw new Error(chain.message);

      const depositMethod = selectDepositMethod(chain.chain);
      try {
        const result = await circle.gatewayDeposit({
          address: input.address,
          amount: input.amount,
          chain: chain.chain,
          method: depositMethod,
        });
        log(
          `circle_gateway_deposit ← ${result.amount} USDC on ${circle.chainLabel(chain.chain)} via ${depositMethod} tx=${result.txId ?? 'n/a'}`,
        );
        return result;
      } catch (e) {
        log(`circle_gateway_deposit ✗ ${(e as Error).message}`);
        throw e;
      }
    },
  });

  return {
    loginTool,
    logoutTool,
    fetchSetupSkillTool,
    fetchSubSkillTool,
    circleCreateWallet,
    circleListWallets,
    circleGetBalance,
    circleWalletFund,
    circleDeployWallet,
    fundFiatTool,
    fetchServiceTool,
    circleSearchServices,
    circleInspectService,
    circleGetGatewayBalance,
    circlePayService,
    circleGatewayDeposit,
  };
}
