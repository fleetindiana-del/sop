import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { verifyApiKey } from "@/lib/api-keys";
import { registerSopTools } from "@/lib/mcp-sop-tools";
import { registerAiTaskTools } from "@/lib/mcp-ai-task-tools";

export const maxDuration = 300;

const handler = createMcpHandler(
  (server) => {
    registerSopTools(server);
    registerAiTaskTools(server);
  },
  {
    serverInfo: { name: "sop-software", version: "1.1.0" },
    instructions:
      "Pharma SOP management platform. Use list_sops/get_sop to find SOPs, upload_sop_from_url or begin_file_upload + finish_* to add documents and training media, request_compliance_run + get_compliance_request for audits, and start_mcq_generation + get_mcq_status for MCQ banks. Confirm with the user before replacing an SOP version. You are the AI model of this software: audits and MCQ banks (including those queued by SOPs you upload) are written by you through the AI task queue. After starting work, and whenever get_ai_task_queue shows pending tasks, loop claim_ai_tasks → answer → submit_ai_task_result until it is empty.",
  },
);

const authHandler = withMcpAuth(
  handler,
  async (_req, token) => {
    const principal = await verifyApiKey(token);
    if (!principal) return undefined;
    return {
      token: token!,
      clientId: principal.keyId,
      scopes: principal.scopes,
      extra: { principal },
    };
  },
  { required: true },
);

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
