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

import { tool } from '@langchain/core/tools';
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

/** LangChain tools return strings, so every result is JSON-encoded. */
function ok(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Encode a failure as a tool result rather than throwing it. A thrown error
 * aborts the graph run; returning it lets the model read the failure and
 * recover on the next step.
 */
function err(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return JSON.stringify({ error: message });
}

/**
 * Build the LangChain tool set.
 *
 * Human-in-the-loop is external here: the two spend tools are gated by Deep
 * Agents' `interruptOn` in `agent.ts`, and the entry point drives the
 * pause/resume cycle. `ask` is therefore only needed by the login tool, which
 * prompts for the email + OTP inline (the kit stores neither), letting the agent
 * recover an expired session mid-conversation instead of dead-ending.
 */
export function buildTools(ask: (q: string) => Promise<string>) {
  // ── Auth tools ────────────────────────────────────────────────────────────

  const loginTool = tool(
    async () => {
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
    {
      name: 'circle_login',
      description: TOOL_DESCRIPTIONS.circle_login,
      schema: z.object({}),
    },
  );

  const logoutTool = tool(
    async () => {
      log('circle_logout');
      try {
        circle.logout(log);
        return ok({ loggedOut: true });
      } catch (e) {
        log(`circle_logout ✗ ${(e as Error).message}`);
        return err(e);
      }
    },
    {
      name: 'circle_logout',
      description: TOOL_DESCRIPTIONS.circle_logout,
      schema: z.object({}),
    },
  );

  // ── Skill fetchers ────────────────────────────────────────────────────────

  const fetchSetupSkillTool = tool(
    async () => {
      log(`fetch_setup_skill → ${SETUP_SKILL_URL}`);
      try {
        const body = await fetchSetupSkill();
        log(`fetch_setup_skill ← ${body.length} bytes`);
        return body;
      } catch (e) {
        log(`fetch_setup_skill ✗ ${(e as Error).message}`);
        return err(e);
      }
    },
    {
      name: 'fetch_setup_skill',
      description: TOOL_DESCRIPTIONS.fetch_setup_skill,
      schema: z.object({}),
    },
  );

  const fetchSubSkillTool = tool(
    async ({ name }) => {
      log(`fetch_sub_skill name=${name}`);
      try {
        const body = await fetchSubSkill(name);
        log(`fetch_sub_skill ← ${body.length} bytes`);
        return body;
      } catch (e) {
        log(`fetch_sub_skill ✗ ${(e as Error).message}`);
        return err(e);
      }
    },
    {
      name: 'fetch_sub_skill',
      description: TOOL_DESCRIPTIONS.fetch_sub_skill,
      schema: z.object({
        name: subSkillEnum.describe(PARAM_DESCRIPTIONS.subSkillName),
      }),
    },
  );

  // ── Wallet tools ──────────────────────────────────────────────────────────

  const listAgentWallets = tool(
    async () => {
      log('circle_list_wallets');
      try {
        const result = await circle.listWallets();
        log(`circle_list_wallets ← ${result.length} wallet(s)`);
        return ok(result);
      } catch (e) {
        log(`circle_list_wallets ✗ ${(e as Error).message}`);
        return err(e);
      }
    },
    {
      name: 'circle_list_wallets',
      description: TOOL_DESCRIPTIONS.circle_list_wallets,
      schema: z.object({}),
    },
  );

  const createAgentWallet = tool(
    async () => {
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
    {
      name: 'circle_create_wallet',
      description: TOOL_DESCRIPTIONS.circle_create_wallet,
      schema: z.object({}),
    },
  );

  const getWalletBalance = tool(
    async ({ address, chain }) => {
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
    {
      name: 'circle_get_balance',
      description: TOOL_DESCRIPTIONS.circle_get_balance,
      schema: z.object({
        address: z.string().describe(PARAM_DESCRIPTIONS.address),
        chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
      }),
    },
  );

  const fundWalletTool = tool(
    async ({ address, method }) => {
      log(`circle_wallet_fund address=${address} method=${method ?? 'crypto'}`);
      try {
        const out = await circle.fundWallet({ address, method });
        log('circle_wallet_fund ← done');
        return out;
      } catch (e) {
        log(`circle_wallet_fund ✗ ${(e as Error).message}`);
        return err(e);
      }
    },
    {
      name: 'circle_wallet_fund',
      description: TOOL_DESCRIPTIONS.circle_wallet_fund,
      schema: z.object({
        address: z.string().describe(PARAM_DESCRIPTIONS.address),
        method: z
          .enum(['crypto', 'fiat'])
          .optional()
          .describe('"crypto" draws from the testnet faucet; "fiat" runs the test card flow.'),
      }),
    },
  );

  const deployWalletTool = tool(
    async ({ address, chain }) => {
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
    {
      name: 'circle_deploy_wallet',
      description: TOOL_DESCRIPTIONS.circle_deploy_wallet,
      schema: z.object({
        address: z.string().describe(PARAM_DESCRIPTIONS.address),
        chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
      }),
    },
  );

  const fundFiatTool = tool(
    async ({ address, amount, chain, token }) => {
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
    {
      name: 'circle_fund_fiat',
      description: TOOL_DESCRIPTIONS.circle_fund_fiat,
      schema: z.object({
        address: z.string().describe(PARAM_DESCRIPTIONS.address),
        amount: z.number().positive().describe(PARAM_DESCRIPTIONS.fiatAmount),
        chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
        token: z
          .enum(['usdc', 'eurc', 'eth', 'native'])
          .optional()
          .describe('Token to buy. Defaults to usdc.'),
      }),
    },
  );

  // ── Service discovery tools ───────────────────────────────────────────────

  const searchServices = tool(
    async ({ keyword }) => {
      log(`circle_search_services keyword="${keyword}"`);
      try {
        const result = await circle.searchServices({ keyword });
        log(`circle_search_services ← ${result.length} hit(s)`);
        return ok(result);
      } catch (e) {
        log(`circle_search_services ✗ ${(e as Error).message}`);
        return err(e);
      }
    },
    {
      name: 'circle_search_services',
      description: TOOL_DESCRIPTIONS.circle_search_services,
      schema: z.object({
        keyword: z.string().describe('Search keyword.'),
      }),
    },
  );

  const inspectService = tool(
    async ({ url }) => {
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
    {
      name: 'circle_inspect_service',
      description: TOOL_DESCRIPTIONS.circle_inspect_service,
      schema: z.object({
        url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
      }),
    },
  );

  const fetchServiceTool = tool(
    async ({ url }) => {
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
    {
      name: 'fetch_service',
      description: TOOL_DESCRIPTIONS.fetch_service,
      schema: z.object({
        url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
      }),
    },
  );

  const getGatewayBalance = tool(
    async ({ address, chain }) => {
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
    {
      name: 'circle_get_gateway_balance',
      description: TOOL_DESCRIPTIONS.circle_get_gateway_balance,
      schema: z.object({
        address: z.string().describe(PARAM_DESCRIPTIONS.address),
        chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
      }),
    },
  );

  // ── Spend tools ───────────────────────────────────────────────────────────
  //
  // No approval prompt in here: Deep Agents' `interruptOn` (see agent.ts) pauses
  // the graph before either of these runs, and the entry point resumes it once
  // the human answers. By the time `execute` is entered, approval has happened.

  const payService = tool(
    async ({ url, address, dataJson, method }) => {
      const httpMethod = (method ?? 'GET').toUpperCase();
      log(
        `circle_pay_service url=${url} from=${address} method=${httpMethod} data=${preview(dataJson, 80)}`,
      );

      const payload = parsePayload(dataJson);
      if (!payload.ok) {
        log('circle_pay_service ✗ invalid dataJson');
        return err(new Error(payload.message));
      }

      const chain = await selectPayChain(url, httpMethod, address, log);
      if (!chain.ok) return err(new Error(chain.message));

      const deployed = await ensureDeployed(address, chain.chain, log);
      if (!deployed.ok) return err(new Error(deployed.message));

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
    {
      name: 'circle_pay_service',
      description: TOOL_DESCRIPTIONS.circle_pay_service,
      schema: z.object({
        url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
        address: z.string().describe(PARAM_DESCRIPTIONS.address),
        method: methodEnum.optional().describe(PARAM_DESCRIPTIONS.httpMethod),
        dataJson: z.string().describe(PARAM_DESCRIPTIONS.dataJson),
      }),
    },
  );

  const gatewayDepositTool = tool(
    async ({ url, address, method, amount }) => {
      const httpMethod = (method ?? 'GET').toUpperCase();
      log(`circle_gateway_deposit url=${url} address=${address} amount=${amount}`);

      const chain = await selectGatewayChain(url, httpMethod, log);
      if (!chain.ok) return err(new Error(chain.message));

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
    {
      name: 'circle_gateway_deposit',
      description: TOOL_DESCRIPTIONS.circle_gateway_deposit,
      schema: z.object({
        url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
        address: z.string().describe(PARAM_DESCRIPTIONS.address),
        method: methodEnum.optional().describe(PARAM_DESCRIPTIONS.httpMethod),
        amount: z.number().positive().describe(PARAM_DESCRIPTIONS.depositAmount),
      }),
    },
  );

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
