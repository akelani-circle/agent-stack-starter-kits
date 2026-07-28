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
 * The Circle Agent Marketplace skills the kits run on.
 *
 * These kits ship no agent instructions of their own. Everything the agent is
 * told to do comes from the markdown served at agents.circle.com/skills, fetched
 * at runtime: `setup.md` drives the first turn, and it routes to the sub-skills
 * below as the flow needs them. Publishing a change to those documents changes
 * every kit's behaviour without a code release, which is the point.
 */

export const SKILLS_BASE_URL = 'https://agents.circle.com/skills';
export const SETUP_SKILL_URL = `${SKILLS_BASE_URL}/setup.md`;

/**
 * The one and only prompt the kits put in front of the agent, quoted verbatim
 * from the marketplace's own setup copy. Everything the agent subsequently does
 * is driven by the markdown this fetches, never by kit-authored guidance.
 */
export const BOOTSTRAP_PROMPT =
  `Run curl -sL ${SETUP_SKILL_URL}, ` +
  'and use the returned setup instructions to set up my agent wallet.';

export const SUB_SKILLS = {
  'wallet-login': `${SKILLS_BASE_URL}/wallet-login.md`,
  'wallet-fund': `${SKILLS_BASE_URL}/wallet-fund.md`,
  'wallet-pay': `${SKILLS_BASE_URL}/wallet-pay.md`,
  'discover-services': `${SKILLS_BASE_URL}/discover-services.md`,
} as const satisfies Record<string, string>;

export type SubSkillName = keyof typeof SUB_SKILLS;

export const SUB_SKILL_NAMES = Object.keys(SUB_SKILLS) as SubSkillName[];

/** Bullet list of the sub-skills and their URLs, for the fetch_sub_skill schema. */
export const SUB_SKILL_CATALOG = SUB_SKILL_NAMES.map((n) => `- ${n} → ${SUB_SKILLS[n]}`).join('\n');

/**
 * Cap on the skill markdown handed back to the model in one tool result.
 *
 * Skill documents are large and every fetched one stays in the conversation
 * history for the rest of the session, so an uncapped fetch of the biggest of
 * them can push a token-per-minute limit into 429s.
 *
 * The cap is sized so that `setup.md` — which drives the entire flow and whose
 * tail carries the Rules and the Terms of Use consent gate — always arrives
 * whole. Truncating that document would drop the very instructions these kits
 * exist to defer to. Today only `wallet-pay.md` exceeds this, and it is fetched
 * on demand for triage whose actionable content leads the document.
 */
export const MAX_SKILL_CHARS = 16_000;

/** Truncate over-long skill markdown, telling the reader what was cut and how to get it. */
function cap(body: string, url: string): string {
  if (body.length <= MAX_SKILL_CHARS) return body;
  const omitted = body.length - MAX_SKILL_CHARS;
  return `${body.slice(0, MAX_SKILL_CHARS)}\n\n[...${omitted} chars omitted. The full document is at ${url}]`;
}

async function fetchMarkdown(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${res.status} ${res.statusText}. ` +
        'Check connectivity or visit the URL in a browser to confirm it is reachable.',
    );
  }
  return cap(await res.text(), url);
}

export function fetchSetupSkill(): Promise<string> {
  return fetchMarkdown(SETUP_SKILL_URL);
}

export function fetchSubSkill(name: SubSkillName): Promise<string> {
  return fetchMarkdown(SUB_SKILLS[name]);
}
