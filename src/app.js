(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const names = {group:'图层组',text:'文字',shape:'形状',smart:'智能对象',adjustment:'调整图层',pixel:'像素图层'};
  const symbols = {group:'▱',text:'T',shape:'◇',smart:'▣',adjustment:'◐',pixel:'▧'};
  const blendNames = {'normal':'正常','pass through':'穿透','multiply':'正片叠底','screen':'滤色','overlay':'叠加','darken':'变暗','lighten':'变亮','soft light':'柔光','hard light':'强光','color dodge':'颜色减淡','color burn':'颜色加深','difference':'差值','exclusion':'排除','hue':'色相','saturation':'饱和度','color':'颜色','luminosity':'明度'};
  const filters=window.LayerDeskFilters,adjustKeys=['brightness','contrast','saturation','temperature','sharpness','strength'];
  let generationClock=0,documentSequence=0,activeSession=null,importBusy=false;
  const sessions=[];
  const createState=()=>({doc:null,layers:new Map(),parents:new Map(),expanded:new Set(),hidden:new Set(),initialHidden:new Set(),solo:null,selected:null,rows:[],zoom:1,panX:0,panY:0,frame:null,tool:'select',space:false,loading:false,picking:false,renderToken:0,generation:++generationClock,thumbs:new Map(),thumbPending:new Set(),thumbQueue:[],thumbBusy:false,adjustments:filters.normalize(),presetId:null,filterRevision:0,compareOriginal:false,adjusting:false,sidebarTab:'adjust',presetThumbnails:new Map(),presetThumbBusy:false,presetToken:0});
  let state=createState();
  let nextId=0, renderBusy=false, renderAgain=false, renderPromise=null, fitNext=true, pickToken=0, pickCycle=null, documentAdapter=null, svgResolutionTimer=null, loadingDelay=null, renderDelay=null, viewRaf=0,filterTimer=null;
  const viewport = $('canvas-viewport'), canvas = $('stage-canvas'), list = $('layer-list');
  const context = canvas.getContext('2d');
  const paper=$('canvas-paper'),renderIndicator=$('canvas-render-status');
  const viewportSize={width:viewport.clientWidth,height:viewport.clientHeight};
  let viewGeometry=null;
  const canvasPreferences={background:'dark',grid:'medium'};
  canvas.style.transformOrigin='0 0';
  const overlay = document.createElement('div');
  overlay.className='selection-bounds'; overlay.style.cssText='position:absolute;pointer-events:none;border:1px solid #649dff;box-shadow:0 0 0 1px #0003;display:none;z-index:2';
  viewport.appendChild(overlay);
  list.innerHTML='<div id="layer-spacer"></div><div id="layer-rows"></div>';
  const rowHost=$('layer-rows'), spacer=$('layer-spacer');
  list.style.position='relative'; rowHost.style.cssText='position:absolute;left:0;right:0;top:0';
  const rowHeight=44;
  const exportState={epoch:0,previewSequence:0,previewBusy:false,previewAgain:false,previewTimer:null,busy:false,canExport:null,snapshot:null,selectedId:null,baseName:''};

  function toast(message, error=false) {
    $('toast').hidden=false; $('toast').textContent=message; $('toast').classList.toggle('error',error); $('toast').classList.add('visible');
    clearTimeout(toast.timer); toast.timer=setTimeout(()=>$('toast').classList.remove('visible'),4500);
  }
  function status(text) { $('status-text').textContent=text;if(activeSession)activeSession.ui.status=text; }
  function fileKind(file){
    const name=String(file?.name||''),type=String(file?.type||'');
    // Unsupported document extensions take precedence over browser MIME hints.
    if(/\.(ai|pdf)$/i.test(name)||/^(?:application\/(?:pdf|postscript|(?:x-)?illustrator|vnd\.adobe\.illustrator)|image\/(?:pdf|(?:x-)?illustrator))$/i.test(type))return null;
    if(/\.(psd|psb)$/i.test(name))return 'psd';
    if(/\.svg$/i.test(name)||/^image\/svg\+xml$/i.test(type))return 'svg';
    if(/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(name)||/^image\/(?:png|jpe?g|webp|gif|bmp|avif)$/i.test(type))return 'image';
    return null;
  }
  function previewIssue(node){
    return node?.previewable===false?node.previewReason||'此图层保留结构和属性，没有可独立预览的画面。':'';
  }
  function setSidebarTab(name){
    const image=state.doc?.format==='image',adjust=image&&name==='adjust';
    if(state.doc)state.sidebarTab=adjust?'adjust':'layers';
    for(const key of ['layers','adjust']){
      const active=key===(adjust?'adjust':'layers'),tab=$(`sidebar-${key}-tab`);
      tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
      $(`sidebar-${key}-panel`).hidden=!active;
    }
    $('sidebar-adjust-tab').disabled=!image;
    $('sidebar-adjust-tab').hidden=!image;
    $('sidebar-adjust-tab').parentElement.hidden=!image;
    if(adjust)drawPresetThumbnails();
  }
  function filterLabel(){
    if(filters.isIdentity(state.adjustments))return '原图参数';
    return filters.PRESETS.find(p=>p.id===state.presetId)?.name||'自定义调整';
  }
  function updateFilterStatus(busy=false){
    $('filter-status').textContent=state.compareOriginal?'原图对比中 · 松开恢复':busy?'正在更新图片…':`${filterLabel()} · 强度 ${state.adjustments.strength}%`;
  }
  function syncAdjustments(){
    const image=state.doc?.format==='image';
    for(const key of adjustKeys){
      const input=$(`adjust-${key}`),value=state.adjustments[key];input.value=String(value);input.disabled=!image||state.loading;
      $(`adjust-${key}-value`).textContent=`${value>0&&!['sharpness','strength'].includes(key)?'+':''}${value}${key==='strength'?'%':''}`;
    }
    $('filter-reset').disabled=!image||state.loading;
    $('filter-compare').disabled=!image||state.loading;
    $('filter-compare').setAttribute('aria-pressed',String(state.compareOriginal));
    for(const button of $('filter-presets').querySelectorAll('[data-filter-preset]')){
      button.disabled=!image||state.loading;const active=button.dataset.filterPreset===state.presetId;
      button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));
    }
    updateFilterStatus();setSidebarTab(state.sidebarTab);
  }
  function drawPresetThumbnails(){
    for(const preset of filters.PRESETS){
      const target=$('filter-presets').querySelector(`[data-filter-preset="${preset.id}"] canvas`),bitmap=state.presetThumbnails.get(preset.id);
      if(!target)continue;const ctx=target.getContext('2d');ctx.clearRect(0,0,target.width,target.height);
      if(bitmap){const scale=Math.max(target.width/bitmap.width,target.height/bitmap.height),w=bitmap.width*scale,h=bitmap.height*scale;ctx.drawImage(bitmap,(target.width-w)/2,(target.height-h)/2,w,h);}
      target.parentElement.classList.toggle('has-preview',!!bitmap);
    }
  }
  async function ensureFilterThumbnails(){
    const owner=activeSession,own=owner?.state,adapter=owner?.adapter;
    if(!owner||own.doc?.format!=='image'||own.presetThumbBusy||own.presetThumbnails.size===filters.PRESETS.length||state.loading)return;
    own.presetThumbBusy=true;const token=++own.presetToken,generation=own.generation;
    try{
      for(const preset of filters.PRESETS){
        if(owner.closed||token!==own.presetToken||generation!==own.generation)return;
        if(own.presetThumbnails.has(preset.id))continue;
        const result=await adapter.handle('filterThumbnail',{adjustments:{...preset.settings},maxSize:160});
        if(owner.closed||token!==own.presetToken||generation!==own.generation){result.bitmap?.close();return;}
        own.presetThumbnails.set(preset.id,result.bitmap);if(owner===activeSession)drawPresetThumbnails();
      }
    }catch{/* A preset thumbnail never prevents image editing or export. */}
    finally{if(token===own.presetToken)own.presetThumbBusy=false;}
  }
  function refreshImageThumbnail(){
    const bitmap=state.thumbs.get('image-1');bitmap?.close();state.thumbs.delete('image-1');state.thumbPending.delete('image-1');
    state.thumbQueue=state.thumbQueue.filter(item=>item.id!=='image-1');drawRows();
  }
  function scheduleFilterRender(immediate=false){
    if(state.doc?.format!=='image'||state.loading)return;
    state.renderToken++;activeSession.dirty=true;
    if(immediate){clearTimeout(filterTimer);filterTimer=null;render();}
    else if(!filterTimer)filterTimer=setTimeout(()=>{filterTimer=null;render();},50);
  }
  function changeAdjustments(raw,{presetId=null,interactive=false,reset=false}={}){
    if(state.doc?.format!=='image'||state.loading)return;
    state.adjustments=filters.normalize(raw);state.presetId=presetId;state.filterRevision++;state.adjusting=interactive;state.compareOriginal=false;
    $('mode-select').value=reset?'original':'composite';state.solo=null;state.hidden=new Set(state.initialHidden);
    syncAdjustments();scheduleFilterRender(!interactive);
  }
  function compareOriginal(value){
    if(state.doc?.format!=='image'||state.loading||state.compareOriginal===value)return;
    state.compareOriginal=value;state.adjusting=false;syncAdjustments();scheduleFilterRender(true);
  }
  function applyCanvasPreferences(save=false){
    const backgrounds={dark:'#383838',medium:'#707070',light:'#b8b8b8',black:'#141414'};
    const gridSizes={none:0,small:4,medium:8,large:16};
    viewport.style.setProperty('--pasteboard',backgrounds[canvasPreferences.background]);
    paper.style.setProperty('--checker-period',`${Math.max(1,gridSizes[canvasPreferences.grid])*2}px`);
    paper.classList.toggle('checker-off',canvasPreferences.grid==='none');
    $('canvas-background-select').value=canvasPreferences.background;
    $('checker-size-select').value=canvasPreferences.grid;
    if(save)try{localStorage.setItem('layerdesk.canvas.v1',JSON.stringify(canvasPreferences));}catch{}
  }
  function restoreCanvasPreferences(){
    try{
      const saved=JSON.parse(localStorage.getItem('layerdesk.canvas.v1'));
      if(['dark','medium','light','black'].includes(saved?.background))canvasPreferences.background=saved.background;
      if(['none','small','medium','large'].includes(saved?.grid))canvasPreferences.grid=saved.grid;
    }catch{}
    applyCanvasPreferences();
  }
  function loadingPhase(phase,message,detail){
    $('loading-text').textContent=message;
    $('loading-detail').textContent=detail||'文件较大时可能需要一些时间。';
    $('loading-step-read').dataset.state=phase==='read'?'active':'done';
    $('loading-step-render').dataset.state=phase==='render'?'active':'waiting';
    $('loading-overlay').querySelector('.loading-card').dataset.phase=phase;
  }
  function setLoading(value, message='正在读取文件…') {
    clearTimeout(loadingDelay);state.loading=value;
    $('loading-overlay').hidden=true;
    viewport.classList.toggle('is-loading',value);viewport.setAttribute('aria-busy',String(value||renderBusy));
    if(value){
      loadingPhase('read',message,'正在读取文件与画面结构。');
      loadingDelay=setTimeout(()=>{if(state.loading)$('loading-overlay').hidden=false;},160);
    }
    $('open-btn').disabled=value; $('demo-btn').disabled=value;
    $('export-btn').disabled=value||!state.doc;
    $('mode-select').disabled=value||!state.doc;
    $('cancel-btn').hidden=!value;
    syncAdjustments();
    if(!value&&state.doc?.format==='image')ensureFilterThumbnails();
    renderTabs();
  }
  function renderFeedback(active){
    clearTimeout(renderDelay);renderIndicator.hidden=true;
    viewport.classList.toggle('is-rendering',active);viewport.setAttribute('aria-busy',String(active||state.loading));
    if(active&&!state.loading&&state.frame){
      renderIndicator.textContent=state.doc?.format==='svg'?'正在细化矢量预览…':'正在更新画布…';
      renderDelay=setTimeout(()=>{if(renderBusy&&!state.loading)renderIndicator.hidden=false;},140);
    }
  }
  function clearPreview(showEmpty=true){
    if(viewRaf){cancelAnimationFrame(viewRaf);viewRaf=0;}
    state.frame=null;viewGeometry=null;canvas.width=canvas.height=1;canvas.hidden=true;paper.hidden=true;
    overlay.style.display='none';viewport.classList.remove('has-document');$('empty-state').hidden=!showEmpty;$('zoom-label').textContent='—';
  }
  function newWorker(owner=activeSession) {
    const ownRequests=owner.requests;
    owner.workerUrl=URL.createObjectURL(new Blob([$('psd-worker-source').textContent],{type:'text/javascript'}));
    owner.worker=new Worker(owner.workerUrl);
    owner.worker.onmessage=event=>{
      const result=event.data, request=ownRequests.get(result.id);
      if(!request){ result.bitmap?.close(); return; }
      ownRequests.delete(result.id);
      result.ok ? request.resolve(result) : request.reject(new Error(result.error||'文件处理失败'));
    };
    owner.worker.onerror=event=>{
      const error=new Error(event.message||'后台解析异常，请重新打开文件');
      for(const req of ownRequests.values()) req.reject(error);
      ownRequests.clear();
      if(owner===activeSession){setLoading(false);status('解析失败');toast(error.message,true);}
    };
  }
  function requestSessionWorker(owner,type,payload={},transfer=[]) {
    return new Promise((resolve,reject)=>{
      if(!owner?.worker||owner.closed)return reject(new Error('文档已关闭'));
      const id=++nextId; owner.requests.set(id,{resolve,reject});
      try{owner.worker.postMessage({id,type,...payload},transfer);}catch(error){owner.requests.delete(id);reject(error);}
    });
  }
  function requestWorker(type,payload={},transfer=[]) {return requestSessionWorker(activeSession,type,payload,transfer);}
  function request(type,payload={}) {
    if(documentAdapter){const backend=documentAdapter;return Promise.resolve().then(()=>type==='open'?backend.open(payload.file):backend.handle(type,payload));}
    return requestWorker(type,payload);
  }
  function closeThumbnails() { for(const image of state.thumbs.values()) image.close(); state.thumbs.clear(); state.thumbPending.clear(); state.thumbQueue=[]; }
  function resetDocument({preservePreview=false}={}) {
    const keepPreview=preservePreview&&state.frame&&!canvas.hidden;
    clearTimeout(svgResolutionTimer);documentAdapter?.dispose();documentAdapter=null;
    if($('export-dialog').open)$('export-dialog').close();
    cancelPick(); pickCycle=null;
    state.generation=++generationClock; state.renderToken++; state.doc=null; state.selected=null;
    state.layers.clear(); state.parents.clear(); state.expanded.clear(); state.hidden.clear(); state.initialHidden.clear(); state.solo=null;
    closeThumbnails(); state.thumbBusy=false; renderBusy=false; renderAgain=false;renderPromise=null;renderFeedback(false);
    if(!keepPreview)clearPreview();else{overlay.style.display='none';$('empty-state').hidden=true;}
    $('inspector').innerHTML='<p class="inspector-empty">选择图层，查看详细信息</p>';
    $('document-tab').textContent='未打开文件'; $('status-dimensions').textContent=''; $('layer-count').textContent='0'; $('notice-area').hidden=true;
    $('mode-select').value='original'; $('layer-search').value='';
    setDocumentLabels('psd');
    updateRows(); setLoading(false); updateTransform();
  }
  async function openDocument(owner) {
    const file=owner.file;
    const kind=fileKind(file);
    if(!kind)throw new Error('当前公开版支持 PSD、PSB、SVG 和普通图片，请选择支持的文件格式。');
    const isSvg=kind==='svg',isImage=kind==='image';
    newWorker(owner); const generation=state.generation;
    const boundWorker=(type,payload,transfer)=>requestSessionWorker(owner,type,payload,transfer);
    if(isSvg)documentAdapter=new window.LayerDeskSvgDocument({requestWorker:boundWorker});
    else if(isImage)documentAdapter=new window.LayerDeskImageDocument({requestWorker:boundWorker});
    owner.adapter=documentAdapter;owner.status='loading';renderTabs();
    $('loading-filename').textContent=file.name;$('document-tab').textContent=file.name;$('document-tab').title=file.name;
    setLoading(true,isSvg?'正在读取 SVG 元素…':isImage?'正在解码图片…':'正在读取图层结构…'); status(`正在打开 ${file.name}`);
    try {
      let result;
      if(documentAdapter)result=await request('open',{file});
      else{
        const controller=new AbortController();owner.readController=controller;
        try{
          const buffer=await window.LayerDeskLocalFile.read(file,{signal:controller.signal});
          if(owner.closed||generation!==state.generation)return;
          result=await boundWorker('open',{buffer,name:file.name},[buffer]);
        }finally{if(owner.readController===controller)owner.readController=null;}
      }
      if(generation!==state.generation)return;
      state.doc=result.doc;
      setDocumentLabels(kind);
      function index(nodes,parent=null,depth=0) { for(const node of nodes||[]) {
        state.layers.set(node.id,node); if(parent)state.parents.set(node.id,parent);
        if(node.hidden)state.hidden.add(node.id);
        if(node.type==='group'&&depth<2)state.expanded.add(node.id);
        index(node.children,node.id,depth+1);
      }}
      index(state.doc.children); state.initialHidden=new Set(state.hidden);
      $('document-tab').textContent=file.name; $('document-tab').title=file.name;
      $('status-dimensions').textContent=`${state.doc.width.toLocaleString()} × ${state.doc.height.toLocaleString()} px · ${isSvg?'SVG 矢量':isImage?state.doc.imageFormat||'图片':state.doc.bitsPerChannel+' 位'}`;
      $('layer-count').textContent=String(state.doc.count);
      $('empty-state').hidden=true;
      updateRows(); showWarnings(state.doc.warnings||[]);
      loadingPhase('render','正在生成画布预览…','画面结构已读取，正在准备显示。');fitNext=true;
      const ready=await render();
      if(generation===state.generation) {owner.status='ready';setLoading(false);processThumbs();if(ready)status(`已打开 · ${state.doc.count} 个${isSvg?'元素':'图层'}及分组 · ${(file.size/1024/1024).toFixed(1)} MB`);else{clearPreview(false);status('已读取画面结构 · 预览暂不可用，可选择其他图层');}}
    } catch(error) {
      if(generation!==state.generation)return;
      owner.status='failed';setLoading(false); status(`打开失败 · ${error.message}`); toast(error.message,true);
      if(!state.doc)clearPreview();
    }
  }
  function renderTabs(){
    const host=$('document-tabs');
    if(!sessions.length){host.innerHTML='<span id="document-tab" class="document-tabs-empty">未打开文件</span>';return;}
    host.innerHTML=sessions.map(session=>{
      const active=session===activeSession,label=session.status==='queued'?'等待打开':session.status==='loading'?'正在打开':session.status==='failed'?'打开失败':'';
      return `<div class="document-tab-item ${active?'active ':''}${session.status}" data-document-id="${session.id}"><button type="button" class="document-tab-button" role="tab" aria-label="${esc(session.name)}" aria-selected="${active}" aria-controls="canvas-viewport" tabindex="${active?0:-1}" title="${esc(session.name)}${label?' · '+label:''}"><svg class="icon" aria-hidden="true"><use href="#i-file"/></svg><span ${active?'id="document-tab" ':''}class="document-tab-name">${esc(session.name)}</span></button><button type="button" class="document-tab-close" aria-label="关闭 ${esc(session.name)}" title="关闭 ${esc(session.name)}">×</button></div>`;
    }).join('');
  }
  function invalidateExport(){
    exportState.epoch++;exportState.previewSequence++;clearTimeout(exportState.previewTimer);
    exportState.previewBusy=false;exportState.previewAgain=false;exportState.busy=false;exportState.snapshot=null;
    if($('export-dialog').open)$('export-dialog').close();
  }
  function pauseSession(){
    if(!activeSession)return;
    const owner=activeSession;
    flushViewTransform();
    owner.ui={...owner.ui,mode:$('mode-select').value,search:$('layer-search').value,scroll:list.scrollTop,dimensions:$('status-dimensions').textContent,status:$('status-text').textContent,fitNext};
    owner.dirty=renderBusy||renderAgain||owner.dirty||state.compareOriginal;
    if(state.frame&&!canvas.hidden&&!state.compareOriginal){
      owner.preview||=document.createElement('canvas');owner.preview.width=canvas.width;owner.preview.height=canvas.height;
      owner.preview.getContext('2d').drawImage(canvas,0,0);
    }
    if(state.compareOriginal){state.frame=null;if(owner.preview)owner.preview.width=owner.preview.height=1;owner.preview=null;}
    state.compareOriginal=false;state.adjusting=false;state.presetToken++;state.presetThumbBusy=false;
    clearTimeout(filterTimer);filterTimer=null;
    state.generation=++generationClock;state.renderToken++;state.space=false;
    state.thumbBusy=false;state.thumbPending.clear();state.thumbQueue=[];
    clearTimeout(svgResolutionTimer);clearTimeout(loadingDelay);clearTimeout(renderDelay);
    if(viewRaf){cancelAnimationFrame(viewRaf);viewRaf=0;}
    drag=null;cancelPick();pickCycle=null;invalidateExport();
    renderBusy=false;renderAgain=false;renderPromise=null;renderFeedback(false);
  }
  function activateSession(owner,{force=false}={}){
    if(!owner||owner.closed)return false;
    if(owner===activeSession)return true;
    if(state.loading&&!force){toast('正在打开文件，完成后即可切换标签。');return false;}
    pauseSession();
    activeSession=owner;state=owner.state;state.generation=++generationClock;state.space=false;state.loading=false;
    state.thumbBusy=false;state.thumbPending.clear();state.thumbQueue=[];
    documentAdapter=owner.adapter;fitNext=owner.ui.fitNext??true;viewGeometry=null;
    renderTabs();setDocumentLabels(state.doc?.format||'psd');
    $('mode-select').value=owner.ui.mode||'original';$('layer-search').value=owner.ui.search||'';
    $('status-dimensions').textContent=owner.ui.dimensions||'';$('layer-count').textContent=String(state.doc?.count||0);
    if(state.frame&&owner.preview){
      state.frame={...state.frame,generation:state.generation};
      canvas.width=owner.preview.width;canvas.height=owner.preview.height;context.drawImage(owner.preview,0,0);
      canvas.hidden=false;paper.hidden=false;viewport.classList.add('has-document');$('empty-state').hidden=true;updateTransform();
    }else clearPreview();
    setLoading(false);showWarnings(owner.ui.warnings||state.doc?.warnings||[]);
    updateRows();list.scrollTop=owner.ui.scroll||0;drawRows();updateInspector();updateBounds();setTool(state.tool);
    status(owner.ui.status||(owner.status==='queued'?'等待打开文件…':'请选择图层查看'));
    $('document-tabs').querySelector('.active')?.scrollIntoView({block:'nearest',inline:'nearest'});
    if(owner.dirty&&state.doc){owner.dirty=false;render();}
    if(state.doc?.format==='image')ensureFilterThumbnails();
    return true;
  }
  function disposeSession(owner){
    owner.closed=true;owner.state.generation=++generationClock;owner.readController?.abort();owner.readController=null;owner.adapter?.dispose();owner.adapter=null;
    owner.worker?.terminate();owner.worker=null;
    if(owner.workerUrl)URL.revokeObjectURL(owner.workerUrl);owner.workerUrl=null;
    for(const pending of owner.requests.values())pending.reject(new Error('文档已关闭'));
    owner.requests.clear();
    for(const bitmap of owner.state.thumbs.values())bitmap.close();
    owner.state.thumbs.clear();owner.state.thumbPending.clear();owner.state.thumbQueue=[];
    owner.state.presetToken++;for(const bitmap of owner.state.presetThumbnails.values())bitmap.close();owner.state.presetThumbnails.clear();
    if(owner.preview)owner.preview.width=owner.preview.height=1;
    owner.preview=null;owner.file=null;owner.state.doc=null;owner.state.layers.clear();owner.state.frame=null;
  }
  function closeSession(owner){
    const index=sessions.indexOf(owner);if(index<0)return;
    const active=owner===activeSession;
    if(active){pauseSession();activeSession=null;documentAdapter=null;}
    sessions.splice(index,1);disposeSession(owner);renderTabs();
    if(active){
      const next=sessions[Math.min(index,sessions.length-1)];
      if(next)activateSession(next,{force:true});
      else{state=createState();renderTabs();resetDocument();setTool('select');status('就绪 · 可继续打开文件');}
    }
  }
  async function drainImports(){
    if(importBusy)return;importBusy=true;
    try{
      let next;
      while((next=sessions.find(session=>session.status==='queued'&&!session.closed))){
        activateSession(next,{force:true});
        try{await openDocument(next);}catch(error){
          if(!next.closed){next.status='failed';if(next===activeSession){setLoading(false);clearPreview();status(`打开失败 · ${error.message}`);toast(error.message,true);}}
        }
        renderTabs();
      }
    }finally{importBusy=false;}
  }
  function openFiles(files){
    let added=0,existing=null;const rejected=[];
    for(const file of Array.from(files||[])){
      if(file.size>768*1024*1024){rejected.push(`${file.name} 超过 768 MB`);continue;}
      if(!fileKind(file)){rejected.push(file.name);continue;}
      const key=`${file.name}\0${file.size}\0${file.lastModified}\0${file.type}`;
      const duplicate=sessions.find(session=>session.key===key&&session.status!=='failed');
      if(duplicate){existing=duplicate;continue;}
      sessions.push({id:`document-${++documentSequence}`,name:file.name,key,file,status:'queued',state:createState(),requests:new Map(),worker:null,workerUrl:null,adapter:null,preview:null,dirty:false,closed:false,ui:{mode:'original',search:'',scroll:0,warnings:[],fitNext:true}});added++;
    }
    renderTabs();
    if(rejected.length)toast(`未导入：${rejected.slice(0,3).join('、')}${rejected.length>3?'等':''}。当前公开版支持 PSD、PSB、SVG 和普通图片。`,true);
    if(added)drainImports();else if(existing)activateSession(existing);
  }
  function setDocumentLabels(format){
    const isSvg=format==='svg',isImage=format==='image';
    const select=$('mode-select');select.querySelector('[value="original"]').textContent=isSvg?'原始 SVG':isImage?'原图':'原始合成';select.querySelector('[value="composite"]').textContent=isImage?'调整后':isSvg?'当前显隐':'图层合成';select.querySelector('[value="layer"]').textContent=isSvg?'当前元素':isImage?'当前图片':'当前图层';
    document.querySelector('.layers-panel .panel-title h2').textContent=isSvg?'元素':'图层';
    $('layer-search').placeholder=isSvg?'搜索元素名称…':'搜索图层名称…';$('layer-search').setAttribute('aria-label',isSvg?'搜索元素名称':'搜索图层名称');
    list.setAttribute('aria-label',isSvg?'SVG 元素树':'PSD 图层树');
    syncAdjustments();
  }
  function params() {
    const vector=state.doc?.format==='svg',layer=$('mode-select').value==='layer'?state.layers.get(state.selected):null;
    const edge=Math.max(layer?.width||state.doc?.width||1,layer?.height||state.doc?.height||1);
    const scale=vector&&!fitNext?Math.max(.05,Math.min(8,state.zoom*(window.devicePixelRatio||1))):1;
    return {mode:$('mode-select').value,layerId:state.selected,hiddenIds:[...state.hidden],soloId:state.solo,maxSize:vector?Math.min(4096,Math.max(1200,Math.ceil(edge*scale))):state.doc?.format==='image'&&state.adjusting?1200:2200,...(vector?{renderScale:scale}:{}),...(state.doc?.format==='image'?{adjustments:{...state.adjustments}}:{})};
  }
  function scheduleSvgResolution(){
    if(state.doc?.format!=='svg'||!state.frame||state.loading)return;
    clearTimeout(svgResolutionTimer);
    svgResolutionTimer=setTimeout(()=>{
      if(state.doc?.format!=='svg'||!state.frame||renderBusy)return;
      const wanted=Math.min(4096,Math.max(state.frame.width,state.frame.height)*Math.min(8,state.zoom*(window.devicePixelRatio||1)));
      if(wanted>Math.max(canvas.width,canvas.height)*1.2)render();
    },130);
  }
  function render() {
    if(!state.doc)return Promise.resolve(false);
    if($('mode-select').value==='layer'&&(!state.selected||previewIssue(state.layers.get(state.selected)))){
      $('mode-select').value=state.frame?.source==='composite'?'composite':'original';state.solo=null;
      if($('mode-select').value==='original')state.hidden=new Set(state.initialHidden);
      drawRows();updateInspector();
    }
    cancelPick(); pickCycle=null;
    state.renderToken++;renderAgain=true;
    if(renderPromise)return renderPromise;
    const generation=state.generation;renderBusy=true;renderFeedback(true);
    renderPromise=(async()=>{
      let committed=false;
      try{
        while(renderAgain&&generation===state.generation){
          renderAgain=false;const token=state.renderToken,renderParams={...params(),...(state.doc.format==='image'?{previewBypass:state.compareOriginal}:{})};status('正在生成预览…');if(state.doc.format==='image')updateFilterStatus(true);
          try{
            const response=await request('render',renderParams);
            await new Promise(resolve=>{const fallback=setTimeout(resolve,80);requestAnimationFrame(()=>{clearTimeout(fallback);resolve();});});
            if(token!==state.renderToken||generation!==state.generation){response.bitmap?.close();continue;}
            canvas.width=response.width;canvas.height=response.height;
            context.drawImage(response.bitmap,0,0);response.bitmap.close();
            state.frame={width:response.documentWidth||response.width,height:response.documentHeight||response.height,originX:response.originX||0,originY:response.originY||0,source:response.source,revision:token,generation,layerId:renderParams.layerId,hiddenIds:renderParams.hiddenIds,soloId:renderParams.soloId,filterRevision:state.filterRevision};
            showWarnings([...(state.doc.warnings||[]),...(response.warnings||[])]);
            if(fitNext){fitNext=false;fit();}else updateTransform();
            canvas.hidden=false;paper.hidden=false;viewport.classList.add('has-document');$('empty-state').hidden=true;committed=true;
            if(state.doc.format==='image'){
              activeSession.dirty=false;updateFilterStatus();
              if(!state.adjusting&&state.imageThumbRevision!==state.filterRevision){state.imageThumbRevision=state.filterRevision;refreshImageThumbnail();}
            }
            status(state.doc.format==='svg'?(response.source==='layer'?'SVG 单元素预览':'SVG 矢量预览 · 点击图形可选中元素'):state.doc.format==='image'?(state.compareOriginal||renderParams.mode==='original'?'原图预览 · 文件保留在本机':`图片调整 · ${filterLabel()} · 强度 ${state.adjustments.strength}%`):(response.source==='original'?'原始合成预览 · 保留文件保存时的画面':response.source==='layer'?'单层预览 · 按图层自身范围显示':'图层合成预览 · 以当前显隐状态生成'));
          }catch(error){if(generation===state.generation&&token===state.renderToken){toast(error.message,true);status('预览更新失败 · 可继续查看图层结构');}}
        }
      }finally{
        if(generation===state.generation){renderBusy=false;renderPromise=null;renderFeedback(false);processThumbs();if(state.doc?.format==='image'){updateFilterStatus();ensureFilterThumbnails();}}
      }
      return committed&&state.frame?.generation===generation;
    })();
    return renderPromise;
  }
  function showWarnings(warnings) {
    const unique=[...new Set(warnings.filter(Boolean))];
    if(activeSession)activeSession.ui.warnings=unique;
    const area=$('notice-area'); area.hidden=!unique.length;
    area.innerHTML=unique.length?`<details><summary>${esc(unique[0])}${unique.length>1?` <span>另 ${unique.length-1} 项</span>`:''}</summary><ul>${unique.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>`:'';
  }
  function effectiveHidden(id) {
    let current=id;
    while(current){if(state.hidden.has(current))return true;current=state.parents.get(current);}
    return false;
  }
  function updateRows() {
    const query=$('layer-search').value.trim().toLowerCase();
    function matches(node) {return node.name.toLowerCase().includes(query)||(node.children||[]).some(matches);}
    const rows=[];
    function visit(nodes,depth=0) { for(const node of [...(nodes||[])].reverse()){
      if(query&&!matches(node))continue;
      rows.push({node,depth});
      if(node.children&&(query||state.expanded.has(node.id)))visit(node.children,depth+1);
    }}
    visit(state.doc?.children);
    state.rows=rows; spacer.style.height=`${rows.length*rowHeight}px`;
    drawRows();
    if(!rows.length)rowHost.innerHTML=`<p class="layers-empty">${query?'没有匹配的图层':'打开文件后，结构将在这里显示'}</p>`;
  }
  const eyeSvg='<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z"/><circle cx="10" cy="10" r="2.2"/></svg>';
  function drawRows() {
    if(!state.rows.length)return;
    const start=Math.max(0,Math.floor(list.scrollTop/rowHeight)-3), end=Math.min(state.rows.length,start+Math.ceil(list.clientHeight/rowHeight)+7);
    const fragment=document.createDocumentFragment();
    for(let i=start;i<end;i++){
      const {node,depth}=state.rows[i], row=document.createElement('div');
      row.className=`layer-row${node.id===state.selected?' selected':''}${effectiveHidden(node.id)?' is-hidden':''}${node.type==='group'?' is-group':''}`;
      row.dataset.id=node.id; row.style.cssText=`position:absolute;left:0;right:0;top:${i*rowHeight}px;height:${rowHeight}px;--depth:${depth}`;
      row.setAttribute('role','treeitem'); row.setAttribute('aria-selected',String(node.id===state.selected)); row.setAttribute('aria-level',String(depth+1));
      if(node.children)row.setAttribute('aria-expanded',String(state.expanded.has(node.id)));
      row.tabIndex=node.id===state.selected||(!state.selected&&i===0)?0:-1;
      row.innerHTML=`<button class="layer-eye ${state.hidden.has(node.id)?'off':''}" data-action="eye" aria-label="${state.hidden.has(node.id)?'显示':'隐藏'} ${esc(node.name)}" aria-pressed="${!state.hidden.has(node.id)}" title="点击显隐；Alt + 点击单独显示">${eyeSvg}</button><button class="layer-toggle" data-action="toggle" ${node.children?'':'disabled'} aria-label="${state.expanded.has(node.id)?'折叠':'展开'} ${esc(node.name)}">${node.children?(state.expanded.has(node.id)?'⌄':'›'):''}</button><span class="layer-thumb"><canvas width="40" height="32" aria-hidden="true"></canvas><span class="layer-type">${symbols[node.type]||'▧'}</span></span><span class="layer-name" title="${esc(node.name)}">${esc(node.name)}</span><span class="layer-badges">${node.clipping?'↳':''}${node.hasMask?'◧':''}${node.hasEffects?'ƒ':''}${state.solo===node.id?'●':''}</span>`;
      const thumb=state.thumbs.get(node.id);
      if(thumb){const c=row.querySelector('canvas');const ratio=Math.min(38/thumb.width,30/thumb.height);c.getContext('2d').drawImage(thumb,(40-thumb.width*ratio)/2,(32-thumb.height*ratio)/2,thumb.width*ratio,thumb.height*ratio);row.querySelector('.layer-type').hidden=true;}
      else if(node.hasPixels&&!state.thumbPending.has(node.id)){
        state.thumbPending.add(node.id);state.thumbQueue.push({id:node.id,generation:state.generation});
      }
      fragment.appendChild(row);
    }
    rowHost.replaceChildren(fragment); processThumbs();
  }
  async function processThumbs(){
    if(state.thumbBusy||renderBusy||state.loading||state.picking||!state.thumbQueue.length||!state.doc)return;
    state.thumbBusy=true;const item=state.thumbQueue.shift();
    try{
      const filterRevision=state.filterRevision,result=await request('thumbnail',{layerId:item.id,...(state.doc.format==='image'?{adjustments:{...state.adjustments}}:{})});
      if(item.generation!==state.generation||filterRevision!==state.filterRevision){result.bitmap?.close();if(item.generation===state.generation)state.thumbPending.delete(item.id);return;}
      if(result.bitmap){
        state.thumbs.set(item.id,result.bitmap);
        if(state.thumbs.size>160){const oldest=state.thumbs.keys().next().value;state.thumbs.get(oldest).close();state.thumbs.delete(oldest);state.thumbPending.delete(oldest);}
        const row=[...rowHost.children].find(el=>el.dataset.id===item.id);
        if(row){const c=row.querySelector('canvas'),t=result.bitmap,ratio=Math.min(38/t.width,30/t.height);c.getContext('2d').drawImage(t,(40-t.width*ratio)/2,(32-t.height*ratio)/2,t.width*ratio,t.height*ratio);row.querySelector('.layer-type').hidden=true;}
      }
    }catch{/* A missing thumbnail must never hide a layer. */}
    finally{if(item.generation===state.generation){state.thumbBusy=false;processThumbs();}}
  }
  function selectLayer(id,options={}) {
    if(!options.fromCanvas){cancelPick();pickCycle=null;}
    const changed=state.selected!==id;
    state.selected=id; const node=state.layers.get(id); if(!node)return;
    if(options.reveal){
      for(let parent=state.parents.get(id);parent;parent=state.parents.get(parent))state.expanded.add(parent);
      updateRows();
      if(!state.rows.some(row=>row.node.id===id)){$('layer-search').value='';updateRows();}
      const index=state.rows.findIndex(row=>row.node.id===id);
      if(index>=0)list.scrollTop=Math.max(0,index*rowHeight-(list.clientHeight-rowHeight)/2);
    }
    drawRows();updateInspector(); updateBounds();
    if($('mode-select').value==='layer'&&(!options.fromCanvas||changed)){fitNext=true;render();}
  }
  function updateInspector(){
    const n=state.layers.get(state.selected);if(!n){$('inspector').innerHTML='<p class="inspector-empty">选择图层，查看详细信息</p>';return;}
    const kind=names[n.type]||n.type,issue=previewIssue(n);
    const props=[['类型',kind],['尺寸',`${n.width} × ${n.height} px`],['位置',`X ${n.left} · Y ${n.top}`],['不透明度',`${Math.round(n.opacity*100)}%`],['混合模式',blendNames[n.blendMode]||n.blendMode],['可见状态',effectiveHidden(n.id)?'隐藏':'可见'],['蒙版',n.hasMask?'有':'无']];
    if(n.font)props.push(['字体',n.font]);
    if(n.svgTag)props.push(['SVG 元素',`<${n.svgTag}>`]);
    if(n.svgId)props.push(['元素 ID',n.svgId]);
    if(n.adjustmentType)props.push(['调整类型',n.adjustmentType]);
    $('inspector').innerHTML=`<div class="inspector-title"><span class="type-chip">${esc(kind)}</span><strong>${esc(n.name)}</strong></div><dl class="property-grid">${props.map(([k,v])=>`<dt class="property-label">${esc(k)}</dt><dd class="property-value">${esc(v)}</dd>`).join('')}</dl>${n.text?`<label class="property-label">文字内容</label><textarea class="text-content" readonly aria-label="图层文字内容">${esc(n.text)}</textarea>`:''}${issue?`<p class="inspector-note">${esc(issue)}</p>`:!n.hasPixels&&n.type!=='group'?'<p class="inspector-note">此图层没有独立像素缓存，保留其结构和属性。</p>':''}${n.type==='smart'&&!n.svgTag?'<p class="inspector-note">显示当前 PSD 中的缓存画面。智能对象内部文件尚未展开。</p>':''}<div class="inspector-actions"><button class="secondary-button" data-action="preview-layer"${issue?' disabled':''}>单独预览</button><button class="secondary-button" data-action="export-layer"${issue?' disabled':''}>导出此${state.doc.format==='svg'?'元素':'层'}图片</button></div>`;
  }
  function toggleVisibility(id,solo=false){
    if(solo){state.solo=state.solo===id?null:id;state.selected=id;$('mode-select').value=state.solo?'layer':'composite';fitNext=true;}
    else{state.solo=null;state.hidden.has(id)?state.hidden.delete(id):state.hidden.add(id);$('mode-select').value='composite';}
    drawRows();updateInspector();render();
  }
  function cancelPick(){pickToken++;state.picking=false;viewport.classList.remove('is-picking');}
  function clearSelection(){state.selected=null;drawRows();updateInspector();updateBounds();}
  async function pickAt(clientX,clientY,cycle=false){
    const frame=state.frame;if(!frame||state.loading||renderBusy)return;
    const bounds=canvas.getBoundingClientRect();
    if(clientX<bounds.left||clientX>=bounds.right||clientY<bounds.top||clientY>=bounds.bottom){
      cancelPick();pickCycle=null;clearSelection();status('未选中图层 · 点击画布中的图形选层');return;
    }
    const x=frame.originX+(clientX-bounds.left)/bounds.width*frame.width;
    const y=frame.originY+(clientY-bounds.top)/bounds.height*frame.height;
    const generation=state.generation,token=++pickToken;
    state.picking=true;viewport.classList.add('is-picking');status('正在定位图层…');
    try{
      const previous=pickCycle;
      const samePoint=previous&&previous.revision===frame.revision&&Math.hypot(x-previous.x,y-previous.y)*state.zoom<4;
      const result=samePoint?previous.result:await request('hitTest',{
        x,y,mode:frame.source,layerId:frame.layerId,hiddenIds:frame.source==='original'?[...state.initialHidden]:frame.hiddenIds,soloId:frame.soloId
      });
      if(token!==pickToken||generation!==state.generation||frame!==state.frame)return;
      if(result.warnings?.length)showWarnings([...(state.doc.warnings||[]),...result.warnings]);
      const candidates=result.candidates||[];
      if(!candidates.length){pickCycle=null;clearSelection();status('此处没有可选图层');return;}
      const index=cycle&&samePoint?(previous.index+1)%candidates.length:0;
      pickCycle={x,y,revision:frame.revision,result,index};
      const selected=candidates[index];
      selectLayer(selected.id,{reveal:true,fromCanvas:true});
      status(`已选中：${selected.name}${candidates.length>1?` · ${index+1}/${candidates.length}，Alt + 点击切换重叠图层`:''}`);
    }catch(error){if(token===pickToken&&generation===state.generation){toast(error.message,true);status('图层定位失败，可从右侧选择');}}
    finally{if(token===pickToken){state.picking=false;viewport.classList.remove('is-picking');processThumbs();}}
  }
  function updateTransform(){
    const f=state.frame;if(!f){$('zoom-label').textContent='—';return;}
    const dpr=window.devicePixelRatio||1,width=f.width*state.zoom,height=f.height*state.zoom;
    const left=Math.round(((viewportSize.width-width)/2+state.panX)*dpr)/dpr,top=Math.round(((viewportSize.height-height)/2+state.panY)*dpr)/dpr;
    viewGeometry={left,top,width,height};
    for(const surface of [paper,canvas]){
      if(surface.style.width!==`${width}px`)surface.style.width=`${width}px`;
      if(surface.style.height!==`${height}px`)surface.style.height=`${height}px`;
      surface.style.transform=`translate3d(${left}px,${top}px,0)`;
    }
    $('zoom-label').textContent=`${+(state.zoom*100).toFixed(1)}%`;
    updateBounds();
  }
  function queueViewTransform(){if(!viewRaf)viewRaf=requestAnimationFrame(()=>{viewRaf=0;updateTransform();});}
  function flushViewTransform(){if(viewRaf){cancelAnimationFrame(viewRaf);viewRaf=0;updateTransform();}}
  function updateBounds(){
    const f=state.frame,n=state.layers.get(state.selected);
    if(!f||!n||f.source==='layer'||!n.width||!n.height){overlay.style.display='none';return;}
    if(!viewGeometry){overlay.style.display='none';return;}
    Object.assign(overlay.style,{display:'block',left:'0',top:'0',transform:`translate3d(${viewGeometry.left+(n.left-f.originX)*state.zoom}px,${viewGeometry.top+(n.top-f.originY)*state.zoom}px,0)`,width:`${n.width*state.zoom}px`,height:`${n.height*state.zoom}px`});
  }
  function fit(){if(!state.frame)return;state.zoom=Math.min((viewportSize.width-90)/state.frame.width,(viewportSize.height-90)/state.frame.height,1);state.zoom=Math.max(.005,state.zoom);state.panX=state.panY=0;updateTransform();}
  function zoom(factor,anchor){
    if(!state.frame)return;
    const previous=state.zoom;state.zoom=Math.max(.005,Math.min(16,state.zoom*factor));
    if(anchor){const x=anchor.x-viewportSize.width/2,y=anchor.y-viewportSize.height/2;state.panX=x-(x-state.panX)*state.zoom/previous;state.panY=y-(y-state.panY)*state.zoom/previous;}
    else {state.panX*=state.zoom/previous;state.panY*=state.zoom/previous;}
    queueViewTransform();
    scheduleSvgResolution();
  }
  function exportSettings(){
    if(!exportState.snapshot)throw new Error('请先打开导出设置');
    const layerOnly=$('export-scope').value==='layer';
    if(layerOnly&&!exportState.selectedId)throw new Error('请先选择一个图层');
    const enabled=$('watermark-enabled').checked,text=$('watermark-text').value.trim();
    if(enabled&&!text)throw new Error('请输入水印文字');
    return {
      ...exportState.snapshot,...(layerOnly?{mode:'layer',layerId:exportState.selectedId}:{}),
      format:$('export-format').value==='jpeg'?'jpeg':'png',
      quality:Number($('export-quality').value)/100,background:$('export-background').value,
      exportSize:Number($('export-size').value),
      watermark:{enabled,text,position:$('watermark-position').value,opacity:Number($('watermark-opacity').value)/100,size:Number($('watermark-size').value),color:$('watermark-color').value}
    };
  }
  function updateExportControls(){
    const jpeg=$('export-format').value==='jpeg';
    $('export-quality-row').hidden=!jpeg;$('export-background-row').hidden=!jpeg;
    $('export-quality-value').value=`${$('export-quality').value}%`;
    $('watermark-opacity-value').value=`${$('watermark-opacity').value}%`;
    $('watermark-size-value').value=`${$('watermark-size').value}%`;
    for(const input of $('export-form').querySelectorAll('input,select'))input.disabled=exportState.busy;
    $('watermark-settings').disabled=exportState.busy||!$('watermark-enabled').checked;
    $('watermark-text').required=$('watermark-enabled').checked;
    const layerOption=$('export-scope').querySelector('option[value="layer"]');
    layerOption.disabled=!exportState.selectedId;
    $('export-download').disabled=exportState.busy||exportState.canExport===false||($('export-scope').value==='layer'&&!exportState.selectedId);
    $('export-download').textContent=exportState.busy?'正在生成图片…':`导出 ${jpeg?'JPG':'PNG'}`;
    const spec=exportState.snapshot;
    if(!spec)return;
    const layerMode=$('export-scope').value==='layer'||spec.mode==='layer';
    const layer=state.layers.get(exportState.selectedId);
    let width=layerMode?layer?.width:state.doc?.width,height=layerMode?layer?.height:state.doc?.height;
    const edge=Number($('export-size').value),ratio=edge?Math.min(1,edge/Math.max(width||1,height||1)):1;
    width=Math.max(1,Math.round((width||1)*ratio));height=Math.max(1,Math.round((height||1)*ratio));
    $('export-details').textContent=`${width.toLocaleString()} × ${height.toLocaleString()} px · ${layerMode?'选中'+(state.doc?.format==='svg'?'元素':'图层'):state.doc?.format==='image'?(spec.mode==='original'?'原图':'调整后图片'):spec.mode==='original'?(state.doc?.format==='svg'?'原始 SVG':'原始合成'):'当前显隐画面'}`;
  }
  function scheduleExportPreview(immediate=false){
    if(!$('export-dialog').open||exportState.busy)return;
    exportState.previewSequence++;clearTimeout(exportState.previewTimer);
    exportState.canExport=null;
    updateExportControls();$('export-error').textContent='';
    $('export-preview-status').textContent='正在更新预览…';
    exportState.previewTimer=setTimeout(renderExportPreview,immediate?0:160);
  }
  async function renderExportPreview(){
    if(!$('export-dialog').open||exportState.busy)return;
    if(exportState.previewBusy){exportState.previewAgain=true;return;}
    const epoch=exportState.epoch,sequence=exportState.previewSequence;
    exportState.previewBusy=true;
    try{
      const settings=exportSettings();
      const result=await request('exportPreview',{...settings,maxSize:900});
      if(epoch!==exportState.epoch||sequence!==exportState.previewSequence||!$('export-dialog').open){result.bitmap?.close();return;}
      const preview=$('export-preview-canvas');preview.width=result.width||result.bitmap.width;preview.height=result.height||result.bitmap.height;
      const ctx=preview.getContext('2d');ctx.clearRect(0,0,preview.width,preview.height);ctx.drawImage(result.bitmap,0,0);result.bitmap.close();
      preview.hidden=false;
      exportState.canExport=result.canExport!==false;updateExportControls();
      $('export-preview-status').textContent=settings.watermark.enabled?'水印效果预览 · 导出时按所选尺寸生成':`${settings.format==='jpeg'?'JPG':'PNG'} 效果预览`;
      if(result.warnings?.length)$('export-error').textContent=result.warnings[0];
    }catch(error){if(epoch===exportState.epoch&&sequence===exportState.previewSequence){$('export-error').textContent=error.message;$('export-preview-status').textContent='预览尚未生成';}}
    finally{if(epoch===exportState.epoch){exportState.previewBusy=false;if(exportState.previewAgain){exportState.previewAgain=false;renderExportPreview();}}}
  }
  function openExport(layerOnly=false){
    if(!state.doc||state.loading||$('export-dialog').open)return;
    if(layerOnly&&!state.selected)return toast('请先选择一个图层');
    const issue=previewIssue(state.layers.get(state.selected));
    if(layerOnly&&issue){status(issue);return;}
    cancelPick();
    exportState.epoch++;exportState.snapshot=params();exportState.selectedId=issue?null:state.selected;
    exportState.baseName=state.doc.name.replace(/\.(psd|psb|svg|png|jpe?g|webp|gif|bmp|avif)$/i,'');
    exportState.busy=false;exportState.canExport=null;exportState.previewBusy=false;exportState.previewAgain=false;
    $('export-scope').value=layerOnly||$('mode-select').value==='layer'?'layer':'current';
    $('export-scope').querySelector('option[value="layer"]').textContent=state.selected?`选中图层：${state.layers.get(state.selected).name}${issue?'（仅属性）':''}`:'选中图层（请先选择）';
    $('export-preview-canvas').hidden=true;$('export-error').textContent='';
    updateExportControls();$('export-dialog').showModal();scheduleExportPreview(true);
  }
  async function downloadExport(event){
    event.preventDefault();
    if(exportState.busy||!$('export-dialog').open)return;
    let settings;try{settings=exportSettings();}catch(error){$('export-error').textContent=error.message;return;}
    const epoch=exportState.epoch,generation=state.generation;
    exportState.busy=true;clearTimeout(exportState.previewTimer);exportState.previewSequence++;
    updateExportControls();$('export-error').textContent='';$('export-preview-status').textContent='正在生成图片，可以取消返回…';
    try{
      const result=await request('export',settings);
      if(epoch!==exportState.epoch||generation!==state.generation||!$('export-dialog').open)return;
      const sourceName=$('export-scope').value==='layer'||settings.mode==='layer'?state.layers.get(exportState.selectedId)?.name||exportState.baseName:exportState.baseName;
      const name=state.doc.format==='image'?sourceName.replace(/\.(png|jpe?g|webp|gif|bmp|avif)$/i,''):sourceName;
      const extension=settings.format==='jpeg'?'jpg':'png';
      const url=URL.createObjectURL(result.blob),a=document.createElement('a');a.href=url;a.download=`${name.replace(/[\\/:*?"<>|]/g,'_')}${settings.watermark.enabled?'_水印':''}.${extension}`;
      if(state.doc.format==='image'&&settings.mode!=='original'&&!filters.isIdentity(settings.adjustments))a.download=a.download.replace(/\.(png|jpg)$/i,'_调整.$1');
      document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
      if(result.warnings?.length)showWarnings(result.warnings);
      $('export-dialog').close();toast(`${extension.toUpperCase()} 已生成，请查看浏览器下载`);
    }catch(error){if(epoch===exportState.epoch&&generation===state.generation){$('export-error').textContent=error.message;$('export-preview-status').textContent='导出失败，可调整设置后重试';}}
    finally{if(epoch===exportState.epoch){exportState.busy=false;updateExportControls();}}
  }
  async function loadDemo(){
    const raw=atob($('demo-psd-data').textContent.trim()),bytes=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    openFiles([new File([bytes],'形与感 · 示例.psd',{type:'image/vnd.adobe.photoshop',lastModified:0})]);
  }
  $('filter-presets').innerHTML=filters.PRESETS.map(preset=>`<button type="button" class="filter-preset" data-filter-preset="${esc(preset.id)}" aria-pressed="false" title="${esc(preset.description)}"><span class="filter-preset-preview"><canvas width="240" height="144" aria-hidden="true"></canvas><span class="filter-preset-placeholder" aria-hidden="true">预览</span></span><span class="filter-preset-name">${esc(preset.name)}</span>${preset.id==='portrait'?'<span class="filter-preset-note">轻微提亮 · 柔和暖调</span>':''}</button>`).join('');
  $('filter-presets').onclick=event=>{
    const button=event.target.closest('[data-filter-preset]');if(!button)return;
    const preset=filters.PRESETS.find(p=>p.id===button.dataset.filterPreset);if(preset)changeAdjustments(preset.settings,{presetId:preset.id});
  };
  for(const key of adjustKeys){
    const input=$(`adjust-${key}`);
    input.addEventListener('input',()=>changeAdjustments({...state.adjustments,[key]:Number(input.value)},{presetId:key==='strength'?state.presetId:null,interactive:true}));
    input.addEventListener('change',()=>{if(state.doc?.format==='image'){state.adjusting=false;scheduleFilterRender(true);}});
  }
  $('filter-reset').onclick=()=>changeAdjustments(filters.DEFAULTS,{reset:true});
  const compareButton=$('filter-compare');
  compareButton.addEventListener('pointerdown',event=>{if(event.button!==0||compareButton.disabled)return;event.preventDefault();compareButton.focus();try{compareButton.setPointerCapture(event.pointerId);}catch{}compareOriginal(true);});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])compareButton.addEventListener(type,()=>compareOriginal(false));
  compareButton.addEventListener('keydown',event=>{if([' ','Enter'].includes(event.key)){event.preventDefault();event.stopPropagation();compareOriginal(true);}});
  compareButton.addEventListener('keyup',event=>{if([' ','Enter'].includes(event.key)){event.preventDefault();event.stopPropagation();compareOriginal(false);}});
  compareButton.addEventListener('blur',()=>compareOriginal(false));
  for(const key of ['layers','adjust']){
    const tab=$(`sidebar-${key}-tab`);tab.onclick=()=>setSidebarTab(key);
    tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||state.doc?.format!=='image')return;event.preventDefault();const next=event.key==='Home'?'layers':event.key==='End'?'adjust':key==='layers'?'adjust':'layers';setSidebarTab(next);$(`sidebar-${next}-tab`).focus();});
  }
  $('open-btn').onclick=()=>$('file-input').click();
  $('canvas-background-select').onchange=e=>{canvasPreferences.background=e.target.value;applyCanvasPreferences(true);};
  $('checker-size-select').onchange=e=>{canvasPreferences.grid=e.target.value;applyCanvasPreferences(true);};
  $('canvas-settings-popover').addEventListener('beforetoggle',e=>{
    if(e.newState!=='open')return;
    const popover=e.currentTarget,button=$('canvas-settings-btn').getBoundingClientRect();
    const width=Math.min(240,window.innerWidth-24);
    popover.style.width=`${width}px`;popover.style.right='auto';
    popover.style.left=`${Math.max(12,Math.min(button.right-width,window.innerWidth-width-12))}px`;
    popover.style.top=`${Math.max(12,Math.min(button.bottom+6,window.innerHeight-235))}px`;
  });
  $('file-input').onchange=e=>{openFiles(e.target.files);e.target.value='';};
  $('document-tabs').addEventListener('click',e=>{
    const tab=e.target.closest('.document-tab-item');if(!tab)return;
    const owner=sessions.find(session=>session.id===tab.dataset.documentId);
    if(e.target.closest('.document-tab-close'))closeSession(owner);
    else if(e.target.closest('.document-tab-button'))activateSession(owner);
  });
  $('document-tabs').addEventListener('keydown',e=>{
    if(!e.target.closest('.document-tab-button')||!['ArrowLeft','ArrowRight','Home','End','Delete'].includes(e.key))return;
    e.preventDefault();const index=sessions.indexOf(activeSession);
    if(e.key==='Delete')closeSession(activeSession);
    else activateSession(sessions[e.key==='Home'?0:e.key==='End'?sessions.length-1:(index+(e.key==='ArrowRight'?1:-1)+sessions.length)%sessions.length]);
    $('document-tabs').querySelector('[aria-selected="true"]')?.focus();
  });
  $('demo-btn').onclick=loadDemo;
  document.querySelectorAll('[data-action="open"]').forEach(el=>el.onclick=()=>$('file-input').click());
  document.querySelectorAll('[data-action="demo"]').forEach(el=>el.onclick=loadDemo);
  $('export-btn').onclick=()=>openExport();
  $('export-form').addEventListener('submit',downloadExport);
  $('export-form').addEventListener('input',()=>scheduleExportPreview());
  $('export-form').addEventListener('change',()=>scheduleExportPreview());
  for(const id of ['export-close','export-cancel'])$(id).onclick=()=>$('export-dialog').close();
  $('export-dialog').addEventListener('close',()=>{exportState.epoch++;exportState.previewSequence++;clearTimeout(exportState.previewTimer);exportState.busy=false;exportState.previewBusy=false;exportState.previewAgain=false;exportState.snapshot=null;});
  $('cancel-btn').onclick=()=>{if(activeSession)closeSession(activeSession);};
  $('mode-select').onchange=()=>{
    if($('mode-select').value==='original'){state.hidden=new Set(state.initialHidden);state.solo=null;drawRows();updateInspector();}
    if($('mode-select').value==='layer'&&!state.selected){const first=state.rows.find(r=>r.node.type!=='group'&&!previewIssue(r.node));if(first)selectLayer(first.node.id);}
    fitNext=true;render();
  };
  $('layer-search').oninput=()=>{list.scrollTop=0;updateRows();};
  list.addEventListener('scroll',()=>requestAnimationFrame(drawRows));
  list.addEventListener('click',e=>{
    const row=e.target.closest('.layer-row');if(!row)return;const id=row.dataset.id,action=e.target.closest('[data-action]')?.dataset.action;
    if(action==='eye')toggleVisibility(id,e.altKey);
    else if(action==='toggle'){state.expanded.has(id)?state.expanded.delete(id):state.expanded.add(id);updateRows();}
    else selectLayer(id);
  });
  list.addEventListener('dblclick',e=>{const row=e.target.closest('.layer-row');if(!row||e.target.closest('button'))return;selectLayer(row.dataset.id);$('mode-select').value='layer';fitNext=true;render();});
  list.addEventListener('keydown',e=>{
    if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Enter',' '].includes(e.key))return;
    const index=state.rows.findIndex(r=>r.node.id===state.selected),n=state.layers.get(state.selected);e.preventDefault();
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){const row=state.rows[Math.max(0,Math.min(state.rows.length-1,index+(e.key==='ArrowDown'?1:-1)))];if(row){selectLayer(row.node.id);const idx=state.rows.indexOf(row);if(idx*rowHeight<list.scrollTop)list.scrollTop=idx*rowHeight;else if((idx+1)*rowHeight>list.scrollTop+list.clientHeight)list.scrollTop=(idx+1)*rowHeight-list.clientHeight;}}
    else if(e.key===' '&&n)toggleVisibility(n.id);
    else if(n?.children){e.key==='ArrowLeft'?state.expanded.delete(n.id):state.expanded.add(n.id);updateRows();}
    rowHost.querySelector('.selected')?.focus({preventScroll:true});
  });
  $('collapse-all').onclick=()=>{state.expanded.clear();updateRows();};
  $('expand-all').onclick=()=>{for(const n of state.layers.values())if(n.children)state.expanded.add(n.id);updateRows();};
  $('inspector').onclick=e=>{const action=e.target.closest('[data-action]')?.dataset.action;if(action==='preview-layer'){$('mode-select').value='layer';fitNext=true;render();}if(action==='export-layer')openExport(true);};
  $('fit-btn').onclick=fit; $('actual-btn').onclick=()=>{state.zoom=1;state.panX=state.panY=0;updateTransform();scheduleSvgResolution();};
  $('zoom-in').onclick=()=>zoom(1.25);$('zoom-out').onclick=()=>zoom(.8);
  function restoreCursor(){viewport.style.cursor=state.space||state.tool==='hand'?'grab':state.tool==='zoom'?'zoom-in':'default';}
  function setTool(tool){state.tool=tool;for(const kind of ['select','hand','zoom']){$('tool-'+kind).classList.toggle('active',tool===kind);$('tool-'+kind).setAttribute('aria-pressed',String(tool===kind));}restoreCursor();}
  $('tool-select').onclick=()=>setTool('select');$('tool-hand').onclick=()=>setTool('hand');$('tool-zoom').onclick=()=>setTool('zoom');
  let drag;
  viewport.addEventListener('pointerdown',e=>{
    if(!state.frame||state.loading||e.target.closest('button,select,input,details')||![0,1].includes(e.button))return;
    viewport.focus({preventScroll:true});
    if(state.tool==='zoom'&&!state.space&&e.button===0){const rect=viewport.getBoundingClientRect();zoom(e.altKey ? .8 : 1.25,{x:e.clientX-rect.left,y:e.clientY-rect.top});return;}
    e.preventDefault();
    drag={x:e.clientX,y:e.clientY,panX:state.panX,panY:state.panY,pointerId:e.pointerId,moved:false,canSelect:state.tool==='select'&&!state.space&&e.button===0,cycle:e.altKey};viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener('pointermove',e=>{if(!drag||drag.pointerId!==e.pointerId)return;if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>4)drag.moved=true;if(!drag.moved)return;state.panX=drag.panX+e.clientX-drag.x;state.panY=drag.panY+e.clientY-drag.y;viewport.style.cursor='grabbing';queueViewTransform();});
  viewport.addEventListener('pointerup',e=>{const gesture=drag;drag=null;flushViewTransform();restoreCursor();if(gesture&&gesture.pointerId===e.pointerId&&gesture.canSelect&&!gesture.moved)pickAt(e.clientX,e.clientY,gesture.cycle);});
  viewport.addEventListener('pointercancel',()=>{drag=null;restoreCursor();});
  viewport.addEventListener('wheel',e=>{if(!state.frame)return;e.preventDefault();const rect=viewport.getBoundingClientRect();if(e.ctrlKey||e.metaKey||state.tool==='zoom')zoom(Math.exp(-e.deltaY*.005),{x:e.clientX-rect.left,y:e.clientY-rect.top});else{state.panX-=e.deltaX;state.panY-=e.deltaY;queueViewTransform();}},{passive:false});
  let dragDepth=0;
  document.addEventListener('dragenter',e=>{e.preventDefault();if(e.dataTransfer.types.includes('Files')){dragDepth++;document.body.classList.add('file-drag');}});
  document.addEventListener('dragover',e=>{e.preventDefault();});
  document.addEventListener('dragleave',e=>{e.preventDefault();if(--dragDepth<=0){dragDepth=0;document.body.classList.remove('file-drag');}});
  document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;document.body.classList.remove('file-drag');openFiles(e.dataTransfer.files);});
  $('help-btn').onclick=()=>$('help-dialog').showModal();$('help-close').onclick=()=>$('help-dialog').close();
  document.addEventListener('keydown',e=>{
    if(e.target.matches('input,textarea,select')||$('help-dialog').open||$('export-dialog').open)return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='o'){e.preventDefault();$('file-input').click();}
    else if(['+','=','-','0','1','v','h','z',' '].includes(e.key.toLowerCase())&&!e.ctrlKey&&!e.metaKey){
      e.preventDefault();
      if(e.key==='+'||e.key==='=')zoom(1.25);if(e.key==='-')zoom(.8);if(e.key==='0')fit();if(e.key==='1')$('actual-btn').click();
      if(e.key.toLowerCase()==='v')setTool('select');if(e.key.toLowerCase()==='h')setTool('hand');if(e.key.toLowerCase()==='z')setTool('zoom');if(e.key===' '){state.space=true;restoreCursor();}
    }
  });
  document.addEventListener('keyup',e=>{if(e.key===' '){state.space=false;restoreCursor();}});
  window.addEventListener('blur',()=>{state.space=false;drag=null;restoreCursor();compareOriginal(false);});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)compareOriginal(false);});
  new ResizeObserver(entries=>{viewportSize.width=entries[0].contentRect.width;viewportSize.height=entries[0].contentRect.height;updateTransform();drawRows();}).observe(viewport);
  new ResizeObserver(()=>drawRows()).observe(list);
  restoreCanvasPreferences();
  try{resetDocument();setTool('select');status('就绪 · 所有文件均在本机处理');}catch(error){toast(error.message,true);}
})();
