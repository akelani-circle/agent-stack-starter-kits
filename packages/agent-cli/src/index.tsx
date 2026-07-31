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

/**
 * Reusable Ink-based chat UI shared by the agent kits.
 *
 * The problem it solves: the kits print log lines with `console.log` and prompt
 * with a fresh readline per question, so the input line scrolls away with the
 * logs. This module pins the input to the bottom of the terminal (like Claude
 * Code) while logs scroll above it, by rendering an Ink app: a `<Static>`
 * scrollback region (each line printed once into terminal history, so it scrolls
 * naturally) plus a live bottom region holding the input box.
 *
 * The kits keep their imperative turn loop untouched — they just call `log()`
 * and `await ask()` on the controller this returns instead of touching
 * `console.log`/readline directly.
 */
import { createInterface } from 'node:readline/promises';
import { format } from 'node:util';

import { Box, render, Static, Text, type Instance } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';

// Shared retry + per-attempt hang timeout, re-exported so kits import it from
// the same package as the chat UI (see ./retry).
export {
  withRetry,
  isRetryableError,
  TurnTimeoutError,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  type WithRetryOptions,
} from './retry';

export interface AskOptions {
  /**
   * Whether the submitted answer is committed to the scrollback. Defaults to
   * true, which is what makes a finished session read as a conversation rather
   * than as the agent talking to itself.
   *
   * Pass false for secrets (the email OTP): the prompt is still recorded, but
   * the value is replaced by a mask so the code never lands in terminal history.
   */
  echo?: boolean;
  /**
   * Grey hint text shown inside the input box while it's empty (e.g. a pointer
   * to `/help`). `ink-text-input` already dims placeholder text and swaps it
   * out for whatever the user types, so this needs no separate "has the user
   * typed yet" tracking. Omit for prompts where a hint would be noise (the
   * approval y/N, login email/OTP).
   */
  placeholder?: string;
}

/** Imperative handle the kits drive; identical shape in TTY and non-TTY modes. */
export interface ChatUi {
  /** Append one line to the scrollback log (keeps any embedded ANSI color). */
  log(line: string): void;
  /** Pin `question` at the bottom and resolve with the line the user submits. */
  ask(question: string, options?: AskOptions): Promise<string>;
  /**
   * Legacy no-op, kept so the kits' existing calls still compile.
   *
   * The busy indicator is no longer switched on and off by hand: it is derived
   * from whether the input is accepting a line (see `Snapshot.question`), which
   * is the only thing "busy" ever meant. Toggling it separately let the two
   * drift apart — the indicator would stop while the input stayed disabled.
   */
  setStatus(text: string | null): void;
  /** Show (or clear, with null) a persistent balance line pinned above the input. */
  setBalance(text: string | null): void;
  /** Unmount the UI and restore the patched console methods. */
  close(): void;
}

export interface ChatUiOptions {
  /** Optional banner printed once at the top of the scrollback. */
  title?: string;
}

interface LogItem {
  id: number;
  text: string;
}

interface Snapshot {
  logs: LogItem[];
  /**
   * The pending question, or null when the agent holds control. This single
   * field drives BOTH halves of the bottom row: a question enables the input,
   * null disables it and shows the animated "Working…" placeholder. They are
   * one state, so they cannot contradict each other.
   */
  question: string | null;
  balance: string | null;
  /** Idle-input hint from the current `ask()`'s `placeholder` option, or ''. */
  placeholder: string;
}

interface Store {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => Snapshot;
}

/**
 * Create the terminal chat UI. In a real TTY this renders the pinned-input Ink
 * app; when stdout/stdin is not a TTY (CI, piped, redirected) it falls back to
 * plain `console.log` + readline so scripted runs keep working unchanged.
 */
export function createChatUi(options: ChatUiOptions = {}): ChatUi {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return interactive ? createInkUi(options) : createPlainUi();
}

/** Strip a trailing prompt marker (`> `) and whitespace so the question reads as
 * a clean label above the input box; the box draws its own `>` caret. */
function toLabel(question: string): string {
  return question.replace(/[\s>]+$/, '');
}

// Dependency-free ANSI, the same approach as kit-core's theme (specific close
// codes so nested stylers don't cancel each other), including its rule for when
// to color at all: never into a pipe or a file, never under NO_COLOR. Kept local
// because this package deliberately has no kit dependencies.
const colored = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'];
const userStyle = (s: string): string => (colored ? `\x1b[1m\x1b[36m${s}\x1b[39m\x1b[22m` : s);

const MASK = '••••••';

/**
 * Render one finished exchange as a scrollback line: the prompt exactly as it
 * was posed, followed by what the user typed, styled so their turns stand out
 * from the agent's output and the `[kit]` framework lines.
 *
 * This exists because Ink holds the terminal in raw mode and draws the input in
 * a live region: nothing records the answer unless we do it here. Under the
 * readline prompts this UI replaced, the terminal's own echo left the exchange
 * in the scrollback for free.
 */
function echoLine(question: string, value: string, echo: boolean): string {
  const shown = echo ? value : value && MASK;
  return `${question}${userStyle(shown)}`;
}

function createInkUi(options: ChatUiOptions): ChatUi {
  const initialLogs: LogItem[] = options.title ? [{ id: 0, text: options.title }] : [];
  // Starts with no question pending: the kit is booting (config, session check,
  // first balance read), which is busy time and reads as such.
  let snapshot: Snapshot = { logs: initialLogs, question: null, balance: null, placeholder: '' };
  let nextId = 1;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const store: Store = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };

  const pushLog = (text: string): void => {
    snapshot = { ...snapshot, logs: [...snapshot.logs, { id: nextId++, text }] };
    emit();
  };

  // One pending question at a time: the kits await ask() sequentially, so a
  // single `echo` flag alongside the resolver is enough to carry the current
  // question's option through to submit.
  let resolveAsk: ((value: string) => void) | null = null;
  let echoAnswer = true;
  const ask = (question: string, options: AskOptions = {}): Promise<string> =>
    new Promise<string>((resolve) => {
      resolveAsk = resolve;
      echoAnswer = options.echo !== false;
      // Re-enabling the input is the one moment control returns to the user, so
      // this is also the moment the busy indicator stops — by construction now,
      // since both read the same field.
      snapshot = { ...snapshot, question, placeholder: options.placeholder ?? '' };
      emit();
    });
  const submit = (value: string): void => {
    const resolve = resolveAsk;
    // No pending question means a stray Enter while the agent works: drop it,
    // rather than committing an orphan prompt line to the scrollback.
    if (!resolve) return;
    resolveAsk = null;
    // Commit the prompt and the answer together, in the same update that clears
    // the input, so the exchange reaches the scrollback as one atomic step.
    const text = echoLine(snapshot.question ?? '', value, echoAnswer);
    snapshot = {
      ...snapshot,
      logs: [...snapshot.logs, { id: nextId++, text }],
      question: null,
    };
    emit();
    resolve(value);
  };

  // No-op: the indicator follows the input state (see ChatUi.setStatus).
  const setStatus = (): void => {};

  const setBalance = (text: string | null): void => {
    snapshot = { ...snapshot, balance: text };
    emit();
  };

  // Route stray console output (tool logs, agent retries, CLI login output)
  // into the scrollback so nothing prints outside the Ink frame. Ink's own
  // console patching is disabled below so these two never fight.
  const original = { log: console.log, error: console.error, warn: console.warn };
  const capture =
    () =>
    (...args: unknown[]): void =>
      pushLog(format(...args));
  console.log = capture();
  console.error = capture();
  console.warn = capture();

  const instance: Instance = render(<App store={store} onSubmit={submit} />, {
    // We own console patching (above); let Ink render straight to stdout.
    patchConsole: false,
  });

  // Idempotent: kits may close on the exit path, in a catch, and again in a
  // finally, so guard against double unmount / double console restore.
  let closed = false;
  return {
    log: pushLog,
    ask,
    setStatus,
    setBalance,
    close: () => {
      if (closed) return;
      closed = true;
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
      instance.unmount();
    },
  };
}

function App({ store, onSubmit }: { store: Store; onSubmit: (value: string) => void }): ReactElement {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [value, setValue] = useState('');

  // Clear the buffer whenever a new question is posed so a stale answer never
  // carries over between prompts.
  useEffect(() => {
    if (snap.question !== null) setValue('');
  }, [snap.question]);

  const handleSubmit = (submitted: string): void => {
    setValue('');
    onSubmit(submitted);
  };

  const pending = snap.question !== null;
  const label = pending ? toLabel(snap.question as string) : '';

  // Busy is the exact complement of "the input is taking a line". Deriving it
  // rather than tracking it separately is what keeps the animation running for
  // the whole disabled stretch — including the gap between a submitted answer
  // and the agent's first output, where a hand-toggled flag was still off.
  const busy = !pending;

  // Animate the "Working" indicator between one, two and three dots so it reads
  // as live progress rather than a frozen line. The timer only runs while the
  // agent is busy; it resets to a single dot each time work starts.
  const [dotFrame, setDotFrame] = useState(0);
  useEffect(() => {
    if (!busy) return;
    setDotFrame(0);
    const timer = setInterval(() => setDotFrame((f) => (f + 1) % 3), 350);
    return () => clearInterval(timer);
  }, [busy]);

  // The input box is ALWAYS mounted, even between prompts. Mounting/unmounting
  // it per turn made `ink-text-input`'s `useInput` toggle the terminal's raw
  // mode on every turn, which under bun corrupts the frame and eventually
  // throws `setRawMode failed with errno: 5`. Keeping it mounted sets raw mode
  // once for the session. Submits while no question is pending are dropped by
  // the controller (there is no `resolveAsk` to satisfy), so an idle Enter is a
  // harmless no-op rather than a race.
  return (
    <Box flexDirection="column">
      <Static items={snap.logs}>{(item) => <Text key={item.id}>{item.text}</Text>}</Static>
      {/* Balance sits ABOVE the input box: rendering it after the input painted
          the readout beneath the prompt, colliding with the caret line. */}
      {snap.balance !== null ? (
        <Text color="green">
          {'◈ '}
          <Text bold>Wallet Balance:</Text>
          {` ${snap.balance}`}
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {label ? <Text>{label}</Text> : null}
        <Box borderStyle="round" paddingX={1} borderColor={pending ? undefined : 'gray'}>
          <Text dimColor={!pending}>{'> '}</Text>
          {/* The busy indicator rides in as the placeholder of the (disabled-looking)
              input rather than as its own line above it. `focus` stays true either
              way: flipping it would toggle `useInput`'s raw mode mid-session, the
              exact churn the note above warns about. Only the fake cursor is hidden
              while working, so the placeholder reads as one dim phrase instead of
              having its first letter inverted into a caret block. */}
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            showCursor={!busy}
            placeholder={busy ? `Working${'.'.repeat(dotFrame + 1)}` : snap.placeholder}
          />
        </Box>
      </Box>
    </Box>
  );
}

/** Non-TTY fallback: the pre-existing behavior (plain logs, per-prompt readline). */
function createPlainUi(): ChatUi {
  return {
    log: (line: string) => console.log(line),
    ask: async (question: string, options: AskOptions = {}): Promise<string> => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(question);
        // Echo into the output stream. This mode is only reached when stdin or
        // stdout is not a terminal, so nothing double-prints: a tty echo of the
        // user's keystrokes goes to the terminal, this line goes to the pipe or
        // file, and each sink ends up with the exchange exactly once.
        console.log(echoLine('', answer, options.echo !== false));
        return answer;
      } finally {
        rl.close();
      }
    },
    setStatus: () => {},
    setBalance: () => {},
    close: () => {},
  };
}
