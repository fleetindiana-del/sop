import { filterPrimaryRegistryRows } from "@/lib/registryPrimaryRows";
import { compareSopCodes } from "@/lib/sop-utils";

export type RegistrySopOption = {
  _id: string;
  sopNo: string;
  displayName: string;
  department: string;
};

export function buildRealSopPickerOptions(rows: any[] | undefined | null): RegistrySopOption[] {
  const primary = filterPrimaryRegistryRows(rows);
  const out: RegistrySopOption[] = [];
  for (const r of primary) {
    const sopNo = String(r.sopNo || r.identifier || "").trim();
    if (!sopNo) continue;
    const rawName = String(r.englishName || r.sopName || r.name || "").trim();
    if (!rawName) continue;
    if (/annexure/i.test(rawName)) continue;
    out.push({
      _id: String(r._id || r.id),
      sopNo,
      displayName: rawName,
      department: String(r.department || "").trim() || "—",
    });
  }
  out.sort((a, b) => compareSopCodes(a.sopNo, b.sopNo));
  return out;
}
