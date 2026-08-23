export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensurePdfNodePolyfills } = await import("./lib/pdf-node-polyfill");
    await ensurePdfNodePolyfills();
  }
}
