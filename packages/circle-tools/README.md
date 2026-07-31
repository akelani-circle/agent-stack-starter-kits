# @agent-stack-starter-kits/circle-tools

Shared, framework-agnostic TypeScript wrappers around the [Circle CLI](https://developers.circle.com/agent-stack/circle-cli/command-reference). Every kit calls these through [`kit-core`](../kit-core); nothing here is framework-specific.

Wrapped commands:

| Command | Used for |
| --- | --- |
| `circle wallet status` | session check, Terms gate |
| `circle wallet login` (`--init`, `--otp`) | email + OTP login |
| `circle wallet logout` | clear stored credentials |
| `circle wallet create` / `list` / `balance` | agent wallets and token balances |
| `circle wallet fund` | testnet USDC (faucet or test card) |
| `circle wallet transfer` | zero-value self-transfer that deploys the Smart Contract Account |
| `circle gateway balance` / `deposit` | Circle Gateway (batched-payment) pool |
| `circle services search` / `inspect` / `pay` | marketplace discovery and x402 payments |

Base and Polygon are both supported; `payService` picks the chain from the options a seller publishes and the wallet's balance on each.

Everything else in the package works over HTTP rather than the CLI: the Transak fiat on-ramp URL builder, the `eth_getCode` deployment check, and the pre-spend guards that refuse a payment the seller would reject — service health, wallet balance vs. price, payload fields against the published schema, and URL path parameters that are still template placeholders.
