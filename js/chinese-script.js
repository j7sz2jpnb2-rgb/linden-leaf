/**
 * chinese-script.js
 * Reversible, WeakMap-backed Simplified <-> Traditional Chinese (s2t / t2s)
 * live document converter with contextual phrase disambiguation.
 */

const originalScriptTextCache = new WeakMap()

const SKIPPED_TAGS = new Set([
    'SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'NOSCRIPT', 'SVG', 'MATH', 'KBD', 'SAMP',
])

// Strictly verified 1-to-1 Simplified/Traditional pairs ("ST" format).
// Polysemous one-to-many characters (干/只/后/发/面/台/里/松/复/准/钟/表/板/范/划) stay out
// of the S2T char fallback or are resolved contextually in PHRASE_S2T below.
const CHAR_PAIRS_RAW =
    '万萬 与與 丑醜 专專 业業 丛叢 东東 丝絲 丢丟 两兩 严嚴 丧喪 个個 丰豐 临臨 为為 丽麗 举舉 么麼 义義 ' +
    '乌烏 乐樂 乔喬 习習 乡鄉 书書 买買 乱亂 争爭 于於 亏虧 云雲 亚亞 产產 亲親 亵褻 亿億 仅僅 仆僕 ' +
    '从從 仑侖 仓倉 仪儀 们們 价價 众眾 优優 伙夥 会會 伞傘 伟偉 传傳 伤傷 伦倫 伪僞 体體 余餘 佣傭 ' +
    '侠俠 侣侶 侥僥 侦偵 侧側 侨僑 俩倆 倾傾 偿償 杰傑 备備 儿兒 兑兌 党黨 兰蘭 关關 兴興 养養 兽獸 ' +
    '内內 冈岡 册冊 写寫 军軍 农農 冲衝 决決 况況 净淨 凄淒 准準 凉涼 减減 凑湊 几幾 凤鳳 凭憑 凯凱 ' +
    '凶兇 击擊 凿鑿 刘劉 则則 刚剛 创創 删刪 别別 刹剎 剂劑 剑劍 剧劇 劝勸 办辦 功功 务務 动動 劲勁 ' +
    '劳勞 势勢 勋勳 汇匯 区區 医醫 华華 协協 单單 卖賣 卢盧 卤鹵 卧臥 卫衛 却卻 厂廠 厅廳 压壓 厌厭 ' +
    '厕廁 厢廂 厦廈 县縣 参參 双雙 变變 叙敘 叶葉 号號 叹嘆 后後 吓嚇 吗嗎 听聽 启啟 吴吳 员員 呜嗚 ' +
    '咏詠 咸鹹 响響 哑啞 哗嘩 哟喲 唤喚 问問 喷噴 团團 园園 国國 图圖 圆圓 场場 坏壞 块塊 坚堅 坛壇 ' +
    '坝壩 坠墜 垄壟 垒壘 堕墮 报報 涂塗 尘塵 墙牆 坟墳 垦墾 壮壯 声聲 壳殼 壶壺 复復 够夠 梦夢 头頭 ' +
    '夸誇 夹夾 夺奪 奋奮 奖獎 奥奧 奸姦 妇婦 娱娛 娇嬌 孙孫 学學 宁寧 宝寶 实實 宠寵 审審 宪憲 宫宮 ' +
    '宽寬 宾賓 对對 寻尋 导導 寿壽 将將 尔爾 尝嘗 尽盡 层層 尸屍 属屬 岁歲 岂豈 岛島 岭嶺 峡峽 崭嶄 ' +
    '巩鞏 币幣 帅帥 师師 帐帳 帘簾 带帶 帮幫 并並 广廣 庄莊 庆慶 库庫 应應 庙廟 庞龐 废廢 开開 异異 ' +
    '弃棄 张張 弥彌 弯彎 弹彈 强強 归歸 当當 录錄 彻徹 征徵 径徑 忆憶 忧憂 怀懷 态態 恋戀 恒恆 耻恥 ' +
    '恶惡 恼惱 悦悅 悬懸 惊驚 惨慘 惯慣 爱愛 愿願 懒懶 扑撲 执執 扩擴 扫掃 扬揚 扰擾 抛拋 抢搶 护護 ' +
    '担擔 拟擬 拥擁 拦攔 拨撥 择擇 挤擠 挥揮 损損 捡撿 换換 捣搗 据據 摆擺 摇搖 敌敵 败敗 数數 斗鬥 ' +
    '断斷 无無 旧舊 时時 显顯 晋晉 晒曬 晓曉 暂暫 术術 机機 杀殺 杂雜 权權 条條 来來 杨楊 极極 构構 ' +
    '标標 栏欄 树樹 样樣 档檔 桥橋 检檢 楼樓 横橫 樱櫻 欢歡 欧歐 残殘 殴毆 毁毀 气氣 氢氫 汉漢 汤湯 ' +
    '馆館 斋齋 笺箋 ' +
    '没沒 沟溝 泪淚 泽澤 洁潔 浅淺 测測 济濟 浑渾 浓濃 涌湧 涛濤 涨漲 游遊 湾灣 湿濕 温溫 满滿 滤濾 ' +
    '滥濫 滨濱 渐漸 潜潛 浊濁 灭滅 灵靈 灾災 炉爐 点點 炼煉 烂爛 烦煩 烧燒 热熱 牵牽 牺犧 状狀 犹猶 ' +
    '独獨 狮獅 狱獄 猎獵 猫貓 献獻 玛瑪 环環 现現 电電 画畫 疗療 痴癡 皱皺 监監 盖蓋 盘盤 确確 码碼 ' +
    '礼禮 祸禍 离離 种種 积積 称稱 税稅 稳穩 穷窮 窝窩 竞競 笔筆 笼籠 篮籃 简簡 签簽 类類 纠糾 红紅 ' +
    '纤纖 约約 级級 纪紀 纬緯 纯純 纲綱 纳納 纵縱 纷紛 纸紙 纹紋 纽紐 线線 练練 组組 绅紳 细細 织織 ' +
    '终終 经經 结結 绕繞 绘繪 给給 络絡 绝絕 统統 继繼 绩績 绪緒 续續 维維 绵綿 综綜 绿綠 缓緩 编編 ' +
    '缘緣 缝縫 缩縮 缴繳 网網 罚罰 罢罷 飞飛 职職 联聯 聪聰 肠腸 胆膽 脑腦 脚腳 脱脫 脸臉 腾騰 脏臟 ' +
    '舰艦 艰艱 艺藝 节節 茎莖 荣榮 药藥 获獲 蓝藍 虚虛 虫蟲 补補 装裝 裤褲 见見 观觀 规規 视視 觉覺 ' +
    '览覽 触觸 誉譽 计計 订訂 认認 讨討 让讓 训訓 议議 讯訊 记記 讲講 许許 论論 设設 访訪 证證 评評 ' +
    '识識 诉訴 词詞 译譯 试試 诗詩 诚誠 话話 诞誕 询詢 该該 详詳 语語 误誤 说說 请請 诸諸 诺諾 读讀 ' +
    '课課 谁誰 调調 谈談 谊誼 谋謀 谓謂 谢謝 谨謹 谱譜 贝貝 贞貞 负負 贡貢 财財 责責 贤賢 货貨 质質 ' +
    '贩販 贪貪 贫貧 购購 贯貫 贴貼 贵貴 贷貸 贸貿 费費 贺賀 贼賊 资資 赏賞 赔賠 赖賴 赚賺 赛賽 赞贊 ' +
    '赠贈 赢贏 趋趨 跃躍 车車 轨軌 轩軒 软軟 轰轟 转轉 轮輪 轻輕 载載 较較 辅輔 辆輛 辈輩 辉輝 辑輯 ' +
    '输輸 辞辭 辩辯 边邊 达達 迁遷 过過 迈邁 运運 还還 这這 进進 远遠 违違 连連 迟遲 适適 选選 逊遜 ' +
    '递遞 遗遺 遥遙 邓鄧 邮郵 邻鄰 释釋 针針 钓釣 钟鐘 钢鋼 钱錢 铁鐵 铅鉛 铜銅 银銀 销銷 锁鎖 锋鋒 ' +
    '错錯 锡錫 锦錦 键鍵 镇鎮 镜鏡 长長 门門 闭閉 闲閒 间間 闷悶 闹鬧 闻聞 阁閣 阅閱 阔闊 队隊 阳陽 ' +
    '阴陰 阵陣 阶階 际際 陆陸 陈陳 险險 随隨 隐隱 难難 虽雖 鸡雞 雾霧 静靜 韵韻 页頁 顶頂 项項 顺順 ' +
    '须須 顽頑 顾顧 顿頓 预預 领領 颇頗 频頻 颗顆 题題 额額 颜顏 风風 饭飯 饮飲 饱飽 饰飾 饼餅 马馬 ' +
    '驱驅 驳駁 驶駛 驻駐 驾駕 验驗 骑騎 骗騙 骚騷 鱼魚 鲁魯 鲜鮮 鸟鳥 鸣鳴 鸭鴨 鹅鵝 盐鹽 麦麥 黄黃 ' +
    '齐齊 齿齒 龄齡 龙龍 龟龜 资資 讯訊'

const S2T_CHAR_MAP = new Map()
const T2S_CHAR_MAP = new Map([
    ['爲', '为'], ['衆', '众'], ['僞', '伪'], ['隻', '只'], ['讎', '仇'],
    ['幹', '干'], ['乾', '干'], ['麵', '面'], ['曆', '历'], ['歷', '历'],
    ['鍾', '钟'], ['複', '复'], ['裡', '里'], ['裏', '里'], ['鬆', '松'],
    ['錶', '表'], ['闆', '板'], ['範', '范'], ['劃', '划'], ['臺', '台'],
    ['檯', '台'], ['颱', '台'], ['發', '发'], ['髮', '发'],
])

for (const pair of CHAR_PAIRS_RAW.trim().split(/\s+/)) {
    const chars = Array.from(pair)
    if (chars.length === 2 && chars[0] !== chars[1]) {
        const [s, t] = chars
        if (!S2T_CHAR_MAP.has(s)) S2T_CHAR_MAP.set(s, t)
        if (!T2S_CHAR_MAP.has(t)) T2S_CHAR_MAP.set(t, s)
    }
}

const PHRASE_S2T = [
    ['头发', '頭髮'], ['理发', '理髮'], ['白发', '白髮'], ['黑发', '黑髮'], ['长发', '長髮'], ['短发', '短髮'], ['脱发', '脫髮'], ['毛发', '毛髮'],
    ['发现', '發現'], ['发展', '發展'], ['发生', '發生'], ['出发', '出發'], ['发觉', '發覺'],
    ['发明', '發明'], ['发表', '發表'], ['发布', '發佈'], ['发挥', '發揮'], ['发育', '發育'], ['发财', '發財'], ['发送', '發送'],
    ['王后', '王后'], ['皇后', '皇后'], ['太后', '太后'], ['以后', '以後'], ['然后', '然後'], ['后来', '後來'],
    ['最后', '最後'], ['背后', '背後'], ['后面', '後面'], ['后果', '後果'], ['后代', '後代'], ['后退', '後退'],
    ['干净', '乾淨'], ['干燥', '乾燥'], ['饼干', '餅乾'], ['葡萄干', '葡萄乾'], ['干杯', '乾杯'],
    ['干部', '幹部'], ['能干', '能幹'], ['实干', '實幹'], ['干活', '幹活'], ['干劲', '幹勁'],
    ['台湾', '臺灣'], ['台风', '颱風'], ['台灯', '檯燈'], ['写字台', '寫字檯'], ['讲台', '講臺'], ['舞台', '舞臺'],
    ['里面', '裡面'], ['这里', '這裡'], ['那里', '那裡'], ['哪里', '哪裡'], ['家里', '家裡'], ['手里', '手裡'], ['心里', '心裡'], ['眼里', '眼裡'], ['书里', '書裡'], ['梦里', '夢裡'], ['公里', '公里'],
    ['面条', '麵條'], ['面包', '麵包'], ['面粉', '麵粉'], ['方便面', '方便麵'],
    ['历史', '歷史'], ['日历', '日曆'], ['公历', '公曆'], ['农历', '農曆'], ['西历', '西曆'], ['阳历', '陽曆'], ['阴历', '陰曆'], ['历法', '曆法'], ['经历', '經歷'],
    ['关系', '關係'], ['联系', '聯繫'], ['系统', '系統'], ['体系', '體系'],
    ['只有', '只有'], ['只要', '只要'], ['只是', '只是'], ['一只', '一隻'], ['两只', '兩隻'], ['三只', '三隻'], ['几只', '幾隻'], ['只身', '隻身'], ['船只', '船隻'],
    ['轻松', '輕鬆'], ['放松', '放鬆'], ['宽松', '寬鬆'], ['松鼠', '松鼠'], ['松树', '松樹'],
    ['复杂', '複雜'], ['复习', '複習'], ['复印', '複印'], ['复制', '複製'], ['重复', '重複'], ['反复', '反覆'], ['恢复', '恢復'], ['复兴', '復興'],
    ['准备', '準備'], ['标准', '標準'], ['准确', '準確'], ['批准', '批准'],
    ['手表', '手錶'], ['钟表', '鐘錶'], ['钟情', '鍾情'], ['钟爱', '鍾愛'], ['老板', '老闆'], ['模范', '模範'], ['示范', '示範'],
    ['软件', '軟件'], ['阅读器', '閱讀器'], ['注释', '注釋'], ['书签', '書籤'],
    ['计划', '計劃'], ['规划', '規劃'], ['划船', '劃船'], ['划分', '劃分'],
]

const PHRASE_T2S = [
    ...PHRASE_S2T.map(([s, t]) => [t, s]),
    ['裏面', '里面'], ['這裏', '这里'], ['那裏', '那里'], ['哪裏', '哪里'],
    ['台灣', '台湾'], ['乾乾淨淨', '干干净净'], ['註釋', '注释'], ['軟體', '软件'], ['記憶體', '内存'],
]

function buildPhraseRegex(entries) {
    const sorted = [...entries].sort((a, b) => b[0].length - a[0].length)
    const lookup = new Map(sorted)
    const escaped = sorted.map(([k]) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    return { lookup, regex: new RegExp(escaped.join('|'), 'g') }
}

const PHRASE_S2T_MATCHER = buildPhraseRegex(PHRASE_S2T)
const PHRASE_T2S_MATCHER = buildPhraseRegex(PHRASE_T2S)

function mapChars(slice, charMap) {
    let changed = false
    let res = ''
    for (const ch of slice) {
        const mapped = charMap.get(ch)
        if (mapped) {
            res += mapped
            changed = true
        } else {
            res += ch
        }
    }
    return changed ? res : slice
}

/**
 * Convert a single string according to `mode` ('original' | 's2t' | 't2s').
 * @param {string} input
 * @param {'original'|'s2t'|'t2s'} mode
 * @returns {string}
 */
export function convertChineseScript(input, mode = 'original') {
    if (typeof input !== 'string' || !input || (mode !== 's2t' && mode !== 't2s')) return input
    const isS2T = mode === 's2t'
    const matcher = isS2T ? PHRASE_S2T_MATCHER : PHRASE_T2S_MATCHER
    const charMap = isS2T ? S2T_CHAR_MAP : T2S_CHAR_MAP

    let out = ''
    let lastIndex = 0
    matcher.regex.lastIndex = 0
    let match
    while ((match = matcher.regex.exec(input)) !== null) {
        if (match.index > lastIndex) {
            out += mapChars(input.slice(lastIndex, match.index), charMap)
        }
        out += matcher.lookup.get(match[0]) || match[0]
        lastIndex = match.index + match[0].length
    }
    if (lastIndex < input.length) {
        out += mapChars(input.slice(lastIndex), charMap)
    }
    return out
}

/**
 * Live reversible DOM Chinese script transformer. Restores exact original text on `'original'`.
 * @param {Document} doc
 * @param {'original'|'s2t'|'t2s'} mode
 * @returns {boolean}
 */
export function applyChineseScriptToDocument(doc, mode = 'original') {
    if (!doc?.body) return false
    const targetMode = mode === 's2t' || mode === 't2s' ? mode : 'original'
    const docView = doc.defaultView || globalThis
    const NodeFilterRef = docView.NodeFilter || globalThis.NodeFilter || { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }

    const isInsideSkippedElement = (node) => {
        let cur = node?.parentElement || null
        while (cur) {
            if (cur.tagName && SKIPPED_TAGS.has(String(cur.tagName).toUpperCase())) return true
            cur = cur.parentElement || null
        }
        return false
    }

    const walker = doc.createTreeWalker(
        doc.body,
        NodeFilterRef.SHOW_TEXT,
        {
            acceptNode(node) {
                if (isInsideSkippedElement(node)) return NodeFilterRef.FILTER_REJECT
                if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilterRef.FILTER_REJECT
                return NodeFilterRef.FILTER_ACCEPT
            },
        },
        false
    )

    let currentNode
    while ((currentNode = walker.nextNode())) {
        if (isInsideSkippedElement(currentNode)) continue
        if (!currentNode.nodeValue || !currentNode.nodeValue.trim()) continue
        if (targetMode === 'original') {
            if (originalScriptTextCache.has(currentNode)) {
                const orig = originalScriptTextCache.get(currentNode)
                if (currentNode.nodeValue !== orig) currentNode.nodeValue = orig
            }
        } else {
            if (!originalScriptTextCache.has(currentNode)) {
                originalScriptTextCache.set(currentNode, currentNode.nodeValue)
            }
            const baseText = originalScriptTextCache.get(currentNode)
            const nextText = convertChineseScript(baseText, targetMode)
            if (currentNode.nodeValue !== nextText) {
                currentNode.nodeValue = nextText
            }
        }
    }
    return true
}
