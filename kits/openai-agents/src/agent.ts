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
  callFreeService,
  buildAuthTools,
} from './tools';

export function buildAgent(config: KitConfig, ask: (q: string) => Promise<string>): Agent {
  const { loginTool, logoutTool } = buildAuthTools(ask);
  // No hand-written system prompt: like the langchain, claude-agent-sdk, and
  // google-adk kits, the bootstrap prompt plus setup.md drive the flow. The
  // agent sets up the wallet and then waits for the user to ask for a service,
  // instead of scripting a discover-then-pay sequence on its own.
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
      callFreeService,
    ],
  });
}
