/* Mobile settings reuse the application's live controls and persistence handlers. */
import { advancedSettings } from './advanced-settings.js'

const GROUPS = {
    appearance: { title: '外观与排版', note: '主题、字体与阅读间距', ids: ['book-override-section', 'theme-settings-section', 'pdf-paper-settings-section', 'font-settings-section', 'reading-presets-section', 'typography-settings-section', 'adv-group-typography'] },
    tts: { title: '听书', note: '语音引擎、音色与语速', ids: ['adv-group-tts'] },
    ai: { title: 'AI 阅读助手', note: '接口配置与用量', ids: ['ai-settings-section', 'adv-group-ai'] },
    translation: { title: '章节翻译', note: '译文、风格与存档', ids: ['adv-group-translation'] },
    dictionary: { title: '词典与资源', note: '查词、词库下载与存储位置', ids: ['dict-settings-section', 'adv-group-dictionary'] },
    interaction: { title: '阅读与交互', note: '翻页、动效与标注', ids: ['adv-group-interaction', 'adv-group-strokes', 'adv-group-txt-rules'] },
    fonts: { title: '字体与配色', note: '自定义字体与调色盘', ids: ['adv-group-fonts', 'adv-group-palette'] },
    backup: { title: '数据与备份', note: '检索、记录与原书关联', ids: ['search-settings-section', 'adv-group-backup', 'mobile-backup-hint', 'mobile-advanced-reset'] },
    profile: { title: '个人与目标', note: '昵称与每日阅读目标', ids: ['user-profile-settings-section', 'goals-settings-section'] },
    about: { title: '关于 Linden Leaf', note: '版本与应用信息', ids: ['about-settings-section'] },
}

const INDEX_SECTIONS = [
    { title: '阅读', groups: ['appearance', 'interaction', 'fonts'] },
    { title: '语音与助手', groups: ['tts', 'ai', 'translation', 'dictionary'] },
    { title: '个人与应用', groups: ['profile', 'backup', 'about'] },
]

const chevron = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>'

export class MobileSettings {
    constructor(shell) {
        this.shell = shell
        this.stack = []
        this.borrowed = []
        this.presentation = []
    }

    get isOpen() { return this.stack.length > 0 }

    ensurePage() {
        if (this.page) return
        this.page = document.createElement('section')
        this.page.id = 'mobile-settings-page'
        this.page.className = 'mobile-only'
        this.page.hidden = true
        this.page.innerHTML = `
            <header class="mobile-settings-header">
                <button type="button" class="mobile-settings-back" aria-label="返回"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg><span class="mobile-settings-back-label">我的</span></button>
                <h1 id="mobile-settings-title">设置</h1>
                <span class="mobile-settings-header-spacer" aria-hidden="true"></span>
            </header>
            <div id="mobile-settings-body" class="mobile-settings-body"></div>`
        document.getElementById('mobile-shell-root').appendChild(this.page)
        this.page.querySelector('.mobile-settings-back').addEventListener('click', () => this.back())
        this.host = this.page.querySelector('#mobile-settings-body')
    }

    open(group = 'index') {
        if (group !== 'index' && !GROUPS[group]) return
        this.ensurePage()
        if (!this.isOpen) {
            this.readerToolsWereVisible = this.shell.readerToolsVisible
            this.shell.closeAllSheets()
            this.shell.setReaderToolsVisible(false)
            this.stack = [group]
        } else if (this.stack.at(-1) !== group) {
            this.stack.push(group)
        }
        this.page.hidden = false
        document.body.classList.add('mobile-settings-active')
        this.render()
    }

    restoreControls() {
        for (const { node, text } of this.presentation) node.textContent = text
        this.presentation = []
        for (const { node, anchor } of this.borrowed) {
            if (anchor.parentNode) anchor.replaceWith(node)
        }
        this.borrowed = []
    }

    render() {
        this.restoreControls()
        this.host.replaceChildren()
        const key = this.stack.at(-1)
        this.page.querySelector('#mobile-settings-title').textContent = GROUPS[key]?.title || '设置'
        this.page.dataset.settingsGroup = key
        this.page.querySelector('.mobile-settings-back-label').textContent = this.stack.length > 1 ? '设置' : (this.shell.isInReader ? '阅读' : '我的')
        if (key === 'index') {
            for (const section of INDEX_SECTIONS) {
                const group = document.createElement('section')
                group.className = 'mobile-settings-index-group'
                const heading = document.createElement('h2')
                heading.className = 'mobile-settings-index-heading'
                heading.textContent = section.title
                const list = document.createElement('div')
                list.className = 'mobile-settings-index'
                for (const key of section.groups) {
                    const spec = GROUPS[key]
                    const button = document.createElement('button')
                    button.type = 'button'
                    button.className = 'mobile-settings-link'
                    button.innerHTML = `<span><span class="mobile-settings-link-title">${spec.title}</span><span class="mobile-settings-link-note">${spec.note}</span></span>${chevron}`
                    button.addEventListener('click', () => this.open(key))
                    list.appendChild(button)
                }
                group.append(heading, list)
                this.host.appendChild(group)
            }
        } else {
            // No cloning: values, IDs, event listeners and backend calls remain the same.
            for (const id of GROUPS[key].ids) {
                const node = document.getElementById(id)
                if (!node) continue
                const anchor = document.createComment(`settings:${id}`)
                node.before(anchor)
                this.borrowed.push({ node, anchor })
                this.host.appendChild(node)
            }
            this.refinePresentation(key)
            advancedSettings.renderUIState()
        }
        this.host.scrollTop = 0
    }

    refinePresentation(key) {
        if (key !== 'tts') return
        const changeText = (node, text) => {
            if (!node) return
            this.presentation.push({ node, text: node.textContent })
            node.textContent = text
        }
        changeText(this.host.querySelector('.advanced-group-title'), '语音与播放')
        changeText(this.host.querySelector('#setting-tts-provider')?.closest('.control-row')?.querySelector('.control-label'), '语音来源')
        const providerNames = { system: '系统语音', offline: '自建服务', api: '云端 API' }
        for (const option of this.host.querySelectorAll('#setting-tts-provider option')) {
            if (providerNames[option.value]) changeText(option, providerNames[option.value])
        }
    }

    back() {
        if (!this.isOpen) return false
        if (this.stack.length > 1) {
            this.stack.pop()
            this.render()
        } else this.close()
        return true
    }

    close() {
        if (!this.isOpen) return
        this.restoreControls()
        this.stack = []
        this.page.hidden = true
        this.host.replaceChildren()
        document.body.classList.remove('mobile-settings-active')
        if (this.readerToolsWereVisible && this.shell.isInReader) this.shell.setReaderToolsVisible(true)
        if (this.shell.currentTab === 'me' && !this.shell.isInReader) this.shell.renderMeTab()
    }
}
