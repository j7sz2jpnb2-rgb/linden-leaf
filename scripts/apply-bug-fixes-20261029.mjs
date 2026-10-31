import fs from 'node:fs';
import path from 'node:path';

const projectRoot = 'D:/LindenLeaf-Dev/astra-mupdf-core';
const appJsPath = path.join(projectRoot, 'js/app.js');
let appJs = fs.readFileSync(appJsPath, 'utf8');

// Check line ending style in app.js
const isCRLF = appJs.includes('\r\n');
const nl = isCRLF ? '\r\n' : '\n';

// 1. Clean up contentAreaHadActiveSelectionOnDown in readerContentArea pointerdown
const target1 = [
    "        let contentAreaHadActiveSelectionOnDown = false",
    "        this.dom.readerContentArea?.addEventListener('pointerdown', e => {",
    "            this._lastContentAreaPointerDownTime = Date.now()",
    "            const winSel = window.getSelection()",
    "            const hasWinSel = Boolean(winSel && !winSel.isCollapsed && winSel.toString().trim().length > 0)",
    "            const hasDict = Boolean(this.dom.readerDictionaryCard?.classList.contains('active') || (this.dom.readerDictionaryCard?.style.display && this.dom.readerDictionaryCard.style.display !== 'none'))",
    "            const hasPopup = Boolean(this.dom.selectionPopup?.classList.contains('active') || (this.dom.selectionPopup?.style.display && this.dom.selectionPopup.style.display !== 'none'))",
    "            contentAreaHadActiveSelectionOnDown = hasWinSel || hasDict || hasPopup",
    "        }, true)"
].join(nl);

const replacement1 = [
    "        let contentAreaHadActiveSelectionOnDown = false",
    "        this.dom.readerContentArea?.addEventListener('pointerdown', e => {",
    "            this._lastContentAreaPointerDownTime = Date.now()",
    "            const hasDict = Boolean(this.dom.readerDictionaryCard?.classList.contains('active') || (this.dom.readerDictionaryCard?.style.display && this.dom.readerDictionaryCard.style.display !== 'none'))",
    "            const hasPopup = Boolean(this.dom.selectionPopup?.classList.contains('active') || (this.dom.selectionPopup?.style.display && this.dom.selectionPopup.style.display !== 'none'))",
    "            const hasHighlightPopup = Boolean(this.dom.highlightActionPopup?.classList.contains('active') || (this.dom.highlightActionPopup?.style.display && this.dom.highlightActionPopup.style.display !== 'none'))",
    "            const hasFootnote = Boolean(this.dom.footnotePopup?.classList.contains('active') || (this.dom.footnotePopup?.style.display && this.dom.footnotePopup.style.display !== 'none'))",
    "            contentAreaHadActiveSelectionOnDown = hasDict || hasPopup || hasHighlightPopup || hasFootnote",
    "        }, true)"
].join(nl);

if (appJs.includes(target1)) {
    appJs = appJs.replace(target1, replacement1);
    console.log('[OK] 1. contentAreaHadActiveSelectionOnDown updated');
} else {
    console.error('[FAIL] 1. target1 not found in app.js');
    process.exit(1);
}

// 2. Clean up hadActiveSelectionOrPopupOnPointerDown in doc pointerdown
const target2 = [
    "            const sel = doc.getSelection()",
    "            const hasSelection = Boolean(sel && !sel.isCollapsed && sel.toString().trim().length > 0)",
    "            const hasDict = Boolean(this.dom.readerDictionaryCard?.classList.contains('active') || (this.dom.readerDictionaryCard?.style.display && this.dom.readerDictionaryCard.style.display !== 'none'))",
    "            const hasPopup = Boolean(this.dom.selectionPopup?.classList.contains('active') || (this.dom.selectionPopup?.style.display && this.dom.selectionPopup.style.display !== 'none'))",
    "            const hasMulti = Boolean(this.multiSelectedRanges && this.multiSelectedRanges.length > 0)",
    "            hadActiveSelectionOrPopupOnPointerDown = hasSelection || hasDict || hasPopup || hasMulti"
].join(nl);

const replacement2 = [
    "            const hasDict = Boolean(this.dom.readerDictionaryCard?.classList.contains('active') || (this.dom.readerDictionaryCard?.style.display && this.dom.readerDictionaryCard.style.display !== 'none'))",
    "            const hasPopup = Boolean(this.dom.selectionPopup?.classList.contains('active') || (this.dom.selectionPopup?.style.display && this.dom.selectionPopup.style.display !== 'none'))",
    "            const hasHighlightPopup = Boolean(this.dom.highlightActionPopup?.classList.contains('active') || (this.dom.highlightActionPopup?.style.display && this.dom.highlightActionPopup.style.display !== 'none'))",
    "            const hasFootnote = Boolean(this.dom.footnotePopup?.classList.contains('active') || (this.dom.footnotePopup?.style.display && this.dom.footnotePopup.style.display !== 'none'))",
    "            hadActiveSelectionOrPopupOnPointerDown = hasDict || hasPopup || hasHighlightPopup || hasFootnote"
].join(nl);

if (appJs.includes(target2)) {
    appJs = appJs.replace(target2, replacement2);
    console.log('[OK] 2. hadActiveSelectionOrPopupOnPointerDown updated');
} else {
    console.error('[FAIL] 2. target2 not found in app.js');
    process.exit(1);
}

// 3. Pointer move slop & drag check
const target3 = [
    "        doc.addEventListener('pointermove', e => {",
    "            const slop = (isTouchPointer || e.pointerType === 'touch') ? 24 : 8",
    "            if (Math.abs(e.clientX - pointerStartX) > slop || Math.abs(e.clientY - pointerStartY) > slop) {",
    "                isDragGesture = true",
    "            }",
    "        }, { passive: true })"
].join(nl);

const replacement3 = [
    "        doc.addEventListener('pointermove', e => {",
    "            const slop = 24",
    "            if (Math.abs(e.clientX - pointerStartX) > slop || Math.abs(e.clientY - pointerStartY) > slop) {",
    "                const sel = doc.getSelection()",
    "                if (sel && !sel.isCollapsed && sel.toString().length > 0) {",
    "                    isDragGesture = true",
    "                } else if (Math.hypot(e.clientX - pointerStartX, e.clientY - pointerStartY) > 32) {",
    "                    isDragGesture = true",
    "                }",
    "            }",
    "        }, { passive: true })"
].join(nl);

if (appJs.includes(target3)) {
    appJs = appJs.replace(target3, replacement3);
    console.log('[OK] 3. pointermove slop & drag detection updated');
} else {
    console.error('[FAIL] 3. target3 not found in app.js');
    process.exit(1);
}

// 4. Click drag check
const target4 = [
    "            if (isDragGesture) {",
    "                isDragGesture = false",
    "                return",
    "            }"
].join(nl);

const replacement4 = [
    "            if (isDragGesture) {",
    "                isDragGesture = false",
    "                const sel = doc.getSelection()",
    "                if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {",
    "                    return",
    "                }",
    "            }"
].join(nl);

if (appJs.includes(target4)) {
    appJs = appJs.replace(target4, replacement4);
    console.log('[OK] 4. click isDragGesture selection guard updated');
} else {
    console.error('[FAIL] 4. target4 not found in app.js');
    process.exit(1);
}

fs.writeFileSync(appJsPath, appJs, 'utf8');
console.log('Successfully updated js/app.js!');
