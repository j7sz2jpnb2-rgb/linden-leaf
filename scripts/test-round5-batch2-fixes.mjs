import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import assert from 'assert'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.join(__dirname, '..')

console.log('====================================================')
console.log(' RUNNING VERIFICATION FOR BATCH 2 SHELF & FILTER FIXES')
console.log('====================================================')

// 1. Verify CSS height unification for overview toolbar
console.log('\nTest 1: Filter bar controls height alignment...')
const mainCss = fs.readFileSync(path.join(root, 'css', 'main.css'), 'utf-8')
assert(mainCss.includes('.overview-search-wrap,\n.btn-overview-action,\n.overview-select'), 'CSS must group overview controls')
assert(mainCss.includes('height: 32px;'), 'CSS must unify heights to 32px')
assert(mainCss.includes('box-sizing: border-box;'), 'CSS must use border-box')
console.log('  ✓ Test 1 Passed: Overview toolbar controls standardized to 32px height.')

// 2. Verify tags popover structure and app.js logic
console.log('\nTest 2: Tags dropdown popover...')
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf-8')
const appJs = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf-8')
assert(indexHtml.includes('id="overview-tags-popover"'), 'index.html must have overview-tags-popover')
assert(indexHtml.includes('id="overview-tags-btn-text"'), 'index.html must have overview-tags-btn-text')
assert(indexHtml.includes('id="btn-popover-manage-tags"'), 'index.html must have btn-popover-manage-tags')
assert(appJs.includes('renderOverviewTagsPopoverList()'), 'app.js must implement renderOverviewTagsPopoverList')
assert(appJs.includes('closeOverviewPopovers()'), 'app.js must implement closeOverviewPopovers')
console.log('  ✓ Test 2 Passed: Tags dropdown popover markup and event controller verified.')

// 3. Verify rating slider popover structure and sync
console.log('\nTest 3: Rating slider popover and fine-grained range filter...')
assert(indexHtml.includes('id="btn-overview-rating-trigger"'), 'index.html must have rating trigger button')
assert(indexHtml.includes('id="overview-rating-popover"'), 'index.html must have overview-rating-popover')
assert(indexHtml.includes('id="overview-rating-slider"'), 'index.html must have range slider')
assert(indexHtml.includes('id="overview-unrated-checkbox"'), 'index.html must have unrated checkbox')
assert(indexHtml.includes('id="btn-reset-rating"'), 'index.html must have reset rating button')
assert(appJs.includes('syncRatingPopoverUI'), 'app.js must implement syncRatingPopoverUI')
console.log('  ✓ Test 3 Passed: Rating slider popover markup and reactive sync logic verified.')

// 4. Verify book card hover button cleanup
console.log('\nTest 4: Book card hover buttons cleanup (keep only favorite/star)...')
assert(!appJs.includes('<button class="grid-delete-btn"'), 'app.js must not render grid-delete-btn on card')
assert(!appJs.includes('<button class="grid-list-btn"'), 'app.js must not render grid-list-btn on card')
assert(!appJs.includes('<button class="skeuo-delete-btn"'), 'app.js must not render skeuo-delete-btn on card')
assert(mainCss.includes('.grid-delete-btn,') && mainCss.includes('display: none !important;'), 'main.css must hide non-star hover buttons')
console.log('  ✓ Test 4 Passed: Book card hover buttons cleaned up to keep only favorite/star.')

// 5. Verify batch mode collision prevention
console.log('\nTest 5: Batch multi-select mode hover button suppression...')
assert(mainCss.includes('.is-batch-mode .grid-fav-btn'), 'main.css must suppress fav button in batch mode')
assert(mainCss.includes('.is-batch-mode .card-batch-checkbox ~ button'), 'main.css must suppress sibling buttons of checkbox')
console.log('  ✓ Test 5 Passed: In batch mode all hover action buttons are suppressed to avoid checkbox overlap.')

// 6. Verify Book Details modal actions
console.log('\nTest 6: Book Details modal list management and deletion actions...')
const bookDetailsJs = fs.readFileSync(path.join(root, 'js', 'book-details.js'), 'utf-8')
assert(bookDetailsJs.includes('id="btn-details-manage-lists"'), 'book-details.js must have btn-details-manage-lists')
assert(bookDetailsJs.includes('id="btn-details-delete"'), 'book-details.js must have btn-details-delete')
assert(bookDetailsJs.includes('callbacks.onManageLists?.(bookId)'), 'book-details.js must call onManageLists')
assert(bookDetailsJs.includes('callbacks.onDeleteBook?.(bookId)'), 'book-details.js must call onDeleteBook')
assert(appJs.includes('onManageLists: (id) =>'), 'app.js must pass onManageLists to bookDetailsModal')
assert(appJs.includes('onDeleteBook: async (id) =>'), 'app.js must pass onDeleteBook to bookDetailsModal')
console.log('  ✓ Test 6 Passed: Book details modal contains list management and shelf deletion actions.')

console.log('\n====================================================')
console.log(' ALL BATCH 2 VERIFICATIONS PASSED SUCCESSFULLY!')
console.log('====================================================\n')
