import { defineSandbox, defaultBackend, type SandboxSession } from "eve/sandbox";

const SANDBOX_BUN_VERSION = "1.3.14";
const BUN_PATH = "$HOME/.bun/bin:/root/.bun/bin:/home/vercel-sandbox/.bun/bin:$PATH";
type NetworkPolicyUse = (options?: { networkPolicy: "allow-all" | "deny-all" }) => Promise<SandboxSession>;

export default defineSandbox({
  backend: defaultBackend(),
  revalidationKey: () => `bun-${SANDBOX_BUN_VERSION}-v1`,
  async bootstrap({ use }) {
    const sandbox = await (use as NetworkPolicyUse)({ networkPolicy: "allow-all" });
    const installBunScript = [
      "set -euo pipefail",
      `export PATH="${BUN_PATH}"`,
      `if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version)" != "${SANDBOX_BUN_VERSION}" ]; then curl -fsSL https://bun.sh/install | bash -s "bun-v${SANDBOX_BUN_VERSION}"; export PATH="${BUN_PATH}"; fi`,
      'actual="$(bun --version)"',
      `if [ "$actual" != "${SANDBOX_BUN_VERSION}" ]; then echo "expected Bun ${SANDBOX_BUN_VERSION}, got $actual" >&2; exit 1; fi`,
    ].join("; ");
    const result = await sandbox.run({
      command: `bash -lc ${shellQuote(installBunScript)}`,
    });
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
    if (exitCode !== 0) {
      const detail = String(result.stderr || result.stdout || "").slice(0, 1_000);
      throw new Error(`Bun sandbox bootstrap failed: ${detail}`);
    }
  },
  async onSession({ use }) {
    await (use as NetworkPolicyUse)({ networkPolicy: "deny-all" });
  },
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
