import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PdfViewport } from '../../js/pdf-viewport.js'
import { PdfJsDriver } from '../../js/pdf-driver.js'

const offsets=[]
let top=16
for(let i=0;i<10000;i++){const height=200+(i*37)%1100;offsets.push({top,height,width:600});top+=height+16}
function reference(scrollTop,height,current){let max=-1,best=current;for(let i=0;i<offsets.length;i++){const p=offsets[i];if(p.top+p.height<scrollTop)continue;if(p.top>scrollTop+height)break;const n=Math.max(0,Math.min(scrollTop+height,p.top+p.height)-Math.max(scrollTop,p.top));if(n>max){max=n;best=i}}return best}
const viewport=Object.create(PdfViewport.prototype)
viewport.pageOffsets=offsets;viewport.options={};viewport.scrollArea={clientHeight:850,scrollTop:0}
for(let i=0;i<3000;i++){const y=(i*7919)%(top+1000);viewport.currentPage=31;viewport.scrollArea.scrollTop=y;viewport._detectCurrentPage();assert.equal(viewport.currentPage,reference(y,850,31))}
let reads=0
viewport.pageOffsets=new Proxy(offsets,{get(t,k){if(/^\d+$/.test(String(k)))reads++;return t[k]}})
viewport.scrollArea.scrollTop=offsets[9997].top;viewport._detectCurrentPage();assert(reads<40,reads)
const indexedReads=reads
viewport.highlightsByPage=new Map();viewport.activeSlots=new Map()
const highlights=Array.from({length:10000},(_,i)=>({id:i,pdfTarget:i%5?{page:i%83,rects:[]}:undefined}))
viewport.setHighlights(highlights)
for(let page=0;page<83;page++)assert.deepEqual(viewport.highlightsByPage.get(page),highlights.filter(h=>h.pdfTarget?.page===page))
viewport.setHighlights([]);assert.equal(viewport.highlightsByPage.size,0)

// Verify the PDF.js driver returns its canvas without encoding, and forwards abort.
const canvas={width:0,height:0,getContext:()=>({}),toDataURL:()=>{throw Error('Unexpected image encoding')}}
globalThis.document={createElement:()=>canvas}
const driver=new PdfJsDriver();let cancels=0,finish,viewports=0
const page={getViewport:({scale})=>{viewports++;return {width:595.5*scale,height:842.2*scale}},render:()=>({promise:new Promise(r=>{finish=r}),cancel:()=>{cancels++;finish()}}),getTextContent:async()=>({items:[{str:'Hello',transform:[12,0,0,12,40,80],width:30,height:12},{str:'World',transform:[12,0,0,12,40,100],width:30,height:12}]}),cleanup:()=>{}}
driver.pdfDoc={getPage:async()=>page}
let promise=driver.renderPage(0,1);await Promise.resolve();finish();assert.equal(await promise,canvas);assert.equal(canvas.width,596)
const abort=new AbortController();promise=driver.renderPage(0,1,abort.signal);await Promise.resolve();abort.abort();await assert.rejects(promise, err=>err?.name==='AbortError');assert.equal(cancels,1)
viewports=0;assert.equal((await driver.getTextLayer(0)).spans.length,2);assert.equal(viewports,1)
console.log(JSON.stringify({status:'PASS',randomViewportCases:3000,tenThousandPagesLookupReads:indexedReads,checks:['highlight index preserves order','canvas output skips encoding','render cancellation','one text viewport per page']}))
