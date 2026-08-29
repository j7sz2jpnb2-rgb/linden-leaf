/**
 * Linden Leaf - GitHub Releases Update Checker & Notification Module
 */

export class AppUpdater {
    constructor() {
        this.currentVersion = '1.1.0'
        this.defaultRepo = 'j7sz2jpnb2-rgb/linden-leaf'
        this.lastCheckTime = 0
        this.latestRelease = null
    }

    async init() {
        if (window.electronAPI?.getVersion) {
            try {
                this.currentVersion = await window.electronAPI.getVersion() || '1.1.0'
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

        try {
            let data = null
            if (window.electronAPI?.checkGitHubRelease) {
                const ipcRes = await window.electronAPI.checkGitHubRelease(repo)
                if (!ipcRes.success) {
                    return {
                        success: false,
                        error: ipcRes.error || '检查更新失败'
                    }
                }
                data = ipcRes.data
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
                                    body: '可在 GitHub 查看最新版本发布与下载。'
                                }
                            }
                        } catch (rawErr) {}
                    }
                    if (!data) {
                        if (res.status === 404) {
                            return {
                                success: false,
                                error: `未在 GitHub 仓库 [${repo}] 找到任何已发布的 Release 版本。请先在 GitHub 仓库创建 Release 发布。`
                            }
                        }
                        if (res.status === 403) {
                            return {
                                success: false,
                                error: 'GitHub API 访问频次暂时受限，请稍候再试（通常 1 小时后自动恢复），或直接前往网页查看。'
                            }
                        }
                        throw new Error(`GitHub API 返回 HTTP ${res.status}`)
                    }
                } else {
                    data = await res.json()
                }
            }

            if (!data) throw new Error('未获取到有效的 Release 数据')

            const latestTag = data.tag_name || data.name || '0.0.0'
            const hasUpdate = this.compareVersions(latestTag, this.currentVersion) > 0

            // Find windows setup or portable asset if present
            let downloadUrl = data.html_url
            if (Array.isArray(data.assets) && data.assets.length > 0) {
                const exeAsset = data.assets.find(a => a.name.endsWith('.exe')) || data.assets[0]
                if (exeAsset && exeAsset.browser_download_url) {
                    downloadUrl = exeAsset.browser_download_url
                }
            }

            this.latestRelease = {
                hasUpdate,
                currentVersion: this.currentVersion,
                latestVersion: latestTag,
                releaseTitle: data.name || latestTag,
                releaseNotes: data.body || '暂无更新日志描述。',
                releaseUrl: data.html_url,
                downloadUrl,
                publishedAt: data.published_at ? new Date(data.published_at).toLocaleDateString() : ''
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
                error: `检查更新失败: ${err.message || '网络连接超时或无法访问 GitHub'}`
            }
        }
    }
}

export const updater = new AppUpdater()