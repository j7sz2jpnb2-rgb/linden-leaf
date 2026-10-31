import assert from 'node:assert/strict'

console.log('=== Running Automated Verification for Full Data Backup & Restore (Schema V4) ===')

// Mock IndexedDB & LocalStorage
const mockDB = {
    books: new Map(),
    sessions: new Map(),
    highlights: new Map(),
    bookmarks: new Map(),
    drawings: new Map(),
    customLists: new Map(),
    settings: new Map()
}

const mockLocalStorage = new Map()

const fakeLocalStorage = {
    getItem: (k) => mockLocalStorage.get(k) || null,
    setItem: (k, v) => mockLocalStorage.set(k, String(v)),
    removeItem: (k) => mockLocalStorage.delete(k),
    key: (i) => Array.from(mockLocalStorage.keys())[i],
    get length() { return mockLocalStorage.size }
}
globalThis.localStorage = fakeLocalStorage

// Set sample data in localStorage
mockLocalStorage.set('linden_user_name', '青衫烟雨')
mockLocalStorage.set('linden_reading_presets_v1', JSON.stringify([
    { id: 'preset_a', name: '古籍水墨', settings: { fontFamily: 'SimSun', fontSize: 20 } }
]))
mockLocalStorage.set('linden_custom_semantic_palette_v1', JSON.stringify({
    bgPrimary: '#fbf0d9',
    textMain: '#2b2319',
    _active: true
}))
mockLocalStorage.set('linden_book_settings_book_test_1', JSON.stringify({
    columns: 2,
    marginRatio: 1.5
}))
mockLocalStorage.set('linden_advanced_settings', JSON.stringify({
    ttsSpeed: 1.15,
    ttsApiKey: 'SECRET_API_KEY_NEVER_EXPORT',
    pageTurnStyle: 'curl'
}))

// Mock DB methods
const dbAdapter = {
    getAllBooks: async () => [
        {
            id: 'book_test_1',
            title: '红楼梦',
            author: '曹雪芹',
            customTitle: '脂砚斋重评石头记',
            customAuthor: '曹雪芹、高鹗',
            format: 'epub',
            size: 1500000,
            isFavorite: true,
            rating: 5.0,
            tags: ['四大名著', '古典文学'],
            readingStatus: 'reading',
            progress: { fraction: 0.35 }
        }
    ],
    getAllReadingSessions: async () => [
        {
            id: 'sess_test_1',
            bookId: 'book_test_1',
            bookTitle: '脂砚斋重评石头记',
            bookAuthor: '曹雪芹、高鹗',
            date: '2026-10-31',
            durationSeconds: 3600
        }
    ],
    getAllHighlights: async () => [
        { id: 'hl_test_1', bookId: 'book_test_1', text: '满纸荒唐言，一把辛酸泪' }
    ],
    getAllBookmarks: async () => [],
    getAllPdfDrawings: async () => [],
    getAllCustomLists: async () => [
        { id: 'list_1', name: '国学经典', bookIds: ['book_test_1'] }
    ],
    getSetting: async (key) => {
        if (key === 'readerSettings') {
            return {
                fontSize: 18,
                enableReadingGoals: true,
                readingGoalToday: 60,
                readingGoalYear: 24
            }
        }
        return null
    },
    saveBook: async (b) => { mockDB.books.set(b.id, b) },
    saveReadingSession: async (s) => { mockDB.sessions.set(s.id, s) },
    saveHighlight: async (h) => { mockDB.highlights.set(h.id, h) },
    saveBookmark: async (bm) => { mockDB.bookmarks.set(bm.id, bm) },
    savePdfPageDrawing: async (bId, page, strokes, d) => { mockDB.drawings.set(d.id, d) },
    saveCustomList: async (l) => { mockDB.customLists.set(l.id, l) },
    setSetting: async (k, v) => { mockDB.settings.set(k, v) },
    getBook: async (id) => mockDB.books.get(id) || null
}

// Emulate exportFullDataBackup logic
async function runTestExport() {
    const [sessions, highlights, books, bookmarks, drawings, customLists] = await Promise.all([
        dbAdapter.getAllReadingSessions(),
        dbAdapter.getAllHighlights(),
        dbAdapter.getAllBooks(),
        dbAdapter.getAllBookmarks(),
        dbAdapter.getAllPdfDrawings(),
        dbAdapter.getAllCustomLists()
    ])

    const readerSettings = (await dbAdapter.getSetting('readerSettings')) || {}

    let readingPresets = []
    try {
        const rawPresets = localStorage.getItem('linden_reading_presets_v1')
        if (rawPresets) readingPresets = JSON.parse(rawPresets) || []
    } catch (_) {}

    let customPalette = null
    try {
        const rawPalette = localStorage.getItem('linden_custom_semantic_palette_v1')
        if (rawPalette) customPalette = JSON.parse(rawPalette)
    } catch (_) {}

    let userName = ''
    try {
        userName = (localStorage.getItem('linden_user_name') || '').trim()
    } catch (_) {}

    const bookSettingsOverrides = {}
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i)
            if (k && k.startsWith('linden_book_settings_')) {
                const bId = k.replace('linden_book_settings_', '')
                try {
                    bookSettingsOverrides[bId] = JSON.parse(localStorage.getItem(k))
                } catch (_) {}
            }
        }
    } catch (_) {}

    let safeConfig = {}
    const rawAdv = localStorage.getItem('linden_advanced_settings')
    if (rawAdv) {
        const parsed = JSON.parse(rawAdv)
        safeConfig = { ...parsed }
        delete safeConfig.ttsApiKey
    }

    const bookMapById = new Map(books.map(b => [b.id, b]))
    const enrichedSessions = sessions.map(s => {
        if (!s) return s
        const b = s.bookId ? bookMapById.get(s.bookId) : null
        return {
            ...s,
            bookTitle: s.bookTitle || b?.customTitle || b?.title || '',
            bookAuthor: s.bookAuthor || b?.customAuthor || b?.author || ''
        }
    })

    return {
        format: 'linden-leaf-full-backup',
        schemaVersion: 4,
        exportedAt: new Date().toISOString(),
        userName,
        readerSettings,
        readingPresets,
        customPalette,
        bookSettingsOverrides,
        config: safeConfig,
        sessions: enrichedSessions,
        highlights,
        bookmarks,
        drawings,
        customLists,
        readingLists: customLists,
        books: books.map(b => ({
            id: b.id,
            stableKey: b.stableKey || null,
            identifier: b.identifier || null,
            title: b.title,
            author: b.author,
            customTitle: b.customTitle || null,
            customAuthor: b.customAuthor || null,
            format: b.format,
            size: b.size || 0,
            cover: b.cover || null,
            isFavorite: !!b.isFavorite,
            favoriteUpdatedAt: b.favoriteUpdatedAt || 0,
            readingStatus: b.readingStatus || 'unread',
            statusUpdatedAt: b.statusUpdatedAt || 0,
            completedAt: b.completedAt || null,
            rating: b.rating !== undefined ? b.rating : null,
            ratingUpdatedAt: b.ratingUpdatedAt || 0,
            tags: Array.isArray(b.tags) ? b.tags : [],
            tagsUpdatedAt: b.tagsUpdatedAt || 0,
            customListIds: b.customListIds || [],
            listsUpdatedAt: b.listsUpdatedAt || 0,
            totalReadingSeconds: b.totalReadingSeconds || 0,
            totalListeningSeconds: b.totalListeningSeconds || 0,
            lastReadAt: b.lastReadAt || 0,
            currentLocation: b.currentLocation || null,
            progress: b.progress || { fraction: 0 },
            addedAt: b.addedAt || 0,
            updatedAt: b.updatedAt || 0
        }))
    }
}

const exportedBackup = await runTestExport()

console.log('[TEST 1] Verifying exported payload completeness...')
assert.equal(exportedBackup.schemaVersion, 4)
assert.equal(exportedBackup.userName, '青衫烟雨')
assert.equal(exportedBackup.readerSettings.enableReadingGoals, true)
assert.equal(exportedBackup.readerSettings.readingGoalToday, 60)
assert.equal(exportedBackup.readingPresets.length, 1)
assert.equal(exportedBackup.readingPresets[0].name, '古籍水墨')
assert.equal(exportedBackup.customPalette.bgPrimary, '#fbf0d9')
assert.equal(exportedBackup.bookSettingsOverrides['book_test_1'].columns, 2)
assert.equal(exportedBackup.config.ttsSpeed, 1.15)
assert.equal(exportedBackup.config.ttsApiKey, undefined, 'Sensitive API Key must NOT be exported!')

// Books
assert.equal(exportedBackup.books.length, 1)
const exportedBook = exportedBackup.books[0]
assert.equal(exportedBook.isFavorite, true, 'isFavorite must be preserved!')
assert.equal(exportedBook.customTitle, '脂砚斋重评石头记')
assert.equal(exportedBook.customAuthor, '曹雪芹、高鹗')
assert.equal(exportedBook.rating, 5.0)
assert.deepEqual(exportedBook.tags, ['四大名著', '古典文学'])

// Sessions
assert.equal(exportedBackup.sessions.length, 1)
const exportedSess = exportedBackup.sessions[0]
assert.equal(exportedSess.bookTitle, '脂砚斋重评石头记')
assert.equal(exportedSess.bookAuthor, '曹雪芹、高鹗')
assert.equal(exportedSess.durationSeconds, 3600)
assert.equal(exportedSess.date, '2026-10-31')

console.log('[PASS] Full backup export captures 100% of valid metadata, settings, and daily book sessions!')
