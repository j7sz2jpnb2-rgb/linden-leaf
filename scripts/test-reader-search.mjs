import assert from 'node:assert/strict';
globalThis.NodeFilter ??= { SHOW_ELEMENT:1, SHOW_TEXT:4, FILTER_ACCEPT:1, FILTER_REJECT:2, FILTER_SKIP:3 };
globalThis.HTMLElement ??= class {};
globalThis.customElements ??= {get(){},define(){}};
const {ReaderSearchController}=await import('../js/reader-search-controller.js');
const {ReaderLocationHistory}=await import('../js/reader-navigation.js');
const {joinMuPdfGeometryChars}=await import('../js/pdf-driver.js');
const {FullTextSearchEngine,EXTRACTOR_VERSION}=await import('../js/fulltext-search.js');
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
await test('MuPDF cross-line phrase search matches alpha\\nbeta against "alpha beta" and returns both line rects', async () => {
 const search = new ReaderSearchController({});
 const controller = new AbortController();
 let geometryCalls = 0;
 const state = {
  query: 'alpha beta',
  signal: controller.signal,
  failedPages: 0,
  viewport: { numPages: 1, pageSizes: [{ width: 100, height: 100 }] },
  driver: {
   async getPagePlainText() { return 'alpha\nbeta'; },
   async getTextLayer() {
    geometryCalls++;
    return {
     spans: [
      { text: 'alpha', x: 10, y: 20, w: 30, h: 10 },
      { text: 'beta', x: 10, y: 40, w: 30, h: 10 }
     ]
    };
   }
  }
 };
 const matches = [];
 for await (const item of search._iterateBookSearchMatches(state)) matches.push(item);
 assert.equal(geometryCalls, 1);
 assert.equal(matches.length, 1);
 assert.equal(matches[0].excerpt.match, 'alpha beta');
 assert.equal(matches[0].rects.length, 2);
});
await test('joinMuPdfGeometryChars preserves word boundaries across lines without double spaces', () => {
 const chars = [
  ...'alpha'.split('').map(text => ({ text, line: 0 })),
  ...'beta'.split('').map(text => ({ text, line: 1 })),
 ];
 assert.equal(joinMuPdfGeometryChars(chars), 'alpha beta');
 const spacedChars = [
  ...'alpha '.split('').map(text => ({ text, line: 0 })),
  ...'beta'.split('').map(text => ({ text, line: 1 })),
 ];
 assert.equal(joinMuPdfGeometryChars(spacedChars), 'alpha beta');
});
await test('loadBookSearchPage renders the first hit progressively before tail pages finish', async () => {
 const prevDocument = globalThis.document;
 const makeEl = (tagName = 'div') => ({
  tagName: String(tagName).toUpperCase(),
  className: '',
  style: { cssText: '' },
  dataset: {},
  children: [],
  textContent: '',
  innerText: '',
  innerHTML: '',
  disabled: false,
  setAttribute() {},
  addEventListener() {},
  append(...items) { this.children.push(...items); },
  replaceChildren(...items) { this.children = [...items]; },
  querySelectorAll(sel) {
   const out = [];
   const targetTag = sel.toUpperCase();
   const walk = node => {
    for (const child of node.children || []) {
     if (child && typeof child === 'object') {
      if (child.tagName === targetTag) out.push(child);
      walk(child);
     }
    }
   };
   walk(this);
   return out;
  }
 });
 globalThis.document = { createElement: makeEl };
 try {
  const container = makeEl('div');
  const pulses = [];
  const viewport = {
   numPages: 500,
   pageSizes: Array(500).fill({ width: 100, height: 100 }),
   pulseRects(page, rects) { pulses.push({ page, rects }); }
  };
  let releaseTail;
  const driver = {
   async getPagePlainText(pageIndex) {
    if (pageIndex === 0) return 'needle on page 0';
    if (pageIndex === 1) return await new Promise(resolve => { releaseTail = resolve; });
    return '';
   },
   async getTextLayer() {
    return { spans: [{ text: 'needle on page 0', x: 10, y: 20, w: 30, h: 10 }] };
   }
  };
  const search = new ReaderSearchController({
   currentBookId: 'book-1',
   pdfViewport: viewport,
   pdfDriver: driver,
   navHistory: { pushLocation() {} },
   annotations: { closeDrawer() {} },
   dialogs: {}
  });
  search.dom = { searchResultsContainer: container };
  search.updateSearchBarUI = () => {};
  const controller = new AbortController();
  const state = {
   bookId: 'book-1',
   query: 'needle',
   signal: controller.signal,
   pageSize: 50,
   nextPage: 0,
   pageIndex: 0,
   total: null,
   pages: new Map(),
   pending: null,
   busy: false,
   failedPages: 0,
   viewport,
   driver,
   view: undefined
  };
  state.iterator = search._iterateBookSearchMatches(state);
  search._bookSearchState = state;

  const pendingLoad = search.loadBookSearchPage(0);
  for (let i = 0; i < 15 && !releaseTail; i++) {
   await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(releaseTail, 'Tail page scan should still be waiting on page 1');
  assert.equal(search.currentSearchMatches.length, 1, 'First match should display before scanning tail pages');
  assert.equal(pulses.length, 1);
  assert.equal(pulses[0].page, 0);
  assert.equal(container.children.some(child => child.className === 'search-result-item'), true);
  assert.equal(search._bookSearchState.busy, true);

  releaseTail('');
  assert.equal(await pendingLoad, true);
  assert.equal(search._bookSearchState.busy, false);
 } finally {
  if (prevDocument === undefined) delete globalThis.document;
  else globalThis.document = prevDocument;
 }
});
await test('FullTextSearchEngine.searchBooks avoids LRU cache thrashing across repeated identical scans', async () => {
 const books = Array.from({ length: 70 }, (_, idx) => ({
  id: `book-${idx}`,
  title: `Book ${idx}`,
  format: 'epub',
  blobRevision: 'rev1'
 }));
 const booksMap = new Map(books.map(b => [b.id, b]));
 const persistedMap = new Map(books.map((b, idx) => [b.id, {
  title: b.title,
  format: 'epub',
  extractorVersion: EXTRACTOR_VERSION,
  blobRevision: 'rev1',
  sections: [{
   id: 's0',
   sectionIndex: 0,
   sectionTitle: 'Chapter 1',
   granularity: 'chapter',
   location: 's0',
   text: idx === 69 ? 'Here is the needle in the haystack.' : 'Ordinary filler content for indexing.'
  }]
 }]));
 let dbReads = 0;
 const mockDb = {
  async getBook(id) { return booksMap.get(id) || null; },
  async getBookSearchIndex(id) { dbReads++; return persistedMap.get(id) || null; }
 };
 const engine = new FullTextSearchEngine({ db: mockDb });
 engine.setResourceBudget({ maxCacheEntries: 60, maxConcurrent: 2 });

 const first = await engine.searchBooks('needle', books);
 assert.equal(dbReads, 70);
 assert.equal(first.results.length, 1);

 dbReads = 0;
 const second = await engine.searchBooks('needle', books);
 assert.equal(dbReads, 10, 'Repeated search must reuse all 60 cached books and only reload the 10 evicted entries');
 assert.equal(second.results.length, 1);
});
console.log(`Reader search tests: ${passed} passed.`);
