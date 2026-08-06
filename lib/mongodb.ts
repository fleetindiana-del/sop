import mongoose from "mongoose";
import "@/lib/mongoose-compat";
import { ensureDefaultAdmin } from "@/lib/ensure-admin";
import { validateEnv } from "@/lib/validateEnv";
import { MONGO_CONNECT_OPTIONS } from "./mongo-client-options.mjs";

const MONGODB_URI = process.env.MONGODB_URI;

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  uri?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var mongooseCache: MongooseCache | undefined;
}

const cached: MongooseCache = global.mongooseCache ?? {
  conn: null,
  promise: null,
};

if (!global.mongooseCache) {
  global.mongooseCache = cached;
}

export async function connectDB() {
  validateEnv();
  if (!MONGODB_URI) {
    throw new Error("Please define MONGODB_URI in .env.local");
  }

  // Reconnect if URI changed (e.g. after .env.local edit)
  if (cached.conn && cached.uri !== MONGODB_URI) {
    await mongoose.disconnect();
    cached.conn = null;
    cached.promise = null;
  }

  if (cached.conn) {
    return cached.conn;
  }

  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!cached.promise) {
      cached.uri = MONGODB_URI;
      cached.promise = mongoose.connect(MONGODB_URI, {
        bufferCommands: false,
        minPoolSize: 5,
        maxPoolSize: 50,
        ...MONGO_CONNECT_OPTIONS,
      });
    }

    try {
      cached.conn = await cached.promise;
      await ensureDefaultAdmin();
      return cached.conn;
    } catch (err) {
      lastError = err;
      cached.conn = null;
      cached.promise = null;
      if (attempt < maxAttempts && isMongoConnectivityError(err)) {
        await new Promise((r) => setTimeout(r, attempt * 1500));
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

/** True when MongoDB is unreachable (network, timeout, IP allowlist, etc.). */
export function isMongoConnectivityError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name ?? "";
  if (
    name === "MongoNetworkError" ||
    name === "MongooseServerSelectionError" ||
    name === "MongoServerSelectionError"
  ) {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /ETIMEDOUT|ECONNREFUSED|MongoNetworkError|server selection/i.test(msg);
}
