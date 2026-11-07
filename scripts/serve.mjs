// 仅提供本地静态文件预览，不包含业务 API、登录或同步。
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const base=path.resolve(fileURLToPath(new URL('../dist/',import.meta.url)));
const index=process.argv.indexOf('--port'),port=index>=0?Number(process.argv[index+1]):4173;
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('端口需为 1024–65535 的整数。');
await fs.access(path.join(base,'index.html'));
const types={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.txt':'text/plain;charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  try{
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end();}
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const relative=pathname.endsWith('/')?pathname+'index.html':pathname;
    const target=path.resolve(base,'.'+relative);
    if(target!==base&&!target.startsWith(base+path.sep)){res.writeHead(403);return res.end('Forbidden');}
    const bytes=await fs.readFile(target);
    res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Cache-Control':pathname.includes('/assets/')?'public,max-age=31536000,immutable':'no-cache','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);
  }catch(err){res.writeHead(err.code==='ENOENT'?404:400);res.end('Not found / invalid path');}
});
server.on('error',err=>{console.error('本地预览未启动：'+err.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`抢救车管理助手：http://127.0.0.1:${port}\n仅本机访问；手机需使用 HTTPS 静态部署地址。按 Ctrl+C 停止。`));
