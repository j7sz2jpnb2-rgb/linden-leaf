import assert from 'node:assert/strict';
import { DomEvents } from '../js/dom-events.js';
import { buildContentCSS } from '../js/reader-style-builder.js';
import { ReaderLocationHistory, normalizeNavigationTarget, decodePdfProgress } from '../js/reader-navigation.js';

globalThis.NodeFilter ??= { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
globalThis.HTMLElement ??= class {};
globalThis.customElements ??= { get() {}, define() {} };

const { UniversalReaderApp } = await import('../js/app.js');
const { BookshelfController } = await import('../js/bookshelf-controller.js');
const { StatsViewController } = await import('../js/stats-view-controller.js');
const { SyncController } = await import('../js/sync-controller.js');
const { ReaderSearchController } = await import('../js/reader-search-controller.js');
const { AnnotationsDrawerController } = await import('../js/annotations-drawer-controller.js');
const { PdfDrawingController, PdfDrawingMutationQueue } = await import('../js/pdf-drawing-controller.js');
const { ReaderCardsController } = await import('../js/reader-cards-controller.js');
const { PdfToolsController } = await import('../js/pdf-tools-controller.js');
const { FoliateSectionBinder } = await import('../js/foliate-section-binder.js');
const { ReadingPresetsManager } = await import('../js/reading-presets.js');
const { resolveLegacyPreserveOriginalStyles } = await import('../js/translation-job-core.js');
const { mobileShell } = await import('../js/mobile-shell.js');
let passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log('[PASS]',name)};

await test('event lifetime preserves once/capture options and removes all owned listeners',()=>{
 const events=new DomEvents(),target=new EventTarget();let normal=0,once=0;
 events.on(target,'change',()=>normal++);events.on(target,'change',()=>once++,{once:true});
 target.dispatchEvent(new Event('change'));target.dispatchEvent(new Event('change'));
 assert.equal(normal,2);assert.equal(once,1);
 events.dispose();target.dispatchEvent(new Event('change'));assert.equal(normal,2);
 events.on(target,'change',()=>normal++);target.dispatchEvent(new Event('change'));assert.equal(normal,3);events.dispose();
});
await test('public navigation exports remain identical to the owning module',()=>{
 assert.equal(UniversalReaderApp.prototype.openBook.name,'openBook');
 assert.deepEqual(normalizeNavigationTarget({pageIndex:0}),{type:'pdf',page:1,pageIndex:0,yRatio:0});
 assert.deepEqual(decodePdfProgress({fraction:0.3},10),{page:3,fraction:0.3});
 assert.equal(typeof ReaderLocationHistory,'function');
});
await test('location history uses the real app PDF format and distinguishes the first two pages',()=>{
 const app={currentBookFormat:'pdf',pdfViewport:{currentPage:0}},history=new ReaderLocationHistory(app);
 assert.deepEqual(history.getCurrentLocation(),{type:'pdf',page:1});
 app.pdfViewport.currentPage=1;assert.deepEqual(history.getCurrentLocation(),{type:'pdf',page:2});
});
await test('CSS builder handles independent themes, columns and vertical text without app state',()=>{
 for(const theme of ['light','black','sepia'])for(const writingMode of ['horizontal','vertical-rl']){
  const css=buildContentCSS({theme,font:'serif',fontSize:18,fontWeight:400,lineHeight:1.6,writingMode,justify:true});
  assert.ok(css.includes('font-size'));assert.ok(!css.includes('[object Object]'));
 }
});
await test('shelf, stats, sync, search, selection and drawing state have one owner',()=>{
 const app=Object.create(UniversalReaderApp.prototype);
 app.bookshelf=new BookshelfController(app);app.stats=new StatsViewController(app);app.sync=new SyncController(app);
 app.search=new ReaderSearchController(app);app.annotations=new AnnotationsDrawerController(app);app.drawing=new PdfDrawingController(app);
 assert.equal(app.bookshelf.shelfCategory,'all');assert.equal(app.stats.statsViewMode,'month');
 app.shelfCategory='recent';assert.equal(app.bookshelf.shelfCategory,'recent');assert.equal(Object.hasOwn(app,'shelfCategory'),false);
 app.syncConfig={providerType:'local_folder'};assert.equal(app.sync.syncConfig.providerType,'local_folder');assert.equal(Object.hasOwn(app,'syncConfig'),false);
 app.annotations.selectedTextInfo={text:'selected'};assert.equal(Object.hasOwn(app,'selectedTextInfo'),false);
 app.selectedBookIds.add('selected-book');assert.ok(app.bookshelf.selectedBookIds.has('selected-book'));assert.equal(Object.hasOwn(app,'selectedBookIds'),false);
});
await test('public shelf entry delegates directly to its owner and returns its result',async()=>{
 const app=Object.create(UniversalReaderApp.prototype);let called=0;
 app.bookshelf={async refreshBookshelf(value){called++;return value}};
 assert.equal(await app.refreshBookshelf('result'),'result');assert.equal(called,1);
});
await test('MuPDF selection copies through Ctrl+C while editable text keeps its own shortcut', async () => {
 const app = Object.create(UniversalReaderApp.prototype);
 app.dom = { bookshelfView: { style: { display: 'none' } } };
 app.pdfViewport = { driver: { kind: 'mupdf' } };
 const selection = { formatType: 'pdf', text: 'PDF 划选文字\nSecond line' };
 app.annotations = {
  selectedTextInfo: selection,
  multiSelectedRanges: [{ text: 'old EPUB selection' }, { text: 'another old range' }],
  hideSelectionPopup() { this.selectedTextInfo = null; }
 };
 app.dialogs = { dom: {}, showToast() {} };
 app.bookshelf = { dom: {} };
 app.updates = { dom: {} };
 app.sync = { dom: {} };
 const previousDocument = globalThis.document;
 const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
 let copied;
 globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
 Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  async writeText(text) { copied = text; }
 } });
 try {
  const event = { key: 'c', ctrlKey: true, preventDefault() { this.defaultPrevented = true; } };
  app.handleGlobalKeydown(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(copied, selection.text);
  assert.equal(app.annotations.selectedTextInfo, selection);
  copied = undefined;
  const editing = { ...event, defaultPrevented: false, target: { isContentEditable: true } };
  app.handleGlobalKeydown(editing);
  assert.equal(editing.defaultPrevented, false);
  assert.equal(copied, undefined);
 } finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
  if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard);
  else delete navigator.clipboard;
 }
});
await test('drawing queue still serializes mutations per book/page and drains',async()=>{
 const queue=new PdfDrawingMutationQueue(),order=[];
 queue.enqueue('b',0,async()=>{await new Promise(r=>setTimeout(r,10));order.push('first')});
 queue.enqueue('b',0,async()=>{order.push('second')});await queue.drainAll();
 assert.deepEqual(order,['first','second']);
});
await test('AI and page OCR begin with initialized controller-owned task state',()=>{
 const app={},cards=new ReaderCardsController(app),tools=new PdfToolsController(app);
 assert.equal(cards._aiReqGeneration,0);assert.equal(cards._lastCompletedAiText,'');
 assert.equal(cards._activeAiSnapshot,null);assert.equal(tools._isPageOcrRunning,false);
 assert.equal(Object.hasOwn(app,'_isPageOcrRunning'),false);
 assert.equal(Object.hasOwn(app,'_lastCompletedAiText'),false);
});
await test('drawing session reset clears transient state while submitted writes finish',async()=>{
 const drawing=new PdfDrawingController({}),order=[];
 drawing._pdfMutationQueue.enqueue('old-book',0,async()=>{await new Promise(r=>setTimeout(r,10));order.push('persisted')});
 drawing._pdfPageStrokesCache.set('old-book:0:r1',[]);drawing._drawingPageGenerations.set('old-book:0',1);
 drawing.pdfDrawTool='pen';const before=drawing._sessionGeneration;drawing.resetSessionState();
 assert.equal(drawing._sessionGeneration,before+1);assert.equal(drawing._pdfPageStrokesCache.size,0);
 assert.equal(drawing._drawingPageGenerations.size,0);assert.equal(drawing.pdfDrawTool,null);
 await drawing.flushPendingWrites();assert.deepEqual(order,['persisted']);
});
await test('first production-style PDF jump can go back to its origin and forward to its destination',async()=>{
 const app={currentBookFormat:'pdf',pdfViewport:{currentPage:0},async navigateReaderToLocation(loc){this.pdfViewport.currentPage=loc.page-1}};
 const history=new ReaderLocationHistory(app);history.pushLocation();app.pdfViewport.currentPage=9;
 assert.ok(history.canGoBack());await history.back();assert.equal(app.pdfViewport.currentPage,0);
 await history.forward();assert.equal(app.pdfViewport.currentPage,9);history.reset();assert.ok(!history.canGoBack());
});
await test('Foliate navigation preserves CFI for TXT and controller cleanup handles a Ctrl boolean',()=>{
 const app={currentBookFormat:'txt',foliateView:{},currentLocation:{cfi:'epubcfi(/6/2!/4/2:0)'}};
 assert.equal(new ReaderLocationHistory(app).getCurrentLocation().cfi,app.currentLocation.cfi);
 const binder=new FoliateSectionBinder(app);binder._activeSelectionGestureCtrl=true;binder.dispose();
 assert.equal(binder._activeSelectionGestureCtrl,false);
});
await test('EPUB publisher-style migration, presets, and CSS builder isolate custom typography',()=>{
 assert.equal(resolveLegacyPreserveOriginalStyles(null),false);
 assert.equal(resolveLegacyPreserveOriginalStyles({theme:'black',font:'serif',fontWeight:400,lineHeight:1.6}),false);
 assert.equal(resolveLegacyPreserveOriginalStyles({preserveOriginalStyles:true}),true);
 assert.equal(resolveLegacyPreserveOriginalStyles({font:'kaiti',lineHeight:1.8}),false);
 assert.equal(resolveLegacyPreserveOriginalStyles({font:'sans'},true),false);
 assert.equal(resolveLegacyPreserveOriginalStyles({theme:'sepia'},true),undefined);
 const presets=new ReadingPresetsManager();
 presets.presets=[{id:'legacy',name:'Legacy',settings:{font:'kaiti',fontSize:20}}];
 const applied=presets.applyPreset('legacy');
 assert.equal(applied.preserveOriginalStyles,false);
 const pubCss=buildContentCSS({theme:'black',font:'kaiti',fontSize:18,fontWeight:700,lineHeight:2.2,preserveOriginalStyles:true});
 assert.ok(!pubCss.includes('2.2')&&pubCss.includes('html {'));
});
await test('mobile Home real view transitions avoid shelf flash, triple redraw, and double-tap races', async () => {
 const app = Object.create(UniversalReaderApp.prototype)
 const createEl = (id, display = '', ...initialClasses) => {
  const classes = new Set(initialClasses)
  const attrs = new Map()
  const children = []
  return {
   id,
   hidden: false,
   disabled: false,
   innerText: '',
   textContent: '',
   innerHTML: '',
   dataset: {},
   style: { display },
   children,
   get childElementCount() { return children.length },
   appendChild(child) { children.push(child); return child },
   setAttribute(k, v) { attrs.set(k, String(v)) },
   getAttribute(k) { return attrs.get(k) ?? null },
   removeAttribute(k) { attrs.delete(k) },
   querySelector(sel) {
    if (sel === '.mobile-reader-loading-title') return this._titleNode || (this._titleNode = createEl('loading-title'))
    if (sel === '.mobile-reader-loading-label') return this._labelNode || (this._labelNode = createEl('loading-label'))
    return null
   },
   classList: {
    add(...names) { names.forEach(name => classes.add(name)) },
    remove(...names) { names.forEach(name => classes.delete(name)) },
    toggle(name, force) {
     const next = force === undefined ? !classes.has(name) : Boolean(force)
     if (next) classes.add(name); else classes.delete(name)
     return next
    },
    contains(name) { return classes.has(name) },
   },
  }
 }

 const reader = createEl('reader-view', 'block', 'active')
 const readerContent = createEl('reader-content-area', 'block')
 const shelf = createEl('bookshelf-view', 'none')
 const home = createEl('mobile-home-view', '', 'active')
 const homeCards = createEl('mobile-home-cards-container')
 homeCards.appendChild(createEl('hero-card-stub'))
 const navBar = createEl('mobile-nav-bar')
 const headerBar = createEl('mobile-header-bar', 'none')
 const paletteBtn = createEl('btn-mobile-palette', 'none')
 const bodyEl = createEl('body')
 const docEl = createEl('html', '', 'is-mobile-viewport')
 const elementsById = new Map([
  ['reader-view', reader],
  ['reader-content-area', readerContent],
  ['bookshelf-view', shelf],
  ['mobile-home-view', home],
  ['mobile-home-cards-container', homeCards],
  ['mobile-nav-bar', navBar],
  ['mobile-header-bar', headerBar],
  ['btn-mobile-palette', paletteBtn],
 ])

 const shell = Object.create(Object.getPrototypeOf(mobileShell))
 let homeRenders = 0
 let shelfRenders = 0
 Object.assign(shell, {
  currentTab: 'home',
  isInReader: true,
  settingsPage: { close() {} },
  isMobileViewport: () => true,
  closeAllSheets() {},
  closeNowPlayingSheet() {},
  setReaderToolsVisible() {},
  syncPdfControls() {},
  updateMiniPlayerState() {},
  renderHomeTab() { homeRenders++ },
  renderShelfTab() { shelfRenders++ },
  renderNotesTab() {},
  renderMeTab() {},
  initSearchTab() {},
 })

 const noOp = () => {}
 const resettable = { resetSessionState: noOp }
 let bookshelfRefreshes = 0
 Object.assign(app, {
  dom: { readerView: reader, bookshelfView: shelf, readerContentArea: readerContent },
  pdfTools: resettable, drawing: resettable, cards: resettable, sections: resettable,
  navHistory: { reset: noOp }, search: { clearSearchState: noOp, dom: {} },
  annotations: { ...resettable, dom: {}, closeDrawer: noOp, switchTab: noOp,
   hideSelectionPopup: noOp, hideHighlightActionPopup: noOp },
  bookshelf: { refreshBookshelf: async () => { bookshelfRefreshes++ }, _scrollToBookAnchor: noOp },
  appearance: { updateBookOverrideUI: noOp, updateSettingsUI: noOp },
  cancelPendingReaderUIToggle: noOp, toggleReaderUI: noOp, sync: {},
  isMobileLayout: () => true, makeProgressSnapshot: () => null,
  _currentBookEpoch: 1,
  _activeSession: { bookId: 'book', abortController: new AbortController() },
 })

 let releaseRecovery
 app.ensureRecoveryBarrier = () => new Promise(resolve => { releaseRecovery = resolve })
 const previousWindow = globalThis.window
 const previousDocument = globalThis.document
 globalThis.window = { mobileShell: shell, app, innerWidth: 390 }
 globalThis.document = {
  title: '',
  body: bodyEl,
  documentElement: docEl,
  getElementById(id) { return elementsById.get(id) || null },
  querySelectorAll(sel) { return sel === '.mobile-view-container' ? [home] : [] },
  createElement(tag) {
   const node = createEl(tag)
   const origAppend = readerContent.appendChild.bind(readerContent)
   readerContent.appendChild = (child) => {
    if (child.id) elementsById.set(child.id, child)
    return origAppend(child)
   }
   return node
  },
 }
 try {
  // 1. publishStartupView('shelf') while on mobile Home must never expose #bookshelf-view
  app.publishStartupView('shelf')
  assert.equal(shelf.style.display, 'none', 'publishStartupView(shelf) exposed bookshelf under mobile Home')
  assert.equal(docEl.dataset.startupView, 'ready')

  // 2. Switching to Shelf tab and calling publishStartupView('shelf') keeps bookshelf visible
  shell.currentTab = 'shelf'
  app.publishStartupView('shelf')
  assert.equal(shelf.style.display, 'flex')
  shell.currentTab = 'home'
  shelf.style.display = 'none'

  // 3. Closing reader returns to Home once without exposing shelf or triggering bookshelf refresh
  await app.closeReader()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(home.classList.contains('active'), true, 'mobile Home did not reactivate on reader close')
  assert.equal(shelf.style.display, 'none', 'reader close exposed the shelf under Home')
  assert.equal(homeRenders, 1, `expected single post-close Home render, got ${homeRenders}`)
  assert.equal(bookshelfRefreshes, 0, 'closing reader on mobile Home needlessly refreshed hidden bookshelf')

  // 4. Reader loading indicator stays visible while book opens and hides once finished
  shell.beginReaderSessionLoading('Sample Book')
  const loadingOverlay = elementsById.get('mobile-reader-loading-overlay')
  assert.ok(loadingOverlay && loadingOverlay.style.display === 'flex', 'reader loading indicator should show during session load')
  assert.equal(home.classList.contains('active'), false)
  shell.finishReaderSessionLoading()
  assert.equal(loadingOverlay.style.display, 'none', 'reader loading indicator did not hide on finish')
  shell.setReaderInView(false)

  // 5. Continue Reading rapid double-tap guard blocks duplicate openBook invocations
  let openCalls = 0
  let releaseOpen
  const origOpenBook = app.openBook
  app.openBook = () => {
   openCalls++
   return new Promise(resolve => { releaseOpen = resolve })
  }
  const firstTap = shell._openBookFromHome('book-1', createEl('hero-card'))
  const secondTap = shell._openBookFromHome('book-1', createEl('hero-card'))
  assert.equal(openCalls, 1, 'rapid double-tap on Continue Reading triggered duplicate openBook calls')
  releaseOpen()
  await Promise.all([firstTap, secondTap])
  app.openBook = origOpenBook

  // 6. Opening a book from Home keeps Home active during async recovery and aborts cleanly
  const opening = app.openBook('book')
  assert.equal(home.classList.contains('active'), true)
  assert.equal(shelf.style.display, 'none')
  app._activeSession.abortController.abort()
  releaseRecovery()
  await opening
  assert.equal(shell.isInReader, false, 'canceled opening entered the reader')
 } finally {
  clearTimeout(app._closeTimer)
  globalThis.window = previousWindow
  globalThis.document = previousDocument
 }
})

await test('satellite reader preserves initial title before load and updates title with book name on locale change', () => {
 const app = Object.create(UniversalReaderApp.prototype)
 const previousDocument = globalThis.document
 globalThis.document = { title: 'Dune - Linden Leaf' }
 try {
  app.isSatelliteReaderWindow = true
  app.currentBookData = null
  app._currentSnapshot = null
  app._updateWindowTitle('en')
  assert.equal(globalThis.document.title, 'Dune - Linden Leaf', 'satellite boot overwrote native book window title')

  app.currentBookData = { title: 'Dune' }
  app._updateWindowTitle('zh-CN')
  assert.ok(globalThis.document.title.startsWith('《Dune》 - '), `unexpected zh title: ${globalThis.document.title}`)

  app._updateWindowTitle('en')
  assert.ok(globalThis.document.title.startsWith('Dune - '), `unexpected en title: ${globalThis.document.title}`)

  app.isSatelliteReaderWindow = false
  app.currentBookData = null
  app._updateWindowTitle('en')
  assert.ok(globalThis.document.title.includes('Linden Leaf') && !globalThis.document.title.includes('Dune'))
 } finally {
  if (previousDocument === undefined) delete globalThis.document
  else globalThis.document = previousDocument
 }
})
console.log(`App composition tests: ${passed} passed.`);
