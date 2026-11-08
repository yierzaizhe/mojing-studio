import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT||4173);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be an integer from 1 to 65535.');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp','.avif':'image/avif','.svg':'image/svg+xml'};
http.createServer((req,res)=>{
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'}).end();return;}
 let pathname;
 try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
 const name=pathname==='/'||pathname==='/index.html'?'/dist/index.html':pathname==='/墨境Studio.html'?'/dist/墨境Studio.html':pathname;
 if(!/^\/(?:dist|tests|docs)\//.test(name)||name.split('/').some(part=>part.startsWith('.'))){res.writeHead(404).end('Not found');return;}
 const target=path.resolve(root,'.'+name);
 if(!target.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 fs.stat(target,(error,stat)=>{
  if(error||!stat.isFile()){res.writeHead(404).end('Not found. Run npm run build first.');return;}
  res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  if(req.method==='HEAD')res.end();else fs.createReadStream(target).pipe(res);
 });
}).listen(port,'127.0.0.1',()=>console.log(`Local: http://127.0.0.1:${port}`));
