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

import { Agent } from '@openai/agents';
import type { KitConfig } from './config';
import {
  fetchSetupSkillTool,
  fetchSubSkillTool,
  circleCreateWallet,
  circleListWallets,
  circleGetBalance,
  circleWalletFund,
  fetchServiceTool,
  circleDeployWallet,
  fundFiatTool,
  circleGetGatewayBalance,
  circleSearchServices,
  circleInspectService,
  circlePayService,
  circleGatewayDeposit,
  buildAuthTools,
  type AskFn,
} from './tools';

/**
 * Build the OpenAI Agents SDK agent for the Autonomous Payment Agent demo.
 *
 * No `instructions` are set, and none are needed: the SDK leaves the system
 * prompt empty when the field is omitted. Everything the agent is told to do
 * arrives at runtime from the Circle marketplace's own skill markdown, which
 * the bootstrap prompt fetches on the first turn.
 */
export function buildAgent(config: KitConfig, ask: AskFn): Agent {
  const { loginTool, logoutTool } = buildAuthTools(ask);
  return new Agent({
    name: 'Circle Payment Agent',
    model: config.model,
    tools: [
      loginTool,
      logoutTool,
      fetchSetupSkillTool,
      fetchSubSkillTool,
      circleCreateWallet,
      circleListWallets,
      circleGetBalance,
      circleWalletFund,
      fetchServiceTool,
      circleDeployWallet,
      fundFiatTool,
      circleGetGatewayBalance,
      circleSearchServices,
      circleInspectService,
      circlePayService,
      circleGatewayDeposit,
    ],
  });
}
