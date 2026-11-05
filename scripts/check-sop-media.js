const { MongoClient } = require("mongodb");
const fs = require("fs");

function hasAny(v) {
  if (!v) return false;
  if (Array.isArray(v)) return v.filter(Boolean).length > 0;
  return String(v).trim().length > 0;
}

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI missing");
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const col = db.collection("sops");

  const total = await col.countDocuments({});
  const withMediaField = await col.countDocuments({ mediaLinks: { $exists: true } });

  const docs = await col
    .find({})
    .project({ identifier: 1, name: 1, department: 1, language: 1, isObsolete: 1, mediaLinks: 1, documentKind: 1, sopBaseId: 1, version: 1 })
    .toArray();

  const byId = new Map();
  for (const d of docs) {
    const id = (d.identifier || d.sopBaseId || "").trim();
    if (!id) continue;
    if (d.isObsolete) continue;
    if (d.documentKind === "media") continue;
    const prev = byId.get(id) || {
      identifier: id,
      name: d.name || "",
      department: d.department || "",
      videosEn: false,
      videosGu: false,
      slidesEn: false,
      slidesGu: false,
      videoUrls: { en: [], gu: [] },
      slideUrls: { en: [], gu: [] },
    };
    const ml = d.mediaLinks || {};
    const ve = [].concat(ml.videos?.en || []).filter(Boolean);
    const vg = [].concat(ml.videos?.gu || []).filter(Boolean);
    const se = [].concat(ml.slides?.en || []).filter(Boolean);
    const sg = [].concat(ml.slides?.gu || []).filter(Boolean);
    if (ve.length) { prev.videosEn = true; prev.videoUrls.en.push(...ve); }
    if (vg.length) { prev.videosGu = true; prev.videoUrls.gu.push(...vg); }
    if (se.length) { prev.slidesEn = true; prev.slideUrls.en.push(...se); }
    if (sg.length) { prev.slidesGu = true; prev.slideUrls.gu.push(...sg); }
    if (!prev.name && d.name) prev.name = d.name;
    if (!prev.department && d.department) prev.department = d.department;
    byId.set(id, prev);
  }

  const rows = [...byId.values()];
  const missingAnyVideo = rows.filter(r => !r.videosEn && !r.videosGu);
  const missingEn = rows.filter(r => !r.videosEn);
  const missingGu = rows.filter(r => !r.videosGu);
  const missingSlidesEn = rows.filter(r => !r.slidesEn);
  const missingSlidesGu = rows.filter(r => !r.slidesGu);
  const completeBoth = rows.filter(r => r.videosEn && r.videosGu);
  const withSomeVideo = rows.filter(r => r.videosEn || r.videosGu);

  const summary = {
    totalDocs: total,
    docsWithMediaLinksField: withMediaField,
    uniqueActiveSops: rows.length,
    withSomeVideo: withSomeVideo.length,
    completeBothLangVideos: completeBoth.length,
    missingAnyVideo: missingAnyVideo.length,
    missingEnVideo: missingEn.length,
    missingGuVideo: missingGu.length,
    missingEnSlides: missingSlidesEn.length,
    missingGuSlides: missingSlidesGu.length,
    sampleWithVideo: withSomeVideo.slice(0, 10),
    sampleMissingAnyVideo: missingAnyVideo.slice(0, 30).map(r => ({
      identifier: r.identifier,
      name: r.name,
      department: r.department,
      videosEn: r.videosEn,
      videosGu: r.videosGu,
      slidesEn: r.slidesEn,
      slidesGu: r.slidesGu,
    })),
  };

  fs.writeFileSync("C:/Users/admin/Downloads/sop-notebooklm/sop-media-report.json", JSON.stringify(summary, null, 2));
  fs.writeFileSync("C:/Users/admin/Downloads/sop-notebooklm/sop-missing-videos.json", JSON.stringify(missingAnyVideo, null, 2));
  console.log(JSON.stringify({
    totalDocs: summary.totalDocs,
    uniqueActiveSops: summary.uniqueActiveSops,
    withSomeVideo: summary.withSomeVideo,
    completeBothLangVideos: summary.completeBothLangVideos,
    missingAnyVideo: summary.missingAnyVideo,
    missingEnVideo: summary.missingEnVideo,
    missingGuVideo: summary.missingGuVideo,
    sampleMissing: summary.sampleMissingAnyVideo.slice(0, 15),
  }, null, 2));
  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
