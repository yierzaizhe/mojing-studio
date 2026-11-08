/* Offline, read-only raster image adapter. All source pixels stay local. */
(() => {
  'use strict';
  const MAX_FILE_BYTES=128*1024*1024,MAX_SOURCE_PIXELS=120000000,MAX_EXPORT_PIXELS=64000000;
  const imageTypes=new Set(['png','jpg','jpeg','webp','gif','bmp','avif']);
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,Number(value)||0));
  const dimensionLimit=(width,height)=>{
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0)throw new Error('图片尺寸无效，无法读取。');
    if(width*height>MAX_SOURCE_PIXELS)throw new Error('图片超过 1.2 亿像素的解码预算，请缩小图片后再打开。');
  };
  function headerInfo(bytes){
    const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),ascii=(at,length)=>String.fromCharCode(...bytes.subarray(at,at+length));
    if(bytes.length>=24&&bytes[0]===137&&ascii(1,3)==='PNG')return{format:'PNG',width:data.getUint32(16),height:data.getUint32(20)};
    if(bytes.length>=10&&['GIF87a','GIF89a'].includes(ascii(0,6)))return{format:'GIF',width:data.getUint16(6,true),height:data.getUint16(8,true),animated:true};
    if(bytes.length>=26&&ascii(0,2)==='BM'){
      const dib=data.getUint32(14,true);
      return dib===12?{format:'BMP',width:data.getUint16(18,true),height:data.getUint16(20,true)}:{format:'BMP',width:Math.abs(data.getInt32(18,true)),height:Math.abs(data.getInt32(22,true))};
    }
    if(bytes.length>=12&&ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP'){
      const info={format:'WebP'};
      if(bytes.length>=30&&ascii(12,4)==='VP8X'){
        info.width=1+bytes[24]+bytes[25]*256+bytes[26]*65536;info.height=1+bytes[27]+bytes[28]*256+bytes[29]*65536;info.animated=!!(bytes[20]&2);
      }
      return info;
    }
    if(bytes.length>=16&&ascii(4,4)==='ftyp'&&/avif|avis/.test(ascii(8,Math.min(48,bytes.length-8))))return{format:'AVIF',animated:ascii(8,4)==='avis'};
    if(bytes.length>3&&bytes[0]===255&&bytes[1]===216){
      const info={format:'JPG'};let offset=2;
      while(offset+3<bytes.length){
        if(bytes[offset++]!==255)continue;
        while(bytes[offset]===255&&offset<bytes.length)offset++;
        const marker=bytes[offset++];
        if(marker===0xda||marker===0xd9)break;
        if(marker===0x01||(marker>=0xd0&&marker<=0xd8))continue;
        if(offset+2>bytes.length)break;
        const length=data.getUint16(offset);if(length<2||offset+length>bytes.length)break;
        if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=7){info.height=data.getUint16(offset+3);info.width=data.getUint16(offset+5);break;}
        offset+=length;
      }
      return info;
    }
    return{};
  }
  class LayerDeskImageDocument{
    constructor({requestWorker}={}){
      this.requestWorker=requestWorker;this.bitmap=null;this.doc=null;this.meta=null;this.disposed=false;
      this.epoch=0;this.queue=Promise.resolve();this.pendingImages=new Set();this.alphaCache=new Map();
    }
    assertOpen(){if(this.disposed||!this.bitmap||!this.doc)throw new Error('图片文档已关闭，请重新打开图片。');}
    async decode(file){
      if(typeof createImageBitmap!=='function')throw new Error('此浏览器不支持图片解码，请使用最新版 Chrome 或 Edge。');
      try{return await createImageBitmap(file,{imageOrientation:'from-image'});}catch{
        // Native image loading covers formats a browser exposes through <img>
        // but not its Blob ImageBitmap decoder, without network access.
        return new Promise((resolve,reject)=>{
          const image=new Image(),url=URL.createObjectURL(file);let settled=false;
          const cleanup=()=>{clearTimeout(timer);image.onload=image.onerror=null;this.pendingImages.delete(cancel);URL.revokeObjectURL(url);};
          const cancel=()=>{if(settled)return;settled=true;cleanup();image.src='';reject(new Error('图片文档已关闭。'));};
          const timer=setTimeout(()=>{if(settled)return;settled=true;cleanup();image.src='';reject(new Error('图片解码超时，请检查文件是否完整。'));},20000);
          this.pendingImages.add(cancel);
          image.onload=async()=>{
            if(settled)return;
            try{
              dimensionLimit(image.naturalWidth,image.naturalHeight);
              const bitmap=await createImageBitmap(image,{imageOrientation:'from-image'});
              if(settled){bitmap.close();return;}settled=true;cleanup();resolve(bitmap);
            }catch{if(!settled){settled=true;cleanup();reject(new Error('图片无法解码或格式不受此浏览器支持，请尝试 PNG、JPG 或 WebP。'));}}
          };
          image.onerror=()=>{if(settled)return;settled=true;cleanup();reject(new Error('图片无法解码或文件不完整，请尝试 PNG、JPG 或 WebP。'));};
          image.src=url;
        });
      }
    }
    async open(file){
      if(this.disposed)throw new Error('图片文档已关闭。');
      if(!file||typeof file.slice!=='function')throw new Error('请选择一个图片文件。');
      if(file.size>MAX_FILE_BYTES)throw new Error('图片超过 128 MB，请压缩或缩小后再打开。');
      const extension=String(file.name||'').split('.').pop().toLowerCase();
      if(!imageTypes.has(extension)&&!/^image\/(?:png|jpe?g|webp|gif|bmp|avif)$/i.test(file.type||''))throw new Error('请选择 PNG、JPG、WebP、GIF、BMP 或 AVIF 图片。');
      const epoch=++this.epoch;this.bitmap?.close();this.bitmap=null;this.doc=null;this.meta=null;this.alphaCache.clear();
      for(const cancel of [...this.pendingImages])cancel();
      const info=headerInfo(new Uint8Array(await file.slice(0,262144).arrayBuffer()));
      if(info.width!==undefined&&info.height!==undefined)dimensionLimit(info.width,info.height);
      let bitmap;
      try{bitmap=await this.decode(file);}catch(error){if(this.disposed||epoch!==this.epoch)throw new Error('图片文档已关闭。');throw error;}
      if(this.disposed||epoch!==this.epoch){bitmap.close();throw new Error('图片文档已关闭。');}
      try{dimensionLimit(bitmap.width,bitmap.height);}catch(error){bitmap.close();throw error;}
      this.bitmap=bitmap;this.width=bitmap.width;this.height=bitmap.height;
      const format=info.format||({jpeg:'JPG',jpg:'JPG',webp:'WebP'}[extension]||extension.toUpperCase());
      const warnings=[];
      if(format==='GIF')warnings.push('GIF 以静态首帧显示和导出。');
      else if(info.animated)warnings.push('动态图片以静态首帧显示和导出。');
      this.meta={id:'image-1',name:file.name||'图片',type:'pixel',left:0,top:0,right:this.width,bottom:this.height,width:this.width,height:this.height,hidden:false,opacity:1,blendMode:'normal',hasPixels:true,hasMask:false,hasEffects:false,text:'',font:''};
      this.doc={format:'image',imageFormat:format,name:file.name||'未命名图片',width:this.width,height:this.height,bitsPerChannel:8,colorMode:3,colorModeName:'RGB',children:[this.meta],count:1,leafCount:1,hasComposite:true,warnings};
      return{doc:this.doc};
    }
    visible(payload={}){
      if(payload.mode==='original'||payload.mode==='layer')return true;
      return!(payload.hiddenIds||[]).includes('image-1')&&(!payload.soloId||payload.soloId==='image-1');
    }
    validateScope(payload){if(payload.mode==='layer'&&payload.layerId!=='image-1')throw new Error('请先选择图片图层。');}
    async raster(width,height,visible=true){
      this.assertOpen();
      if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>32767||height>32767||width*height>MAX_EXPORT_PIXELS)throw new Error('图片输出超过 6400 万像素或浏览器尺寸上限，请选择缩小导出。');
      const epoch=this.epoch,surface=document.createElement('canvas');surface.width=width;surface.height=height;
      try{
        const ctx=surface.getContext('2d');if(!ctx)throw new Error('浏览器无法创建图片画布。');
        ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';if(visible)ctx.drawImage(this.bitmap,0,0,width,height);
        const bitmap=await createImageBitmap(surface);
        if(this.disposed||epoch!==this.epoch){bitmap.close();throw new Error('图片文档已关闭。');}
        return bitmap;
      }finally{surface.width=surface.height=1;}
    }
    settings(payload={}){
      if(payload.mode==='original'||payload.previewBypass)return null;
      return window.LayerDeskFilters?.normalize(payload.adjustments)||null;
    }
    async adjustedRaster(width,height,payload={}){
      const epoch=this.epoch,bitmap=await this.raster(width,height,this.visible(payload)),adjustments=this.settings(payload);
      if(this.disposed||epoch!==this.epoch){bitmap.close();throw new Error('图片文档已关闭。');}
      if(!adjustments||window.LayerDeskFilters.isIdentity(adjustments))return bitmap;
      try{
        if(typeof this.requestWorker!=='function')throw new Error('图片调整服务尚未就绪。');
        const result=await this.requestWorker('adjustRaster',{bitmap,adjustments,sourceWidth:this.width,sourceHeight:this.height},[bitmap]);
        if(this.disposed||epoch!==this.epoch){result.bitmap?.close();throw new Error('图片文档已关闭。');}
        return result.bitmap;
      }finally{bitmap.close();}
    }
    async render(payload={}){
      this.assertOpen();this.validateScope(payload);
      const epoch=this.epoch;
      const edge=clamp(payload.maxSize||2200,1,4096),ratio=Math.min(1,edge/Math.max(this.width,this.height));
      const bitmap=await this.adjustedRaster(Math.max(1,Math.round(this.width*ratio)),Math.max(1,Math.round(this.height*ratio)),payload);
      if(this.disposed||epoch!==this.epoch){bitmap.close();throw new Error('图片文档已关闭。');}
      return{bitmap,width:bitmap.width,height:bitmap.height,documentWidth:this.width,documentHeight:this.height,originX:0,originY:0,source:payload.mode||'original',warnings:[...this.doc.warnings]};
    }
    async thumbnail(payload){
      this.assertOpen();if(payload.layerId!=='image-1')throw new Error('图片图层不存在。');
      const result=await this.render({...payload,mode:'layer',layerId:'image-1',maxSize:48});
      return{bitmap:result.bitmap,width:result.width,height:result.height,layerId:'image-1'};
    }
    async filterThumbnail(payload={}){
      return this.render({...payload,mode:'composite',hiddenIds:[],soloId:null,previewBypass:false,maxSize:Math.min(180,payload.maxSize||160)});
    }
    async hitTest(payload){
      this.assertOpen();this.validateScope(payload);
      const x=Math.floor(payload.x),y=Math.floor(payload.y);
      if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=this.width||y>=this.height||!this.visible(payload))return{layerId:null,candidates:[],warnings:[]};
      const key=`${x},${y}`;let alpha=this.alphaCache.get(key);
      if(alpha===undefined){
        const surface=document.createElement('canvas');surface.width=surface.height=1;
        try{const ctx=surface.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=false;ctx.drawImage(this.bitmap,x,y,1,1,0,0,1,1);alpha=ctx.getImageData(0,0,1,1).data[3];this.alphaCache.set(key,alpha);if(this.alphaCache.size>512)this.alphaCache.delete(this.alphaCache.keys().next().value);}
        finally{surface.width=surface.height=1;}
      }
      const candidates=alpha?[{id:'image-1',name:this.meta.name,type:'pixel'}]:[];
      return{layerId:candidates[0]?.id||null,candidates,warnings:[]};
    }
    async export(payload={},preview=false){
      this.assertOpen();this.validateScope(payload);
      const epoch=this.epoch;
      if(typeof this.requestWorker!=='function')throw new Error('图片导出服务尚未就绪。');
      const edge=Number(payload.exportSize)>0?clamp(Math.round(payload.exportSize),1,32767):0;
      const ratio=edge?Math.min(1,edge/Math.max(this.width,this.height)):1;
      const exportWidth=Math.max(1,Math.round(this.width*ratio)),exportHeight=Math.max(1,Math.round(this.height*ratio));
      const canExport=exportWidth<=32767&&exportHeight<=32767&&exportWidth*exportHeight<=MAX_EXPORT_PIXELS;
      if(!preview&&!canExport)throw new Error('原尺寸超过 6400 万像素或浏览器尺寸上限，请选择缩小导出。');
      const previewEdge=preview?clamp(payload.maxSize||900,1,2048):Infinity;
      const rasterRatio=preview?Math.min(1,previewEdge/Math.max(exportWidth,exportHeight)):1;
      const bitmap=await this.raster(Math.max(1,Math.round(exportWidth*rasterRatio)),Math.max(1,Math.round(exportHeight*rasterRatio)),this.visible(payload));
      try{
        const result=await this.requestWorker('rasterExport',{...payload,adjustments:this.settings(payload),sourceWidth:this.width,sourceHeight:this.height,bitmap,preview,exportWidth,exportHeight,documentWidth:this.width,documentHeight:this.height,originX:0,originY:0},[bitmap]);
        if(this.disposed||epoch!==this.epoch){result.bitmap?.close();throw new Error('图片文档已关闭。');}
        return{...result,warnings:[...new Set([...(this.doc?.warnings||[]),...(result.warnings||[])])]};
      }finally{bitmap.close();}
    }
    handle(type,payload={}){
      const task=async()=>{
        this.assertOpen();
        switch(type){
          case'render':return this.render(payload);
          case'thumbnail':return this.thumbnail(payload);
          case'filterThumbnail':return this.filterThumbnail(payload);
          case'hitTest':return this.hitTest(payload);
          case'exportPreview':return this.export(payload,true);
          case'export':return this.export(payload,false);
          default:throw new Error('未知的图片操作。');
        }
      };
      const result=this.queue.then(task);this.queue=result.catch(()=>{});return result;
    }
    dispose(){
      if(this.disposed)return;
      this.disposed=true;this.epoch++;for(const cancel of [...this.pendingImages])cancel();this.pendingImages.clear();
      this.bitmap?.close();this.bitmap=null;this.doc=null;this.meta=null;this.alphaCache.clear();
    }
  }
  window.LayerDeskImageDocument=LayerDeskImageDocument;
})();
