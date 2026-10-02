// assign a unique ID for each TOC item
const assignIDs = toc => {
    let id = 0
    const assignID = item => {
        item.id = id++
        if (item.subitems) for (const subitem of item.subitems) assignID(subitem)
    }
    for (const item of toc) assignID(item)
    return toc
}

const flatten = items => items
    .map(item => item.subitems?.length
        ? [item, flatten(item.subitems)].flat()
        : item)
    .flat()

export class TOCProgress {
    async init({ toc, ids, splitHref, getFragment }) {
        assignIDs(toc)
        const items = flatten(toc)
        const grouped = new Map()
        for (const [i, item] of items.entries()) {
            const [id, fragment] = await splitHref(item?.href) ?? []
            const value = { fragment, item }
            if (grouped.has(id)) grouped.get(id).items.push(value)
            else grouped.set(id, { prev: items[i - 1], items: [value] })
        }
        const map = new Map()
        for (const [i, id] of ids.entries()) {
            if (grouped.has(id)) map.set(id, grouped.get(id))
            else map.set(id, map.get(ids[i - 1]))
        }
        this.ids = ids
        this.map = map
        this.getFragment = getFragment
    }
    getProgress(index, range) {
        if (!this.ids) return
        const id = this.ids[index]
        const obj = this.map.get(id)
        if (!obj) return null
        const { prev, items } = obj
        if (!items) return prev
        if (!range || items.length === 1 && !items[0].fragment) return items[0].item

        const doc = range.startContainer.getRootNode()
        for (const [i, { fragment }] of items.entries()) {
            const el = this.getFragment(doc, fragment)
            if (!el) continue
            if (range.comparePoint(el, 0) > 0)
                return (items[i - 1]?.item ?? prev)
        }
        return items[items.length - 1].item
    }
}

export class SectionProgress {
    constructor(sections, sizePerLoc, sizePerTimeUnit) {
        this.sizes = sections.map(s => s.linear != 'no' && s.size > 0 ? s.size : 0)
        this.sizePerLoc = sizePerLoc
        this.sizePerTimeUnit = sizePerTimeUnit
        this.sizeTotal = this.sizes.reduce((a, b) => a + b, 0)
        this.sectionFractions = this.#getSectionFractions()
    }
    #getSectionFractions() {
        const { sizeTotal } = this
        if (!sizeTotal || sizeTotal <= 0) {
            const count = this.sizes.length
            return count ? [0, ...this.sizes.map((_, i) => (i + 1) / count)] : [0]
        }
        const results = [0]
        let sum = 0
        for (const size of this.sizes) results.push((sum += size) / sizeTotal)
        return results
    }
    // get progress given index of and fractions within a section
    getProgress(index, fractionInSection, pageFraction = 0) {
        const { sizes, sizePerLoc, sizePerTimeUnit, sizeTotal } = this
        const sizeInSection = sizes[index] ?? 0
        const sizeBefore = sizes.slice(0, index).reduce((a, b) => a + b, 0)
        const safeFraction = Number.isFinite(fractionInSection) ? Math.max(0, Math.min(1, fractionInSection)) : 0
        const safePageFraction = Number.isFinite(pageFraction) ? Math.max(0, Math.min(1, pageFraction)) : 0
        const size = sizeBefore + safeFraction * sizeInSection
        const nextSize = size + safePageFraction * sizeInSection
        const remainingTotal = Math.max(0, (sizeTotal || 0) - size)
        const remainingSection = Math.max(0, (1 - safeFraction) * sizeInSection)
        return {
            fraction: sizeTotal > 0 ? Math.max(0, Math.min(1, nextSize / sizeTotal)) : (sizes.length ? index / sizes.length : 0),
            section: {
                current: index,
                total: sizes.length,
            },
            location: {
                current: sizePerLoc > 0 ? Math.floor(size / sizePerLoc) : 0,
                next: sizePerLoc > 0 ? Math.floor(nextSize / sizePerLoc) : 0,
                total: (sizePerLoc > 0 && sizeTotal > 0) ? Math.ceil(sizeTotal / sizePerLoc) : 0,
            },
            time: {
                section: sizePerTimeUnit > 0 ? remainingSection / sizePerTimeUnit : 0,
                total: (sizePerTimeUnit > 0 && sizeTotal > 0) ? remainingTotal / sizePerTimeUnit : 0,
            },
        }
    }
    // the inverse of `getProgress`
    // get index of and fraction in section based on total fraction
    getSection(fraction) {
        if (!Number.isFinite(fraction) || fraction <= 0) return [0, 0]
        if (fraction >= 1) return [this.sizes.length - 1, 1]
        fraction = fraction + Number.EPSILON
        const { sizeTotal } = this
        let index = this.sectionFractions.findIndex(x => x > fraction) - 1
        if (index < 0) return [0, 0]
        while (index < this.sizes.length && !this.sizes[index]) index++
        if (index >= this.sizes.length) return [this.sizes.length - 1, 1]
        const secRatio = sizeTotal > 0 ? this.sizes[index] / sizeTotal : (this.sizes.length ? 1 / this.sizes.length : 0)
        const fractionInSection = secRatio > 0
            ? Math.max(0, Math.min(1, (fraction - this.sectionFractions[index]) / secRatio))
            : 0
        return [index, fractionInSection]
    }
}
