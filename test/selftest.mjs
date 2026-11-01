// 自测：不连宿主，把 lib/client.js 当浏览器 bundle 跑一遍——
// 用假的 window.__ModuleLoader__ 截下工厂，用假 React / 假 document 执行。
// 覆盖：没有要求就没有批注 / 只发已勾选 / 注册的槽与 id /
//       缺陷1 点击右半边空白不得弹批注 / 缺陷2 面板清单与插槽生命周期解耦。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 最小 DOM：够跑 renderPanel 的建节点 / append / className / dataset / textContent。
function fakeEl(tag) {
  const e = {
    tag,
    style: {},
    dataset: {},
    attrs: {},
    children: [],
    className: "",
    _text: "",
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute() {
      return null;
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    append() {
      for (let i = 0; i < arguments.length; i++) this.children.push(arguments[i]);
    },
    addEventListener() {},
    removeEventListener() {},
    remove() {},
  };
  Object.defineProperty(e, "textContent", {
    get() {
      return this._text;
    },
    set(v) {
      this._text = v;
      this.children.length = 0;
    },
  });
  return e;
}

const body = fakeEl("body");
let factory = null;
globalThis.window = {
  innerWidth: 1200,
  innerHeight: 900,
  getSelection: () => null,
  __ModuleLoader__: {
    load(o) {
      factory = o.factory;
    },
  },
};
globalThis.document = {
  head: fakeEl("head"),
  body,
  getElementById() {
    return null;
  },
  querySelector() {
    return null;
  },
  createElement: fakeEl,
  addEventListener() {},
  removeEventListener() {},
};

const fakeReact = {
  createElement: () => null,
  useState: (v) => [v, () => {}],
  useEffect: () => {},
};

new Function(readFileSync(join(ROOT, "lib/client.js"), "utf8"))();
assert.equal(typeof factory, "function", "bundle 必须通过 window.__ModuleLoader__.load 注册工厂");

const mod = factory((id) => {
  if (id === "react") return fakeReact;
  throw new Error("unexpected require: " + id);
});

const t = mod.__test;
assert.ok(t, "应导出 __test");
assert.deepEqual(mod.inject, ["slots"]);

// --- 没有要求就没有批注 ---
t.reset();
const list = t.getItems();
t.pushItem(list, { kind: "text", ref: "这段文字", note: "   " });
assert.equal(list.length, 0, "要求为空白时不得生成批注");
t.pushItem(list, { kind: "text", ref: "这段文字", note: null });
assert.equal(list.length, 0, "要求为 null 时不得生成批注");

// --- 正常一条：扁平字段，一条一句话要求 ---
t.pushItem(list, { kind: "image", ref: "fig1", x: 0.4321, y: 0.9876, note: "  把图例挪到左边  " });
assert.equal(list.length, 1);
assert.deepEqual(Object.keys(list[0]).sort(), ["id", "kind", "note", "on", "ref", "x", "y"]);
assert.equal(list[0].note, "把图例挪到左边", "首尾空白要 trim");
assert.equal(list[0].on, true, "新批注默认勾选");
assert.equal(list[0].kind, "image");
t.pushItem(list, { kind: "??", ref: "x", note: "兜底" });
assert.equal(list[1].kind, "text", "未知 kind 兜底成 text");

// --- 只发已勾选的 ---
t.pushItem(list, { kind: "panel", ref: "右栏预览", note: "标题换行" });
assert.equal(list.length, 3);
list[1].on = false;
const text = t.buildPrompt(list);
assert.ok(text.startsWith("请按下面 2 条批注修改："), text);
assert.ok(text.includes("位置 43%, 99%"), text);
assert.ok(text.includes("[侧栏面板]"), text);
assert.ok(!text.includes("兜底"), "未勾选的条目不能出现在正文里");
for (const i of list) i.on = false;
assert.equal(t.buildPrompt(list), "");
t.reset();
assert.equal(t.buildPrompt(t.getItems()), "");

// --- 缺陷1：点击右半边空白不得弹批注 ---
const blank = { closest: () => null };
assert.equal(
  t.hitAt(blank, { zone: "panel", selText: "", cx: 1100, cy: 500 }),
  null,
  "右半边空白（zone=panel 但没有内容）不得给批注入口",
);
assert.equal(t.hitAt(blank, { zone: null, selText: "", cx: 300, cy: 500 }), null, "对话区空白同样不弹");

// 图片：对话里记 image，右栏里记 panel，坐标归一化
const imgEl = {
  tagName: "IMG",
  getAttribute: () => "fig",
  getBoundingClientRect: () => ({ left: 100, top: 200, width: 200, height: 100 }),
  closest: (sel) => (sel === "img" ? imgEl : null),
};
const chatImg = t.hitAt(imgEl, { zone: null, selText: "", cx: 200, cy: 250 });
assert.equal(chatImg.kind, "image");
assert.equal(chatImg.ref, "fig");
assert.equal(chatImg.x, 0.5);
assert.equal(chatImg.y, 0.5);
assert.equal(t.hitAt(imgEl, { zone: "panel", selText: "", cx: 200, cy: 250 }).kind, "panel");

// iframe / embed / canvas 预览容器可批注（PDF 常是 embed 或 iframe）
const frameEl = { tagName: "IFRAME", closest: (sel) => (sel.includes("iframe") ? frameEl : null) };
const fhit = t.hitAt(frameEl, { zone: "panel", selText: "", cx: 1100, cy: 400 });
assert.equal(fhit.kind, "panel");
assert.equal(fhit.ref, "<iframe>");
const embedEl = { tagName: "EMBED", closest: (sel) => (sel.includes("embed") ? embedEl : null) };
assert.equal(t.hitAt(embedEl, { zone: "panel", selText: "", cx: 1100, cy: 400 }).ref, "<embed>");

// 文字选区可批注；输入框里的选区不行
assert.equal(t.hitAt(blank, { zone: null, selText: "这段文字", cx: 300, cy: 300 }).kind, "text");
assert.equal(t.hitAt(blank, { zone: "panel", selText: "右栏文字", cx: 1100, cy: 300 }).kind, "panel");
const inputEl = { closest: (sel) => (sel.includes("input") ? inputEl : null) };
assert.equal(t.hitAt(inputEl, { zone: null, selText: "草稿", cx: 300, cy: 700 }), null);

// --- apply：注册到 conversation.input.right，id 固定 ---
const registered = [];
const injections = [];
const ctx = {
  slots: {
    inject: (name, fn) => injections.push(name) && fn(),
    register: (meta, comp) => {
      registered.push({ meta, comp });
      return () => {};
    },
  },
  on: () => {},
};
mod.apply(ctx);
assert.deepEqual(injections, ["conversation.input.right"]);
assert.equal(registered.length, 1);
assert.equal(registered[0].meta.name, "conversation.input.right");
assert.equal(registered[0].meta.id, "annotate");
assert.equal(typeof registered[0].comp, "function", "开关按钮必须是 React 组件");

// --- 缺陷2：清单不随插槽生命周期走 ---
// 面板必须挂在自己建在 body 上的节点里，而不是渲染在输入框插槽的组件树内。
const panel = body.children.find((c) => c.className === "an-panel");
assert.ok(panel, "面板应挂在 body 上（与插槽卸载解耦）");
assert.equal(panel.style.display, "none", "没打开时不显示");

// 清单位置：贴「批注」按钮上方（按钮拿不到时退回右下角），不再抢占右上角停靠位
t.setPanelOpen(true);
assert.equal(panel.style.bottom, "84px", "清单应从底部锚定（浮在输入框按钮上方）");
assert.equal(panel.style.right, "14px");
assert.equal(panel.style.top, undefined, "不能再写 top，否则会跑回右上角");
t.setPanelOpen(false);

t.reset();
t.pushItem(t.getItems(), { kind: "text", ref: "第一处", note: "太笼统" });
t.pushItem(t.getItems(), { kind: "image", ref: "fig", x: 0.25, y: 0.5, note: "图例左移" });

// 反复开合（相当于右栏反复开关、插槽反复重挂）：清单与渲染都得留着
for (let i = 0; i < 5; i++) {
  t.setPanelOpen(true);
  assert.equal(panel.style.display, "flex", "打开时面板应可见（第 " + (i + 1) + " 次）");
  assert.equal(panel.children.length, 3, "面板应有 head / list / foot 三段");
  const rows = panel.children[1].children;
  assert.equal(rows.length, 2, "两条批注都要渲染出来（第 " + (i + 1) + " 次）");
  assert.equal(t.getItems().length, 2, "开合不得清空数据");
  t.setPanelOpen(false);
  assert.equal(panel.style.display, "none");
  assert.equal(t.getItems().length, 2, "关闭同样不得清空数据");
}
assert.equal(t.buildPrompt(t.getItems()).includes("太笼统"), true);

// --- 清单尺寸与 yml / package.json 对得上 ---
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
assert.equal(pkg.dsh.bundle.patch, "cordis.patch.yml");
assert.equal(pkg.dsh.client.platform, "web");
assert.ok(pkg.files.includes("lib/client.js"));
const yml = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
assert.ok(yml.includes("- insert:"), "patch 必须用 insert: 包裹");
assert.ok(yml.includes("name: dsh-annotate"), yml);

// --- 写回失败不得报成功（宿主 insertText 在 revision 漂移时返回 false） ---
t.reset();
t.pushItem(t.getItems(), { kind: "text", ref: "A", note: "改一下" });
const calls = [];
t.setComposer((text) => {
  calls.push(text);
  return false;
});
assert.equal(t.doSend(), false, "宿主拒绝时 doSend 必须返回 false");
assert.equal(t.getItems().length, 1, "写回失败不得清空清单");

// --- 宿主接受：清单清空，且可以撤销 ---
t.setComposer((text) => {
  calls.push(text);
  return true;
});
assert.equal(t.doSend(), true);
assert.equal(t.getItems().length, 0, "发送成功后清单清空");
assert.ok(t.hasBackup(), "要留住刚发出的那批供撤销");
t.doUndo();
assert.equal(t.getItems().length, 1, "撤销把批注恢复回来");
assert.equal(t.getItems()[0].note, "改一下");

// --- 清单按会话分桶：切会话不能串味 ---
t.reset();
t.setSession("s1");
t.pushItem(t.getItems(), { kind: "text", ref: "S1", note: "会话一" });
t.setSession("s2");
assert.equal(t.getItems().length, 0, "另一个会话看不到上一段的批注");
t.pushItem(t.getItems(), { kind: "text", ref: "S2", note: "会话二" });
t.setSession("s1");
assert.equal(t.getItems().length, 1);
assert.equal(t.getItems()[0].ref, "S1");

// --- 图片 ref：无 alt 用文件名，再退回「第 N 张图」 ---
const noAlt = { getAttribute: (k) => (k === "src" ? "https://x/y/fig-2.png?raw=1" : null) };
assert.equal(t.imageRef(noAlt), "fig-2.png");
const dataImg = { getAttribute: (k) => (k === "src" ? "data:image/png;base64,AAAA" : null) };
assert.equal(t.imageRef(dataImg), "内嵌图片", "拿不到消息容器就不给会漂移的序号");

// --- 文字批注带上前后文上下文 ---
const ctxHit = t.hitAt(
  { closest: () => null },
  { zone: null, selText: "结论", selCtx: "前文 … 结论 … 后文", cx: 10, cy: 10 },
);
assert.equal(ctxHit.kind, "text");
assert.ok(ctxHit.ref.includes("前文"), ctxHit.ref);

// --- 新批注出现后，上一次的「撤销」必须失效（否则撤销会把新条目一起吞掉） ---
t.reset();
t.pushItem(t.getItems(), { kind: "text", ref: "旧", note: "旧的一条" });
t.setComposer(() => true);
t.doSend();
assert.ok(t.hasBackup(), "发送后应留下撤销备份");
t.pushItem(t.getItems(), { kind: "text", ref: "新", note: "新的一条" });
assert.equal(t.hasBackup(), false, "新批注一出现，撤销备份就该作废");
t.doUndo();
assert.equal(t.getItems().length, 1, "撤销不得把新批注吞掉");
assert.equal(t.getItems()[0].note, "新的一条");

// --- ⑤ 图片兜底编号：容器内计数、带会话前缀 ---
const mkDataImg = () => ({ getAttribute: (k) => (k === "src" ? "data:image/png;base64,AAAA" : null) });
const mkBox = (key, imgs) => ({
  getAttribute: (k) => (k === "data-chat-node-key" ? key : null),
  querySelectorAll: () => imgs,
});
t.setSession("s1");
const imgA = mkDataImg();
const imgB = mkDataImg();
const boxA = mkBox("chat-a1b2", [mkDataImg(), mkDataImg(), imgA]);
const boxB = mkBox("chat-b9z8", [mkDataImg(), mkDataImg(), imgB]);
imgA.closest = () => boxA;
imgB.closest = () => boxB;
assert.equal(t.imageRef(imgA), "第 3/3 张图 · s1/chat-a1b2", "按消息容器计数，键带会话前缀");
assert.notEqual(t.imageRef(imgA), t.imageRef(imgB), "不同消息里同序号的图不得同 ref");
t.setSession("s2");
const refOtherSession = t.imageRef(imgA);
t.setSession("s1");
assert.notEqual(t.imageRef(imgA), refOtherSession, "同一张图换个会话也不能同 ref（轮次号跨会话重号）");

// --- ⑤ 头像/图标不算数；懒加载量不到宽高的图仍要算 ---
const realImg = mkDataImg();
const avatarImg = mkDataImg();
const lazyImg = mkDataImg();
realImg.naturalWidth = 800;
realImg.naturalHeight = 600;
avatarImg.naturalWidth = 24;
avatarImg.naturalHeight = 24;
const fbox = mkBox("chat-f1", [avatarImg, realImg, lazyImg]);
realImg.closest = () => fbox;
lazyImg.closest = () => fbox;
assert.equal(t.imageRef(realImg), "第 1/2 张图 · s1/chat-f1", "24px 头像必须过滤，量不到宽高的懒加载图按真图计");

// --- ⑧ 来源标签：对话区 → null，右栏 → panel，其它 → page ---
const mkTarget = (opts) => ({
  closest: (sel) => {
    if (opts.chat && /data-conversation-scroll/.test(sel)) return {};
    if (opts.dock && /data-sidebar-right-session/.test(sel)) return {};
    return null;
  },
});
assert.equal(t.zoneOf(mkTarget({ dock: true })), "panel");
assert.equal(t.zoneOf(mkTarget({ chat: true, dock: true })), null, "对话区优先：工作区整体包在 pane 里也不能标成侧栏面板");
assert.equal(t.zoneOf(mkTarget({})), "page", "非对话、非右栏的内容算「页面」，不是「对话」");
assert.equal(t.zoneOf(null), null);
assert.equal(t.zoneOf({}), null, "没有 closest 的元素也要安全退回 null");
const pageHit = t.hitAt(mkTarget({}), { zone: "page", selText: "标题", selCtx: "标题", cx: 1, cy: 1 });
assert.equal(pageHit.kind, "page");
assert.equal(t.KIND_LABEL.page, "页面");

// --- ④ 角标重算：预览增删/自身属性变化触发，canvas 也算候选，60ms 节流不退化 ---
const previewNode = { nodeType: 1, matches: (s) => s.indexOf("iframe") >= 0, querySelector: () => null };
assert.equal(
  t.pinSyncRelevant({ type: "childList", addedNodes: [previewNode], removedNodes: [] }),
  true,
  "预览插入要重算角标",
);
assert.equal(
  t.pinSyncRelevant({ type: "childList", addedNodes: [{ nodeType: 1, matches: () => false, querySelector: () => null }], removedNodes: [] }),
  false,
  "普通节点插入不重算",
);
assert.equal(t.pinSyncRelevant({ type: "attributes", target: previewNode }), true, "预览自身 style/class 变化要重算");
assert.equal(
  t.pinSyncRelevant({ type: "attributes", target: { nodeType: 1, matches: () => false } }),
  false,
  "别的节点属性抖动不重算（不扫全树）",
);

let observed = [];
let roFire = null;
globalThis.ResizeObserver = class {
  constructor(cb) {
    roFire = cb;
  }
  observe(n) {
    observed.push(n);
  }
  unobserve() {}
  disconnect() {}
};
let rectFrame = { left: 100, top: 200, width: 300, height: 200, right: 400, bottom: 400 };
let rectCanvas = { left: 10, top: 10, width: 200, height: 200, right: 210, bottom: 210 };
const frameNode = {
  tagName: "IFRAME",
  nodeType: 1,
  getBoundingClientRect: () => rectFrame,
  matches: (s) => s.indexOf("iframe") >= 0,
  querySelector: () => null,
};
const canvasNode = {
  tagName: "CANVAS",
  nodeType: 1,
  getBoundingClientRect: () => rectCanvas,
  matches: (s) => s.indexOf("canvas") >= 0,
  querySelector: () => null,
};
const hadQSPins = document.querySelectorAll;
const parentBox = { nodeType: 1 };
frameNode.parentElement = parentBox;
document.querySelectorAll = (sel) => (sel === "iframe, embed, object" ? [frameNode] : []);

const pins = t.pins();
assert.ok(pins, "角标探针要在 apply 时挂上");
pins.sync();
let snap = pins.snapshot();
assert.equal(snap.length, 1, "只给 iframe/embed/object 挂角标：canvas 不吃 mouseup，直接点即可");
assert.ok(observed.indexOf(frameNode) >= 0, "预览自身要进 ResizeObserver");
assert.ok(observed.indexOf(parentBox) >= 0, "父容器也要盯，否则流式内容把预览推下去时角标不动");
assert.equal(observed.length, 2, "同一块预览 + 父容器各 observe 一次");
assert.equal(snap[0].left, "388px", "角标贴预览右下（400-0-12）");
assert.equal(snap[0].top, "388px");

rectFrame = { left: 100, top: 200, width: 400, height: 100, right: 500, bottom: 300 };
pins.sync();
snap = pins.snapshot();
assert.equal(snap[0].left, "488px", "预览变宽后角标必须重算到新位置");
assert.equal(snap[0].top, "288px");
assert.equal(observed.length, 2, "稳定集合不得反复 observe（否则自触发循环）");

rectFrame = { left: 100, top: 200, width: 50, height: 50, right: 150, bottom: 250 };
pins.sync();
assert.equal(pins.snapshot().length, 0, "缩到看不见的预览不再挂角标");

const before = pins.syncs;
pins.schedule();
pins.schedule();
await new Promise((r) => setTimeout(r, 120));
assert.equal(pins.syncs, before + 1, "60ms 节流：连触发两次只重算一次");

const beforeRO = pins.syncs;
roFire([], {});
await new Promise((r) => setTimeout(r, 120));
assert.equal(pins.syncs, beforeRO + 1, "预览尺寸变化要经 ResizeObserver 触发重算");

document.querySelectorAll = hadQSPins;
delete globalThis.ResizeObserver;

// --- 必修1：只移出勾选的，没勾的必须留着 ---
t.reset();
t.setSession("s9");
t.pushItem(t.getItems(), { kind: "text", ref: "A", note: "第一条" });
t.pushItem(t.getItems(), { kind: "text", ref: "B", note: "第二条" });
t.pushItem(t.getItems(), { kind: "text", ref: "C", note: "第三条" });
t.getItems()[1].on = false;
t.setComposer(() => true);
assert.equal(t.doSend(), true);
assert.equal(t.getItems().length, 1, "没勾的那条必须留在清单里");
assert.equal(t.getItems()[0].ref, "B");
t.doUndo();
assert.equal(t.getItems().length, 3, "撤销把已发的放回，且不吞掉没勾的");

// --- 必修3：写回被拒不能说成「没有输入框」 ---
t.reset();
t.setSession("s10");
t.pushItem(t.getItems(), { kind: "text", ref: "X", note: "写回会失败" });
t.setComposer(() => false);
assert.equal(t.doSend(), false);
assert.equal(t.getItems().length, 1, "写回失败不得清清单");
assert.ok(t.hint().includes("草稿刚变过"), "失败文案要指向「再点一次」：" + t.hint());

const noApi = t.writeBack({ draft: "", draftRev: 1, actions: {}, text: "x" });
assert.equal(noApi.ok, false);
assert.equal(noApi.noApi, true, "两张 API 都没有才算「没有输入框」");

// --- 必修4：草稿里有 chip/附件占位符时只追加，不整段替换 ---
const chipDraft = "看一下这段\uFFFC 再改";
const chipCalls = [];
const chipRes = t.writeBack({
  draft: chipDraft,
  draftRev: 7,
  actions: {
    insertText: (text, span) => {
      chipCalls.push({ text, span });
      return true;
    },
  },
  text: "请按下面 1 条批注修改：",
});
assert.equal(chipRes.ok, true);
assert.equal(chipCalls[0].span.start, chipDraft.length, "含占位符时 start 必须是草稿末尾");
assert.equal(chipCalls[0].span.end, chipDraft.length, "含占位符时 end 必须是草稿末尾");
assert.ok(!chipCalls[0].text.includes("看一下"), "不得整段替换草稿（会抹掉 chip）");
assert.ok(chipRes.note.includes("原引用保留"), "提示语要说清原引用保留：" + chipRes.note);

const plainCalls = [];
const plainDraft = "旧草稿内容";
t.writeBack({
  draft: plainDraft,
  draftRev: 7,
  actions: {
    insertText: (text, span) => {
      plainCalls.push({ text, span });
      return true;
    },
  },
  text: "批注",
});
assert.equal(plainCalls[0].span.start, 0);
assert.equal(plainCalls[0].span.end, plainDraft.length);
assert.equal(plainCalls[0].text, plainDraft + "\n\n批注", "没有占位符时仍整段替换写回");

// --- 建议11：插槽没挂时不得把批注写进上一个会话的桶 ---
t.reset();
t.setButton(null);
assert.equal(t.slotLive(), false);
assert.equal(t.record({ kind: "text", ref: "R", x: null, y: null }, "无会话"), false);
assert.equal(t.getItems().length, 0, "没有可归属的会话就不记");
t.setButton({ isConnected: true });
assert.equal(t.record({ kind: "text", ref: "R", x: null, y: null }, "有会话"), true);
assert.equal(t.getItems().length, 1);

console.log("selftest ok");
