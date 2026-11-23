// One scale for both the bars and their axis labels. Empty data has no range.
export function getReadingChartScale(data = []) {
    let peak = 0
    for (const item of data) {
        const value = Number(item?.minutes)
        if (Number.isFinite(value) && value > peak) peak = value
    }
    if (peak === 0) return { hasData: false, maxMinutes: 0, midMinutes: 0, unit: 'minutes' }
    const unit = peak >= 60 ? 'hours' : 'minutes'
    const factor = unit === 'hours' ? 60 : 1
    const half = Math.max(peak / factor, unit === 'minutes' ? 20 : 1) / 2
    const magnitude = 10 ** Math.floor(Math.log10(half))
    const step = [1, 2, 5, 10].find(value => value * magnitude >= half) * magnitude
    return { hasData: true, maxMinutes: step * 2 * factor, midMinutes: step * factor, unit }
}
