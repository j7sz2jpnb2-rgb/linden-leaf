import assert from 'node:assert/strict';
globalThis.NodeFilter ??= { SHOW_ELEMENT:1, SHOW_TEXT:4, FILTER_ACCEPT:1, FILTER_REJECT:2, FILTER_SKIP:3 };
globalThis.HTMLElement ??= class {};
globalThis.customElements ??= {get(){},define(){}};
const {ReaderSearchController}=await import('../js/reader-search-controller.js');
const {ReaderLocationHistory}=await import('../js/reader-navigation.js');
let passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('[PASS]',name)};
await test('PDF search streams every match past the former 100/300 limits',async()=>{
 const search=new ReaderSearchController({}),controller=new AbortController();let geometry=0;
 const state={query:'needle',signal:controller.signal,failedPages:0,viewport:{numPages:3,pageSizes:Array(3).fill({width:100,height:100})},
  driver:{async getPagePlainText(p){return p===1?'no match':'needle '.repeat(310)},async getTextLayer(){geometry++;return {spans:[{text:'needle '.repeat(310),x:0,y:0,w:50,h:10}]}}}};
 let count=0;for await(const item of search._iterateBookSearchMatches(state)){assert.equal(item.excerpt.match,'needle');count++}
 assert.equal(count,620);assert.equal(geometry,2);assert.equal(state.failedPages,0);
});
await test('cancelling a paused result stream stops work before the next page',async()=>{
 const search=new ReaderSearchController({}),controller=new AbortController();let pages=0;
 const state={query:'a',signal:controller.signal,failedPages:0,viewport:{numPages:100,pageSizes:[{width:100,height:100}]},
  driver:{async getPagePlainText(){pages++;return 'aaa'},async getTextLayer(){return {spans:[{text:'aaa',x:0,y:0,w:30,h:10}]}}}};
 const iterator=search._iterateBookSearchMatches(state);assert.equal((await iterator.next()).done,false);
 controller.abort();assert.equal((await iterator.next()).done,true);assert.equal(pages,1);
});
await test('matching PDF characters keep their exact normalized geometry',()=>{
 const search=new ReaderSearchController({});
 const span={text:'ab',x:0,y:0,w:30,h:30,charOffsets:[{start:0,end:1},{start:1,end:2}],charBoxes:[{x0:10,y0:20,x1:20,y1:30},{x0:20,y0:20,x1:30,y1:30}]};
 assert.deepEqual(search._pdfSearchRects([{span,start:0}],1,2,{width:100,height:100}),[[.2,.2,.3,.3]]);
});
await test('closing one search scope does not cancel the other scope',()=>{
 const search=new ReaderSearchController({});
 search._crossSearchAbortController=new AbortController();const cross=search._crossSearchAbortController;
 search._bookSearchAbortController=new AbortController();const book=search._bookSearchAbortController;
 search.clearSearchState();assert.equal(book.signal.aborted,true);assert.equal(cross.signal.aborted,false);
 search.closeCrossSearchModal();assert.equal(cross.signal.aborted,true);
});
await test('an old navigation completion cannot unlock a new session navigation',async()=>{
 const resolvers=[],app={navigateReaderToLocation(){return new Promise(resolve=>resolvers.push(resolve))}};
 const history=new ReaderLocationHistory(app),old=history._goToLocation({type:'pdf',page:1});history.reset();
 const next=history._goToLocation({type:'pdf',page:2});resolvers[0]();await old;
 await new Promise(resolve=>setTimeout(resolve,280));assert.equal(history.isNavigating,true);
 resolvers[1]();await next;history.reset();
});
console.log(`Reader search tests: ${passed} passed.`);
