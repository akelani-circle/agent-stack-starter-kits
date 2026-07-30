# OpenAI Agents SDK × Circle Agent Stack

An agent built with the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/guides/agents/) that owns a USDC wallet and pays for services on the [Circle Agent Marketplace](https://agents.circle.com/services) on your behalf. It boots from Circle's own [setup skill](https://agents.circle.com/skills/setup.md), fetched at runtime, then drops you into a terminal chat.

## Prerequisites

- [Bun](https://bun.com) 1.2+
- Circle CLI: `bun add -g @circle-fin/cli`
- A Circle account and an `OPENAI_API_KEY` (this SDK supports OpenAI models only)

## Run

```bash
bun install
cp kits/openai-agents/.env.example kits/openai-agents/.env   # add your API key
bun run --cwd kits/openai-agents demo
```

Use `--cwd`, not `bun --filter`: the filter dashboard elides output and interferes with the approval prompt.

## First run

- **Login.** The demo checks your Circle session and, if needed, logs you in with your email and a one-time code. You type both; the kit stores neither.
- **Terms of Use.** If your account has not accepted Circle's Terms, the demo stops and asks you to run `circle wallet status` once and accept them yourself — an agent must never accept them for you.
- **Approval.** Before anything spends USDC, the pending call is printed and waits for `y/N`. Nothing is spent unless you approve.
- Type `exit` or `quit` to end the session.

## Try it

Once the wallet is set up, ask for what you want in plain language:

- `check my flight WN2417 using FlightAware`
- `what services are available for weather data?`
- `top up my wallet with testnet USDC`

## Quick commands

A few common lookups skip the model round-trip and answer directly from `circle-tools`:

| Command | Does |
| --- | --- |
| `/help` | list the commands below |
| `/wallets` | list agent wallet addresses |
| `/balance` | per-wallet USDC balances |
| `/gateway` | Circle Gateway balance for the primary wallet |
| `/discover <keyword>` | search the marketplace |

`/discover` prints a numbered list; reply with just a number (e.g. `1`) to hand that service to the agent instead of retyping its name or URL. That still goes through the agent as a normal turn — and the same approval gate if it leads to a payment — the number is just a shortcut for the reference, not a bypass.

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | For Anthropic models, use the `langchain` or `claude-agent-sdk` kit instead. |
| `LLM_MODEL` | no | Overrides the default model (`gpt-5.4`). |
| `CIRCLE_CHAIN` | no | Only labels the startup line. The payment chain is picked per service — Base, or Polygon when a service offers no Base option. |
| `NO_COLOR` | no | Disables colored output. Color is off automatically when output is piped. |

## Links

- OpenAI Agents SDK: [docs](https://openai.github.io/openai-agents-js/guides/agents/), [GitHub](https://github.com/openai/openai-agents-js)
- [Circle Agent Stack](https://developers.circle.com/agent-stack)
- [Circle Agent Marketplace](https://agents.circle.com/services)
- [Circle CLI reference](https://developers.circle.com/agent-stack/circle-cli/command-reference)
- [Circle Developer Discord](https://discord.com/invite/buildoncircle)
