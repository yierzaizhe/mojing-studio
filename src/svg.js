/* Browser-native, offline SVG document adapter. Source SVGs remain read-only. */
(() => {
  'use strict';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAX_NODES = 20000, MAX_DEPTH = 80, MAX_PIXELS = 64000000;
  const DRAW = new Set(['path','rect','circle','ellipse','line','polyline','polygon','text','image','use']);
  const GROUP = new Set(['g','a','switch','svg']);
  const KEEP = new Set([
    ...DRAW,...GROUP,'defs','style','title','desc','metadata','symbol','marker','lineargradient','radialgradient','stop','pattern','clippath','mask','filter',
    'feblend','fecolormatrix','fecomponenttransfer','fecomposite','feconvolvematrix','fediffuselighting','fedisplacementmap','fedistantlight','fedropshadow','feflood',
    'fefunca','fefuncb','fefuncg','fefuncr','fegaussianblur','feimage','femerge','femergenode','femorphology','feoffset','fepointlight','fespecularlighting','fespotlight','fetile','feturbulence','tspan','textpath',
  ]);
  const SKIP = new Set(['defs','style','title','desc','metadata','symbol','marker','lineargradient','radialgradient','pattern','clippath','mask','filter']);
  const TAG_NAMES = {g:'分组',a:'链接分组',switch:'条件分组',svg:'嵌套画布',path:'路径',rect:'矩形',circle:'圆形',ellipse:'椭圆',line:'线条',polyline:'折线',polygon:'多边形',text:'文字',image:'图片',use:'符号实例'};
  const unique = values => [...new Set(values.filter(Boolean))];
  const clamp = (value,min,max) => Math.max(min,Math.min(max,Number(value)||0));
  const rect = (x,y,w,h) => ({x,y,w,h});
  const contains = (area,x,y) => x>=area.x&&y>=area.y&&x<area.x+area.w&&y<area.y+area.h;
  const union = (a,b) => {
    if(!a?.w||!a?.h)return b;if(!b?.w||!b?.h)return a;
    const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y);
    return rect(x,y,Math.max(a.x+a.w,b.x+b.w)-x,Math.max(a.y+a.h,b.y+b.h)-y);
  };
  const hiddenStyle = value => value==='hidden'||value==='collapse';
  const cssUnescape = value => value.replace(/\\([0-9a-f]{1,6})\s?/gi,(_,hex)=>String.fromCodePoint(Math.min(0x10ffff,parseInt(hex,16))))
    .replace(/\\([^\r\n\f0-9a-f])/gi,'$1');
  function removeCssBlocks(css,pattern) {
    let value=css, match;
    while((match=pattern.exec(value))){
      const start=match.index,open=value.indexOf('{',start);
      if(open<0){value=value.slice(0,start);break;}
      let depth=1,index=open+1,quote='';
      for(;index<value.length&&depth;index++){
        const ch=value[index];
        if(quote){if(ch==='\\'){index++;continue;}if(ch===quote)quote='';continue;}
        if(ch==='"'||ch==="'"){quote=ch;continue;}
        if(ch==='{')depth++;if(ch==='}')depth--;
      }
      value=value.slice(0,start)+value.slice(index);pattern.lastIndex=0;
    }
    return value;
  }
  function cleanCss(input,warnings) {
    let css=cssUnescape(String(input||'')).replace(/\/\*[\s\S]*?\*\//g,'');
    if(/:host(?:\b|\s*\()|::slotted\s*\(/i.test(css)){
      warnings.add('SVG 中针对页面或交互环境的特殊样式已跳过。');return '';
    }
    css=css.replace(/@import\b[^;{}]*(?:;|$)/gi,()=>{warnings.add('SVG 中的外部资源或样式已跳过；请将所需图片嵌入 SVG。');return '';});
    css=removeCssBlocks(css,/@(?:font-face|(?:-webkit-)?keyframes)\b/gi);
    css=css.replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi,(all,quote,url)=>{
      if(/^#[^\s]*$/.test(url.trim()))return `url("${url.trim().replace(/"/g,'')}" )`;
      warnings.add('SVG 中的外部资源或样式已跳过；请将所需图片嵌入 SVG。');return 'none';
    });
    if(/(?:javascript\s*:|expression\s*\(|-moz-binding|behavior\s*:)/i.test(css)){
      warnings.add('SVG 中的脚本、动画和交互内容不会执行。');return '';
    }
    // :root inside a shadow measurement tree or the raster viewport wrapper
    // must continue to refer to the source document's original SVG root.
    return css.replace(/:root\b/g,'[data-layerdesk-root]').replace(/(?:^|[;{])\s*(?:animation(?:-[\w-]+)?|transition(?:-[\w-]+)?)\s*:[^;}]*;?/gi,match=>match.startsWith('{')?'{':';');
  }
  function lengthPixels(value) {
    const match=String(value||'').trim().match(/^([+]?(?:\d*\.)?\d+(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|q)?$/i);
    if(!match)return undefined;
    const factor={px:1,pt:96/72,pc:16,mm:96/25.4,cm:96/2.54,in:96,q:96/101.6};
    const number=Number(match[1])*(factor[(match[2]||'px').toLowerCase()]||1);
    return Number.isFinite(number)&&number>0?number:undefined;
  }
  function dimensions(svg) {
    const box=String(svg.getAttribute('viewBox')||'').trim().split(/[\s,]+/).map(Number);
    const view=box.length===4&&box.every(Number.isFinite)&&box[2]>0&&box[3]>0?box:undefined;
    let width=lengthPixels(svg.getAttribute('width'))||lengthPixels(svg.style?.width);
    let height=lengthPixels(svg.getAttribute('height'))||lengthPixels(svg.style?.height);
    if(view){if(!width&&!height){width=view[2];height=view[3];}else if(!width)width=height*view[2]/view[3];else if(!height)height=width*view[3]/view[2];}
    width=Math.round(width||300);height=Math.round(height||150);
    if(!width||!height||width>300000||height>300000)throw new Error('SVG 画布尺寸无效或超过 300000 像素上限。');
    return {width,height};
  }
  function sanitize(svg,warnings) {
    const all=[svg,...svg.querySelectorAll('*')];
    if(all.length>MAX_NODES*3)throw new Error('SVG 元素过多，无法安全展开。');
    for(const element of all){
      if(element!==svg&&!svg.contains(element))continue;
      const tag=element.localName.toLowerCase();
      if((element.namespaceURI&&element.namespaceURI!==SVG_NS)||!KEEP.has(tag)){
        if(['script','foreignobject','animate','animatemotion','animatetransform','set','discard','handler'].includes(tag))warnings.add('SVG 中的脚本、动画和交互内容不会执行。');
        element.remove();continue;
      }
      for(const attr of [...element.attributes]){
        const local=attr.localName.toLowerCase(),full=attr.name.toLowerCase(),value=attr.value.trim();
        if(local.startsWith('on')||full==='xml:base'||local==='src'||local==='srcset'){
          element.removeAttributeNode(attr);warnings.add('SVG 中的脚本、动画和交互内容不会执行。');continue;
        }
        if(local==='href'){
          const embedded=['image','feimage'].includes(tag)&&/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value);
          if(!/^#[^\s]*$/.test(value)&&!embedded){element.removeAttributeNode(attr);if(value)warnings.add('SVG 中的外部资源或样式已跳过；请将所需图片嵌入 SVG。');}
        }else if(local==='style')element.setAttribute(attr.name,cleanCss(value,warnings));
        else if(/url\s*\(|\\/i.test(value))element.setAttribute(attr.name,cleanCss(value,warnings));
      }
      if(tag==='style')element.textContent=cleanCss(element.textContent,warnings);
      if(element.style){element.style.setProperty('animation','none','important');element.style.setProperty('transition','none','important');}
    }
  }

  class LayerDeskSvgDocument {
    constructor({requestWorker}={}) {
      this.requestWorker=requestWorker;this.nodes=new Map();this.initialHidden=new Set();this.warnings=[];
      this.host=null;this.svg=null;this.doc=null;this.disposed=false;this.queue=Promise.resolve();this.images=new Set();
      this.alphaCache=new Map();
    }
    async open(file) {
      if(this.disposed)throw new Error('SVG 文档已关闭。');
      if(!file||typeof file.text!=='function')throw new Error('请选择一个 SVG 文件。');
      if(file.size>25*1024*1024)throw new Error('SVG 超过 25 MB，请精简后再打开。');
      this.host?.remove();this.host=null;this.svg=null;this.doc=null;this.roots=[];
      this.nodes.clear();this.initialHidden.clear();this.alphaCache.clear();this.warnings=[];
      for(const image of [...this.images])image.cancel();
      let text=await file.text();
      if(this.disposed)throw new Error('SVG 文档已关闭。');
      if(/<!ENTITY\b/i.test(text))throw new Error('此 SVG 包含不支持的 XML 实体声明，请另存为普通 SVG。');
      text=text.replace(/<!DOCTYPE[^>]*>/gi,'').replace(/<\?[\s\S]*?\?>/g,'');
      let parsed=new DOMParser().parseFromString(text,'image/svg+xml');
      let root=parsed.documentElement;
      if(!root||root.localName.toLowerCase()!=='svg'||parsed.querySelector('parsererror'))throw new Error('SVG 文件结构异常或 XML 不完整，无法读取。');
      if(root.namespaceURI&&root.namespaceURI!==SVG_NS)throw new Error('文件不是有效的 SVG 矢量图。');
      if(!root.namespaceURI){
        // Common hand-authored SVG snippets omit xmlns. Give their elements
        // the SVG namespace before importing, so geometry APIs still work.
        root.removeAttribute('xmlns');
        const source=new XMLSerializer().serializeToString(root).replace(/<svg\b/i,`<svg xmlns="${SVG_NS}"`);
        parsed=new DOMParser().parseFromString(source,'image/svg+xml');root=parsed.documentElement;
      }
      const warnings=new Set();sanitize(root,warnings);
      const size=dimensions(root);this.width=size.width;this.height=size.height;
      const svg=document.importNode(root,true);this.svg=svg;
      svg.setAttribute('xmlns',SVG_NS);svg.setAttribute('data-layerdesk-root','');
      svg.setAttribute('width',String(this.width));svg.setAttribute('height',String(this.height));
      svg.setAttribute('x','0');svg.setAttribute('y','0');
      svg.style.setProperty('width',`${this.width}px`,'important');svg.style.setProperty('height',`${this.height}px`,'important');
      const host=document.createElement('div');this.host=host;
      host.setAttribute('aria-hidden','true');host.style.cssText=`all:initial;position:fixed;left:-1000000px;top:0;width:${this.width}px;height:${this.height}px;opacity:0;pointer-events:none;overflow:hidden;contain:strict;z-index:-2147483647`;
      const shadow=host.attachShadow({mode:'closed'});shadow.appendChild(svg);document.body.appendChild(host);
      if(document.fonts?.ready)await Promise.race([document.fonts.ready.catch(()=>{}),new Promise(resolve=>setTimeout(resolve,180))]);
      if(this.disposed)throw new Error('SVG 文档已关闭。');
      const originalStyles=new Map();
      const nativeStyles=new Map();
      for(const element of [svg,...svg.querySelectorAll('*')]){
        originalStyles.set(element,element.getAttribute('style'));
        if(DRAW.has(element.localName.toLowerCase())||GROUP.has(element.localName.toLowerCase())){
          const style=getComputedStyle(element);nativeStyles.set(element,{display:style.display,visibility:style.visibility,opacity:style.opacity});
        }
      }
      svg.style.setProperty('display','block','important');svg.style.setProperty('visibility','visible','important');
      const collect=(parent,parentNode=null,depth=0)=>{
        if(depth>MAX_DEPTH)throw new Error('SVG 分组嵌套过深，无法展开。');
        const result=[];
        for(const element of parent.children){
          const tag=element.localName.toLowerCase();if(SKIP.has(tag))continue;
          if(!DRAW.has(tag)&&!GROUP.has(tag))continue;
          if(this.nodes.size>=MAX_NODES)throw new Error('SVG 可视元素超过 20000 个，无法展开。');
          const style=getComputedStyle(element),native=nativeStyles.get(element)||style;
          const id=`svg-${this.nodes.size+1}`,isGroup=GROUP.has(tag);
          const ownHidden=style.display==='none'||hiddenStyle(style.visibility);
          const display=style.display==='none'?'inline':style.display||'inline';
          const name=element.getAttributeNS('http://www.inkscape.org/namespaces/inkscape','label')||element.getAttribute('inkscape:label')||element.getAttribute('aria-label')||element.getAttribute('data-name')||element.id||`${TAG_NAMES[tag]||tag} ${this.nodes.size+1}`;
          const type=isGroup?'group':tag==='text'?'text':tag==='image'?'pixel':tag==='use'?'smart':'shape';
          const node={id,element,parent:parentNode,children:[],display,nativeDisplay:native.display,nativeVisibility:native.visibility,nativeOpacity:Number(native.opacity),bounds:rect(0,0,0,0)};
          node.meta={id,name,type,left:0,top:0,right:0,bottom:0,width:0,height:0,hidden:ownHidden,opacity:Number.isFinite(Number(style.opacity))?clamp(style.opacity,0,1):1,blendMode:style.mixBlendMode||'normal',hasPixels:!isGroup,hasMask:style.maskImage!=='none'&&!!style.maskImage||!!element.getAttribute('mask')||!!element.getAttribute('clip-path')||style.clipPath!=='none'&&!!style.clipPath,hasEffects:style.filter!=='none'&&!!style.filter,text:tag==='text'?element.textContent.slice(0,500000):'',font:tag==='text'?style.fontFamily:'',svgTag:tag,svgId:element.id||'',...(isGroup?{children:[]}:{})};
          if(ownHidden)this.initialHidden.add(id);this.nodes.set(id,node);element.setAttribute('data-layerdesk-node',id);
          // Capture each node before revealing it, so inherited visibility does
          // not incorrectly make every child a separately hidden layer.
          element.style.setProperty('display',display,'important');element.style.setProperty('visibility','visible','important');
          if(isGroup){node.children=collect(element,node,depth+1);node.meta.children=node.children.map(child=>child.meta);}
          result.push(node);
        }
        return result;
      };
      try{
        this.roots=collect(svg);
        const rootRect=svg.getBoundingClientRect();
        for(const node of [...this.nodes.values()].reverse()){
          let bounds=this.measure(node,rootRect,warnings);
          if(node.children.length)for(const child of node.children)bounds=union(bounds,child.bounds);
          node.bounds=bounds||rect(0,0,0,0);
          const b=node.bounds;Object.assign(node.meta,{left:b.x,top:b.y,right:b.x+b.w,bottom:b.y+b.h,width:b.w,height:b.h});
        }
      }catch(error){this.dispose();throw error;}
      finally{for(const [element,style] of originalStyles)style===null?element.removeAttribute('style'):element.setAttribute('style',style);}
      this.rootNative=nativeStyles.get(svg)||{display:'inline',visibility:'visible',opacity:'1'};
      this.warnings=[...warnings];
      this.doc={format:'svg',name:file.name||'未命名.svg',width:this.width,height:this.height,bitsPerChannel:8,colorMode:3,colorModeName:'RGB',children:this.roots.map(n=>n.meta),count:this.nodes.size,leafCount:[...this.nodes.values()].filter(n=>n.meta.type!=='group').length,warnings:this.warnings};
      if(!this.nodes.size)this.doc.warnings.push('此 SVG 没有独立的可视元素，仍可查看整幅画面。');
      return {doc:this.doc};
    }
    measure(node,rootRect,warnings) {
      try{
        const element=node.element,box=element.getBBox(),matrix=element.getScreenCTM();
        if(!matrix)return rect(0,0,0,0);
        const style=getComputedStyle(element);
        let x=box.x,y=box.y,w=box.width,h=box.height;
        const stroke=style.stroke!=='none'&&Number(style.strokeOpacity)!==0?Math.max(0,parseFloat(style.strokeWidth)||0):0;
        if(stroke&&style.vectorEffect!=='non-scaling-stroke'){x-=stroke/2;y-=stroke/2;w+=stroke;h+=stroke;}
        const filterValue=String(style.filter||'');
        const filterId=filterValue.match(/url\(["']?(?:[^#]*#)([^"')\s]+)["']?\)/)?.[1];
        const filter=filterId?[...this.svg.querySelectorAll('[id]')].find(el=>el.id===filterId):null;
        if(filter?.localName==='filter'&&w&&h){
          if(filter.getAttribute('filterUnits')!=='userSpaceOnUse'){
            const ratio=(value,fallback)=>value===null?fallback:String(value).endsWith('%')?parseFloat(value)/100:parseFloat(value);
            const fx=ratio(filter.getAttribute('x'),-.1),fy=ratio(filter.getAttribute('y'),-.1),fw=ratio(filter.getAttribute('width'),1.2),fh=ratio(filter.getAttribute('height'),1.2);
            if([fx,fy,fw,fh].every(Number.isFinite)&&fw>0&&fh>0){x=box.x+fx*box.width;y=box.y+fy*box.height;w=fw*box.width;h=fh*box.height;}
          }else{
            const fx=parseFloat(filter.getAttribute('x')),fy=parseFloat(filter.getAttribute('y')),fw=parseFloat(filter.getAttribute('width')),fh=parseFloat(filter.getAttribute('height'));
            if([fx,fy,fw,fh].every(Number.isFinite)&&fw>0&&fh>0){x=fx;y=fy;w=fw;h=fh;}
          }
        }
        const points=[[x,y],[x+w,y],[x,y+h],[x+w,y+h]].map(([px,py])=>({x:matrix.a*px+matrix.c*py+matrix.e-rootRect.left,y:matrix.b*px+matrix.d*py+matrix.f-rootRect.top}));
        let left=Math.min(...points.map(p=>p.x)),top=Math.min(...points.map(p=>p.y)),right=Math.max(...points.map(p=>p.x)),bottom=Math.max(...points.map(p=>p.y));
        if(stroke&&style.vectorEffect==='non-scaling-stroke'){left-=stroke/2;top-=stroke/2;right+=stroke/2;bottom+=stroke/2;}
        if(![left,top,right,bottom].every(Number.isFinite))return rect(0,0,0,0);
        left=Math.floor(left+1e-7);top=Math.floor(top+1e-7);right=Math.ceil(right-1e-7);bottom=Math.ceil(bottom-1e-7);
        return rect(left,top,Math.max(0,right-left),Math.max(0,bottom-top));
      }catch{warnings.add('部分 SVG 元素无法读取独立边界，整图预览仍可使用。');return rect(0,0,0,0);}
    }
    dispose() {
      this.disposed=true;this.host?.remove();this.host=null;
      for(const item of [...this.images])item.cancel();this.images.clear();this.alphaCache.clear();
      this.svg=null;this.nodes.clear();
    }
    handle(type,payload={}) {
      const task=this.queue.then(()=>{
        if(this.disposed)throw new Error('SVG 文档已关闭。');
        if(!this.doc)throw new Error('请先打开一个 SVG 文件。');
        switch(type){
          case 'render':return this.render(payload);
          case 'thumbnail':return this.thumbnail(payload);
          case 'hitTest':return this.hitTest(payload);
          case 'export':return this.exportImage(payload,false);
          case 'exportPreview':return this.exportImage(payload,true);
          default:throw new Error('SVG 不支持此操作。');
        }
      });
      this.queue=task.catch(()=>{});return task;
    }
    scope(payload) {
      const selected=payload.mode==='layer'?this.nodes.get(payload.layerId):null;
      if(payload.mode==='layer'&&!selected)throw new Error('请先选择一个 SVG 元素。');
      const area=selected?selected.bounds:rect(0,0,this.width,this.height);
      if(!area.w||!area.h)throw new Error('此 SVG 分组或元素没有可预览的范围。');
      return {selected,area};
    }
    isDescendant(node,ancestor){for(let current=node;current;current=current.parent)if(current===ancestor)return true;return false;}
    eligible(node,payload,selected) {
      if(node.meta.type==='group')return false;
      if(selected&&!this.isDescendant(node,selected))return false;
      const original=payload.mode==='original';
      const hidden=Array.isArray(payload.hiddenIds)?new Set(payload.hiddenIds):this.initialHidden;
      for(let current=node;current;current=current.parent){
        if(current===selected)break;
        if(original){if(current.nativeDisplay==='none')return false;}
        else if(hidden.has(current.id))return false;
        if(current.meta.opacity===0)return false;
      }
      if(!selected&&original&&(hiddenStyle(node.nativeVisibility)||this.rootNative.display==='none'||this.rootNative.opacity==='0'))return false;
      if(!selected&&payload.soloId){const solo=this.nodes.get(payload.soloId);if(solo&&!this.isDescendant(node,solo))return false;}
      return true;
    }
    makeClone(payload,targetId=null) {
      const clone=this.svg.cloneNode(true),elements=new Map([...clone.querySelectorAll('[data-layerdesk-node]')].map(el=>[el.getAttribute('data-layerdesk-node'),el]));
      const original=payload.mode==='original';
      const hidden=Array.isArray(payload.hiddenIds)?new Set(payload.hiddenIds):this.initialHidden;
      if(!original)for(const node of this.nodes.values()){
        const element=elements.get(node.id);if(!element)continue;
        if(hidden.has(node.id))element.style.setProperty('display','none','important');
        else if(node.meta.hidden){element.style.setProperty('display',node.display,'important');element.style.setProperty('visibility','visible','important');}
      }
      const scope=payload.mode==='layer'?this.nodes.get(payload.layerId):payload.soloId?this.nodes.get(payload.soloId):null;
      if(scope){
        clone.style.setProperty('display','block','important');clone.style.setProperty('visibility','visible','important');clone.style.setProperty('opacity','1','important');
        for(let current=scope;current;current=current.parent){
          const element=elements.get(current.id);if(!element)continue;
          element.style.setProperty('display',current.display,'important');element.style.setProperty('visibility','visible','important');element.style.setProperty('opacity','1','important');
        }
        for(const node of this.nodes.values())if(!this.isDescendant(node,scope)&&!this.isDescendant(scope,node))elements.get(node.id)?.style.setProperty('display','none','important');
      }
      const target=targetId?this.nodes.get(targetId):null;
      if(target)for(const node of this.nodes.values())if(!this.isDescendant(node,target)&&!this.isDescendant(target,node))elements.get(node.id)?.style.setProperty('display','none','important');
      return clone;
    }
    async raster(payload,area,width,height,targetId=null) {
      if(this.disposed)throw new Error('SVG 文档已关闭。');
      width=Math.max(1,Math.round(width));height=Math.max(1,Math.round(height));
      if(width>32767||height>32767||width*height>MAX_PIXELS)throw new Error('SVG 输出超过浏览器画布上限，请选择缩小导出。');
      const svg=document.createElementNS(SVG_NS,'svg');
      svg.setAttribute('xmlns',SVG_NS);svg.setAttribute('width',String(width));svg.setAttribute('height',String(height));
      svg.setAttribute('viewBox',`${area.x} ${area.y} ${area.w} ${area.h}`);svg.setAttribute('preserveAspectRatio','none');
      svg.style.setProperty('width',`${width}px`,'important');svg.style.setProperty('height',`${height}px`,'important');svg.style.setProperty('overflow','hidden','important');
      svg.appendChild(this.makeClone(payload,targetId));
      const xml=new XMLSerializer().serializeToString(svg),url=URL.createObjectURL(new Blob([xml],{type:'image/svg+xml;charset=utf-8'}));
      const image=new Image();image.decoding='async';
      let item;
      try{
        await new Promise((resolve,reject)=>{
          let done=false;
          const finish=error=>{if(done)return;done=true;clearTimeout(timer);image.onload=image.onerror=null;error?reject(error):resolve();};
          const timer=setTimeout(()=>finish(new Error('SVG 渲染超时，请检查文件中的图片和字体。')),15000);
          item={cancel:()=>{image.removeAttribute('src');finish(new Error('SVG 文档已关闭。'));}};this.images.add(item);
          image.onload=()=>finish();image.onerror=()=>finish(new Error('浏览器无法渲染此 SVG，请检查文件结构。'));image.src=url;
        });
        if(this.disposed)throw new Error('SVG 文档已关闭。');
        const surface=document.createElement('canvas');surface.width=width;surface.height=height;
        try{const context=surface.getContext('2d');context.drawImage(image,0,0,width,height);return await createImageBitmap(surface);}
        finally{surface.width=surface.height=1;}
      }finally{if(item)this.images.delete(item);URL.revokeObjectURL(url);image.removeAttribute('src');}
    }
    async render(payload) {
      const {area}=this.scope(payload),max=clamp(payload.maxSize||2200,16,8192),scale=clamp(payload.renderScale||1,1,8),ratio=Math.min(scale,max/Math.max(area.w,area.h));
      const bitmap=await this.raster(payload,area,Math.max(1,Math.round(area.w*ratio)),Math.max(1,Math.round(area.h*ratio)));
      return {bitmap,width:bitmap.width,height:bitmap.height,documentWidth:area.w,documentHeight:area.h,originX:area.x,originY:area.y,source:payload.mode==='layer'?'layer':payload.mode==='composite'?'composite':'original',warnings:[...this.warnings]};
    }
    async thumbnail(payload) {
      const node=this.nodes.get(payload.layerId);
      if(!node||node.meta.type==='group'||!node.bounds.w||!node.bounds.h)return {empty:true};
      return this.render({mode:'layer',layerId:node.id,maxSize:48});
    }
    async hitTest(payload) {
      if(!Number.isFinite(payload.x)||!Number.isFinite(payload.y))throw new Error('无效的画布坐标。');
      const {area,selected}=this.scope(payload),x=Math.floor(payload.x),y=Math.floor(payload.y);
      if(!contains(area,x,y))return {layerId:null,candidates:[],warnings:[]};
      const candidates=[],settingsKey=JSON.stringify([payload.mode,payload.layerId,payload.soloId,[...(payload.hiddenIds||[])].sort()]);
      for(const node of [...this.nodes.values()].reverse()){
        if(candidates.length>=50)break;
        if(!contains(node.bounds,x,y)||!this.eligible(node,payload,selected))continue;
        const key=`${settingsKey}:${node.id}:${x},${y}`;
        let alpha=this.alphaCache.get(key);
        if(alpha===undefined){
          const bitmap=await this.raster(payload,rect(x,y,1,1),1,1,node.id);
          const surface=document.createElement('canvas');surface.width=surface.height=1;
          try{const ctx=surface.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);alpha=ctx.getImageData(0,0,1,1).data[3];}
          finally{bitmap.close();surface.width=surface.height=1;}
          this.alphaCache.set(key,alpha);if(this.alphaCache.size>512)this.alphaCache.delete(this.alphaCache.keys().next().value);
        }
        if(alpha>0)candidates.push({id:node.id,name:node.meta.name,type:node.meta.type});
      }
      return {layerId:candidates[0]?.id||null,candidates,warnings:[]};
    }
    async exportImage(payload,preview) {
      if(typeof this.requestWorker!=='function')throw new Error('SVG 图片导出服务尚未就绪。');
      const {area}=this.scope(payload),edge=Number(payload.exportSize),ratio=Number.isFinite(edge)&&edge>0?Math.min(1,Math.min(32767,edge)/Math.max(area.w,area.h)):1;
      const exportWidth=Math.max(1,Math.round(area.w*ratio)),exportHeight=Math.max(1,Math.round(area.h*ratio));
      const canExport=exportWidth<=32767&&exportHeight<=32767&&exportWidth*exportHeight<=MAX_PIXELS;
      if(!preview&&!canExport)throw new Error('导出图像超过 6400 万像素或浏览器尺寸上限。请选择缩小导出，或导出较小的单个元素。');
      const previewRatio=preview?Math.min(1,clamp(payload.maxSize||900,16,2048)/Math.max(exportWidth,exportHeight)):1;
      const bitmap=await this.raster(payload,area,Math.max(1,Math.round(exportWidth*previewRatio)),Math.max(1,Math.round(exportHeight*previewRatio)));
      let result;
      try{result=await this.requestWorker('rasterExport',{...payload,bitmap,preview,exportWidth,exportHeight,documentWidth:area.w,documentHeight:area.h,originX:area.x,originY:area.y},[bitmap]);}
      catch(error){try{bitmap.close();}catch{}throw error;}
      return {...result,warnings:unique([...this.warnings,...(result.warnings||[])])};
    }
  }
  window.LayerDeskSvgDocument=LayerDeskSvgDocument;
})();
