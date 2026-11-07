import sharp from 'sharp';
import { mkdir,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=new URL('../public/icons/',import.meta.url);await mkdir(root,{recursive:true});
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="100" fill="#195b70"/><rect x="108" y="142" width="296" height="246" rx="27" fill="#fff"/><path d="M190 142v-30h132v30" fill="none" stroke="#fff" stroke-width="25" stroke-linejoin="round"/><path d="M256 192v138m-69-69h138" stroke="#195b70" stroke-width="34"/><path d="m142 358 24 24m180-24 24 24" stroke="#195b70" stroke-width="12"/></svg>';
await writeFile(new URL('mark.svg',root),svg);
for(const size of [192,512])await sharp(Buffer.from(svg)).resize(size).png().toFile(fileURLToPath(new URL(`icon-${size}.png`,root)));
await sharp(Buffer.from(svg)).resize(512).png().toFile(fileURLToPath(new URL('maskable-512.png',root)));
await sharp(Buffer.from(svg)).resize(180).png().toFile(fileURLToPath(new URL('apple-touch-icon.png',root)));
