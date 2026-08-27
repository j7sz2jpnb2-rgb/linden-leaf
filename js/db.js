// db.js - IndexedDB storage wrapper for Universal E-Book Reader (with WeChat Read Statistics)

const DB_NAME = 'UniversalReaderDB'
const DB_VERSION = 5

let dbInstance = null

// Helper: Format Date to local 'YYYY-MM-DD'
export const toLocalDateKey = (dateInput = new Date()) => {
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput)
    if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

export const openDB = () => {
    if (dbInstance) return Promise.resolve(dbInstance)
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        
        req.onupgradeneeded = e => {
            const db = e.target.result
            
            // Store for Books (Metadata only)
            if (!db.objectStoreNames.contains('books')) {
                const bookStore = db.createObjectStore('books', { keyPath: 'id' })
                bookStore.createIndex('addedAt', 'addedAt', { unique: false })
                bookStore.createIndex('lastReadAt', 'lastReadAt', { unique: false })
            }

            // Store for Book Binary Files (Separated from metadata to prevent OOM)
            if (!db.objectStoreNames.contains('book_files')) {
                db.createObjectStore('book_files', { keyPath: 'id' })
            }

            // Store for Bookmarks
            if (!db.objectStoreNames.contains('bookmarks')) {
                const bmStore = db.createObjectStore('bookmarks', { keyPath: 'id' })
                bmStore.createIndex('bookId', 'bookId', { unique: false })
            }

            // Store for Highlights & Notes
            if (!db.objectStoreNames.contains('highlights')) {
                const hlStore = db.createObjectStore('highlights', { keyPath: 'id' })
                hlStore.createIndex('bookId', 'bookId', { unique: false })
            }

            // Store for App Settings & State
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings', { keyPath: 'key' })
            }

            // Store for Reading Sessions (WeChat Read style logs)
            if (!db.objectStoreNames.contains('reading_sessions')) {
                const sessionStore = db.createObjectStore('reading_sessions', { keyPath: 'id' })
                sessionStore.createIndex('bookId', 'bookId', { unique: false })
                sessionStore.createIndex('date', 'date', { unique: false })
                sessionStore.createIndex('startTime', 'startTime', { unique: false })
            }

            // Store for Custom Reading Lists
            if (!db.objectStoreNames.contains('custom_lists')) {
                const listStore = db.createObjectStore('custom_lists', { keyPath: 'id' })
                listStore.createIndex('createdAt', 'createdAt', { unique: false })
            }

            // Store for Deletion Tombstones (Cloud Sync Deletion Propagation)
            if (!db.objectStoreNames.contains('deleted_records')) {
                const delStore = db.createObjectStore('deleted_records', { keyPath: 'id' })
                delStore.createIndex('type', 'type', { unique: false })
                delStore.createIndex('deletedAt', 'deletedAt', { unique: false })
            }

            // Migrate DB_VERSION < 4 records (strip blob from books and save to book_files)
            if (e.oldVersion < 4 && e.oldVersion > 0) {
                try {
                    const tx = e.target.transaction
                    const bookStore = tx.objectStore('books')
                    const fileStore = tx.objectStore('book_files')
                    const cursorReq = bookStore.openCursor()
                    cursorReq.onsuccess = ev => {
                        const cursor = ev.target.result
                        if (cursor) {
                            const val = cursor.value
                            if (val && val.blob) {
                                fileStore.put({ id: val.id, blob: val.blob })
                                delete val.blob
                                cursor.update(val)
                            }
                            cursor.continue()
                        }
                    }
                } catch (err) {
                    console.warn('[DB Upgrade] Migration error:', err)
                }
            }
        }

        req.onblocked = () => {
            console.warn('IndexedDB upgrade blocked by another open tab or instance.')
        }

        req.onsuccess = e => {
            dbInstance = e.target.result
            dbInstance.onversionchange = () => {
                dbInstance.close()
                dbInstance = null
                console.warn('IndexedDB version changed; connection closed.')
            }
            resolve(dbInstance)
        }

        req.onerror = e => {
            console.error('IndexedDB open error:', e)
            reject(req.error || e)
        }
    })
}

// Books CRUD
export const saveBook = async bookData => {
    const db = await openDB()
    const { blob, ...meta } = bookData

    return new Promise((resolve, reject) => {
        const storeNames = blob ? ['books', 'book_files'] : ['books']
        const tx = db.transaction(storeNames, 'readwrite')
        const bookStore = tx.objectStore('books')

        if (meta.title != null) {
            if (meta.totalReadingSeconds == null) meta.totalReadingSeconds = 0
            if (!meta.addedAt) meta.addedAt = Date.now()
            if (!meta.lastReadAt) meta.lastReadAt = meta.addedAt
            bookStore.put(meta)
        } else if (meta.id) {
            // Partial metadata update or only file blob update
            const getReq = bookStore.get(meta.id)
            getReq.onsuccess = () => {
                const existing = getReq.result
                if (existing) {
                    Object.assign(existing, meta)
                    bookStore.put(existing)
                }
            }
        }

        if (blob && meta.id) {
            tx.objectStore('book_files').put({ id: meta.id, blob })
        }
        tx.oncomplete = () => resolve(meta.id)
        tx.onerror = () => reject(tx.error || new Error('Failed to save book'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'))
    })
}

export const getBookFileBlob = async id => {
    if (!id) return null
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(['book_files', 'books'], 'readonly')
            const fileStore = tx.objectStore('book_files')
            const req = fileStore.get(id)
            req.onsuccess = () => {
                if (req.result && req.result.blob) {
                    resolve(req.result.blob)
                } else {
                    // Fallback to legacy books table
                    const bookReq = tx.objectStore('books').get(id)
                    bookReq.onsuccess = () => {
                        resolve(bookReq.result?.blob || null)
                    }
                    bookReq.onerror = () => resolve(null)
                }
            }
            req.onerror = () => resolve(null)
        } catch (e) {
            resolve(null)
        }
    })
}
export const getBookBlob = getBookFileBlob
export const getBookFile = getBookFileBlob

export const getBook = async id => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readonly')
        const store = tx.objectStore('books')
        const req = store.get(id)
        req.onsuccess = () => resolve(req.result || null)
        req.onerror = () => reject(req.error || new Error(`Failed to get book ${id}`))
    })
}

export const getAllBooks = async () => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readonly')
        const store = tx.objectStore('books')
        const req = store.getAll()
        req.onsuccess = () => {
            const list = req.result || []
            list.sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0))
            resolve(list)
        }
        req.onerror = () => reject(req.error || new Error('Failed to get all books'))
    })
}

export const updateBookProgress = async (id, progressData) => {
    if (!id) return null
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readwrite')
        const store = tx.objectStore('books')
        const getReq = store.get(id)
        getReq.onsuccess = () => {
            const book = getReq.result
            if (!book) return resolve(null)
            book.progress = progressData
            book.lastReadAt = Date.now()
            store.put(book)
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed to update progress'))
    })
}

export const updateBookReadingTime = async (id, addedSeconds) => {
    if (!id || !addedSeconds || addedSeconds <= 0) return
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readwrite')
        const store = tx.objectStore('books')
        const getReq = store.get(id)
        getReq.onsuccess = () => {
            const book = getReq.result
            if (!book) return resolve(null)
            book.totalReadingSeconds = (book.totalReadingSeconds || 0) + addedSeconds
            book.lastReadAt = Date.now()
            store.put(book)
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed to update reading time'))
    })
}

export const updateBookMetadata = async (id, { title, author }) => {
    if (!id) return null
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readwrite')
        const store = tx.objectStore('books')
        const getReq = store.get(id)
        getReq.onsuccess = () => {
            const book = getReq.result
            if (!book) return resolve(null)
            if (title != null) book.title = title.trim()
            if (author != null) book.author = author.trim()
            book.updatedAt = Date.now()
            store.put(book)
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed to update book metadata'))
    })
}

export const toggleBookFavorite = async id => {
    if (!id) return false
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('books', 'readwrite')
        const store = tx.objectStore('books')
        const getReq = store.get(id)
        let isFav = false
        getReq.onsuccess = () => {
            const book = getReq.result
            if (!book) return
            book.isFavorite = !book.isFavorite
            book.favoriteUpdatedAt = Date.now()
            book.updatedAt = Date.now()
            isFav = book.isFavorite
            store.put(book)
        }
        tx.oncomplete = () => resolve(isFav)
        tx.onerror = () => reject(tx.error || new Error('Failed to toggle book favorite'))
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'))
    })
}

export const deleteBook = async id => {
    if (!id) return false
    const db = await openDB()
    return new Promise((resolve, reject) => {
        try {
            const storeNames = db.objectStoreNames.contains('deleted_records')
                ? ['books', 'book_files', 'bookmarks', 'highlights', 'deleted_records']
                : ['books', 'book_files', 'bookmarks', 'highlights']
            const tx = db.transaction(storeNames, 'readwrite')
            
            // Delete main book entry and binary blob file
            tx.objectStore('books').delete(id)
            tx.objectStore('book_files').delete(id)
            if (storeNames.includes('deleted_records')) {
                tx.objectStore('deleted_records').put({ id, type: 'book', deletedAt: Date.now() })
            }
            
            // Safely clean up associated bookmarks and highlights
            // Note: reading_sessions are PERMANENT user statistics logs and are NEVER purged on book removal!
            const cleanStoreByIndex = (storeName, indexName) => {
                try {
                    const store = tx.objectStore(storeName)
                    const index = store.index(indexName)
                    const req = index.getAllKeys(id)
                    req.onsuccess = () => {
                        const keys = req.result || []
                        for (const key of keys) {
                            store.delete(key)
                            if (storeNames.includes('deleted_records')) {
                                tx.objectStore('deleted_records').put({ id: key, type: storeName, deletedAt: Date.now() })
                            }
                        }
                    }
                } catch (e) {
                    console.warn(`[deleteBook] Clean ${storeName} error:`, e)
                }
            }

            cleanStoreByIndex('bookmarks', 'bookId')
            cleanStoreByIndex('highlights', 'bookId')

            tx.oncomplete = () => resolve(true)
            tx.onerror = () => reject(tx.error || new Error(`Failed to delete book ${id}`))
            tx.onabort = () => reject(tx.error || new Error(`Delete transaction aborted for book ${id}`))
        } catch (err) {
            reject(err)
        }
    })
}

// Highlights & Notes
export const saveHighlight = async highlight => {
    if (!highlight || !highlight.id) return null
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = db.objectStoreNames.contains('deleted_records') ? ['highlights', 'deleted_records'] : ['highlights']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('highlights')
        store.put(highlight)
        if (storeNames.includes('deleted_records')) {
            tx.objectStore('deleted_records').delete(highlight.id)
        }
        tx.oncomplete = () => resolve(highlight.id)
        tx.onerror = () => reject(tx.error || new Error('Failed to save highlight'))
    })
}

export const getHighlightsByBook = async bookId => {
    if (!bookId) return []
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('highlights', 'readonly')
        const index = tx.objectStore('highlights').index('bookId')
        const req = index.getAll(bookId)
        req.onsuccess = () => resolve(req.result || [])
        req.onerror = () => reject(req.error || new Error('Failed to get highlights'))
    })
}

export const getAllHighlights = async () => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('highlights', 'readonly')
        const store = tx.objectStore('highlights')
        const req = store.getAll()
        req.onsuccess = () => resolve(req.result || [])
        req.onerror = () => reject(req.error || new Error('Failed to get all highlights'))
    })
}

export const deleteHighlight = async id => {
    if (!id) return false
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = db.objectStoreNames.contains('deleted_records') ? ['highlights', 'deleted_records'] : ['highlights']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('highlights')
        store.delete(id)
        if (storeNames.includes('deleted_records')) {
            tx.objectStore('deleted_records').put({ id, type: 'highlight', deletedAt: Date.now() })
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed to delete highlight'))
    })
}

// Bookmarks
export const saveBookmark = async bookmark => {
    if (!bookmark || !bookmark.id) return null
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = db.objectStoreNames.contains('deleted_records') ? ['bookmarks', 'deleted_records'] : ['bookmarks']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('bookmarks')
        store.put(bookmark)
        if (storeNames.includes('deleted_records')) {
            tx.objectStore('deleted_records').delete(bookmark.id)
        }
        tx.oncomplete = () => resolve(bookmark.id)
        tx.onerror = () => reject(tx.error || new Error('Failed to save bookmark'))
    })
}

export const getBookmarksByBook = async bookId => {
    if (!bookId) return []
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('bookmarks', 'readonly')
        const index = tx.objectStore('bookmarks').index('bookId')
        const req = index.getAll(bookId)
        req.onsuccess = () => resolve(req.result || [])
        req.onerror = () => reject(req.error || new Error('Failed to get bookmarks'))
    })
}

export const getAllBookmarks = async () => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('bookmarks', 'readonly')
        const store = tx.objectStore('bookmarks')
        const req = store.getAll()
        req.onsuccess = () => resolve(req.result || [])
        req.onerror = () => reject(req.error || new Error('Failed to get all bookmarks'))
    })
}

export const deleteBookmark = async id => {
    if (!id) return false
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = db.objectStoreNames.contains('deleted_records') ? ['bookmarks', 'deleted_records'] : ['bookmarks']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('bookmarks')
        store.delete(id)
        if (storeNames.includes('deleted_records')) {
            tx.objectStore('deleted_records').put({ id, type: 'bookmark', deletedAt: Date.now() })
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed to delete bookmark'))
    })
}

// Settings
export const getSetting = async (key, defaultValue = null) => {
    const db = await openDB()
    return new Promise(resolve => {
        const tx = db.transaction('settings', 'readonly')
        const req = tx.objectStore('settings').get(key)
        req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue)
        req.onerror = () => resolve(defaultValue)
    })
}

export const setSetting = async (key, value) => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite')
        tx.objectStore('settings').put({ key, value })
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed to save setting'))
    })
}

// ==========================================
// Reading Sessions & WeChat Read Analytics
// ==========================================
export const recordReadingSession = async (session, updateBookTotal = true) => {
    if (!session || !session.id) return null
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = updateBookTotal ? ['reading_sessions', 'books'] : ['reading_sessions']
        const tx = db.transaction(storeNames, 'readwrite')
        const sessStore = tx.objectStore('reading_sessions')
        const bookStore = updateBookTotal ? tx.objectStore('books') : null

        const getSessReq = sessStore.get(session.id)
        getSessReq.onsuccess = () => {
            const existing = getSessReq.result
            const prevDuration = (existing && existing.durationSeconds) ? existing.durationSeconds : 0
            const delta = Math.max(0, (session.durationSeconds || 0) - prevDuration)
            
            sessStore.put(session)

            // Increment book totalReadingSeconds only in normal reading (not cloud sync replay)
            if (updateBookTotal && session.bookId && delta > 0 && bookStore) {
                const getBookReq = bookStore.get(session.bookId)
                getBookReq.onsuccess = () => {
                    const book = getBookReq.result
                    if (book) {
                        book.totalReadingSeconds = (book.totalReadingSeconds || 0) + delta
                        book.lastReadAt = Date.now()
                        bookStore.put(book)
                    }
                }
            }
        }

        tx.oncomplete = () => resolve(session.id)
        tx.onerror = () => reject(tx.error || new Error('Failed to record session'))
    })
}

export const saveReadingSession = recordReadingSession

export const getAllReadingSessions = async () => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('reading_sessions', 'readonly')
        const store = tx.objectStore('reading_sessions')
        const req = store.getAll()
        req.onsuccess = () => {
            const list = req.result || []
            list.sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
            resolve(list)
        }
        req.onerror = () => reject(req.error || new Error('Failed to get sessions'))
    })
}

// Calculate WeChat Read Full Statistics (Supports Week, Month, Year, Total views)
export const getReadingStats = async (viewMode = 'month', targetYear = new Date().getFullYear(), targetMonth = new Date().getMonth() + 1) => {
    const allRawSessions = await getAllReadingSessions()
    const sessions = allRawSessions.filter(s => s && (s.durationSeconds || 0) >= 60)
    const books = await getAllBooks()
    const highlights = await getAllHighlights()

    const now = new Date()
    const todayStr = toLocalDateKey(now)
    let totalSeconds = 0
    const dailyMap = {} // 'YYYY-MM-DD' -> seconds
    const monthlyMap = {} // 'YYYY-MM' -> seconds
    const yearlyMap = {} // 'YYYY' -> seconds
    const activeDates = new Set()
    let earliestTime = now.getTime()

    for (const sess of sessions) {
        const dur = sess.durationSeconds || 0
        totalSeconds += dur
        const d = sess.date || toLocalDateKey(sess.startTime || now)
        dailyMap[d] = (dailyMap[d] || 0) + dur
        const ym = d.slice(0, 7)
        monthlyMap[ym] = (monthlyMap[ym] || 0) + dur
        const y = d.slice(0, 4)
        yearlyMap[y] = (yearlyMap[y] || 0) + dur

        if (dur >= 60) {
            activeDates.add(d)
        }
        if (sess.startTime && sess.startTime < earliestTime) {
            earliestTime = sess.startTime
        }
    }

    // Include book totalReadingSeconds fallback if sessions store is empty
    if (sessions.length === 0) {
        for (const b of books) {
            if (b.totalReadingSeconds && b.totalReadingSeconds > 0) {
                const bTime = b.lastReadAt || b.addedAt || now.getTime()
                const d = toLocalDateKey(bTime)
                dailyMap[d] = (dailyMap[d] || 0) + b.totalReadingSeconds
                const ym = d.slice(0, 7)
                monthlyMap[ym] = (monthlyMap[ym] || 0) + b.totalReadingSeconds
                const y = d.slice(0, 4)
                yearlyMap[y] = (yearlyMap[y] || 0) + b.totalReadingSeconds
                if (b.totalReadingSeconds >= 30) activeDates.add(d)
                if (bTime < earliestTime) earliestTime = bTime
                totalSeconds += b.totalReadingSeconds
            }
        }
    }

    let totalBookFallback = 0
    for (const b of books) {
        if (b.totalReadingSeconds && b.totalReadingSeconds > 0) {
            totalBookFallback += b.totalReadingSeconds
        }
    }
    const finalTotalSeconds = Math.max(totalSeconds, totalBookFallback)

    // Calculate true consecutive reading streak days
    let streakDays = 0
    const todayKey = todayStr
    const yesterdayDate = new Date(now)
    yesterdayDate.setDate(yesterdayDate.getDate() - 1)
    const yesterdayKey = toLocalDateKey(yesterdayDate)

    let curCheck = new Date(now)
    if (activeDates.has(todayKey)) {
        streakDays = 1
        curCheck.setDate(curCheck.getDate() - 1)
    } else if (activeDates.has(yesterdayKey)) {
        curCheck = yesterdayDate
    }

    if (activeDates.has(todayKey) || activeDates.has(yesterdayKey)) {
        while (true) {
            const k = toLocalDateKey(curCheck)
            if (activeDates.has(k)) {
                if (k !== todayKey) streakDays++
                curCheck.setDate(curCheck.getDate() - 1)
            } else {
                break
            }
        }
    }

    // 1. Overall Stats
    const todaySeconds = dailyMap[todayStr] || 0
    const finishedCount = books.filter(b => b.progress?.fraction && b.progress.fraction >= 0.99).length
    const companionDays = Math.max(1, Math.floor((now.getTime() - earliestTime) / (86400 * 1000)) + 1)

    // 2. View Specific Distribution Charts
    let chartData = []
    let viewTotalSeconds = 0
    let peakInfo = { label: '', timeStr: '', seconds: 0 }
    let viewReadDays = 0
    let weekDateRangeStr = ''

    if (viewMode === 'week') {
        // Monday through Sunday of current week in LOCAL time
        const curDay = now.getDay() || 7 // 1 (Mon) to 7 (Sun)
        const monday = new Date(now)
        monday.setDate(now.getDate() - curDay + 1)
        monday.setHours(0, 0, 0, 0)
        const sunday = new Date(monday)
        sunday.setDate(monday.getDate() + 6)
        weekDateRangeStr = `${monday.getMonth() + 1}月${monday.getDate()}日 - ${sunday.getMonth() + 1}月${sunday.getDate()}日`
        const weekLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

        for (let i = 0; i < 7; i++) {
            const d = new Date(monday)
            d.setDate(monday.getDate() + i)
            const dateStr = toLocalDateKey(d)
            const secs = dailyMap[dateStr] || 0
            viewTotalSeconds += secs
            if (secs >= 60) viewReadDays++
            const mins = Math.floor(secs / 60)
            if (secs > peakInfo.seconds) {
                peakInfo = { label: `${weekLabels[i]}阅读最久`, timeStr: mins >= 60 ? `${Math.floor(mins/60)}小时${mins%60}分` : `${mins}分钟`, seconds: secs }
            }
            chartData.push({
                label: weekLabels[i],
                subLabel: `${d.getMonth() + 1}/${d.getDate()}`,
                fullDate: `${d.getMonth() + 1}月${d.getDate()}日 (${weekLabels[i]})`,
                seconds: secs,
                minutes: mins,
                isCurrent: dateStr === todayStr
            })
        }
    } else if (viewMode === 'month') {
        // 1 to N days of target month in LOCAL time
        const daysInMonth = new Date(targetYear, targetMonth, 0).getDate()
        const curMonthStr = `${targetYear}-${String(targetMonth).padStart(2, '0')}`

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${curMonthStr}-${String(day).padStart(2, '0')}`
            const secs = dailyMap[dateStr] || 0
            viewTotalSeconds += secs
            if (secs >= 60) viewReadDays++
            const mins = Math.floor(secs / 60)
            if (secs > peakInfo.seconds) {
                peakInfo = { label: `${day}日阅读最久`, timeStr: mins >= 60 ? `${Math.floor(mins/60)}小时${mins%60}分` : `${mins}分钟`, seconds: secs }
            }
            chartData.push({
                label: `${day}`,
                fullDate: `${targetMonth}月${day}日`,
                seconds: secs,
                minutes: mins,
                isCurrent: dateStr === todayStr && targetYear === now.getFullYear() && targetMonth === (now.getMonth() + 1),
                isKeyTick: day === 1 || day === 5 || day === 10 || day === 15 || day === 20 || day === 25 || day === daysInMonth
            })
        }
    } else if (viewMode === 'year') {
        // Count active days in this year
        const yearPrefix = `${targetYear}-`
        for (const [d, s] of Object.entries(dailyMap)) {
            if (d.startsWith(yearPrefix) && s >= 60) {
                viewReadDays++
            }
        }
        // 1 to 12 months of target year
        for (let m = 1; m <= 12; m++) {
            const ym = `${targetYear}-${String(m).padStart(2, '0')}`
            const secs = monthlyMap[ym] || 0
            viewTotalSeconds += secs
            const mins = Math.floor(secs / 60)
            if (secs > peakInfo.seconds) {
                peakInfo = { label: `${m}月阅读最久`, timeStr: mins >= 60 ? `${Math.floor(mins/60)}小时${mins%60}分` : `${mins}分钟`, seconds: secs }
            }
            chartData.push({
                label: `${m}月`,
                fullDate: `${targetYear}年${m}月`,
                seconds: secs,
                minutes: mins,
                isCurrent: m === (now.getMonth() + 1) && targetYear === now.getFullYear()
            })
        }
    } else if (viewMode === 'total') {
        viewReadDays = activeDates.size
        // Multi-year distribution
        const startY = Math.min(new Date(earliestTime).getFullYear(), now.getFullYear() - 3)
        const endY = now.getFullYear()
        for (let y = startY; y <= endY; y++) {
            const secs = yearlyMap[String(y)] || 0
            viewTotalSeconds += secs
            const mins = Math.floor(secs / 60)
            if (secs > peakInfo.seconds) {
                peakInfo = { label: `${y}年阅读最久`, timeStr: mins >= 60 ? `${Math.floor(mins/60)}小时${mins%60}分` : `${mins}分钟`, seconds: secs }
            }
            chartData.push({
                label: `${y}年`,
                fullDate: `${y}年`,
                seconds: secs,
                minutes: mins,
                isCurrent: y === endY
            })
        }
    }

    // Filter sessions belonging to the current viewMode period
    const isSessInPeriod = (s) => {
        if (!s) return false
        const d = s.date || toLocalDateKey(s.startTime || now)
        if (viewMode === 'week') {
            const mondayKey = toLocalDateKey(monday)
            const sundayKey = toLocalDateKey(sunday)
            return d >= mondayKey && d <= sundayKey
        }
        if (viewMode === 'month') {
            const ym = `${targetYear}-${String(targetMonth).padStart(2, '0')}`
            return d.startsWith(ym)
        }
        if (viewMode === 'year') {
            return d.startsWith(`${targetYear}-`)
        }
        return true // 'total'
    }

    const periodSessions = sessions.filter(isSessInPeriod)
    const periodBookDurationMap = new Map()
    periodSessions.forEach(s => {
        if (s.bookId) {
            periodBookDurationMap.set(s.bookId, (periodBookDurationMap.get(s.bookId) || 0) + (s.durationSeconds || 0))
        }
    })

    let periodBooks = []
    if (periodBookDurationMap.size > 0) {
        periodBooks = books
            .filter(b => periodBookDurationMap.has(b.id))
            .map(b => ({
                ...b,
                periodReadingSeconds: periodBookDurationMap.get(b.id) || 0
            }))
            .sort((a, b) => b.periodReadingSeconds - a.periodReadingSeconds)
    } else {
        // Fallback: books with totalReadingSeconds > 0
        periodBooks = books
            .filter(b => (b.totalReadingSeconds || 0) > 0)
            .map(b => ({
                ...b,
                periodReadingSeconds: b.totalReadingSeconds || 0
            }))
            .sort((a, b) => b.periodReadingSeconds - a.periodReadingSeconds)
    }

    const periodFinishedBooks = periodBooks.filter(b => (b.progress?.fraction || 0) >= 0.99 || b.isFinished)

    const periodHighlights = highlights.filter(h => {
        if (!h) return false
        const hTime = h.createdAt || h.updatedAt || 0
        const d = toLocalDateKey(hTime)
        if (viewMode === 'week') {
            const mondayKey = toLocalDateKey(monday)
            const sundayKey = toLocalDateKey(sunday)
            return d >= mondayKey && d <= sundayKey
        }
        if (viewMode === 'month') {
            const ym = `${targetYear}-${String(targetMonth).padStart(2, '0')}`
            return d.startsWith(ym)
        }
        if (viewMode === 'year') {
            return d.startsWith(`${targetYear}-`)
        }
        return true
    })

    const topBooks = [...books].sort((a, b) => (b.totalReadingSeconds || 0) - (a.totalReadingSeconds || 0))

    return {
        viewMode,
        targetYear,
        targetMonth,
        weekDateRangeStr,
        todaySeconds,
        todayMinutes: Math.round(todaySeconds / 60),
        viewTotalSeconds,
        viewHours: Math.floor(viewTotalSeconds / 3600),
        viewMins: Math.floor((viewTotalSeconds % 3600) / 60),
        viewReadDays,
        totalSeconds: finalTotalSeconds,
        totalHours: parseFloat((finalTotalSeconds / 3600).toFixed(1)),
        streakDays,
        activeDaysCount: activeDates.size,
        companionDays,
        earliestDateStr: new Date(earliestTime).toLocaleDateString('zh-CN'),
        finishedCount,
        totalBooksCount: books.length,
        totalHighlightsCount: highlights.length,
        periodBooks,
        periodBooksCount: periodBooks.length,
        periodFinishedBooks,
        periodFinishedCount: periodFinishedBooks.length,
        periodHighlights,
        periodHighlightsCount: periodHighlights.length,
        chartData,
        peakInfo: peakInfo.seconds > 0 ? peakInfo : null,
        topBooks: topBooks.slice(0, 10),
        recentSessions: sessions.slice(0, 15)
    }
}

// ==========================================================
// Custom Reading Lists CRUD
// ==========================================================

export const saveCustomList = async listData => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = db.objectStoreNames.contains('deleted_records') ? ['custom_lists', 'deleted_records'] : ['custom_lists']
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore('custom_lists')
        if (!listData.id) {
            listData.id = `list_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        }
        if (!listData.createdAt) listData.createdAt = Date.now()
        listData.updatedAt = Date.now()
        store.put(listData)
        if (storeNames.includes('deleted_records')) {
            tx.objectStore('deleted_records').delete(listData.id)
        }
        tx.oncomplete = () => resolve(listData)
        tx.onerror = () => reject(tx.error || new Error('Failed to save custom list'))
    })
}

export const getAllCustomLists = async () => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('custom_lists', 'readonly')
        const store = tx.objectStore('custom_lists')
        const req = store.getAll()
        req.onsuccess = async () => {
            let list = req.result || []
            // Initialize default lists if empty
            if (list.length === 0) {
                const defaultLists = [
                    { id: 'list_unread', name: '待读清单', icon: '📌', color: '#8b5cf6', isBuiltIn: true, createdAt: 1, updatedAt: 1 },
                    { id: 'list_recommend', name: '2026 必读书单', icon: '🌟', color: '#f59e0b', isBuiltIn: false, createdAt: 2, updatedAt: 2 },
                    { id: 'list_study', name: '专业研读与工作', icon: '📜', color: '#3b82f6', isBuiltIn: false, createdAt: 3, updatedAt: 3 }
                ]
                for (const d of defaultLists) {
                    await saveCustomList(d)
                }
                list = defaultLists
            }
            list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
            resolve(list)
        }
        req.onerror = () => reject(req.error || new Error('Failed to get custom lists'))
    })
}

export const deleteCustomList = async id => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const storeNames = db.objectStoreNames.contains('deleted_records')
            ? ['books', 'custom_lists', 'deleted_records']
            : ['books', 'custom_lists']
        const tx = db.transaction(storeNames, 'readwrite')
        const bookStore = tx.objectStore('books')
        const listStore = tx.objectStore('custom_lists')
        listStore.delete(id)
        if (storeNames.includes('deleted_records')) {
            tx.objectStore('deleted_records').put({ id, type: 'custom_list', deletedAt: Date.now() })
        }
        
        const req = bookStore.openCursor()
        req.onsuccess = e => {
            const cursor = e.target.result
            if (cursor) {
                const book = cursor.value
                if (book.customListIds && book.customListIds.includes(id)) {
                    book.customListIds = book.customListIds.filter(lid => lid !== id)
                    book.listsUpdatedAt = Date.now()
                    cursor.update(book)
                }
                cursor.continue()
            }
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error(`Failed to delete list ${id}`))
    })
}

export const updateCustomList = async (id, updateData) => {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction('custom_lists', 'readwrite')
        const store = tx.objectStore('custom_lists')
        const getReq = store.get(id)
        getReq.onsuccess = () => {
            const item = getReq.result
            if (!item) return resolve(null)
            Object.assign(item, updateData, { updatedAt: Date.now() })
            store.put(item)
        }
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(tx.error || new Error('Failed to update custom list'))
    })
}

// ==========================================================
// Tombstone & Cloud Deletion Records
// ==========================================================

export const getAllDeletedRecords = async () => {
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('deleted_records')) return resolve([])
            const tx = db.transaction('deleted_records', 'readonly')
            const req = tx.objectStore('deleted_records').getAll()
            req.onsuccess = () => resolve(req.result || [])
            req.onerror = () => resolve([])
        } catch (e) {
            resolve([])
        }
    })
}

export const recordDeletedItem = async (id, type) => {
    if (!id) return false
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('deleted_records')) return resolve(false)
            const tx = db.transaction('deleted_records', 'readwrite')
            tx.objectStore('deleted_records').put({ id, type, deletedAt: Date.now() })
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => resolve(false)
        } catch (e) {
            resolve(false)
        }
    })
}

export const removeDeletedRecord = async (id) => {
    if (!id) return false
    const db = await openDB()
    return new Promise((resolve) => {
        try {
            if (!db.objectStoreNames.contains('deleted_records')) return resolve(true)
            const tx = db.transaction('deleted_records', 'readwrite')
            tx.objectStore('deleted_records').delete(id)
            tx.oncomplete = () => resolve(true)
            tx.onerror = () => resolve(false)
        } catch (e) {
            resolve(false)
        }
    })
}

export const setBookLists = async (bookId, listIds) => {
    const book = await getBook(bookId)
    if (!book) return false
    book.customListIds = Array.isArray(listIds) ? listIds : []
    await saveBook(book)
    return true
}

export const addBookToList = async (bookId, listId) => {
    const book = await getBook(bookId)
    if (!book) return false
    if (!book.customListIds) book.customListIds = []
    if (!book.customListIds.includes(listId)) {
        book.customListIds.push(listId)
        await saveBook(book)
    }
    return true
}

export const removeBookFromList = async (bookId, listId) => {
    const book = await getBook(bookId)
    if (!book || !book.customListIds) return false
    book.customListIds = book.customListIds.filter(id => id !== listId)
    await saveBook(book)
    return true
}
