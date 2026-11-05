import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getPublicOrigin } from "mcp-handler";
import { registerScopedTool } from "@/lib/mcp-sop-tools";
import { API_GRANT_HEADER, signApiGrant } from "@/lib/api-grant";
import { API_CATALOG } from "@/lib/api-catalog";

const MAX_RESPONSE_CHARS = 200_000;

const catalogPatterns = API_CATALOG.map((entry) => ({
  entry,
  pattern: new RegExp(
    "^" +
      entry.path
        .split("/")
        .map((part) =>
          /^\[\[?\.\.\..+\]\]?$/.test(part) ? ".+" : /^\[.+\]$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|\\]/g, "\\$&"),
        )
        .join("/") +
      "$",
  ),
}));

function catalogEntryFor(apiPath: string) {
  return catalogPatterns.find(({ pattern }) => pattern.test(apiPath))?.entry;
}

export function registerApiTools(server: McpServer) {
  registerScopedTool(
    server,
    "list_api_endpoints",
    {
      title: "List readable app APIs",
      description:
        "The app's read-only (GET) APIs — the same data the web pages show (dashboard, SOP registry, employees, LMS training progress, induction, MCQ bank and approval stats, compliance, training matrix). Filter with search. Bracketed segments like [id] are path parameters. Then fetch one with call_api.",
      inputSchema: z.object({
        search: z.string().optional().describe("Matches path or description, e.g. \"training\", \"mcq\", \"employee\"."),
      }),
      readOnly: true,
    },
    "api:read",
    async ({ search }) => {
      const q = search?.trim().toLowerCase();
      const endpoints = q
        ? API_CATALOG.filter((e) => e.path.toLowerCase().includes(q) || e.description.toLowerCase().includes(q))
        : API_CATALOG;
      return { count: endpoints.length, endpoints };
    },
  );

  registerScopedTool(
    server,
    "call_api",
    {
      title: "Call a read-only app API",
      description:
        `GET one of the app's APIs (see list_api_endpoints) as the API key's owner and return its JSON — exactly what the web page receives, already computed (training completion, MCQ approval, compliance scores). Narrow big responses with query parameters such as department. Responses over ${MAX_RESPONSE_CHARS.toLocaleString()} characters are cut off.`,
      inputSchema: z.object({
        path: z.string().min(5).describe("API path, e.g. /api/lms/admin/employee-training"),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Query parameters, e.g. { \"department\": \"QA\" }"),
      }),
      readOnly: true,
    },
    "api:read",
    async ({ path: rawPath, query }, principal, ctx) => {
      const apiPath = rawPath.trim().split("?")[0].replace(/\/+$/, "");
      if (!apiPath.startsWith("/api/") || apiPath.includes("..") || !catalogEntryFor(apiPath)) {
        throw new Error(`"${apiPath}" is not a readable API. Use list_api_endpoints to see what is available.`);
      }
      if (!ctx.http?.req) throw new Error("No request context");

      const url = new URL(apiPath, getPublicOrigin(ctx.http.req));
      for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));

      const res = await fetch(url, {
        method: "GET",
        headers: { [API_GRANT_HEADER]: signApiGrant(principal.keyId), accept: "application/json" },
        cache: "no-store",
        redirect: "manual",
      });
      const text = await res.text();
      const truncated = text.length > MAX_RESPONSE_CHARS;
      let body: unknown = truncated ? text.slice(0, MAX_RESPONSE_CHARS) : text;
      if (!truncated) {
        try {
          body = JSON.parse(text);
        } catch {
          /* non-JSON response: return as text */
        }
      }
      return {
        status: res.status,
        url: `${url.pathname}${url.search}`,
        ...(truncated
          ? { truncated: true, note: `Response was ${text.length.toLocaleString()} characters; add query filters (e.g. department) to narrow it.` }
          : {}),
        body,
      };
    },
  );
}
