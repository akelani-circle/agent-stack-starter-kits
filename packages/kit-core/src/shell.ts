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
 * The shell the agent works in.
 *
 * Circle's skills are written for an agent that drives a terminal — every step
 * of them is a command — so the agent gets a terminal, and nothing is withheld
 * from it beyond the approval gate in `./approval`. That is also why there is no
 * allowlist here: the point of a shell is that `circle` is one of the things on
 * it, next to `curl`, `jq`, `npm` and everything else the user has installed.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * Marketplace searches, paid calls and package installs are all slower than a
 * typical tool timeout, and a paid call that is killed mid-flight has still been
 * charged for.
 */
export const DEFAULT_SHELL_TIMEOUT_MS = 180_000;

/**
 * Cap on what one command hands back to the model.
 *
 * A marketplace search is thousands of lines of JSON schema, well past what a
 * tool result can usefully carry, and every byte of it stays in the conversation
 * for the rest of the session. Past this the output is cut and the agent is told
 * to redirect the command to a file and read back the part it wants — which is
 * what a person does, and is why `read_file` and `grep` exist alongside this.
 */
export const MAX_SHELL_OUTPUT_CHARS = 30_000;

export interface ShellOptions {
  /** Where the command runs. Defaults to the user's home directory. */
  cwd?: string;
  /** Milliseconds before the command is killed. Defaults to three minutes. */
  timeoutMs?: number;
  /** Cap on returned characters. Defaults to {@link MAX_SHELL_OUTPUT_CHARS}. */
  maxOutputChars?: number;
}

export interface ShellResult {
  command: string;
  /** Exit status, or null when the process was killed by a signal. */
  exitCode: number | null;
  /** stdout and stderr interleaved in the order they arrived, as a terminal shows them. */
  output: string;
  /** True when `output` was cut at the cap. */
  truncated: boolean;
  /** Characters dropped by the cap. */
  omitted: number;
  /** True when the command outran `timeoutMs` and was killed. */
  timedOut: boolean;
  durationMs: number;
}

/**
 * Environment variables the child inherits.
 *
 * A deliberately short list. The Circle CLI keeps its session token in the
 * operating system's keyring rather than a file, so reaching it takes the DBus
 * session on Linux and the profile paths on Windows — without them every command
 * reports a logged-out wallet on a host that is logged in.
 *
 * What is *not* forwarded matters as much. The kit's own `.env` holds an LLM
 * provider key, and the agent has no use for it: passing the whole environment
 * would put that key one `env` command away from any output the model reads
 * back. CIRCLE_ACCEPT_TERMS is absent for a different reason — accepting
 * Circle's Terms of Use is not something an agent may do for a user.
 */
const INHERITED_ENV_VARS = [
  'PATH',
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'COMSPEC',
];

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Colour escapes and Node's deprecation warnings are noise the model has to
    // read past, and they cost tokens on every single command.
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
  };
  for (const name of INHERITED_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * The interpreter a command string is handed to.
 *
 * POSIX shells only, even when the user's own login shell is something else:
 * the approval gate in `./approval` splits on `;`, `|`, `&&` and `||`, and the
 * skills are written in the same syntax. Running the line under a shell that
 * parses it differently would put the gate and the interpreter out of step,
 * which is the one disagreement that matters here.
 */
function interpreter(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c'] };
  }
  const bash = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p));
  return { command: bash ?? '/bin/sh', args: ['-c'] };
}

/** Cut `text` to `max` characters, reporting how much was dropped. */
function cap(text: string, max: number): { text: string; truncated: boolean; omitted: number } {
  if (text.length <= max) return { text, truncated: false, omitted: 0 };
  const omitted = text.length - max;
  return { text: text.slice(0, max), truncated: true, omitted };
}

/**
 * Run one shell command and resolve with everything it printed.
 *
 * Never rejects on a non-zero exit: a command that fails is an ordinary result
 * the agent has to read and act on, and turning it into a thrown error would
 * hide the stderr that says what to fix. It rejects only when no process could
 * be started at all.
 *
 * stdin is closed rather than piped. A CLI subcommand that reads it — a
 * confirmation prompt, an OTP entry — sees EOF immediately and fails fast,
 * instead of hanging forever on input no agent is there to type.
 */
export function runShell(command: string, options: ShellOptions = {}): Promise<ShellResult> {
  const cwd = options.cwd ?? homedir();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? MAX_SHELL_OUTPUT_CHARS;
  const shell = interpreter();
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(shell.command, [...shell.args, command], {
      cwd,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a timeout kills the whole pipeline rather than
      // just the shell that spawned it and leaving orphans behind.
      detached: process.platform !== 'win32',
    });

    // One buffer for both streams, in arrival order. A CLI that reports progress
    // on stderr and data on stdout reads as one transcript this way, which is
    // what the agent would see if it were sitting at the terminal.
    let output = '';
    let timedOut = false;
    // Keep a little past the cap so `omitted` is a real count for short
    // overruns, without buffering a runaway command without limit. Trimmed to
    // the remaining budget rather than checked-then-appended, so one large
    // chunk (a pipe can deliver tens of KB at once) can't push `output` past
    // this hard cap.
    const hardCap = maxOutputChars * 4;
    const collect = (chunk: string): void => {
      const remaining = hardCap - output.length;
      if (remaining <= 0) return;
      output += chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') child.kill();
        else process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const capped = cap(output, maxOutputChars);
      resolve({
        command,
        exitCode: code,
        output: capped.text,
        truncated: capped.truncated,
        omitted: capped.omitted,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Render a result as the model reads it.
 *
 * Exit status is always stated, including on success, because "it printed
 * nothing" and "it failed silently" are otherwise the same string. A truncation
 * says what to do about it rather than only that it happened — re-running a
 * command to see output you already fetched is the expensive mistake here, and
 * on a paid call it is a second charge.
 */
export function formatShellResult(result: ShellResult): string {
  const body = result.output.trim();
  const parts: string[] = [];

  if (result.timedOut) {
    parts.push(
      `Command killed after ${Math.round(result.durationMs / 1000)}s (timeout). ` +
        'Anything it had already printed follows; anything it was going to do may or may not have happened.',
    );
  }
  parts.push(body || '(no output)');
  if (result.truncated) {
    parts.push(
      `[output cut here — ${result.omitted} more characters. Do not re-run this command to see ` +
        'the rest: run it again only with `> /tmp/out.json` appended, then use read_file or grep ' +
        'on that file.]',
    );
  }
  if (!result.timedOut) {
    parts.push(result.exitCode === 0 ? '[exit 0]' : `[exit ${String(result.exitCode)}]`);
  }
  return parts.join('\n\n');
}
