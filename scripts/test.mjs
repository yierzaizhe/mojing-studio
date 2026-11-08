import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tasks=['build.mjs','tests/file-read.cjs','tests/clip-alpha.cjs','tests/hit-test.cjs','tests/export-watermark.cjs','tests/svg-raster-export.cjs','tests/psd-layer-preview.cjs','tests/image-filters.cjs','tests/public-build.cjs'];
for(const task of tasks){
 console.log(`\n> ${task}`);
 const result=spawnSync(process.execPath,[task],{cwd:root,stdio:'inherit'});
 if(result.error){console.error(result.error.message);process.exit(1);}
 if(result.status!==0)process.exit(result.status??1);
}
console.log('\nAll public-edition checks passed.');
