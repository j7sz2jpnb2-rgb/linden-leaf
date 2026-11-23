/**
 * Linden Leaf - GitHub Releases Update Checker & Notification Module
 */

import { t, getIntlLocale } from './i18n.js'

export class AppUpdater {
    constructor() {
        this.currentVersion = '1.0.0'
        this.defaultRepo = 'j7sz2jpnb2-rgb/linden-leaf'
        this.lastCheckTime = 0
        this.latestRelease = null
    }

    async init() {
        if (typeof platformBridge !== 'undefined' && platformBridge.getAppVersion) {
            try {
                this.currentVersion = await platformBridge.getAppVersion() || '1.0.0'
                return
            } catch (e) {}
        }
        if (window.electronAPI?.getVersion) {
            try {
                this.currentVersion = await window.electronAPI.getVersion() || '1.0.0'
            } catch (e) {
                console.warn('Failed to get app version from electron:', e)
            }
        }
    }

    /**
     * Parses semantic version string into array of numbers [major, minor, patch]
     */
    parseVersion(versionStr) {
        if (!versionStr) return [0, 0, 0]
        const clean = versionStr.replace(/^[vV]/, '').split('-')[0]
        const parts = clean.split('.').map(p => parseInt(p, 10) || 0)
        while (parts.length < 3) parts.push(0)
        return parts.slice(0, 3)
    }

    /**
     * Compare two version strings. Returns:
     *  1 if v1 > v2
     * -1 if v1 < v2
     *  0 if v1 === v2
     */
    compareVersions(v1, v2) {
        const [maj1, min1, pat1] = this.parseVersion(v1)
        const [maj2, min2, pat2] = this.parseVersion(v2)

        // Historical dev builds: 2.0.0..2.0.18 were pre-release dev builds before resetting to 1.0.0.
        // They should be treated as older than 1.0.0. Future 2.0.19+ or 2.1+ are genuine future versions.
        const isPredecessorDev = (maj, min, pat) => maj === 2 && min === 0 && pat <= 18
        if (maj1 === 1 && isPredecessorDev(maj2, min2, pat2)) return 1
        if (isPredecessorDev(maj1, min1, pat1) && maj2 === 1) return -1

        if (maj1 !== maj2) return maj1 > maj2 ? 1 : -1
        if (min1 !== min2) return min1 > min2 ? 1 : -1
        if (pat1 !== pat2) return pat1 > pat2 ? 1 : -1
        return 0
    }

    /**
     * Query latest release from GitHub Releases API
     */
    async checkForUpdates(customRepo = null) {
        await this.init()
        const repo = (customRepo || localStorage.getItem('linden_custom_github_repo') || this.defaultRepo).trim()
        if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
            return {
                success: false,
                error: t('updater.invalidRepo')
            }
        }

        try {
            let data = null
            if (typeof platformBridge !== 'undefined' && platformBridge.checkGitHubRelease) {
                const ipcRes = await platformBridge.checkGitHubRelease(repo)
                if (!ipcRes.success) {
                    return {
                        success: false,
                        error: ipcRes.error || t('updater.checkFailed')
                    }
                }
                data = ipcRes.data || ipcRes
            } else if (window.electronAPI?.checkGitHubRelease) {
                const ipcRes = await window.electronAPI.checkGitHubRelease(repo)
                if (!ipcRes.success) {
                    return {
                        success: false,
                        error: ipcRes.error || t('updater.checkFailed')
                    }
                }
                data = ipcRes.data || ipcRes
            } else {
                const url = `https://api.github.com/repos/${repo}/releases/latest`
                const res = await fetch(url, {
                    headers: {
                        'Accept': 'application/vnd.github.v3+json'
                    }
                })

                if (!res.ok) {
                    if (res.status === 403) {
                        try {
                            const rawRes = await fetch(`https://raw.githubusercontent.com/${repo}/main/package.json`)
                            if (rawRes.ok) {
                                const pkg = await rawRes.json()
                                data = {
                                    tag_name: `v${pkg.version || '0.1.0'}`,
                                    name: `Linden Leaf v${pkg.version || '0.1.0'}`,
                                    html_url: `https://github.com/${repo}/releases`,
                                    body: t('updater.viewOnGithub')
                                }
                            }
                        } catch (rawErr) {}
                    }
                    if (!data) {
                        if (res.status === 404) {
                            return {
                                success: false,
                                error: t('updater.noRelease', { repo })
                            }
                        }
                        if (res.status === 403) {
                            return {
                                success: false,
                                error: t('updater.rateLimited')
                            }
                        }
                        throw new Error(t('updater.httpError', { status: res.status }))
                    }
                } else {
                    data = await res.json()
                }
            }

            if (!data) throw new Error(t('updater.noData'))

            const latestTag = data.tag_name || data.tagName || data.name || '0.0.0'
            const hasUpdate = this.compareVersions(latestTag, this.currentVersion) > 0

            // Find windows setup or portable asset if present
            let downloadUrl = data.html_url || data.htmlUrl
            if (Array.isArray(data.assets) && data.assets.length > 0) {
                const exeAsset = data.assets.find(a => a.name.endsWith('.exe')) || data.assets[0]
                if (exeAsset && (exeAsset.browser_download_url || exeAsset.browserDownloadUrl)) {
                    downloadUrl = exeAsset.browser_download_url || exeAsset.browserDownloadUrl
                }
            }

            this.latestRelease = {
                hasUpdate,
                currentVersion: this.currentVersion,
                latestVersion: latestTag,
                releaseTitle: data.name || latestTag,
                releaseNotes: data.body || t('updater.noDescription'),
                releaseUrl: data.html_url || data.htmlUrl,
                downloadUrl,
                publishedAt: (data.published_at || data.publishedAt) ? new Date(data.published_at || data.publishedAt).toLocaleDateString(getIntlLocale()) : ''
            }
            this.lastCheckTime = Date.now()

            return {
                success: true,
                ...this.latestRelease
            }
        } catch (err) {
            console.error('Update check failed:', err)
            return {
                success: false,
                error: t('updater.checkFailedWithMsg', { message: err.message || t('updater.networkFallback') })
            }
        }
    }
}

export const updater = new AppUpdater();
export default updater;