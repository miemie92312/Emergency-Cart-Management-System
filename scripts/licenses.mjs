import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const lock=JSON.parse(await fs.readFile(path.join(root,'package-lock.json'),'utf8'));
const installed=[];
for(const [location,entry] of Object.entries(lock.packages||{})){
  if(!location.startsWith('node_modules/'))continue;
  try{const pkg=JSON.parse(await fs.readFile(path.join(root,location,'package.json'),'utf8'));installed.push({name:pkg.name,version:pkg.version,license:typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license||'UNKNOWN'),dev:!!entry.dev});}catch{}
}
installed.sort((a,b)=>a.name.localeCompare(b.name));
await fs.mkdir(path.join(root,'docs'),{recursive:true});
await fs.writeFile(path.join(root,'docs','dependency-inventory.json'),JSON.stringify({generatedAt:new Date().toISOString(),packages:installed},null,2));
let notices='第三方软件归属与许可证\n应用源码未擅自指定开源许可证；第三方代码按各自许可证分发。\n\n';
for(const name of ['dexie','zod','xlsx','workbox-window','workbox-core','workbox-precaching','workbox-routing','workbox-strategies']){
  const dir=path.join(root,'node_modules',name),pkg=JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8'));
  notices+=`${name} ${pkg.version} — ${pkg.license}\n`;
  const files=(await fs.readdir(dir)).filter(f=>/^licen[sc]e(?:\.|$)|^notice(?:\.|$)/i.test(f));
  if(!files.length)throw Error('缺少随附许可证：'+name);
  for(const file of files)notices+=`\n${file}\n${await fs.readFile(path.join(dir,file),'utf8')}\n`;
  notices+='\n----------------\n';
}
await fs.writeFile(path.join(root,'public','THIRD_PARTY_NOTICES.txt'),notices);
console.log(JSON.stringify({installedPackages:installed.length,unknown:installed.filter(p=>p.license==='UNKNOWN').map(p=>p.name),runtimeNotices:'public/THIRD_PARTY_NOTICES.txt'}));
