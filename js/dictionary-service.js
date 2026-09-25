/**
 * dictionary-service.js - Standalone Offline / Local Word Lookup Dictionary
 * Decoupled from AI: no 10-second cooldown, no token budget, instant POS & definition.
 * Part of Linden Leaf (2026-09-25)
 */

// Embedded offline English-Chinese vocabulary covering common reading terms
const BUILTIN_DICTIONARY = {
    'book': {
        phonetic: '/bʊk/',
        entries: [
            { pos: 'n.', def: '书；书籍；本子；卷，篇' },
            { pos: 'v.', def: '预订；预约；登记' }
        ]
    },
    'read': {
        phonetic: '/riːd/',
        entries: [
            { pos: 'v.', def: '阅读；朗读；理解；显示；释义' },
            { pos: 'n.', def: '读物；阅读过程' }
        ]
    },
    'reading': {
        phonetic: '/ˈriːdɪŋ/',
        entries: [
            { pos: 'n.', def: '阅读；读本；读数；理解方式' },
            { pos: 'adj.', def: '阅读的；读书用的' }
        ]
    },
    'leaf': {
        phonetic: '/liːf/',
        entries: [
            { pos: 'n.', def: '叶；树叶；页；薄金属片' },
            { pos: 'v.', def: '生叶；翻页浏览' }
        ]
    },
    'page': {
        phonetic: '/peɪdʒ/',
        entries: [
            { pos: 'n.', def: '页；面；纸页；时代，篇章' },
            { pos: 'v.', def: '翻页；按页排序；呼叫' }
        ]
    },
    'chapter': {
        phonetic: '/ˈtʃæptə(r)/',
        entries: [
            { pos: 'n.', def: '章；回；篇；时期；分会' }
        ]
    },
    'word': {
        phonetic: '/wɜːd/',
        entries: [
            { pos: 'n.', def: '单词；词；话语；消息；诺言' },
            { pos: 'v.', def: '用词表达；措辞' }
        ]
    },
    'text': {
        phonetic: '/tekst/',
        entries: [
            { pos: 'n.', def: '文本；正文；原文；教科书' },
            { pos: 'v.', def: '发短信；给…发信息' }
        ]
    },
    'context': {
        phonetic: '/ˈkɒntekst/',
        entries: [
            { pos: 'n.', def: '上下文；语境；背景；环境' }
        ]
    },
    'reference': {
        phonetic: '/ˈrefrəns/',
        entries: [
            { pos: 'n.', def: '参考；参照；引用；证明人；参考文献' },
            { pos: 'v.', def: '查阅；引用' }
        ]
    },
    'quote': {
        phonetic: '/kwəʊt/',
        entries: [
            { pos: 'v.', def: '引用；引述；报价' },
            { pos: 'n.', def: '引文；引述；引号' }
        ]
    },
    'history': {
        phonetic: '/ˈhɪstri/',
        entries: [
            { pos: 'n.', def: '历史；历史学；发展史；来历' }
        ]
    },
    'translate': {
        phonetic: '/trænzˈleɪt/',
        entries: [
            { pos: 'v.', def: '翻译；转化；解释；变为' }
        ]
    },
    'translation': {
        phonetic: '/trænzˈleɪʃn/',
        entries: [
            { pos: 'n.', def: '翻译；译本；译文；转化' }
        ]
    },
    'explain': {
        phonetic: '/ɪkˈspleɪn/',
        entries: [
            { pos: 'v.', def: '解释；说明；阐述；辩解' }
        ]
    },
    'explanation': {
        phonetic: '/ˌekspləˈneɪʃn/',
        entries: [
            { pos: 'n.', def: '解释；说明；阐述；辩明原因' }
        ]
    },
    'setting': {
        phonetic: '/ˈsetɪŋ/',
        entries: [
            { pos: 'n.', def: '设置；环境；背景；布景；安装' }
        ]
    },
    'system': {
        phonetic: '/ˈsɪstəm/',
        entries: [
            { pos: 'n.', def: '系统；体系；体制；制度' }
        ]
    },
    'language': {
        phonetic: '/ˈlæŋɡwɪdʒ/',
        entries: [
            { pos: 'n.', def: '语言；言语；文字体系；风格' }
        ]
    },
    'thought': {
        phonetic: '/θɔːt/',
        entries: [
            { pos: 'n.', def: '思想；思考；想法；意念；心思' }
        ]
    },
    'mind': {
        phonetic: '/maɪnd/',
        entries: [
            { pos: 'n.', def: '头脑；心智；精神；注意力' },
            { pos: 'v.', def: '介意；留心；照顾；服从' }
        ]
    },
    'memory': {
        phonetic: '/ˈmeməri/',
        entries: [
            { pos: 'n.', def: '记忆；记忆力；回忆；纪念；内存' }
        ]
    },
    'time': {
        phonetic: '/taɪm/',
        entries: [
            { pos: 'n.', def: '时间；时代；次数；节拍' },
            { pos: 'v.', def: '计时；为…安排时间' }
        ]
    },
    'life': {
        phonetic: '/laɪf/',
        entries: [
            { pos: 'n.', def: '生命；生活；人生；寿命；生物' }
        ]
    },
    'world': {
        phonetic: '/wɜːld/',
        entries: [
            { pos: 'n.', def: '世界；地球；领域；天下；人世' }
        ]
    },
    'people': {
        phonetic: '/ˈpiːpl/',
        entries: [
            { pos: 'n.', def: '人；人们；民族；大众' },
            { pos: 'v.', def: '居住于；在…定居' }
        ]
    },
    'work': {
        phonetic: '/wɜːk/',
        entries: [
            { pos: 'v.', def: '工作；运转；起作用；从事' },
            { pos: 'n.', def: '工作；著作；作品；劳动' }
        ]
    },
    'great': {
        phonetic: '/ɡreɪt/',
        entries: [
            { pos: 'adj.', def: '伟大的；巨大的；杰出的；极好的' }
        ]
    },
    'good': {
        phonetic: '/ɡʊd/',
        entries: [
            { pos: 'adj.', def: '好的；优秀的；有益的；正义的' },
            { pos: 'n.', def: '好处；善事；商品' }
        ]
    },
    'new': {
        phonetic: '/njuː/',
        entries: [
            { pos: 'adj.', def: '新的；新鲜的；初次的；不熟悉的' }
        ]
    },
    'old': {
        phonetic: '/əʊld/',
        entries: [
            { pos: 'adj.', def: '老的；旧的；以前的；过去的' }
        ]
    },
    'first': {
        phonetic: '/fɜːst/',
        entries: [
            { pos: 'adj.', def: '第一的；首要的' },
            { pos: 'adv.', def: '首先；最初' },
            { pos: 'n.', def: '第一；最初' }
        ]
    },
    'last': {
        phonetic: '/lɑːst/',
        entries: [
            { pos: 'adj.', def: '最后的；最近的' },
            { pos: 'v.', def: '持续；维持' },
            { pos: 'adv.', def: '最后地' }
        ]
    },
    'long': {
        phonetic: '/lɒŋ/',
        entries: [
            { pos: 'adj.', def: '长的；长时间的；长期的' },
            { pos: 'v.', def: '渴望；盼望' }
        ]
    },
    'little': {
        phonetic: '/ˈlɪtl/',
        entries: [
            { pos: 'adj.', def: '小的；少的；幼小的' },
            { pos: 'adv.', def: '毫不；几乎没有' }
        ]
    },
    'own': {
        phonetic: '/əʊn/',
        entries: [
            { pos: 'adj.', def: '自己的；特有的' },
            { pos: 'v.', def: '拥有；承认' }
        ]
    },
    'other': {
        phonetic: '/ˈʌðə(r)/',
        entries: [
            { pos: 'adj.', def: '其他的；另外的' },
            { pos: 'pron.', def: '其他的人或事' }
        ]
    },
    'right': {
        phonetic: '/raɪt/',
        entries: [
            { pos: 'adj.', def: '正确的；右边的；恰当的' },
            { pos: 'n.', def: '权利；右边；公正' },
            { pos: 'adv.', def: '正好；向右；直接地' }
        ]
    },
    'left': {
        phonetic: '/left/',
        entries: [
            { pos: 'adj.', def: '左边的；左派的' },
            { pos: 'n.', def: '左边' },
            { pos: 'v.', def: 'leave 的过去式和过去分词（离开）' }
        ]
    },
    'see': {
        phonetic: '/siː/',
        entries: [
            { pos: 'v.', def: '看见；领会；明白；观察；经历' }
        ]
    },
    'know': {
        phonetic: '/nəʊ/',
        entries: [
            { pos: 'v.', def: '知道；了解；认识；辨认' }
        ]
    },
    'think': {
        phonetic: '/θɪŋk/',
        entries: [
            { pos: 'v.', def: '认为；思考；想起；设想' }
        ]
    },
    'take': {
        phonetic: '/teɪk/',
        entries: [
            { pos: 'v.', def: '拿；取；采用；花费；接受；记录' }
        ]
    },
    'make': {
        phonetic: '/meɪk/',
        entries: [
            { pos: 'v.', def: '制作；使成为；制造；产生；制定' },
            { pos: 'n.', def: '牌子；型号' }
        ]
    },
    'give': {
        phonetic: '/ɡɪv/',
        entries: [
            { pos: 'v.', def: '给；提供；赋予；举办；让步' }
        ]
    },
    'find': {
        phonetic: '/faɪnd/',
        entries: [
            { pos: 'v.', def: '找到；发现；感到；发觉' }
        ]
    },
    'tell': {
        phonetic: '/tel/',
        entries: [
            { pos: 'v.', def: '告诉；讲述；辨别；显露' }
        ]
    },
    'ask': {
        phonetic: '/ɑːsk/',
        entries: [
            { pos: 'v.', def: '询问；要求；邀请；请求' }
        ]
    },
    'feel': {
        phonetic: '/fiːl/',
        entries: [
            { pos: 'v.', def: '感觉；摸；体会；察觉' },
            { pos: 'n.', def: '手感；感受' }
        ]
    },
    'try': {
        phonetic: '/traɪ/',
        entries: [
            { pos: 'v.', def: '尝试；试图；试验；审判' },
            { pos: 'n.', def: '尝试；努力' }
        ]
    },
    'leave': {
        phonetic: '/liːv/',
        entries: [
            { pos: 'v.', def: '离开；留下；遗忘；委托' },
            { pos: 'n.', def: '假期；准许' }
        ]
    },
    'call': {
        phonetic: '/kɔːl/',
        entries: [
            { pos: 'v.', def: '呼唤；打电话；把…称为' },
            { pos: 'n.', def: '电话；呼喊；访问；号召' }
        ]
    },
    'need': {
        phonetic: '/niːd/',
        entries: [
            { pos: 'v.', def: '需要；必须' },
            { pos: 'n.', def: '需要；必需品；贫困' }
        ]
    },
    'mean': {
        phonetic: '/miːn/',
        entries: [
            { pos: 'v.', def: '意思是；意味着；意欲' },
            { pos: 'adj.', def: '刻薄的；平均的' }
        ]
    },
    'keep': {
        phonetic: '/kiːp/',
        entries: [
            { pos: 'v.', def: '保持；继续；保存；遵守' },
            { pos: 'n.', def: '生活费；城堡主楼' }
        ]
    },
    'let': {
        phonetic: '/let/',
        entries: [
            { pos: 'v.', def: '让；允许；出租' }
        ]
    },
    'begin': {
        phonetic: '/bɪˈɡɪn/',
        entries: [
            { pos: 'v.', def: '开始；着手；起始' }
        ]
    },
    'seem': {
        phonetic: '/siːm/',
        entries: [
            { pos: 'v.', def: '似乎；好像；看来' }
        ]
    },
    'help': {
        phonetic: '/help/',
        entries: [
            { pos: 'v.', def: '帮助；协助；改善' },
            { pos: 'n.', def: '帮助；助手' }
        ]
    },
    'talk': {
        phonetic: '/tɔːk/',
        entries: [
            { pos: 'v.', def: '谈话；说话；商讨' },
            { pos: 'n.', def: '会谈；讲话；空谈' }
        ]
    },
    'turn': {
        phonetic: '/tɜːn/',
        entries: [
            { pos: 'v.', def: '转动；翻转；转变；变成' },
            { pos: 'n.', def: '转弯；轮流；转变' }
        ]
    },
    'start': {
        phonetic: '/stɑːt/',
        entries: [
            { pos: 'v.', def: '开始；启动；出发；惊起' },
            { pos: 'n.', def: '开端；起点' }
        ]
    },
    'show': {
        phonetic: '/ʃəʊ/',
        entries: [
            { pos: 'v.', def: '显示；出示；展示；表现' },
            { pos: 'n.', def: '展览；演出；迹象' }
        ]
    },
    'hear': {
        phonetic: '/hɪə(r)/',
        entries: [
            { pos: 'v.', def: '听见；听到；得知；倾听' }
        ]
    },
    'play': {
        phonetic: '/pleɪ/',
        entries: [
            { pos: 'v.', def: '玩；演奏；扮演；进行比赛' },
            { pos: 'n.', def: '戏剧；游玩' }
        ]
    },
    'run': {
        phonetic: '/rʌn/',
        entries: [
            { pos: 'v.', def: '跑；运转；经营；流淌' },
            { pos: 'n.', def: '跑步；行程' }
        ]
    },
    'move': {
        phonetic: '/muːv/',
        entries: [
            { pos: 'v.', def: '移动；搬家；感动；提议' },
            { pos: 'n.', def: '行动；步骤；搬家' }
        ]
    },
    'like': {
        phonetic: '/laɪk/',
        entries: [
            { pos: 'v.', def: '喜欢；喜爱' },
            { pos: 'prep.', def: '像；如同' }
        ]
    },
    'live': {
        phonetic: '/lɪv/',
        entries: [
            { pos: 'v.', def: '生活；居住；活着' },
            { pos: 'adj.', def: '活的；现场直播的 (/laɪv/)' }
        ]
    },
    'believe': {
        phonetic: '/bɪˈliːv/',
        entries: [
            { pos: 'v.', def: '相信；认为；信任' }
        ]
    },
    'hold': {
        phonetic: '/həʊld/',
        entries: [
            { pos: 'v.', def: '拿着；容纳；举行；保持' },
            { pos: 'n.', def: '握紧；控制；支撑点' }
        ]
    },
    'bring': {
        phonetic: '/brɪŋ/',
        entries: [
            { pos: 'v.', def: '带来；拿来；引起' }
        ]
    },
    'happen': {
        phonetic: '/ˈhæpən/',
        entries: [
            { pos: 'v.', def: '发生；碰巧；出现' }
        ]
    },
    'write': {
        phonetic: '/raɪt/',
        entries: [
            { pos: 'v.', def: '写；书写；写作；编写' }
        ]
    },
    'provide': {
        phonetic: '/prəˈvaɪd/',
        entries: [
            { pos: 'v.', def: '提供；供应；规定' }
        ]
    },
    'sit': {
        phonetic: '/sɪt/',
        entries: [
            { pos: 'v.', def: '坐；就座；坐落' }
        ]
    },
    'stand': {
        phonetic: '/stænd/',
        entries: [
            { pos: 'v.', def: '站立；容忍；处于；支持' },
            { pos: 'n.', def: '看台；立足点；货摊' }
        ]
    },
    'lose': {
        phonetic: '/luːz/',
        entries: [
            { pos: 'v.', def: '丢失；输掉；迷失；丧失' }
        ]
    },
    'pay': {
        phonetic: '/peɪ/',
        entries: [
            { pos: 'v.', def: '支付；付出代价；合算' },
            { pos: 'n.', def: '工资；报酬' }
        ]
    },
    'meet': {
        phonetic: '/miːt/',
        entries: [
            { pos: 'v.', def: '遇见；相遇；满足；符合' }
        ]
    },
    'include': {
        phonetic: '/ɪnˈkluːd/',
        entries: [
            { pos: 'v.', def: '包括；包含；列入' }
        ]
    },
    'continue': {
        phonetic: '/kənˈtɪnjuː/',
        entries: [
            { pos: 'v.', def: '继续；持续；延伸' }
        ]
    },
    'set': {
        phonetic: '/set/',
        entries: [
            { pos: 'v.', def: '设置；放置；树立；落下' },
            { pos: 'n.', def: '一套；集合；布景' }
        ]
    },
    'learn': {
        phonetic: '/lɜːn/',
        entries: [
            { pos: 'v.', def: '学习；得知；获悉；记住' }
        ]
    },
    'change': {
        phonetic: '/tʃeɪndʒ/',
        entries: [
            { pos: 'v.', def: '改变；变换；交换' },
            { pos: 'n.', def: '变化；零钱' }
        ]
    },
    'lead': {
        phonetic: '/liːd/',
        entries: [
            { pos: 'v.', def: '领导；引导；导致' },
            { pos: 'n.', def: '领先；线索；铅 (/led/)' }
        ]
    },
    'understand': {
        phonetic: '/ˌʌndəˈstænd/',
        entries: [
            { pos: 'v.', def: '理解；明白；懂；听说' }
        ]
    },
    'watch': {
        phonetic: '/wɒtʃ/',
        entries: [
            { pos: 'v.', def: '观看；注视；看守' },
            { pos: 'n.', def: '手表；监视；守夜' }
        ]
    },
    'follow': {
        phonetic: '/ˈfɒləʊ/',
        entries: [
            { pos: 'v.', def: '跟随；遵从；沿…而行；紧随' }
        ]
    },
    'stop': {
        phonetic: '/stɒp/',
        entries: [
            { pos: 'v.', def: '停止；阻止；逗留' },
            { pos: 'n.', def: '停止；车站；句号' }
        ]
    },
    'create': {
        phonetic: '/kriˈeɪt/',
        entries: [
            { pos: 'v.', def: '创造；创建；引起；造成' }
        ]
    },
    'speak': {
        phonetic: '/spiːk/',
        entries: [
            { pos: 'v.', def: '说；说话；演讲；讲（某种语言）' }
        ]
    },
    'allow': {
        phonetic: '/əˈlaʊ/',
        entries: [
            { pos: 'v.', def: '允许；承认；给予；同意' }
        ]
    },
    'add': {
        phonetic: '/æd/',
        entries: [
            { pos: 'v.', def: '添加；增加；补充说' }
        ]
    },
    'spend': {
        phonetic: '/spend/',
        entries: [
            { pos: 'v.', def: '花费；度过；消耗' }
        ]
    },
    'grow': {
        phonetic: '/ɡrəʊ/',
        entries: [
            { pos: 'v.', def: '生长；种植；变得；增长' }
        ]
    },
    'open': {
        phonetic: '/ˈəʊpən/',
        entries: [
            { pos: 'v.', def: '打开；开启；开放' },
            { pos: 'adj.', def: '开着的；公开的；坦率的' }
        ]
    },
    'walk': {
        phonetic: '/wɔːk/',
        entries: [
            { pos: 'v.', def: '散步；步行；走' },
            { pos: 'n.', def: '步行；散步；人行道' }
        ]
    },
    'win': {
        phonetic: '/wɪn/',
        entries: [
            { pos: 'v.', def: '赢；赢得；获得；成功' },
            { pos: 'n.', def: '胜利' }
        ]
    },
    'offer': {
        phonetic: '/ˈɒfə(r)/',
        entries: [
            { pos: 'v.', def: '提供；提议；奉献' },
            { pos: 'n.', def: '提议；出价；录取通知' }
        ]
    },
    'remember': {
        phonetic: '/rɪˈmembə(r)/',
        entries: [
            { pos: 'v.', def: '记住；想起；铭记；代向…问好' }
        ]
    },
    'love': {
        phonetic: '/lʌv/',
        entries: [
            { pos: 'v.', def: '爱；喜欢；热爱' },
            { pos: 'n.', def: '爱；爱情；喜爱' }
        ]
    },
    'consider': {
        phonetic: '/kənˈsɪdə(r)/',
        entries: [
            { pos: 'v.', def: '考虑；认为；顾及；细想' }
        ]
    },
    'appear': {
        phonetic: '/əˈpɪə(r)/',
        entries: [
            { pos: 'v.', def: '出现；显露；看来；出庭' }
        ]
    },
    'buy': {
        phonetic: '/baɪ/',
        entries: [
            { pos: 'v.', def: '购买；买；收买' },
            { pos: 'n.', def: '合算的交易' }
        ]
    },
    'wait': {
        phonetic: '/weɪt/',
        entries: [
            { pos: 'v.', def: '等待；等候；侍候' },
            { pos: 'n.', def: '等待；等待的时间' }
        ]
    },
    'serve': {
        phonetic: '/sɜːv/',
        entries: [
            { pos: 'v.', def: '服务；提供；服役；接待' }
        ]
    },
    'die': {
        phonetic: '/daɪ/',
        entries: [
            { pos: 'v.', def: '死亡；凋谢；停止运转' }
        ]
    },
    'send': {
        phonetic: '/send/',
        entries: [
            { pos: 'v.', def: '发送；寄送；派遣；传达' }
        ]
    },
    'expect': {
        phonetic: '/ɪkˈspekt/',
        entries: [
            { pos: 'v.', def: '预料；期待；指望；要求' }
        ]
    },
    'build': {
        phonetic: '/bɪld/',
        entries: [
            { pos: 'v.', def: '建造；构建；发展；建立' },
            { pos: 'n.', def: '体型；体格；构造' }
        ]
    },
    'stay': {
        phonetic: '/steɪ/',
        entries: [
            { pos: 'v.', def: '停留；保持；待；暂住' },
            { pos: 'n.', def: '停留；逗留' }
        ]
    },
    'fall': {
        phonetic: '/fɔːl/',
        entries: [
            { pos: 'v.', def: '落下；跌倒；降低；沦陷' },
            { pos: 'n.', def: '落下；秋天；瀑布' }
        ]
    },
    'cut': {
        phonetic: '/kʌt/',
        entries: [
            { pos: 'v.', def: '切；割；削减；剪短' },
            { pos: 'n.', def: '伤口；削减；切块' }
        ]
    },
    'reach': {
        phonetic: '/riːtʃ/',
        entries: [
            { pos: 'v.', def: '达到；抵达；伸出；联系' },
            { pos: 'n.', def: '范围；伸展' }
        ]
    },
    'kill': {
        phonetic: '/kɪl/',
        entries: [
            { pos: 'v.', def: '杀死；终结；毁掉；消磨' }
        ]
    },
    'remain': {
        phonetic: '/rɪˈmeɪn/',
        entries: [
            { pos: 'v.', def: '保持；依然；留下；剩余' }
        ]
    },
    'suggest': {
        phonetic: '/səˈdʒest/',
        entries: [
            { pos: 'v.', def: '建议；提议；暗示；表明' }
        ]
    },
    'raise': {
        phonetic: '/reɪz/',
        entries: [
            { pos: 'v.', def: '举起；提高；筹集；抚养；引起' },
            { pos: 'n.', def: '加薪' }
        ]
    },
    'pass': {
        phonetic: '/pɑːs/',
        entries: [
            { pos: 'v.', def: '通过；经过；传递；流逝' },
            { pos: 'n.', def: '及格；通行证；山口' }
        ]
    },
    'sell': {
        phonetic: '/sel/',
        entries: [
            { pos: 'v.', def: '出售；卖；推销；背叛' }
        ]
    },
    'require': {
        phonetic: '/rɪˈkwaɪə(r)/',
        entries: [
            { pos: 'v.', def: '需要；要求；命令' }
        ]
    },
    'report': {
        phonetic: '/rɪˈpɔːt/',
        entries: [
            { pos: 'v.', def: '报告；报道；汇报；报到' },
            { pos: 'n.', def: '报告；成绩单；报道' }
        ]
    },
    'decide': {
        phonetic: '/dɪˈsaɪd/',
        entries: [
            { pos: 'v.', def: '决定；决意；裁决；解决' }
        ]
    },
    'pull': {
        phonetic: '/pʊl/',
        entries: [
            { pos: 'v.', def: '拉；拖；拔出；扯' },
            { pos: 'n.', def: '拉力；引力' }
        ]
    }
}

/**
 * Normalizes input word/token for dictionary lookup.
 * Strips outer punctuation, quotes, trailing numbers, lowercases.
 *
 * @param {string} rawWord
 * @returns {string}
 */
export function normalizeWord(rawWord) {
    if (!rawWord || typeof rawWord !== 'string') return ''
    return rawWord
        .trim()
        .toLowerCase()
        // Normalize typographic apostrophes
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        // Strip non-letter/non-number from outer edges while preserving inner letters in any script (including Latin accents)
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

/**
 * Simple English lemmatization candidates for inflected words, possessives, and hyphens.
 *
 * @param {string} word
 * @returns {string[]}
 */
export function getLemmatizationCandidates(word) {
    const candidates = []
    if (!word || word.length < 3) return candidates

    // Possessive e.g. book's -> book, books' -> books -> book
    if (word.endsWith("'s") && word.length > 3) {
        const base = word.slice(0, -2)
        candidates.push(base)
        if (base.endsWith('s') && base.length > 3) {
            candidates.push(base.slice(0, -1))
        }
    } else if (word.endsWith("'") && word.length > 3) {
        const base = word.slice(0, -1)
        candidates.push(base)
        if (base.endsWith('s') && base.length > 3) {
            candidates.push(base.slice(0, -1))
        }
    }

    // Hyphenated compound words e.g. well-known -> well, known
    if (word.includes('-')) {
        const parts = word.split('-').filter(Boolean)
        if (parts.length > 0) {
            candidates.push(parts[0])
            if (parts.length > 1) {
                candidates.push(parts[1])
            }
        }
    }

    // Plural / 3rd-person singular -s / -es / -ies
    if (word.endsWith('ies') && word.length > 4) {
        candidates.push(word.slice(0, -3) + 'y')
    }
    if (word.endsWith('es') && word.length > 3) {
        candidates.push(word.slice(0, -2))
        candidates.push(word.slice(0, -1))
    }
    if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) {
        candidates.push(word.slice(0, -1))
    }

    // Past tense -ed / -d / -ied
    if (word.endsWith('ied') && word.length > 4) {
        candidates.push(word.slice(0, -3) + 'y')
    }
    if (word.endsWith('ed') && word.length > 3) {
        candidates.push(word.slice(0, -2))
        candidates.push(word.slice(0, -1))
    }

    // Participle -ing
    if (word.endsWith('ing') && word.length > 4) {
        candidates.push(word.slice(0, -3))
        candidates.push(word.slice(0, -3) + 'e')
        // double consonant e.g. running -> run
        if (word.length > 5) {
            const stem = word.slice(0, -3)
            if (stem[stem.length - 1] === stem[stem.length - 2]) {
                candidates.push(stem.slice(0, -1))
            }
        }
    }

    // Adverb -ly
    if (word.endsWith('ly') && word.length > 4) {
        candidates.push(word.slice(0, -2))
    }

    return candidates
}

/**
 * DictionaryService - Standalone Local Dictionary Lookup Service
 */
export class DictionaryService {
    constructor(app = null) {
        this.app = app
        this.customDict = new Map()
        this.cache = new Map()
        this.enabled = true
        this.saveHistory = false
        this.activeCard = null

        this.initSettings()
    }

    initSettings() {
        try {
            const raw = localStorage.getItem('linden_dict_enabled')
            if (raw !== null) {
                this.enabled = raw === 'true'
            }
            const rawHist = localStorage.getItem('linden_dict_save_history')
            if (rawHist !== null) {
                this.saveHistory = rawHist === 'true'
            }
        } catch (e) {}
    }

    setEnabled(enabled) {
        this.enabled = !!enabled
        try {
            localStorage.setItem('linden_dict_enabled', String(this.enabled))
        } catch (e) {}
    }

    setSaveHistory(save) {
        this.saveHistory = !!save
        try {
            localStorage.setItem('linden_dict_save_history', String(this.saveHistory))
        } catch (e) {}
    }

    /**
     * Look up word locally.
     * Decoupled from AI: NO 10-second cooldown, NO token budget, NO model API calls.
     *
     * @param {string} rawWord
     * @returns {{ found: boolean, word: string, normalizedWord: string, phonetic: string, entries: Array<{ pos: string, def: string }>, source: string }}
     */
    lookup(rawWord) {
        const norm = normalizeWord(rawWord)
        if (!norm) {
            return {
                found: false,
                word: rawWord,
                normalizedWord: '',
                phonetic: '',
                entries: [],
                source: '本地离线词典'
            }
        }

        // Cache hit
        if (this.cache.has(norm)) {
            return this.cache.get(norm)
        }

        // 1. Direct match in custom dictionary or builtin
        let record = this.customDict.get(norm) || BUILTIN_DICTIONARY[norm]
        let matchedWord = norm

        // 2. Lemmatization fallback
        if (!record) {
            const candidates = getLemmatizationCandidates(norm)
            for (const cand of candidates) {
                const found = this.customDict.get(cand) || BUILTIN_DICTIONARY[cand]
                if (found) {
                    record = found
                    matchedWord = cand
                    break
                }
            }
        }

        const result = {
            found: !!record,
            word: rawWord,
            normalizedWord: matchedWord,
            phonetic: record?.phonetic || '',
            entries: record?.entries || [],
            source: '本地离线词典'
        }

        this.cache.set(norm, result)

        if (this.saveHistory && result.found) {
            this.recordHistory(result)
        }

        return result
    }

    /**
     * Determines whether selection text qualifies for dictionary word lookup (single word / short phrase).
     *
     * @param {string} text
     * @returns {boolean}
     */
    isWordOrShortPhrase(text) {
        if (!text || typeof text !== 'string') return false
        const trimmed = text.trim()
        if (!trimmed || trimmed.length > 40) return false
        // Contains newline or sentence ending punctuation -> not a single word/phrase
        if (/[\r\n。！？!?]/.test(trimmed)) return false
        // Count words
        const words = trimmed.split(/\s+/).filter(Boolean)
        return words.length >= 1 && words.length <= 3
    }

    recordHistory(result) {
        try {
            const raw = localStorage.getItem('linden_dict_history') || '[]'
            const list = JSON.parse(raw)
            list.unshift({
                word: result.normalizedWord || result.word,
                entries: result.entries.slice(0, 2),
                timestamp: Date.now()
            })
            // Keep at most 200 entries
            if (list.length > 200) list.length = 200
            localStorage.setItem('linden_dict_history', JSON.stringify(list))
        } catch (e) {}
    }

    clearHistory() {
        try {
            localStorage.removeItem('linden_dict_history')
        } catch (e) {}
    }

    getHistory() {
        try {
            const raw = localStorage.getItem('linden_dict_history')
            return raw ? JSON.parse(raw) : []
        } catch (e) {
            return []
        }
    }
}

// Global shared singleton
export const dictionaryService = new DictionaryService()
