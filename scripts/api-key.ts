/**
 * Manage API keys for bots (e.g. GrokBot) that call /api/mcp.
 *
 *   npx tsx scripts/api-key.ts create --user <username> --name GrokBot [--scopes sops:read,sops:write] [--days 90]
 *   npx tsx scripts/api-key.ts list
 *   npx tsx scripts/api-key.ts revoke <keyId>
 *
 * Without --scopes a key gets every scope. Write scopes only take effect when
 * the owning user is an admin or SOP admin.
 */
import fs from "fs";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { API_KEY_SCOPES, generateApiKey, isApiKeyScope } from "@/lib/api-keys";
import ApiKey from "@/models/ApiKey";
import User from "@/models/User";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      const env = fs.readFileSync(file, "utf8");
      for (const line of env.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (!m || process.env[m[1]]) continue;
        let value = m[2].trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[m[1]] = value;
      }
      return;
    } catch {
      /* try next */
    }
  }
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function create(args: string[]) {
  const username = flag(args, "user")?.toLowerCase();
  const name = flag(args, "name") ?? "GrokBot";
  if (!username) throw new Error("--user <username> is required");

  const user = await User.findOne({ username }).select("_id name role").lean();
  if (!user) throw new Error(`No user "${username}"`);

  const requested = flag(args, "scopes")?.split(",").map((s) => s.trim()).filter(Boolean);
  const invalid = requested?.filter((s) => !isApiKeyScope(s)) ?? [];
  if (invalid.length) throw new Error(`Unknown scope(s): ${invalid.join(", ")}. Valid: ${API_KEY_SCOPES.join(", ")}`);
  const scopes = requested ?? [...API_KEY_SCOPES];

  const days = Number(flag(args, "days") ?? 0);
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86_400_000) : undefined;

  const { key, keyHash, displayPrefix } = generateApiKey();
  const doc = await ApiKey.create({ name, keyHash, displayPrefix, userId: user._id, scopes, expiresAt });

  console.log(`Created key ${doc._id} "${name}" acting as ${user.name} (${user.role})`);
  console.log(`Scopes: ${scopes.join(", ")}${expiresAt ? ` — expires ${expiresAt.toISOString()}` : ""}`);
  if (user.role !== "admin" && user.role !== "sop_admin") {
    console.log("Note: write scopes are ignored because this user is not an admin.");
  }
  console.log("\nAPI key (shown once — store it securely):\n");
  console.log(key);
}

async function list() {
  const keys = await ApiKey.find({}).sort({ createdAt: -1 }).lean();
  const users = await User.find({ _id: { $in: keys.map((k) => k.userId) } }).select("username").lean();
  const usernames = new Map(users.map((u) => [String(u._id), u.username]));
  for (const k of keys) {
    const state = k.revokedAt ? "revoked" : k.expiresAt && k.expiresAt < new Date() ? "expired" : "active";
    console.log(
      `${k._id}  ${k.displayPrefix}…  ${k.name}  user=${usernames.get(String(k.userId)) ?? "?"}  ${state}` +
        `  scopes=${k.scopes.join(",")}  lastUsed=${k.lastUsedAt?.toISOString() ?? "never"}`,
    );
  }
  if (!keys.length) console.log("No API keys.");
}

async function revoke(keyId: string | undefined) {
  if (!keyId || !mongoose.Types.ObjectId.isValid(keyId)) throw new Error("revoke <keyId> is required");
  const res = await ApiKey.updateOne({ _id: keyId }, { revokedAt: new Date() });
  console.log(res.matchedCount ? `Revoked ${keyId}` : `No key ${keyId}`);
}

async function main() {
  loadEnv();
  await connectDB();
  const [command, ...args] = process.argv.slice(2);
  if (command === "create") await create(args);
  else if (command === "list") await list();
  else if (command === "revoke") await revoke(args[0]);
  else console.log("Usage: npx tsx scripts/api-key.ts <create|list|revoke> ...");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
