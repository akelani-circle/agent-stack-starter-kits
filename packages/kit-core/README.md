# @agent-stack-starter-kits/kit-core

Framework-agnostic building blocks shared across the Circle Agent Stack kits. Sits one layer above [`circle-tools`](../circle-tools) (the Circle CLI wrappers): each kit imports these pieces and adapts them to its framework's tool/agent interface, so tool wording, skill URLs, payment safety logic, and terminal output stay identical across all six kits.

## Subpath exports

| Import | Module | Contents |
| --- | --- | --- |
| `@agent-stack-starter-kits/kit-core/skill` | `src/skill.ts` | Marketplace skill URLs, fetching, and the bootstrap prompt |
| `@agent-stack-starter-kits/kit-core/tools` | `src/tools.ts` | Tool + parameter descriptions, payment preflight, approval helper |
| `@agent-stack-starter-kits/kit-core/theme` | `src/theme.ts` | Terminal color and formatting helpers |

The package root (`.`) re-exports all three.

## `skill`

The kits ship **no agent instructions of their own**. Everything the agent is told to do comes from the markdown served at `agents.circle.com/skills`, fetched at runtime — so publishing a change to those documents changes every kit's behaviour with no code release.

- `SKILLS_BASE_URL`, `SETUP_SKILL_URL`, `SUB_SKILLS`, `SUB_SKILL_NAMES`, `SUB_SKILL_CATALOG`, `SubSkillName` — skill URLs and names, single-sourced.
- `BOOTSTRAP_PROMPT` — the only prompt any kit puts in front of the agent, quoted verbatim from the marketplace's setup copy. Every kit's entry point uses this constant; none writes its own.
- `fetchSetupSkill()` — fetch `setup.md`, the markdown that drives the agent's first turn.
- `fetchSubSkill(name)` — fetch a named sub-skill (`wallet-login`, `wallet-fund`, `wallet-pay`, `discover-services`).
- `MAX_SKILL_CHARS` — cap on the markdown returned in one tool result, sized so `setup.md` always arrives whole (its tail carries the Rules and the Terms of Use consent gate). Only `wallet-pay.md` currently exceeds it.

## `tools`

Shared model-facing copy plus the payment safety logic.

- `TOOL_DESCRIPTIONS` / `PARAM_DESCRIPTIONS` — the description of every tool and shared parameter, single-sourced so a wording change lands in all six kits at once.

  These say **what a tool does and what its arguments mean, and nothing about when to call it**. Call ordering and safety are enforced in code, not prompted for: the preflight helpers below refuse an unpayable call and return an actionable message the model reads back as a tool result.

- `SPEND_TOOL_NAMES` — the two USDC-moving tools, so each kit's approval gate is keyed off one list.
- `CHAIN_VALUES`, `HTTP_METHOD_VALUES` — enum values each kit wraps in its own framework's zod instance.
- `preview()` — collapse a value to one capped line, for compact log output.
- `parsePayload(dataJson)` — parse the JSON-string payload, returning a message instead of throwing so a malformed payload reaches the model as a correctable tool result.
- Payment preflight (each returns a chosen chain or an actionable error, never throws):
  - `selectPayChain(url, method, address, log)` — confirm the seller publishes a pay option on a supported chain and pick it, preferring Base but deferring to whichever offered chain the wallet can afford.
  - `selectGatewayChain(url, method, log)` — confirm the seller requires a Circle Gateway payment and pick the deposit chain.
  - `ensureDeployed(address, chain, log)` — confirm the wallet's SCA is deployed on the pay chain (a counterfactual wallet cannot sign x402). Best-effort: a flaky RPC passes.
  - `selectDepositMethod(chain)` — Polygon → `eco` (~30s), Base → `direct` (13-19 min).
  - Types: `ChainSelection`, `PreflightCheck`.
- `approveSpend(ask, name, args, log)` — terminal human-in-the-loop gate, for the frameworks whose tool API has no external approval hook (Mastra, Vercel AI). The rest use their native hook: `needsApproval`, `interruptOn`, `canUseTool`, `beforeToolCallback`.

## `theme`

Dependency-free ANSI helpers for the demos' terminal output, switching off when stdout is not a TTY or `NO_COLOR` is set: `bold`, `dim`, `italic`, the color functions (`red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `gray`), `colorizeJson()`, `toolLine()`, `makeKitLine(label)`, and `heading()`.

Each kit's `src/theme.ts` re-exports this module and adds only its own `kitLine`, built from `makeKitLine` with that kit's tag.

## Scripts

- `bun run typecheck` — `tsc --noEmit`
- `bun run build` — `tsc -p tsconfig.json`
- `bun run clean` — remove build output
