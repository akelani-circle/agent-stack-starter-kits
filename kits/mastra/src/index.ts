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

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { createChatUi, withRetry, type ChatUi } from '@agent-stack-starter-kits/agent-cli';
import { ensureSession } from '@agent-stack-starter-kits/circle-tools';
import { BOOTSTRAP_PROMPT, createBalanceReadout } from '@agent-stack-starter-kits/kit-core';
import { onboardingWorkflow } from './workflow';
import { buildAgent } from './agent';
import { loadConfig } from './config';
import { bold, kitLine } from './theme';

// The chat UI pins the input to the bottom while logs scroll above it. It is
// created in main(); the module-level handle lets the fatal handler close it
// (restoring the console) before printing, and lets the helpers below route
// output into the scrollback once it exists.
let ui: ChatUi | null = null;

/** Emit a namespaced `[mastra-kit]` framework line to the scrollback. */
function log(line: string): void {
  const formatted = kitLine(line);
  if (ui) ui.log(formatted);
  else console.log(formatted);
}

/** Emit an already-formatted line (agent output) verbatim. */
function out(line: string): void {
  if (ui) ui.log(line);
  else console.log(line);
}

// The pinned USDC readout, shared by every kit (see kit-core/balance). `ui` is
// passed as a getter because it only exists once main() creates the chat UI.
const balance = createBalanceReadout(() => ui);

async function ask(question: string): Promise<string> {
  if (ui) return (await ui.ask(question)).trim();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  // Pin the input to the bottom (Claude Code-style) while logs scroll above.
  // Falls back to plain console + readline when stdout/stdin is not a TTY.
  const chat = createChatUi({ title: bold('Circle Agent Stack onboarding') });
  ui = chat;

  log('starting Circle Agent Stack onboarding demo');
  const config = loadConfig();
  log(`chain=${config.chain} provider=${config.provider} model=${config.model}`);

  await ensureSession({ ask, log, bold });
  await balance.refresh();

  chat.setStatus('working…');
  const run = await onboardingWorkflow.createRun();
  let result = await run.start({ inputData: {} });

  // Generic resume driver: no shipped step suspends (login is handled up front
  // by `ensureSession`), but any human-in-the-loop step added to the workflow
  // gets prompted through the chat UI without touching this file. A suspending
  // step must `suspend(...)` and then return immediately — on resume Mastra
  // re-executes it from the top with `resumeData` set.
  while (result.status === 'suspended') {
    const suspendedEntry = Object.entries(result.steps).find(([, s]) => s.status === 'suspended');
    if (!suspendedEntry) break;
    const [stepId, stepResult] = suspendedEntry;
    const payload = (stepResult as any).suspendPayload as { prompt: string } | undefined;
    if (!payload?.prompt) break;
    chat.setStatus(null);
    const value = await ask(`\n${payload.prompt}\n> `);
    chat.setStatus('working…');
    result = await run.resume({ step: stepId, resumeData: { value } });
  }
  chat.setStatus(null);

  if (result.status !== 'success') {
    out(`[mastra-kit] workflow ended with status: ${result.status}`);
    chat.close();
    return;
  }

  const summary: string =
    (result as any).result?.summary ??
    (result as any).steps?.agent?.output?.summary ??
    '(no output)';
  out(summary);
  balance.refreshSoon();

  log('continue the conversation — type "exit" to quit');
  const agent = buildAgent(config, ask);
  const messages: Array<{ role: 'user'; content: string } | { role: 'assistant'; content: string }> = [
    { role: 'user', content: BOOTSTRAP_PROMPT },
    { role: 'assistant', content: summary },
  ];

  while (true) {
    const input = await ask('> ');
    if (input.toLowerCase() === 'exit') break;
    // A blank line is a stray Enter, not an intent to quit: re-prompt.
    if (!input) continue;
    messages.push({ role: 'user', content: input });
    chat.setStatus('working…');
    const response = await withRetry(
      (signal) => agent.generate(messages, { maxSteps: 30, abortSignal: signal }),
      { label: 'agent', log },
    );
    chat.setStatus(null);
    balance.refreshSoon();
    const text = response.text ?? '(no output)';
    out('\n' + text + '\n');
    messages.push({ role: 'assistant', content: text });
  }

  log('onboarding complete');
  // Unmount the UI (and restore the patched console) so the process can exit.
  chat.close();
}

main().catch((err: unknown) => {
  // Tear down the UI first so the console is restored before we print.
  ui?.close();
  console.error('[mastra-kit] fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
