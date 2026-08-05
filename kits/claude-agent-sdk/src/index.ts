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
  query,
  type CanUseTool,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { createChatUi, type ChatUi } from '@agent-stack-starter-kits/agent-cli';
import {
  ensureSession,
  parseServiceSearch,
  type AskFn,
} from '@agent-stack-starter-kits/circle-tools';

import {
  approveCommand,
  buildInitialPrompt,
  createBalanceReadout,
  createCommandRouter,
  isProviderOverloaded,
  preview,
  recordServiceSearch,
  reportFatal,
  requiresApproval,
  REJECTED_MESSAGE,
} from '@agent-stack-starter-kits/kit-core';
import { buildQueryOptions, SHELL_TOOL } from './agent';
import { loadConfig } from './config';
import { bold, dim, heading, kitLine, red, streamedBlock, yellow } from './theme';

// The chat UI pins the input to the bottom while logs scroll above it. It is
// created in main(); the module-level handle lets the fatal handler close it
// (restoring the console) before printing, and lets the log helpers below route
// output into the scrollback once it exists.
let ui: ChatUi | null = null;

/** Emit a namespaced `[claude-agent-kit]` framework line to the scrollback. */
function log(line: string): void {
  const formatted = kitLine(line);
  if (ui) ui.log(formatted);
  else console.log(formatted);
}

/** Emit an already-formatted line (JSON, agent prose) verbatim. */
function out(line: string): void {
  if (ui) ui.log(line);
  else console.log(line);
}

// The pinned USDC readout, shared by every kit (see kit-core/balance). `ui` is
// passed as a getter because it only exists once main() creates the chat UI.
const balance = createBalanceReadout(() => ui);

/** Wrap a turn of user text as the streaming-input message the SDK expects. */
function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

/**
 * Marketplace searches the agent has run and whose output has not come back yet,
 * keyed by tool-use id.
 *
 * The other kits arm the numbered quick-pick from inside their own shell tool,
 * where the command and its output are one function call apart. Here the shell
 * is the SDK's, so the two arrive as separate messages — the command on an
 * assistant message, the output on the user message that answers it — and the id
 * is what ties them back together.
 */
const pendingSearches = new Set<string>();

/**
 * Print one assistant message: the model's prose under a per-turn heading, and a
 * line for each tool it reached for.
 *
 * The tool lines matter more here than they look. This kit's tools are the SDK's
 * own, so nothing logs itself the way a hand-written tool body would, and
 * without this the terminal would show a long silence and then a conclusion,
 * with no sign of the commands that produced it.
 *
 * NOTE: prose prints in the `--- agent ---` frame rather than the
 * `--- agent reply ---` one the other five kits close a turn with. Those kits
 * invoke discretely and so have a single final answer to frame; this one
 * streams, and every text block arrives the same way, with no marker on the
 * stream that says which is the last. Showing them as they land is the point of
 * a streaming session, so they are all framed as mid-turn prose.
 */
function printAssistant(msg: Extract<SDKMessage, { type: 'assistant' }>): void {
  const content = msg.message.content;
  const blocks = Array.isArray(content) ? content : [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text.trim()) {
      out(streamedBlock(block.text));
    } else if (block.type === 'tool_use') {
      const input = (block.input ?? {}) as Record<string, unknown>;
      const detail =
        typeof input.command === 'string'
          ? input.command
          : typeof input.file_path === 'string'
            ? input.file_path
            : typeof input.pattern === 'string'
              ? input.pattern
              : '';
      log(`${block.name}${detail ? ` ${preview(detail)}` : ''}`);
      if (
        block.name === SHELL_TOOL &&
        typeof input.command === 'string' &&
        /\bcircle\s+services\s+search\b/.test(input.command)
      ) {
        pendingSearches.add(block.id);
      }
    }
  }
}

/**
 * Re-arm the numbered quick-pick from a marketplace search the agent ran itself,
 * so a bare "2" at the next prompt means the second result it just printed.
 * Silent by contract: output that is not a search payload leaves the list alone.
 */
function noteToolResults(msg: Extract<SDKMessage, { type: 'user' }>): void {
  const content = msg.message.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type !== 'tool_result' || !pendingSearches.delete(block.tool_use_id)) continue;
    const text =
      typeof block.content === 'string'
        ? block.content
        : (block.content ?? [])
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('\n');
    const services = parseServiceSearch(text);
    if (services.length > 0) recordServiceSearch(services);
  }
}

/** Print a one-line turn summary (duration + cost), or the error on failure. */
function printResult(msg: Extract<SDKMessage, { type: 'result' }>): void {
  const secs = (msg.duration_ms / 1000).toFixed(1);
  if (msg.subtype === 'success') {
    log(dim(`turn complete (${secs}s, $${msg.total_cost_usd.toFixed(4)})`));
  } else {
    log(red(`turn ended: ${msg.subtype} (${secs}s)`));
    // The Claude Code subprocess retries 529 itself (those retries surface via
    // the wired stderr), so a 529 that reaches here means retries ran out —
    // transient on the provider's side, not a kit bug.
    if (msg.errors.some(isProviderOverloaded)) {
      log(yellow('The LLM provider is overloaded (HTTP 529). This is transient; try again in a moment.'));
    }
    for (const e of msg.errors) out(red(e));
  }
}

async function main(): Promise<void> {
  // Pin the input to the bottom (Claude Code-style) while logs scroll above.
  // Falls back to plain console + readline when stdout/stdin is not a TTY.
  const chat = createChatUi({ title: heading('Autonomous Payment Agent') });
  ui = chat;

  log('Autonomous Payment Agent demo starting');
  const config = loadConfig();
  log(`provider=${config.provider} model=${config.model}`);

  // Every prompt (chat input, approval [y/N], email/OTP) flows through the same
  // pinned input box the chat UI renders at the bottom of the terminal.
  // `exit` typed at ANY prompt halts the demo immediately, tearing down the UI
  // (which restores the console) before the answer reaches the caller.
  const ask: AskFn = async (q, options) => {
    const answer = await chat.ask(q, options);
    if (answer.trim().toLowerCase() === 'exit') {
      log('exit, halting.');
      chat.close();
      process.exit(0);
    }
    return answer;
  };

  // Human-in-the-loop. `canUseTool` is the SDK-native place for it, and it sees
  // the tool's arguments — which is what the gate now needs, because with a
  // shell the thing worth stopping is a command, not a tool. Everything but the
  // shell is auto-allowed in agent.ts and never reaches this; a shell command
  // that spends stops for a y/N, and every other one runs.
  const canUseTool: CanUseTool = async (toolName, input): Promise<PermissionResult> => {
    const command = String((input as { command?: unknown }).command ?? '');
    if (toolName !== SHELL_TOOL || !requiresApproval(command)) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (await approveCommand(ask, command, { log, out })) {
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: REJECTED_MESSAGE };
  };

  // Streaming input: the bootstrap prompt drives turn one; thereafter the result
  // handler feeds follow-ups through `pushInput`. Buffering decouples the SDK
  // pulling the next input from when the user actually answers, so the prompt
  // order never races the SDK's read of the stream.
  const buffered: Array<SDKUserMessage | null> = [];
  let waiter: ((m: SDKUserMessage | null) => void) | null = null;
  function pushInput(m: SDKUserMessage | null): void {
    if (waiter) {
      waiter(m);
      waiter = null;
    } else {
      buffered.push(m);
    }
  }
  function nextInput(): Promise<SDKUserMessage | null> {
    if (buffered.length > 0) return Promise.resolve(buffered.shift() ?? null);
    return new Promise((resolve) => {
      waiter = resolve;
    });
  }

  // On a machine with no skills this is Circle's own bootstrap line, so the
  // first turn installs them; otherwise it is a status check.
  const initialPrompt = await buildInitialPrompt();

  async function* inputStream(): AsyncGenerator<SDKUserMessage> {
    yield userMessage(initialPrompt);
    while (true) {
      const next = await nextInput();
      if (next === null) return;
      yield next;
    }
  }

  // Inline auth: ensure the Circle CLI has a valid agent session before the
  // agent runs. Logs in with email + OTP if needed; a pending Terms gate is
  // reported as a manual step (the kit never accepts the Terms for the user).
  await ensureSession({ ask, log, bold });
  await balance.refresh();

  // Handles "/balance", "/discover <keyword>", etc. (direct circle-tools calls,
  // no model turn spent) and bare-number replies to a prior "/discover" list.
  const commands = createCommandRouter({ log, out, refreshBalance: balance.refresh });

  log('invoking agent ...');
  chat.setStatus('working…');
  const session = query({
    prompt: inputStream(),
    options: await buildQueryOptions(config, canUseTool),
  });

  // One `query` call is the whole conversation: the SDK keeps full context
  // across turns natively, so there is no thread_id to carry. We print as
  // messages stream and, on each turn's `result`, prompt for the next turn.
  //
  // NOTE: unlike the discrete-invoke kits (openai/mastra/vercel/langchain),
  // this kit does NOT wrap turns in the shared `withRetry` + per-attempt
  // timeout. A single streaming `query` session cannot be re-invoked without
  // discarding the whole conversation, and racing a timeout against the stream
  // would truncate legitimately long turns. If a stall guard is needed here,
  // drive the iterator manually and race each `.next()` against a timeout,
  // calling `session.return?.()` to tear the session down on timeout.
  for await (const msg of session) {
    if (msg.type === 'assistant') {
      printAssistant(msg);
    } else if (msg.type === 'user') {
      noteToolResults(msg);
    } else if (msg.type === 'result') {
      printResult(msg);
      chat.setStatus(null);
      balance.refreshSoon();
      // Loop locally until there's either a quit or real text for the agent: a
      // blank line re-prompts, and "/command"/numbered picks are answered here
      // without ever feeding the SDK's input stream. `exit` is handled in `ask`.
      let forward: string | null = null;
      for (;;) {
        const next = (await ask('> ', { placeholder: 'type "/help" for quick commands or "exit" to quit' })).trim();
        if (!next) continue;
        if (next.toLowerCase() === 'quit') break;
        const outcome = await commands.run(next);
        if (!outcome.handled) {
          forward = next;
          break;
        }
        if (outcome.forward) {
          forward = outcome.forward;
          break;
        }
      }
      if (forward === null) {
        log('done.');
        pushInput(null);
      } else {
        chat.setStatus('working…');
        pushInput(userMessage(forward));
      }
    }
  }

  // Unmount the UI (and restore the patched console) so the process can exit.
  chat.close();
}

main().catch((err: unknown) => {
  // Tear down the UI first so the console is restored before we print the
  // failure; otherwise these lines would be swallowed by the Ink frame.
  ui?.close();
  reportFatal(err, kitLine);
  process.exit(1);
});
