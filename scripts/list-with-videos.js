const { MongoClient } = require("mongodb");
const fs = require("fs");
(async () => {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const docs = await client.db().collection("sops").find({}).project({identifier:1,name:1,department:1,isObsolete:1,documentKind:1,mediaLinks:1,sopBaseId:1}).toArray();
  const byId = new Map();
  for (const d of docs) {
    if (d.isObsolete || d.documentKind === "media") continue;
    const id = (d.identifier || d.sopBaseId || "").trim();
    if (!id) continue;
    const prev = byId.get(id) || { identifier:id, name:d.name||"", department:d.department||"", videosEn:false, videosGu:false, slidesEn:false, slidesGu:false, urls:{en:[],gu:[]} };
    const ml = d.mediaLinks || {};
    for (const u of [].concat(ml.videos?.en||[]).filter(Boolean)) { prev.videosEn=true; prev.urls.en.push(u); }
    for (const u of [].concat(ml.videos?.gu||[]).filter(Boolean)) { prev.videosGu=true; prev.urls.gu.push(u); }
    for (const u of [].concat(ml.slides?.en||[]).filter(Boolean)) prev.slidesEn=true;
    for (const u of [].concat(ml.slides?.gu||[]).filter(Boolean)) prev.slidesGu=true;
    if (!prev.name && d.name) prev.name=d.name;
    if (!prev.department && d.department) prev.department=d.department;
    byId.set(id, prev);
  }
  const rows=[...byId.values()];
  const withSome=rows.filter(r=>r.videosEn||r.videosGu);
  fs.writeFileSync("C:/Users/admin/Downloads/sop-notebooklm/sop-with-videos.json", JSON.stringify(withSome,null,2));
  console.log(JSON.stringify({ withSome: withSome.length, sample: withSome.slice(0,8).map(r=>({id:r.identifier,name:r.name,en:r.videosEn,gu:r.videosGu,urls:r.urls})) }, null, 2));
  await client.close();
})().catch(e=>{console.error(e); process.exit(1);});
