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

console.log("selftest ok");
