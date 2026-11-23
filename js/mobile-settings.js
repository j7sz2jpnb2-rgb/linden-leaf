/* Mobile settings reuse the application's live controls and persistence handlers. */
import { advancedSettings } from './advanced-settings.js'
import { t } from './i18n.js'

const GROUPS = {
    appearance: { get title() { return t('mobileSettings.group.appearance.title') }, get note() { return t('mobileSettings.group.appearance.note') }, ids: ['book-override-section', 'theme-settings-section', 'pdf-paper-settings-section', 'font-settings-section', 'reading-presets-section', 'typography-settings-section', 'adv-group-typography'] },
    tts: { get title() { return t('mobileSettings.group.tts.title') }, get note() { return t('mobileSettings.group.tts.note') }, ids: ['adv-group-tts'] },
    ai: { get title() { return t('mobileSettings.group.ai.title') }, get note() { return t('mobileSettings.group.ai.note') }, ids: ['ai-settings-section', 'adv-group-ai'] },
    translation: { get title() { return t('mobileSettings.group.translation.title') }, get note() { return t('mobileSettings.group.translation.note') }, ids: ['adv-group-translation'] },
    dictionary: { get title() { return t('mobileSettings.group.dictionary.title') }, get note() { return t('mobileSettings.group.dictionary.note') }, ids: ['dict-settings-section', 'adv-group-dictionary'] },
    interaction: { get title() { return t('mobileSettings.group.interaction.title') }, get note() { return t('mobileSettings.group.interaction.note') }, ids: ['adv-group-interaction', 'adv-group-strokes', 'adv-group-txt-rules'] },
    fonts: { get title() { return t('mobileSettings.group.fonts.title') }, get note() { return t('mobileSettings.group.fonts.note') }, ids: ['adv-group-fonts', 'adv-group-palette'] },
    backup: { get title() { return t('mobileSettings.group.backup.title') }, get note() { return t('mobileSettings.group.backup.note') }, ids: ['search-settings-section', 'adv-group-backup', 'mobile-backup-hint', 'mobile-advanced-reset'] },
    profile: { get title() { return t('mobileSettings.group.profile.title') }, get note() { return t('mobileSettings.group.profile.note') }, ids: ['user-profile-settings-section', 'goals-settings-section', 'language-settings-section'] },
    about: { get title() { return t('mobileSettings.group.about.title') }, get note() { return t('mobileSettings.group.about.note') }, ids: ['about-settings-section'] },
}

const INDEX_SECTIONS = [
    { get title() { return t('mobileSettings.section.reading') }, groups: ['appearance', 'interaction', 'fonts'] },
    { get title() { return t('mobileSettings.section.voiceAi') }, groups: ['tts', 'ai', 'translation', 'dictionary'] },
    { get title() { return t('mobileSettings.section.personalApp') }, groups: ['profile', 'backup', 'about'] },
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
                <button type="button" class="mobile-settings-back" aria-label="${t('mobileSettings.backAria')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg><span class="mobile-settings-back-label">${t('mobileSettings.tabMe')}</span></button>
                <h1 id="mobile-settings-title">${t('mobileSettings.title')}</h1>
                <span class="mobile-settings-header-spacer" aria-hidden="true"></span>
            </header>
            <div id="mobile-settings-body" class="mobile-settings-body"></div>`
        document.getElementById('mobile-shell-root').appendChild(this.page)
        this.page.querySelector('.mobile-settings-back').addEventListener('click', () => this.back())
        this.host = this.page.querySelector('#mobile-settings-body')
        this.host.addEventListener('focusin', (e) => {
            const target = e.target
            if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
                setTimeout(() => target.scrollIntoView({ block: 'nearest' }), 180)
            }
        })
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
        this.page.querySelector('#mobile-settings-title').textContent = GROUPS[key]?.title || t('mobileSettings.title')
        this.page.dataset.settingsGroup = key
        this.page.querySelector('.mobile-settings-back').setAttribute('aria-label', t('mobileSettings.backAria'))
        this.page.querySelector('.mobile-settings-back-label').textContent = this.stack.length > 1 ? t('mobileSettings.title') : (this.shell.isInReader ? t('mobileSettings.tabRead') : t('mobileSettings.tabMe'))
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
        changeText(this.host.querySelector('.advanced-group-title'), t('mobileSettings.ttsTitle'))
        changeText(this.host.querySelector('#setting-tts-provider')?.closest('.control-row')?.querySelector('.control-label'), t('mobileSettings.ttsSource'))
        const providerNames = {
            system: t('mobileSettings.ttsProvider.system'),
            offline: t('mobileSettings.ttsProvider.offline'),
            api: t('mobileSettings.ttsProvider.api')
        }
        for (const option of this.host.querySelectorAll('#setting-tts-provider option')) {
            if (providerNames[option.value]) changeText(option, providerNames[option.value])
        }
    }

    refreshLocale() {
        if (this.page && this.isOpen) {
            this.render()
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
