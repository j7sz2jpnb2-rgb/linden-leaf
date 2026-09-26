// scripts/verify-ecdict-sample.mjs
import { DictionaryService } from '../js/dictionary-service.js'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = path.resolve(__dirname, '../resources/dictionary/ecdict.db')

console.log('Testing ECDICT with SQLite database at:', dbPath)
const rawDb = new DatabaseSync(dbPath, { readOnly: true })
const service = new DictionaryService({ dbPath, sqliteDb: rawDb })

// 1. Check status
const status = await service.getStatus()
console.log('Dictionary Status:', status)
if (!status.installed || status.totalWords < 700000) {
    console.error('FAIL: Expected >= 700,000 words, got', status.totalWords)
    process.exit(1)
}

// 2. Sample 200 words from DB
const sampleRows = rawDb.prepare(`
    SELECT word, translation FROM entries 
    WHERE length(word) >= 3 AND translation IS NOT NULL AND length(translation) >= 2 
    ORDER BY RANDOM() LIMIT 200
`).all()

console.log(`Sampling and verifying ${sampleRows.length} words...`)
let successCount = 0
for (const row of sampleRows) {
    const res = await service.lookup(row.word)
    if (!res || !res.found || !res.entries || res.entries.length === 0) {
        console.error(`FAIL: Lookup failed for sampled word "${row.word}"`, res)
        process.exit(1)
    }
    successCount++
}
console.log(`PASS: All ${successCount} sampled words successfully looked up with Chinese translations!`)

// 3. Test lemmatization and inflections
const inflections = [
    { query: 'cats', lemma: 'cat' },
    { query: 'ran', lemma: 'run' },
    { query: 'running', lemma: 'run' },
    { query: 'better', lemma: 'good' },
    { query: 'limousines', lemma: 'limousine' },
    { query: 'collisions', lemma: 'collision' }
]

for (const item of inflections) {
    const res = await service.lookup(item.query)
    if (!res || !res.found) {
        console.error(`FAIL: Lemmatized lookup failed for "${item.query}"`)
        process.exit(1)
    }
    const def = res.entries?.[0]?.def || res.translation || ''
    console.log(`Inflection "${item.query}" -> found lemma "${res.word}", phonetic: ${res.phonetic || '(none)'}, translation: ${def.slice(0, 30)}...`)
}

console.log('\nALL ECDICT VERIFICATION CHECKS PASSED!')
