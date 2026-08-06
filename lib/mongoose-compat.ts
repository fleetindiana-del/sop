import mongoose from "mongoose";

/**
 * Mongoose 9 warns on deprecated `new` / `returnOriginal` for findOneAndUpdate.
 * Convert those options to `returnDocument` before Mongoose sees them, so leftover
 * callers (or stale bundles) cannot emit the deprecation warning.
 */
export function patchMongooseDeprecatedFindOptions(): void {
  const g = globalThis as typeof globalThis & {
    __sopMongooseFindOptionsPatched?: boolean;
  };
  if (g.__sopMongooseFindOptionsPatched) return;
  g.__sopMongooseFindOptionsPatched = true;

  const proto = mongoose.Query.prototype as unknown as {
    setOptions: (options: Record<string, unknown>, overwrite?: boolean) => unknown;
  };
  const original = proto.setOptions;

  proto.setOptions = function patchedSetOptions(
    this: unknown,
    options: Record<string, unknown>,
    overwrite?: boolean,
  ) {
    if (options && typeof options === "object") {
      if (Object.prototype.hasOwnProperty.call(options, "new")) {
        if (options.returnDocument == null) {
          options.returnDocument = options.new ? "after" : "before";
        }
        delete options.new;
      }
      if (Object.prototype.hasOwnProperty.call(options, "returnOriginal")) {
        if (options.returnDocument == null) {
          options.returnDocument = options.returnOriginal ? "before" : "after";
        }
        delete options.returnOriginal;
      }
    }
    return original.call(this, options, overwrite);
  };
}

patchMongooseDeprecatedFindOptions();
