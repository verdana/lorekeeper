import { describe, expect, it } from 'vitest'
import { extractChapterOutline } from '../../src/renderer/src/outlineBeats'

const outline = `## 五、逐章大纲

### 第一幕：死者的书房（1—5章）

#### 第01章｜血月下的第二次心跳

- 奥莉薇娅以霜棺刺穿艾洛斯心脏。
- **章尾：** 已经停下的心脏再次跳动。

#### 第02章｜盘没有回答他

- 杨羽爬入书房，找到真盘。
- **章尾：** 楼下骑士齐齐转身追向铅盒。

#### 第03章｜镜子里的人先动了

- 留守骑士搜查书房。杨羽借全身镜中反照伤痕制造一次误判。
- 反照不能实体伤人。杨羽用壁炉灰、门闩和普通短枪完成反制。
- 他能够补枪杀死留守骑士，却选择先解除武器并把人拖离烟尘。
- 他取得克莱门特遗落的证物封条。
- **章尾：** 一柄短剑抵住杨羽后颈，陌生女人准确说出艾洛斯藏真盘的位置。

#### 第04章｜门外的女上尉

- 瓦莱里娅按艾洛斯密信潜入。
- **章尾：** 瓦莱里娅收剑。
`

describe('extractChapterOutline', () => {
  it('extracts the author beats between the chapter heading and the next one', () => {
    const beats = extractChapterOutline(outline, '第03章｜镜子里的人先动了')
    expect(beats).toContain('留守骑士搜查书房。杨羽借全身镜中反照伤痕制造一次误判。')
    expect(beats).toContain('一柄短剑抵住杨羽后颈，陌生女人准确说出艾洛斯藏真盘的位置。')
    expect(beats).not.toContain('第04章｜门外的女上尉')
    expect(beats).not.toContain('第02章｜盘没有回答他')
  })

  it('falls back to the chapter ordinal when the heading title differs slightly', () => {
    const beats = extractChapterOutline(outline, '第03章｜镜子里的影子先动了')
    expect(beats).toContain('留守骑士搜查书房')
  })

  it('returns empty when the outline has no matching chapter block', () => {
    expect(extractChapterOutline(outline, '第99章｜不存在的章节')).toBe('')
    expect(extractChapterOutline('', '第03章｜镜子里的人先动了')).toBe('')
    expect(extractChapterOutline(outline, '')).toBe('')
  })

  it('handles a chapter block that runs to the end of the document', () => {
    const tail = `${outline}\n\n#### 第05章｜账只算到天亮\n\n- 两人只约定三件事。`
    const beats = extractChapterOutline(tail, '第05章｜账只算到天亮')
    expect(beats).toContain('两人只约定三件事')
  })

  it('does not cross act headings that separate chapter blocks', () => {
    const beats = extractChapterOutline(outline, '第01章｜血月下的第二次心跳')
    expect(beats).toContain('奥莉薇娅以霜棺刺穿艾洛斯心脏。')
    expect(beats).not.toContain('第02章｜盘没有回答他')
  })
})
