import type { Metadata } from "next";
import { NutraLabelComplianceClient } from "@/components/compliance/NutraLabelComplianceClient";

export const metadata: Metadata = {
  title: "Nutra Label Compliance — FSSAI",
  description: "Upload nutraceutical label photos. Gemini extracts the pack and checks FSSAI labelling rules. No login required.",
};

export default function NutraLabelCompliancePage() {
  return <NutraLabelComplianceClient />;
}
