import assert from 'node:assert/strict'
import fs from 'node:fs'

console.log('=== Running Quote & Popup Fixes Verification ===\n')

// 1. Verify Quote Logic
console.log('Test 1: Quotes replacement logic')

function transformQuotes(text, isPredominantlyCJK) {
    if (!isPredominantlyCJK) return text

    let result = text
    result = result.replace(/“/g, '「').replace(/”/g, '」')
    result = result.replace(/‘/g, '『')
    result = result.replace(/(?<![a-zA-Z0-9])’|’(?![a-zA-Z0-9])/g, (match, offset, fullStr) => {
        const before = fullStr.slice(Math.max(0, offset - 10), offset)
        if (/[a-zA-Z]+s$/i.test(before)) {
            return '’'
        }
        return '』'
    })
    return result
}

function checkCJKDominance(sampleText, bookLang = '') {
    const isEnglishBook = bookLang.toLowerCase().startsWith('en')
    const cjkCount = (sampleText.match(/[\u4e00-\u9fa5\u3040-\u30ff]/g) || []).length
    const latinCount = (sampleText.match(/[a-zA-Z]/g) || []).length
    return !isEnglishBook && (
        (cjkCount > 0 && latinCount === 0) ||
        (cjkCount >= 10 && cjkCount >= latinCount * 0.2)
    )
}

// Case 1A: English text (The Great Gatsby)
const gatsbySample = `“Whenever you feel like criticizing any one,” he told me, “just remember that all the people in this world haven’t had the advantages that you’ve had.” It was Gatsby’s idea and the workers’ rights.`
const gatsbyIsCJK = checkCJKDominance(gatsbySample, 'en')
assert.equal(gatsbyIsCJK, false, 'Gatsby should NOT be treated as predominantly CJK')
const gatsbyTransformed = transformQuotes(gatsbySample, gatsbyIsCJK)
assert.equal(gatsbyTransformed, gatsbySample, 'English Gatsby text should remain completely unmodified')
assert.ok(gatsbyTransformed.includes('haven’t'), 'haven’t must be intact')
assert.ok(gatsbyTransformed.includes('you’ve'), 'you’ve must be intact')
assert.ok(gatsbyTransformed.includes('Gatsby’s'), 'Gatsby’s must be intact')
assert.ok(!gatsbyTransformed.includes('』'), 'English text must never have corner quotes')
console.log('  ✓ English text (The Great Gatsby) passed: no quotes mutated, no apostrophes broken.')

// Case 1B: Chinese text with quotes and embedded English words/contractions
const chineseSample = `他说：“今天我们读《The Great Gatsby》，他说：‘I haven’t seen it, but I’ve heard Gatsby’s story.’ 这是真的吗？”`
const chineseIsCJK = checkCJKDominance(chineseSample, 'zh-CN')
assert.equal(chineseIsCJK, true, 'Chinese sample should be treated as predominantly CJK')
const chineseTransformed = transformQuotes(chineseSample, chineseIsCJK)
console.log('  Transformed Chinese text:', chineseTransformed)
assert.ok(chineseTransformed.includes('「今天我们读'), 'Double opening quote transformed to 「')
assert.ok(chineseTransformed.includes('真的吗？」'), 'Double closing quote transformed to 」')
assert.ok(chineseTransformed.includes('『I haven’t seen it'), 'Single opening quote transformed to 『')
assert.ok(chineseTransformed.includes('Gatsby’s story.』'), 'Single closing quote transformed to 』')
assert.ok(chineseTransformed.includes('haven’t'), 'English contraction haven’t preserved')
assert.ok(chineseTransformed.includes('I’ve'), 'English contraction I’ve preserved')
assert.ok(chineseTransformed.includes('Gatsby’s'), 'English possessive Gatsby’s preserved')
console.log('  ✓ Chinese text passed: dialogue quotes transformed to 「」/『』, English contractions preserved.')

// 2. Verify Dictionary Card Positioning Logic
console.log('\nTest 2: Dictionary Card Positioning Logic')

function computeCardPosition(rect, cardHeight = 190, cardWidth = 290, windowWidth = 1024, windowHeight = 768) {
    const rectHeight = rect.height || 24
    const rectBottom = (rect.bottom != null && !isNaN(rect.bottom)) ? rect.bottom : (rect.top + rectHeight)
    const spaceAbove = rect.top

    let top
    if (spaceAbove >= cardHeight + 14) {
        top = rect.top - cardHeight - 10
    } else {
        top = rectBottom + 10
    }
    top = Math.max(10, Math.min(windowHeight - cardHeight - 10, top))

    let left = rect.left + ((rect.width || 0) / 2) - (cardWidth / 2)
    left = Math.max(12, Math.min(windowWidth - cardWidth - 12, left))

    return { top, left, cardBottom: top + cardHeight }
}

// Case 2A: Word near top of screen (line 1, e.g. plagiaristic at top: 40)
const topRowWord = { top: 40, height: 22, bottom: 62, left: 120, width: 85 }
const posTop = computeCardPosition(topRowWord)
console.log('  Top row word pos:', posTop)
assert.ok(posTop.top >= topRowWord.bottom, 'Card must flip BELOW word when space above is insufficient')
assert.equal(posTop.top, 72, 'Card top should be rectBottom + 10 (72)')
assert.ok(posTop.top > topRowWord.top, 'Card top is strictly below word')
console.log('  ✓ Top row word passed: flips below word, word is NOT occluded.')

// Case 2B: Word in middle of screen (top: 350)
const midRowWord = { top: 350, height: 22, bottom: 372, left: 200, width: 60 }
const posMid = computeCardPosition(midRowWord)
console.log('  Mid row word pos:', posMid)
assert.ok(posMid.cardBottom <= midRowWord.top, 'Card should sit ABOVE word when space above is sufficient')
assert.equal(posMid.top, 350 - 190 - 10, 'Card top = 150')
console.log('  ✓ Mid row word passed: sits above word.')

// Case 2C: Word near bottom of screen (top: 700)
const btmRowWord = { top: 700, height: 22, bottom: 722, left: 300, width: 50 }
const posBtm = computeCardPosition(btmRowWord)
console.log('  Bottom row word pos:', posBtm)
assert.ok(posBtm.cardBottom <= btmRowWord.top, 'Card sits above word')
console.log('  ✓ Bottom row word passed: sits above word.')

// 3. Verify Source String Cleanliness
console.log('\nTest 3: Dictionary source string sanitization')
function sanitizeSource(source) {
    const raw = source || 'ECDICT 离线词库'
    return raw.replace(/\s*[\(（][^）\)]*[\)）]/g, '').trim()
}

assert.equal(sanitizeSource('ECDICT 离线词库 (77万词条)'), 'ECDICT 离线词库')
assert.equal(sanitizeSource('ECDICT 离线词库（77万词条）'), 'ECDICT 离线词库')
assert.equal(sanitizeSource('ECDICT 离线词库'), 'ECDICT 离线词库')
console.log('  ✓ Source sanitization passed: removes all parenthesized suffix counts.')

console.log('\n=== All Tests Passed Successfully! ===')
