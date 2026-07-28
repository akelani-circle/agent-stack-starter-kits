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

import { Agent } from '@mastra/core/agent';
import type { KitConfig } from './config';
import { buildTools } from './tools';

/**
 * Build the Mastra agent for the Autonomous Payment Agent demo.
 *
 * Like every kit here it ships no authored instructions. `instructions` is a
 * required field on Mastra's `Agent`, so it is set empty rather than filled
 * with guidance of our own: everything the agent is told to do arrives at
 * runtime from the Circle marketplace's own skill markdown, which the bootstrap
 * prompt fetches on the first turn.
 */
export function buildAgent(config: KitConfig, ask: (q: string) => Promise<string>): Agent {
  return new Agent({
    id: 'circle-payment-agent',
    name: 'Circle Payment Agent',
    instructions: '',
    model: config.model,
    tools: buildTools(ask),
  });
}
