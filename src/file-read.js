/* Read user-selected files in the page, before crossing the worker boundary. */
(() => {
  'use strict';
  const aborted=()=>Object.assign(new Error('文件读取已取消。'),{name:'AbortError',code:'LOCAL_FILE_ABORTED'});
  const unreadable=cause=>Object.assign(new Error('无法读取本机文件（I/O）。请重新选择文件；若文件在云盘、移动硬盘或聊天附件中，请先完整下载并复制到本机文件夹后再打开。'),{code:'LOCAL_FILE_READ_FAILED',cause});
  function firstRead(file,signal){
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',onAbort);error?reject(error):resolve(value);};
      const onAbort=()=>finish(aborted());
      signal?.addEventListener('abort',onAbort,{once:true});
      if(signal?.aborted){onAbort();return;}
      Promise.resolve().then(()=>{if(signal?.aborted)throw aborted();return file.arrayBuffer();}).then(value=>finish(null,value),error=>finish(error));
    });
  }
  function readerRead(file,signal){
    return new Promise((resolve,reject)=>{
      let reader,settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',onAbort);if(reader)reader.onload=reader.onerror=reader.onabort=null;error?reject(error):resolve(value);};
      const onAbort=()=>{finish(aborted());try{reader?.abort();}catch{}};
      signal?.addEventListener('abort',onAbort,{once:true});
      if(signal?.aborted){onAbort();return;}
      try{
        reader=new window.FileReader();
        reader.onload=()=>finish(null,reader.result);
        reader.onerror=()=>finish(reader.error||new Error('FileReader 无法读取文件。'));
        reader.onabort=()=>finish(aborted());
        reader.readAsArrayBuffer(file);
      }catch(error){finish(error);}
    });
  }
  async function read(file,{signal}={}){
    if(signal?.aborted)throw aborted();
    if(!file||!Number.isFinite(file.size)||file.size<0)throw unreadable(new Error('无效的本机文件引用。'));
    if(file.size>768*1024*1024)throw new Error('文件超过 768 MB，请选择较小的 PSD 或 PSB。');
    const validate=buffer=>{
      if(!(buffer instanceof ArrayBuffer)||buffer.byteLength!==file.size)throw new Error('文件读取不完整。');
      return buffer;
    };
    try{return validate(await firstRead(file,signal));}
    catch(error){if(signal?.aborted||error?.name==='AbortError')throw aborted();}
    try{return validate(await readerRead(file,signal));}
    catch(error){if(signal?.aborted||error?.name==='AbortError')throw aborted();throw unreadable(error);}
  }
  window.LayerDeskLocalFile=Object.freeze({read});
})();
