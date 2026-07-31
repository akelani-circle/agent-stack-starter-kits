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

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as circle from '@agent-stack-starter-kits/circle-tools';
import {
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
 * The Circle tools run as an in-process MCP server (`createSdkMcpServer`), the
 * Claude Agent SDK's native way to expose custom tools. Each tool is named
 * `<TOOL>` here but the SDK addresses it as `mcp__circle__<TOOL>` once the
 * server is mounted under MCP_SERVER_NAME, so the entry point and `canUseTool`
 * use the fully-qualified names below.
 */
export const MCP_SERVER_NAME = 'circle';

/** Fully-qualified MCP name for a tool on this server. */
function fq(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

/**
 * The two USDC-moving tools, fully qualified to match what the SDK passes to
 * `canUseTool`. The entry point routes these through human approval; every
 * other tool runs without a pause.
 */
export const SPEND_TOOLS = SPEND_TOOL_NAMES.map(fq);

/** A tool result is plain text the model reads back: JSON for our tools. */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function log(line: string): void {
  console.log(toolLine(line));
}

function text(body: string): ToolResult {
  return { content: [{ type: 'text', text: body }] };
}

function ok(value: unknown): ToolResult {
  return text(JSON.stringify(value));
}

function err(e: unknown): ToolResult {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

const subSkillEnum = z.enum(SUB_SKILL_NAMES as [SubSkillName, ...SubSkillName[]]);
const chainEnum = z.enum(CHAIN_VALUES);
const methodEnum = z.enum(HTTP_METHOD_VALUES);

// ── Skill fetchers ──────────────────────────────────────────────────────────

const fetchSetupSkillTool = tool(
  'fetch_setup_skill',
  TOOL_DESCRIPTIONS.fetch_setup_skill,
  {},
  async (): Promise<ToolResult> => {
    log(`fetch_setup_skill → ${SETUP_SKILL_URL}`);
    try {
      const body = await fetchSetupSkill();
      log(`fetch_setup_skill ← ${body.length} bytes`);
      return text(body);
    } catch (e) {
      log(`fetch_setup_skill ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const fetchSubSkillTool = tool(
  'fetch_sub_skill',
  TOOL_DESCRIPTIONS.fetch_sub_skill,
  { name: subSkillEnum.describe(PARAM_DESCRIPTIONS.subSkillName) },
  async ({ name }): Promise<ToolResult> => {
    log(`fetch_sub_skill name=${name}`);
    try {
      const body = await fetchSubSkill(name);
      log(`fetch_sub_skill ← ${body.length} bytes`);
      return text(body);
    } catch (e) {
      log(`fetch_sub_skill ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

// ── Wallet tools ────────────────────────────────────────────────────────────

const listAgentWallets = tool(
  'circle_list_wallets',
  TOOL_DESCRIPTIONS.circle_list_wallets,
  {},
  async (): Promise<ToolResult> => {
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
);

const createAgentWallet = tool(
  'circle_create_wallet',
  TOOL_DESCRIPTIONS.circle_create_wallet,
  {},
  async (): Promise<ToolResult> => {
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
);

const getWalletBalance = tool(
  'circle_get_balance',
  TOOL_DESCRIPTIONS.circle_get_balance,
  {
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
  },
  async ({ address, chain }): Promise<ToolResult> => {
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
);

const fundWalletTool = tool(
  'circle_wallet_fund',
  TOOL_DESCRIPTIONS.circle_wallet_fund,
  {
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    method: z
      .enum(['crypto', 'fiat'])
      .optional()
      .describe('"crypto" draws from the testnet faucet; "fiat" runs the test card flow.'),
  },
  async ({ address, method }): Promise<ToolResult> => {
    log(`circle_wallet_fund address=${address} method=${method ?? 'crypto'}`);
    try {
      const out = await circle.fundWallet({ address, method });
      log('circle_wallet_fund ← done');
      return text(out);
    } catch (e) {
      log(`circle_wallet_fund ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const deployWalletTool = tool(
  'circle_deploy_wallet',
  TOOL_DESCRIPTIONS.circle_deploy_wallet,
  {
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
  },
  async ({ address, chain }): Promise<ToolResult> => {
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
);

const fundFiatTool = tool(
  'circle_fund_fiat',
  TOOL_DESCRIPTIONS.circle_fund_fiat,
  {
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    amount: z.number().positive().describe(PARAM_DESCRIPTIONS.fiatAmount),
    chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
    token: z
      .enum(['usdc', 'eurc', 'eth', 'native'])
      .optional()
      .describe('Token to buy. Defaults to usdc.'),
  },
  async ({ address, amount, chain, token }): Promise<ToolResult> => {
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
);

// ── Service discovery tools ─────────────────────────────────────────────────

const searchServices = tool(
  'circle_search_services',
  TOOL_DESCRIPTIONS.circle_search_services,
  { keyword: z.string().describe('Search keyword.') },
  async ({ keyword }): Promise<ToolResult> => {
    log(`circle_search_services keyword="${keyword}"`);
    try {
      const result = await circle.searchServices({ keyword });
      log(`circle_search_services ← ${result.length} hit(s)`);
      // Makes these hits addressable by number at the next prompt, exactly as
      // if the user had run `/discover` themselves.
      recordServiceSearch(result);
      return ok(result);
    } catch (e) {
      log(`circle_search_services ✗ ${(e as Error).message}`);
      return err(e);
    }
  },
);

const inspectService = tool(
  'circle_inspect_service',
  TOOL_DESCRIPTIONS.circle_inspect_service,
  { url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl) },
  async ({ url }): Promise<ToolResult> => {
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
);

const fetchServiceTool = tool(
  'fetch_service',
  TOOL_DESCRIPTIONS.fetch_service,
  { url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl) },
  async ({ url }): Promise<ToolResult> => {
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
);

const getGatewayBalance = tool(
  'circle_get_gateway_balance',
  TOOL_DESCRIPTIONS.circle_get_gateway_balance,
  {
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    chain: chainEnum.optional().describe(PARAM_DESCRIPTIONS.chain),
  },
  async ({ address, chain }): Promise<ToolResult> => {
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
);

// ── Spend tools ─────────────────────────────────────────────────────────────
//
// No approval prompt in here: `canUseTool` (see agent.ts) is the SDK-native
// permission hook and pauses before either of these runs, so by the time the
// handler below is entered the human has already approved.

const payServiceTool = tool(
  'circle_pay_service',
  TOOL_DESCRIPTIONS.circle_pay_service,
  {
    url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    method: methodEnum.optional().describe(PARAM_DESCRIPTIONS.httpMethod),
    dataJson: z.string().describe(PARAM_DESCRIPTIONS.dataJson),
  },
  async ({ url, address, dataJson, method }): Promise<ToolResult> => {
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
);

const gatewayDepositTool = tool(
  'circle_gateway_deposit',
  TOOL_DESCRIPTIONS.circle_gateway_deposit,
  {
    url: z.string().describe(PARAM_DESCRIPTIONS.serviceUrl),
    address: z.string().describe(PARAM_DESCRIPTIONS.address),
    method: methodEnum.optional().describe(PARAM_DESCRIPTIONS.httpMethod),
    amount: z.number().positive().describe(PARAM_DESCRIPTIONS.depositAmount),
  },
  async ({ url, address, amount, method }): Promise<ToolResult> => {
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
);

const ALL_TOOLS = [
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
  payServiceTool,
  gatewayDepositTool,
];

/**
 * Build the in-process MCP server exposing the Circle tools.
 *
 * `ask` is needed only by the login tool, which prompts for the email + OTP
 * inline (the kit stores neither), letting the agent recover an expired session
 * mid-conversation instead of dead-ending on "run it yourself".
 */
export function buildCircleServer(ask: AskFn) {
  const loginTool = tool(
    'circle_login',
    TOOL_DESCRIPTIONS.circle_login,
    {},
    async (): Promise<ToolResult> => {
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
  );

  const logoutTool = tool(
    'circle_logout',
    TOOL_DESCRIPTIONS.circle_logout,
    {},
    async (): Promise<ToolResult> => {
      log('circle_logout');
      try {
        await circle.logout(log);
        return ok({ loggedOut: true });
      } catch (e) {
        log(`circle_logout ✗ ${(e as Error).message}`);
        return err(e);
      }
    },
  );

  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '0.0.0',
    tools: [...ALL_TOOLS, loginTool, logoutTool],
  });
}
