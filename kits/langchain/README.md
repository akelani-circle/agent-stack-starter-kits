# LangChain Deep Agents × Circle Agent Stack

An agent built with [LangChain Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview) that owns a USDC wallet and pays for services on the [Circle Agent Marketplace](https://agents.circle.com/services) on your behalf. It boots from Circle's own [setup skill](https://agents.circle.com/skills/setup.md), fetched at runtime, then drops you into a terminal chat.

## Prerequisites

- [Bun](https://bun.com) 1.2+
- Circle CLI: `bun add -g @circle-fin/cli`
- A Circle account, plus an `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`

## Run

```bash
bun install
cp kits/langchain/.env.example kits/langchain/.env   # add your API key
bun run --cwd kits/langchain demo
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

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` *or* `OPENAI_API_KEY` | one of | Anthropic is used when both are set. |
| `LLM_MODEL` | no | Overrides the default model (`claude-sonnet-4-6` / `gpt-5.4`). |
| `NO_COLOR` | no | Disables colored output. Color is off automatically when output is piped. |

The kit pays on Base, or Polygon when a service offers no Base option. The chain is chosen per service, so there is nothing to configure.

## Links

- LangChain Deep Agents: [docs](https://docs.langchain.com/oss/javascript/deepagents/overview), [GitHub](https://github.com/langchain-ai/deepagentsjs)
- [Circle Agent Stack](https://developers.circle.com/agent-stack)
- [Circle Agent Marketplace](https://agents.circle.com/services)
- [Circle CLI reference](https://developers.circle.com/agent-stack/circle-cli/command-reference)
- [Circle Developer Discord](https://discord.com/invite/buildoncircle)
