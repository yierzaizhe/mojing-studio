'use strict';

// Actual PSD hit testing through the same bundled parser and worker that ship
// in the offline HTML. The native canvas runtime is used only by this test.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const { createCanvas, ImageData, Path2D } = require(process.env.PSD_TEST_CANVAS || '@napi-rs/canvas');
const ag = require(process.env.PSD_TEST_MODULE || 'ag-psd');
ag.initializeCanvas(createCanvas, (w, h) => new ImageData(w, h));
let layerId = 0;
function layer(name, x, y, width, height, draw, extra = {}) {
  const canvas = createCanvas(width, height);
  draw(canvas.getContext('2d'), width, height);
  return { id: ++layerId, name, left: x, top: y, canvas, opacity: 1, blendMode: 'normal', ...extra };
}
const solid = color => (ctx, w, h) => { ctx.fillStyle = color; ctx.fillRect(0, 0, w, h); };
const mask = createCanvas(20, 20), maskCtx = mask.getContext('2d');
maskCtx.fillStyle = '#000'; maskCtx.fillRect(0, 0, 20, 20);
maskCtx.fillStyle = '#fff'; maskCtx.fillRect(0, 0, 10, 20);
const rectanglePath = (x, y, width, height, operation = 'combine') => ({
  open: false, operation, fillRule: 'non-zero',
  knots: [[x,y],[x+width,y],[x+width,y+height],[x,y+height]].map(([x,y]) => ({ linked: false, points: [x,y,x,y,x,y] })),
});
const children = [
  layer('background', 0, 0, 64, 48, solid('#fff')),
  { id: ++layerId, name: 'masked group', opacity: 1, blendMode: 'normal', children: [layer('masked child', 0, 0, 20, 20, solid('#f00'))], mask: { left: 0, top: 0, canvas: mask, defaultColor: 0 } },
  { id: ++layerId, name: 'zero opacity group', opacity: 0, blendMode: 'normal', children: [layer('zero group child', 24, 0, 20, 20, solid('#0f0'))] },
  layer('zero opacity leaf', 48, 0, 16, 20, solid('#00f'), { opacity: 0 }),
  layer('transparent hole', 0, 24, 20, 20, (ctx,w,h) => { solid('#000')(ctx,w,h); ctx.clearRect(5,5,10,10); }),
  { id: ++layerId, name: 'vector with hole', opacity: 1, blendMode: 'normal', vectorFill: { type:'color', color: {r:160,g:0,b:220} }, vectorMask: { fillStartsWithAllPixels: false, paths: [rectanglePath(24,24,20,20), rectanglePath(29,29,10,10,'subtract')] } },
  { id: ++layerId, name: 'hidden group', opacity: 1, blendMode:'normal', hidden: true, children: [layer('hidden group child',48,24,16,20,solid('#0ff'))] },
];
const merged = createCanvas(64, 48); solid('#fff')(merged.getContext('2d'),64,48);
const fixture = ag.writePsdBuffer({ width:64, height:48, canvas:merged, children });
const cases = [
  { file:'hit-test', at:[4,8], expected:'masked child', why:'ancestor group white mask preserves child' },
  { file:'hit-test', at:[14,8], expected:'background', why:'ancestor group black mask removes child' },
  { file:'hit-test', at:[30,8], expected:'background', why:'zero opacity group excludes child' },
  { file:'hit-test', at:[52,8], expected:'background', why:'zero opacity leaf is not selectable' },
  { file:'hit-test', at:[3,34], expected:'transparent hole', why:'opaque border remains selectable' },
  { file:'hit-test', at:[10,34], expected:'background', why:'transparent hole does not capture click' },
  { file:'hit-test', at:[26,26], expected:'vector with hole', why:'uncached native vector can be selected' },
  { file:'hit-test', at:[34,34], expected:'background', why:'vector subtract path leaves a hole' },
  { file:'hit-test', at:[52,34], expected:'background', why:'hidden ancestor excludes child' },
  { file:'hit-test', at:[52,34], expected:'hidden group child', hiddenNames:[], why:'showing initial hidden group enables child' },
  { file:'hit-test', at:[52,34], expected:'hidden group child', scope:'hidden group', why:'single group mode ignores group own hidden flag' },
  { file:'hit-test', at:[52,8], expected:'zero opacity leaf', scope:'zero opacity leaf', why:'single layer mode follows displayed own opacity' },
  { file:'hit-test', at:[-2,8], expected:null, why:'outside document does not select anything' },
  { file:'compositing', at:[12,12], expected:'red square', candidates:['red square','white background'], why:'hidden top layer is skipped and candidates retain z order' },
  { file:'compositing', at:[12,12], expected:'hidden blue square', hiddenNames:[], why:'showing a hidden top layer changes hit target' },
  { file:'compositing', at:[52,12], expected:'blue in group', why:'group opacity preserves visible child target' },
  { file:'compositing', at:[64,20], expected:'green in group', candidates:['green in group','blue in group','white background'], why:'overlapping group children are returned top to bottom' },
  { file:'compositing', at:[8,56], expected:'magenta with left half mask', why:'white bitmap mask allows selection' },
  { file:'compositing', at:[28,56], expected:'white background', why:'black bitmap mask prevents selection' },
  { file:'compositing', at:[60,60], expected:'clipped orange', candidates:['clipped orange','clipping base circle','white background'], why:'clip inside base is selectable above base' },
  { file:'compositing', at:[46,46], expected:'white background', why:'clip outside base alpha is excluded' },
  { file:'compositing', at:[60,60], expected:'white background', hiddenNames:['hidden blue square','clipping base circle'], why:'hidden clipping base suppresses clipped layers' },
  { file:'compositing', at:[100,8], expected:'multiply magenta', candidates:['multiply magenta','multiply base yellow','white background'], why:'blend layers preserve visual stack selection order' },
  { file:'demo', at:[650,130], expected:'蓝色竖向色块', why:'demo blue rectangle is picked through transparent overlay layers' },
  { file:'demo', at:[650,380], expected:'橙色球体', why:'demo orange sphere can be picked' },
  { file:'demo', at:[520,235], expected:'暖灰纸张', why:'transparent circle bounds corner does not pick the sphere' },
  { file:'demo', at:[820,570], expected:'蓝色竖向色块', why:'transparent semicircle corner does not capture background rectangle' },
];

if (process.argv.includes('--write')) {
  fs.writeFileSync(path.join(__dirname,'hit-test.psd'),fixture);
  fs.writeFileSync(path.join(__dirname,'hit-test.expected.json'),JSON.stringify({cases},null,2)+'\n');
}
function offscreen(width,height) {
  const canvas=createCanvas(width,height); canvas.close=()=>{};
  canvas.convertToBlob=async()=>new Blob([canvas.toBuffer('image/png')],{type:'image/png'});
  return canvas;
}
async function createBitmap(source,...args) {
  if(source instanceof ImageData){const c=offscreen(source.width,source.height);c.getContext('2d').putImageData(source,0,0);source=c;}
  let sx=0,sy=0,sw=source.width,sh=source.height,options={};
  if(args.length>=4)[sx,sy,sw,sh,options={}]=args;else options=args[0]||{};
  const result=offscreen(options.resizeWidth||sw,options.resizeHeight||sh);
  result.getContext('2d').drawImage(source,sx,sy,sw,sh,0,0,result.width,result.height);
  return result;
}
let counter=0;const pending=new Map();
const sandbox={agPsd:ag,OffscreenCanvas:offscreen,ImageData,Path2D,createImageBitmap:createBitmap,Blob,File,DataView,ArrayBuffer,Uint8Array,Uint8ClampedArray,Uint16Array,Float32Array,self:{postMessage(r){pending.get(r.id)(r);pending.delete(r.id);}}};
vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(ROOT,'src/worker.js'),'utf8'),sandbox);
function request(type,payload){return new Promise(resolve=>{const id=++counter;pending.set(id,resolve);sandbox.self.onmessage({data:{id,type,...payload}});});}
const flatten=nodes=>(nodes||[]).flatMap(n=>[n,...flatten(n.children)]);
async function verify(){
  let current,all;
  for(const probe of cases){
    if(current!==probe.file){
      const bytes=probe.file==='hit-test'?fixture:fs.readFileSync(path.join(ROOT,probe.file==='demo'?'src/demo.psd':'tests/compositing.psd'));
      const opened=await request('open',{file:new File([bytes],probe.file+'.psd')});assert(opened.ok,opened.error);all=flatten(opened.doc.children);current=probe.file;
    }
    const scope=probe.scope&&all.find(n=>n.name===probe.scope);
    const hiddenIds=probe.hiddenNames?.map(name=>{const n=all.find(n=>n.name===name);assert(n,`missing layer ${name}`);return n.id;});
    const result=await request('hitTest',{x:probe.at[0],y:probe.at[1],mode:scope?'layer':'original',layerId:scope?.id,...(hiddenIds?{hiddenIds}:{})});
    assert(result.ok,result.error);
    const actual=all.find(n=>n.id===result.layerId)?.name||null;
    assert.equal(actual,probe.expected,`${probe.why}: got ${actual}; candidates ${result.candidates.map(n=>n.name)}`);
    if(probe.candidates)assert.deepEqual(Array.from(result.candidates,n=>n.name),probe.candidates,probe.why);
    console.log(`PASS ${probe.why}: ${actual}`);
  }
  // Verify actual glyph alpha, rather than its rectangular text bounds.
  const title=all.find(n=>n.name==='主标题 · FORM & FEEL');
  const layer=ag.readPsd(fs.readFileSync(path.join(ROOT,'src/demo.psd')),{useRawData:true,skipThumbnail:true});
  const raw=flatten(layer.children).find(n=>n.name===title.name);
  const pixels=ag.getLayerImageData(raw);let opaque,transparent;
  for(let y=10;y<pixels.height-10&&(!opaque||!transparent);y++)for(let x=10;x<pixels.width-10;x++){
    const alpha=pixels.data[(y*pixels.width+x)*4+3];
    if(alpha===255&&!opaque)opaque=[title.left+x,title.top+y];
    if(alpha===0&&!transparent)transparent=[title.left+x,title.top+y];
  }
  assert(opaque&&transparent,'glyph fixture lacks transparent/opaque pixels');
  const filled=await request('hitTest',{x:opaque[0],y:opaque[1],mode:'original'});
  assert.equal(filled.layerId,title.id,'glyph pixels are selectable');
  const hole=await request('hitTest',{x:transparent[0],y:transparent[1],mode:'original'});
  assert.notEqual(hole.layerId,title.id,'text whitespace does not capture click');
  console.log(`PASS text glyph alpha at ${opaque}; whitespace at ${transparent}`);
  console.log(`${cases.length+2} hit-test probes passed.`);
}
verify().catch(error=>{console.error(error);process.exitCode=1;});
