// dsh-annotate 客户端：右侧停靠的批注面板 + 三处手势批注。
//
// 三条批注位置：
//   ① 右侧面板内容（右栏里的文档 / 图片预览）：选中文字、点图，或点 iframe/canvas 预览
//   ② 对话里的文字：选中 → 浮出「＋ 批注」
//   ③ 对话里的图片：点图 → 按点击位置（归一化百分比）浮出「＋ 批注」
//
// 一条批注 = 一个锚点（kind/ref/x/y）+ 一句话要求（note）。没有要求就没有批注：
// 悬浮卡片的保存按钮在要求为空时是禁用的，pushItem 也会再拦一道。
//
// 清单按会话分桶：切到另一个会话就看不到、也发不出上一段的批注。
//
// 语义：批注只是给 AI 的修改指令。不写回源软件，不画进成品图，也不落盘。
window.__ModuleLoader__.load({
  id: "dsh-annotate",
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useState } = React;

    const inject = ["slots"];
    const SLOT = "conversation.input.right";
    const ENTRY_ID = "annotate";
    const UI_ATTR = "data-annotate-ui";
    const CTX_CHARS = 20; // 文字批注额外带选区前后各多少字，长文档里重复句子才分得清

    // ---------------- 数据 ----------------
    // 极简扁平：{ id, kind, ref, x, y, note, on }。x/y 只有 kind=image 才有意义。
    // 全部放在模块作用域（按会话分桶）：不挂在任何 React 组件的 state 上，右栏开合 /
    // 输入框插槽卸载重挂 / 会话重渲染都不会动到这份清单。
    const KIND_LABEL = { text: "对话文字", image: "对话图片", panel: "侧栏面板" };

    const buckets = new Map();
    let currentSession = "";

    function bucketOf(id) {
      let b = buckets.get(id);
      if (!b) {
        b = { items: [], seq: 0 };
        buckets.set(id, b);
      }
      return b;
    }
    const bucket = () => bucketOf(currentSession);
    const list = () => bucket().items;

    function pushItem(list, { kind, ref, x, y, note }) {
      const text = String(note == null ? "" : note).trim();
      if (!text) return list; // 没有要求就没有批注
      list.push({
        id: ++bucket().seq,
        kind: KIND_LABEL[kind] ? kind : "text",
        ref: String(ref == null ? "" : ref).trim(),
        x: x == null ? null : x,
        y: y == null ? null : y,
        note: text,
        on: true,
      });
      // 新批注一出现，上一次「撤销」就不再成立——否则撤销会把这条新批注一起吞掉。
      sentBackup = null;
      sendHint = "";
      return list;
    }

    // 只收已勾选的条目，一条都没有就返回空串（发送按钮据此禁用）。
    function buildPrompt(list) {
      const picked = list.filter((i) => i.on);
      if (!picked.length) return "";
      const out = ["请按下面 " + picked.length + " 条批注修改："];
      picked.forEach((i, n) => {
        let head = n + 1 + ". [" + KIND_LABEL[i.kind] + "]";
        if (i.kind === "image" && i.x != null && i.y != null) {
          head += " 位置 " + Math.round(i.x * 100) + "%, " + Math.round(i.y * 100) + "%";
        }
        if (i.ref) head += "：" + (i.ref.length > 80 ? i.ref.slice(0, 80) + "…" : i.ref);
        out.push(head);
        out.push("   要求：" + i.note);
      });
      return out.join("\n");
    }

    function metaText(item) {
      let text = KIND_LABEL[item.kind] || "批注";
      if (item.kind === "image" && item.x != null && item.y != null) {
        text += " · " + Math.round(item.x * 100) + "%, " + Math.round(item.y * 100) + "%";
      }
      if (item.ref) text += " · " + item.ref.replace(/\s+/g, " ").slice(0, 40);
      return text;
    }

    // ---------------- 样式 ----------------
    const CSS = `
      .an-btn {
        all: unset; display: inline-flex; align-items: center; gap: 4px; flex: none;
        height: 28px; padding: 0 8px; border-radius: var(--dsw-radius-sm, 6px);
        font-size: 12px; line-height: 1; cursor: pointer; user-select: none;
        color: var(--dsw-alias-label-primary, #1f1f1f);
        border: 1px solid var(--dsw-alias-line-1, rgba(0,0,0,.14));
        background: var(--dsw-alias-bg-base, transparent);
      }
      .an-btn:hover { background: var(--dsw-alias-bg-hover, rgba(0,0,0,.05)); }
      .an-btn[data-on="1"] { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
      .an-badge { font-variant-numeric: tabular-nums; opacity: .7; }

      /* all: unset 抹掉了原生焦点环，键盘 Tab 过去会看不见落点，这里统一补回。 */
      .an-btn:focus-visible, .an-pin:focus-visible, .an-send:focus-visible,
      .an-x:focus-visible, .an-del:focus-visible, .an-undo:focus-visible,
      .an-tip-btn:focus-visible, .an-tip-row button:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
        outline-offset: 1px;
      }

      .an-panel {
        position: fixed; right: 14px; bottom: 84px; z-index: 9999;
        width: 320px; max-height: min(70vh, 560px); display: flex; flex-direction: column;
        border-radius: 10px; overflow: hidden; font-size: 12px;
        color: var(--dsw-alias-label-primary, #1f1f1f);
        background: var(--dsw-alias-bg-elevated, #fff);
        border: 1px solid var(--dsw-alias-line-1, rgba(0,0,0,.14));
        box-shadow: 0 10px 30px rgba(0,0,0,.16);
      }

      /* 预览（PDF / 文档 iframe）的常驻角标：指针进到 iframe 里面之后父文档收不到
         mouseup，只能靠这块小按钮进批注。放右下角，避开阅读器自己的顶部工具栏。 */
      .an-pin {
        all: unset; position: fixed; z-index: 9998; cursor: pointer;
        height: 22px; padding: 0 8px; border-radius: 6px;
        font-size: 11px; line-height: 22px; opacity: .5; user-select: none;
        color: #fff; background: var(--dsw-alias-brand-primary, #4d6bfe);
        box-shadow: 0 2px 8px rgba(0,0,0,.2);
      }
      .an-pin:hover { opacity: 1; }
      .an-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
        border-bottom: 1px solid var(--dsw-alias-line-1, rgba(0,0,0,.1)); font-weight: 600; }
      .an-head .an-x { all: unset; margin-left: auto; cursor: pointer; opacity: .55;
        width: 22px; height: 22px; display: inline-flex; align-items: center;
        justify-content: center; border-radius: 4px; font-size: 13px; }
      .an-head .an-x:hover { opacity: 1; background: rgba(0,0,0,.06); }
      .an-list { flex: 1; overflow: auto; padding: 6px 0; }
      .an-empty { padding: 18px 14px; opacity: .6; line-height: 1.6; }
      .an-row { display: flex; gap: 8px; padding: 8px 12px; align-items: flex-start; }
      .an-row + .an-row { border-top: 1px dashed var(--dsw-alias-line-1, rgba(0,0,0,.08)); }
      .an-row[data-off="1"] { opacity: .45; }
      .an-row input { margin: 2px 0 0; flex: none; cursor: pointer; }
      .an-body { flex: 1; min-width: 0; }
      .an-meta { opacity: .6; font-size: 11px; margin-bottom: 2px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
      .an-note { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
      .an-del { all: unset; flex: none; cursor: pointer; width: 22px; height: 22px;
        display: inline-flex; align-items: center; justify-content: center;
        border-radius: 4px; font-size: 15px; line-height: 1; opacity: .45; }
      .an-del:hover { opacity: 1; color: #d4380d; background: rgba(212,56,13,.1); }
      .an-foot { padding: 8px 12px 10px; border-top: 1px solid var(--dsw-alias-line-1, rgba(0,0,0,.1)); }
      .an-send { all: unset; box-sizing: border-box; display: block; width: 100%; height: 32px;
        text-align: center; line-height: 32px; border-radius: var(--dsw-radius-sm, 6px);
        font-size: 12px; font-weight: 600; cursor: pointer;
        color: #fff; background: var(--dsw-alias-brand-primary, #4d6bfe); }
      .an-send[disabled] { opacity: .4; cursor: not-allowed; }
      .an-hint { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 11px; opacity: .65; }
      .an-undo { all: unset; cursor: pointer; text-decoration: underline; font-size: 11px; }

      .an-tip { position: fixed; z-index: 10000; font-size: 12px; }
      .an-tip-btn { all: unset; cursor: pointer; padding: 5px 10px; border-radius: 999px;
        color: #fff; background: var(--dsw-alias-brand-primary, #4d6bfe);
        box-shadow: 0 4px 14px rgba(0,0,0,.22); user-select: none; }
      .an-tip-card { width: 280px; padding: 10px; border-radius: 10px; user-select: none;
        color: var(--dsw-alias-label-primary, #1f1f1f);
        background: var(--dsw-alias-bg-elevated, #fff);
        border: 1px solid var(--dsw-alias-line-1, rgba(0,0,0,.14));
        box-shadow: 0 10px 30px rgba(0,0,0,.18); }
      .an-tip-head { font-weight: 600; margin-bottom: 4px; }
      .an-tip-ref { opacity: .6; font-size: 11px; margin-bottom: 6px; max-height: 48px;
        overflow: hidden; word-break: break-word; }
      .an-tip-input { box-sizing: border-box; width: 100%; resize: vertical; min-height: 48px;
        font: inherit; padding: 6px; border-radius: 6px;
        color: inherit; background: transparent;
        border: 1px solid var(--dsw-alias-line-1, rgba(0,0,0,.18)); }
      .an-tip-row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
      .an-tip-row button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 6px;
        border: 1px solid var(--dsw-alias-line-1, rgba(0,0,0,.18)); }
      .an-tip-save { color: #fff; background: var(--dsw-alias-brand-primary, #4d6bfe);
        border-color: transparent !important; }
      .an-tip-save[disabled] { opacity: .4; cursor: not-allowed; }
    `;

    function installStyles() {
      const id = "dsh-annotate-css";
      if (document.getElementById(id)) return;
      const style = document.createElement("style");
      style.id = id;
      style.setAttribute("data-plugin-css", "dsh-annotate");
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // ---------------- 批注面板（原生 DOM，挂在 body 上） ----------------
    // 面板不能寄生在 conversation.input.right 里：那是输入框旁的插槽，打开右栏 /
    // 重排布局时整个插槽可能被卸载重挂，面板跟着消失，看起来就像清单被清空了。
    // 挂在 body 上，和任何插槽的生命周期彻底解耦。
    let panelEl = null;
    let btnEl = null; // 输入框旁「批注」按钮的 DOM，清单浮在它上方
    let composerSend = null; // 由输入框旁的按钮组件注册：把结构化文字写回草稿
    let sendHint = "";
    let sentBackup = null; // 刚发出去的那批，供「撤销」恢复
    const subs = new Set();

    function el(tag, cls) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      return e;
    }

    // 面板里的局部刷新：fake DOM / 老宿主没有 querySelector 时退回整块重建。
    function findIn(cls) {
      if (!panelEl || typeof panelEl.querySelector !== "function") return null;
      return panelEl.querySelector("." + cls);
    }

    function refreshFooter() {
      const chosen = list().filter((i) => i.on).length;
      const send = findIn("an-send");
      if (!send) return renderPanel();
      send.disabled = !chosen;
      send.textContent = chosen ? "发送批注（" + chosen + " 条）" : "发送批注";
      const badge = findIn("an-badge");
      if (badge) badge.textContent = list().length ? "共 " + list().length + " 条" : "";
      return null;
    }

    function renderPanel() {
      if (!document.body) return;
      if (!panelEl) {
        panelEl = el("div", "an-panel");
        panelEl.setAttribute(UI_ATTR, "");
        panelEl.addEventListener("click", onPanelClick);
        document.body.appendChild(panelEl);
      }
      if (!panelOpen) {
        panelEl.style.display = "none";
        return;
      }
      panelEl.style.display = "flex";

      // 位置跟着「批注」按钮走：贴着按钮上方展开，向上长高，绝不盖住输入框。
      // 拿不到按钮（插槽还没挂 / 已卸载）就退回右下角，功能不丢。
      const rect = btnEl && typeof btnEl.getBoundingClientRect === "function" ? btnEl.getBoundingClientRect() : null;
      if (rect && rect.height > 0) {
        panelEl.style.right = Math.max(6, window.innerWidth - rect.right) + "px";
        panelEl.style.bottom = Math.max(6, window.innerHeight - rect.top + 8) + "px";
        panelEl.style.maxHeight = Math.min(560, Math.max(140, rect.top - 16)) + "px";
      } else {
        panelEl.style.right = "14px";
        panelEl.style.bottom = "84px";
        panelEl.style.maxHeight = "min(70vh, 560px)";
      }
      panelEl.textContent = "";

      const withItems = list();
      const head = el("div", "an-head");
      const title = el("span");
      title.textContent = "批注清单";
      const count = el("span", "an-badge");
      count.textContent = withItems.length ? "共 " + withItems.length + " 条" : "";
      const close = el("button", "an-x");
      close.type = "button";
      close.textContent = "✕";
      close.title = "收起";
      close.setAttribute("aria-label", "收起批注清单");
      close.dataset.act = "close";
      head.append(title, count, close);

      const body = el("div", "an-list");
      if (!withItems.length) {
        const empty = el("div", "an-empty");
        empty.textContent = "还没有批注。选中对话里的文字，或点一下对话里的图片，再点「＋ 批注」。";
        body.append(empty);
      } else {
        for (const item of withItems) body.append(rowEl(item));
      }

      const chosen = withItems.filter((i) => i.on).length;
      const foot = el("div", "an-foot");
      const send = el("button", "an-send");
      send.type = "button";
      send.dataset.act = "send";
      send.disabled = !chosen;
      send.textContent = chosen ? "发送批注（" + chosen + " 条）" : "发送批注";
      foot.append(send);
      if (sendHint) {
        const hint = el("div", "an-hint");
        const text = el("span");
        text.textContent = sendHint;
        hint.append(text);
        if (sentBackup) {
          const undo = el("button", "an-undo");
          undo.type = "button";
          undo.dataset.act = "undo";
          undo.textContent = "撤销";
          hint.append(undo);
        }
        foot.append(hint);
      }

      panelEl.append(head, body, foot);
    }

    function rowEl(item) {
      const row = el("div", "an-row");
      row.dataset.off = item.on ? "0" : "1";
      row.dataset.id = String(item.id);

      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = item.on;
      box.dataset.act = "toggle";
      box.dataset.id = String(item.id);

      const body = el("div", "an-body");
      const meta = el("div", "an-meta");
      meta.textContent = metaText(item);
      const note = el("div", "an-note");
      note.textContent = item.note;
      body.append(meta, note);

      const del = el("button", "an-del");
      del.type = "button";
      del.title = "删除这条批注";
      del.dataset.act = "del";
      del.dataset.id = String(item.id);
      del.textContent = "✕";

      row.append(box, body, del);
      return row;
    }

    function rowOf(id) {
      if (!panelEl || typeof panelEl.querySelector !== "function") return null;
      return panelEl.querySelector('.an-row[data-id="' + id + '"]');
    }

    // 发送：只把已勾选的写回草稿；宿主明确拒绝（insertText 返回 false）时不能说成功。
    function doSend() {
      const text = buildPrompt(list());
      if (!text) return false;
      const ok = !!(composerSend && composerSend(text));
      if (ok) {
        sentBackup = list().slice();
        bucket().items = [];
        sendHint = "已插入输入框，清单已清空";
      } else {
        sendHint = "当前会话没有可写回的输入框";
      }
      notify();
      return ok;
    }

    function doUndo() {
      if (!sentBackup) return;
      bucket().items = sentBackup;
      sentBackup = null;
      sendHint = "已恢复刚发出的批注";
      notify();
    }

    function onPanelClick(e) {
      const hit = e.target instanceof Element ? e.target.closest("[data-act]") : null;
      if (!hit) return;
      const act = hit.dataset.act;
      const id = Number(hit.dataset.id);
      if (act === "close") {
        setPanelOpen(false);
        return;
      }
      if (act === "undo") {
        doUndo();
        return;
      }
      if (act === "toggle") {
        const item = list().find((i) => i.id === id);
        if (item) item.on = !item.on;
        // 勾选是最高频操作：只改这一行，别整块重建（会闪、会丢滚动位置）。
        const row = item ? rowOf(id) : null;
        if (row) {
          row.dataset.off = item.on ? "0" : "1";
          const box = row.querySelector ? row.querySelector('input[data-act="toggle"]') : null;
          if (box) box.checked = item.on;
          refreshFooter();
          for (const f of subs) f();
        } else {
          notify();
        }
        return;
      }
      if (act === "del") {
        const items = list();
        bucket().items = items.filter((i) => i.id !== id);
        const row = rowOf(id);
        if (row && bucket().items.length) {
          row.remove();
          refreshFooter();
          for (const f of subs) f();
        } else {
          notify();
        }
        return;
      }
      if (act === "send") doSend();
    }

    function notify() {
      renderPanel();
      for (const f of subs) f();
    }

    let panelOpen = false;
    function setPanelOpen(v) {
      if (panelOpen === v) return;
      panelOpen = v;
      notify();
    }

    // ---------------- 手势批注 ----------------
    // ponytail: 来源标签只认宿主自己的容器标记（右栏 dock / 右栏会话区），判不出就留
    // null。它绝不参与「能不能批注」的判断；也不能按点击 x 比例猜分栏——宽聊天窗里
    // 右侧的文字会被误标成「侧栏面板」。
    const RIGHT_SEL = "[data-sidebar-right-session], [data-dockkit-pane], [data-dockkit-float]";
    const zoneOf = (target) =>
      target && typeof target.closest === "function" && target.closest(RIGHT_SEL) ? "panel" : null;

    // 一条消息的容器：图片兜底编号要按容器内计数，否则不同消息里的第 2 张图会撞名。
    const MSG_SEL = "[data-chat-node-key], [data-chat-turn]";

    // 图片在没有 alt 时靠 src 文件名区分；连名字都没有（data: 内嵌图、粘贴的图）
    // 就退回「第 N/M 张图 · 消息键」：先数所属消息容器内的图，拿不到容器才退回整段文档。
    function imageRef(img) {
      const alt = String(img.getAttribute("alt") || "").trim();
      if (alt) return alt;
      const src = String(img.getAttribute("src") || (img.currentSrc || ""));
      if (src && src.slice(0, 5) !== "data:") {
        const tail = src.split(/[?#]/)[0].split("/").pop();
        if (tail && tail.length <= 60) return tail;
      }
      const box = typeof img.closest === "function" ? img.closest(MSG_SEL) : null;
      const scope = box && typeof box.querySelectorAll === "function" ? box : document;
      const all = scope && scope.querySelectorAll ? scope.querySelectorAll("img") : null;
      const idx = all ? Array.prototype.indexOf.call(all, img) + 1 : 0;
      if (!(idx > 0)) return "图";
      if (!box) return "第 " + idx + " 张图"; // 拿不到消息容器：退回文档级索引
      const key = box.getAttribute
        ? String(box.getAttribute("data-chat-node-key") || box.getAttribute("data-chat-turn") || "").slice(0, 12)
        : "";
      return "第 " + idx + "/" + all.length + " 张图" + (key ? " · " + key : "");
    }

    // 一次点击够不够格弹批注入口：够格返回 pending，不够格返回 null。
    // 判据只有三条，且全都要落到「有内容的东西」上：
    //   img > 输入框之外的文字选区 > iframe / canvas 预览容器。
    // zone 只影响来源标签（侧栏面板 / 对话），不参与放行判断。
    function hitAt(target, { zone, selText, selCtx, cx, cy }) {
      const img = target.closest("img");
      if (img) {
        const r = img.getBoundingClientRect();
        const x = r.width ? Math.min(1, Math.max(0, (cx - r.left) / r.width)) : 0.5;
        const y = r.height ? Math.min(1, Math.max(0, (cy - r.top) / r.height)) : 0.5;
        return { kind: zone ? "panel" : "image", ref: imageRef(img), x, y };
      }
      const editable = target.closest("input, textarea, [contenteditable='true'], [contenteditable='']");
      if (selText && !editable) {
        return { kind: zone || "text", ref: selCtx || selText, x: null, y: null };
      }
      const frame = target.closest("iframe, embed, object, canvas");
      if (frame) {
        return { kind: "panel", ref: "<" + String(frame.tagName || "").toLowerCase() + ">", x: null, y: null };
      }
      return null;
    }

    const PREVIEW_SEL = "iframe, embed, object, canvas";
    const matchesPreview = (node) => !!(node && typeof node.matches === "function" && node.matches(PREVIEW_SEL));
    const holdsPreview = (node) => {
      if (!node || node.nodeType !== 1) return false;
      if (matchesPreview(node)) return true;
      return typeof node.querySelector === "function" ? !!node.querySelector(PREVIEW_SEL) : false;
    };

    // MutationObserver 的记录值不值得重算角标：预览节点增删，或预览自身改了
    // style/class/src/data（display 切换、换页）。别的节点 class 抖动一律不算，
    // 免得流式输出时每帧都去扫全树。
    const pinSyncRelevant = (r) => {
      if (!r) return false;
      if (r.type === "attributes") return matchesPreview(r.target);
      if (r.type !== "childList") return false;
      for (const group of [r.addedNodes, r.removedNodes]) {
        for (let i = 0; i < group.length; i++) if (holdsPreview(group[i])) return true;
      }
      return false;
    };

    // 角标测试探针（installGestures 里填），只给 test/selftest.mjs 用。
    let pinsProbe = null;

    function installGestures() {
      if (document.querySelector("[data-annotate-tip]")) return;

      const tip = document.createElement("div");
      tip.className = "an-tip";
      tip.setAttribute("data-annotate-tip", "");
      tip.setAttribute(UI_ATTR, "");
      tip.style.display = "none";
      document.body.appendChild(tip);

      let pending = null;
      let anchor = { x: 0, y: 0 };

      const close = () => {
        pending = null;
        tip.style.display = "none";
        tip.textContent = "";
      };

      // 编辑卡片一律出现在锚点（「＋ 批注」按钮处）上方，横向以锚点居中；
      // 上方放不下才退回下方，全程夹在视口内。
      const place = (above) => {
        const w = tip.offsetWidth || 280;
        const hgt = tip.offsetHeight || 60;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = anchor.x - w / 2;
        left = Math.max(6, Math.min(left, vw - w - 6));
        let top = above ? anchor.y - hgt - 10 : anchor.y + 12;
        if (top < 6) top = Math.min(anchor.y + 12, vh - hgt - 6);
        if (top + hgt > vh - 6) top = Math.max(6, vh - hgt - 6);
        tip.style.left = left + "px";
        tip.style.top = top + "px";
      };

      const editor = () => {
        if (!pending) return;
        const box = document.createElement("div");
        box.className = "an-tip-card";

        const head = document.createElement("div");
        head.className = "an-tip-head";
        head.textContent =
          pending.kind === "image" ? "批注这张图" : pending.kind === "panel" ? "批注这块内容" : "批注选中的内容";

        const ref = document.createElement("div");
        ref.className = "an-tip-ref";
        ref.textContent = pending.ref || (pending.kind === "panel" ? "（点在预览 / 画布上）" : "（无可显示的原文）");

        const input = document.createElement("textarea");
        input.className = "an-tip-input";
        input.rows = 2;
        input.placeholder = "一句话：这里要怎么改？（必填）";

        const row = document.createElement("div");
        row.className = "an-tip-row";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "取消";
        cancel.onclick = close;
        const save = document.createElement("button");
        save.type = "button";
        save.className = "an-tip-save";
        save.textContent = "保存批注";
        save.disabled = true;
        const commit = () => {
          if (!input.value.trim()) return;
          pushItem(list(), { ...pending, note: input.value });
          setPanelOpen(true);
          close();
        };
        save.onclick = commit;
        input.oninput = () => {
          save.disabled = !input.value.trim();
        };
        input.onkeydown = (ev) => {
          if (ev.key === "Escape") close();
          if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) commit();
        };
        row.append(cancel, save);
        box.append(head, ref, input, row);

        tip.textContent = "";
        tip.style.visibility = "hidden";
        tip.style.display = "block";
        tip.appendChild(box);
        place(true);
        tip.style.visibility = "";
        input.focus();
      };

      const offer = (target, x, y) => {
        pending = target;
        anchor = { x: x, y: y };
        tip.textContent = "";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "an-tip-btn";
        btn.textContent = "＋ 批注";
        btn.onclick = editor;
        tip.appendChild(btn);
        tip.style.display = "block";
        place(false);
      };

      // PDF / 文档预览：指针进到 iframe（PDF 自带阅读器）里面之后，父文档收不到
      // mouseup——事件全被框架内部吃掉。所以给每块预览挂一个常驻小角标，放右下角
      // 避开阅读器顶部工具栏；点角标即批注这块预览（不挡内容，只有 22px 高）。
      let pins = [];
      let pinTick = 0;
      const previewRef = (node) => {
        const src = String(node.getAttribute("src") || node.getAttribute("data") || "");
        const tail = src.split(/[?#]/)[0].split("/").pop();
        return tail || "<" + String(node.tagName || "").toLowerCase() + ">";
      };
      // 预览尺寸一变（右栏拖宽、display 切换、标签换页）就得重算，光听 childList 会
      // 让角标浮在空白处。ResizeObserver 盯预览元素本身；观察全集（含此刻隐藏的），
      // 否则一藏就再也收不到「重新显示」的通知；只在增删时 observe/unobserve，避免
      // 反复重观察引起自触发循环。
      let ro = null;
      const tracked = new Set();
      const trackPreviews = (nodes) => {
        if (typeof ResizeObserver !== "function") return;
        if (!ro) ro = new ResizeObserver(() => schedulePins());
        const keep = new Set(nodes);
        for (const n of tracked) {
          if (keep.has(n)) continue;
          ro.unobserve(n);
          tracked.delete(n);
        }
        for (const n of keep) {
          if (tracked.has(n)) continue;
          tracked.add(n);
          ro.observe(n);
        }
      };
      const syncPins = () => {
        if (!document.querySelectorAll || !document.body) return;
        if (pinsProbe) pinsProbe.syncs += 1;
        const all = Array.prototype.slice.call(document.querySelectorAll(PREVIEW_SEL));
        trackPreviews(all);
        const live = all.filter((n) => {
          const r = n.getBoundingClientRect();
          return r.width > 80 && r.height > 80 && r.bottom > 0 && r.top < window.innerHeight;
        });
        if (live.length !== pins.length || live.some((n, i) => pins[i].node !== n)) {
          for (const p of pins) p.el.remove();
          pins = live.map((node) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "an-pin";
            b.setAttribute(UI_ATTR, "");
            b.title = "批注这块预览";
            b.textContent = "＋ 批注";
            b.onclick = (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const r = node.getBoundingClientRect();
              offer({ kind: "panel", ref: previewRef(node), x: null, y: null }, r.left + r.width / 2, r.bottom - 26);
            };
            document.body.appendChild(b);
            return { node, el: b };
          });
        }
        for (const p of pins) {
          const r = p.node.getBoundingClientRect();
          p.el.style.left = Math.max(6, r.right - (p.el.offsetWidth || 0) - 12) + "px";
          p.el.style.top = Math.max(6, r.bottom - (p.el.offsetHeight || 0) - 12) + "px";
        }
      };
      const schedulePins = () => {
        if (pinTick) return;
        pinTick = setTimeout(() => {
          pinTick = 0;
          syncPins();
        }, 60);
      };
      pinsProbe = {
        syncs: 0,
        sync: () => syncPins(),
        schedule: () => schedulePins(),
        snapshot: () =>
          pins.map((p) => ({
            tag: String(p.node.tagName || "").toLowerCase(),
            left: p.el.style.left,
            top: p.el.style.top,
          })),
      };
      syncPins();
      // 流式输出时 body 每秒变几十次；只认「预览增删」和「预览自身属性变化」，
      // 其余记录直接跳过（60ms 节流仍在，不会退化成每帧全量扫描）。
      const mo =
        typeof MutationObserver === "function"
          ? new MutationObserver((records) => {
              for (const r of records) {
                if (pinSyncRelevant(r)) {
                  schedulePins();
                  return;
                }
              }
            })
          : null;
      if (mo) {
        mo.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["style", "class", "hidden", "src", "data"],
        });
      }
      if (window.addEventListener) window.addEventListener("resize", schedulePins);
      document.addEventListener("scroll", schedulePins, true);

      // 选中文字时把前后各 20 字一起带上：长文档里同一句话可能出现很多次。
      const selectionRef = (sel, selText) => {
        try {
          if (!sel.rangeCount) return selText;
          const range = sel.getRangeAt(0);
          const node = range.startContainer;
          if (!node || node.nodeType !== 3 || typeof node.data !== "string") return selText;
          const before = node.data.slice(Math.max(0, range.startOffset - CTX_CHARS), range.startOffset).trim();
          // 跨文本节点时 endOffset 属于 endContainer，拿它切 startContainer 会拼进无关文字。
          const after =
            range.endContainer === range.startContainer
              ? node.data.slice(range.endOffset, range.endOffset + CTX_CHARS).trim()
              : "";
          const text = selText;
          return (before ? before + " … " : "") + text + (after ? " … " + after : "");
        } catch {
          return selText;
        }
      };

      // 只有真的点到「有内容的东西」才给批注入口（判据见 hitAt）。
      // 其它一律不弹——尤其是右半边的空白处。
      const onUp = (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target || target.closest("[" + UI_ATTR + "]")) return;

        const sel = window.getSelection();
        const selText = sel && sel.rangeCount ? String(sel).trim() : "";
        const hit = hitAt(target, {
          zone: zoneOf(target),
          selText,
          selCtx: selText ? selectionRef(sel, selText) : "",
          cx: e.clientX,
          cy: e.clientY,
        });
        if (!hit) {
          close();
          return;
        }
        offer(hit, e.clientX, e.clientY);
      };

      const onDown = (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (target && target.closest("[" + UI_ATTR + "]")) return;
        close();
      };

      const onKey = (e) => {
        if (e.key !== "Escape") return;
        // Esc 先收起浮层，浮层没开时再收面板——键盘用户不能只能靠点 ✕。
        if (pending || tip.style.display === "block") {
          close();
          return;
        }
        if (panelOpen) setPanelOpen(false);
      };

      document.addEventListener("mouseup", onUp, true);
      document.addEventListener("mousedown", onDown, true);
      document.addEventListener("keydown", onKey, true);

      return () => {
        document.removeEventListener("mouseup", onUp, true);
        document.removeEventListener("mousedown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("scroll", schedulePins, true);
        if (window.removeEventListener) window.removeEventListener("resize", schedulePins);
        if (mo) mo.disconnect();
        if (ro) {
          ro.disconnect();
          ro = null;
        }
        tracked.clear();
        pinsProbe = null;
        if (pinTick) clearTimeout(pinTick);
        for (const p of pins) p.el.remove();
        pins = [];
        tip.remove();
      };
    }

    // ---------------- 输入框旁的开关按钮 ----------------
    function useItems() {
      const [, force] = useState(0);
      useEffect(() => {
        const rerender = () => force((n) => n + 1);
        subs.add(rerender);
        return () => subs.delete(rerender);
      }, []);
      return list();
    }

    function AnnotateButton(props) {
      const items = useItems();
      const draft = String(props?.useInput?.((s) => s?.draft) ?? "");
      const draftRev = props?.useInput?.((s) => s?.draftRev);
      const actions = props?.inputActions;

      // 清单属于会话，不属于布局：换会话就换一份清单。
      useEffect(() => {
        const id = typeof props?.sessionId === "string" ? props.sessionId.trim() : "";
        if (id !== currentSession) {
          currentSession = id;
          sentBackup = null;
          sendHint = "";
          notify();
        }
      }, [props?.sessionId]);

      // 面板挂在 body 上，拿不到插槽 props：把「写回草稿」这个能力登记出去。
      useEffect(() => {
        const mine = (text) => {
          const cur = String(draft || "").replace(/\s+$/, "");
          const next = cur ? cur + "\n\n" + text : text;
          // 先走 insertText：它能判成败（revision 漂移返回 false），失败会如实显示。
          // 注：整段替换纯文本，草稿里已有的 chip / 引用会被一并替换掉——与原先 setDraft
          // 的行为一致，要保 chip 得宿主另给引用级 API。setDraft 返回 void、失败也不吭声，
          // 只作为没有 insertText 时的退路。
          if (typeof actions?.insertText === "function") {
            const end = String(draft || "").length;
            return actions.insertText(next, { start: 0, end, draftRev }) !== false;
          }
          if (typeof actions?.setDraft === "function") {
            actions.setDraft(next);
            return true;
          }
          return false;
        };
        composerSend = mine;
        return () => {
          if (composerSend === mine) composerSend = null;
        };
      }, [draft, draftRev, actions]);

      return h(
        "button",
        {
          type: "button",
          className: "an-btn",
          title: "批注：选中文字或点图片，指出成品哪里要改",
          "data-on": panelOpen ? "1" : "0",
          ref: (node) => {
            if (node) btnEl = node; // 清单浮在这个按钮上方
          },
          onClick: () => setPanelOpen(!panelOpen),
        },
        "批注",
        items.length ? h("span", { className: "an-badge" }, String(items.length)) : null,
      );
    }

    // ---------------- 入口 ----------------
    let teardown = null;

    function apply(ctx) {
      installStyles();
      renderPanel();
      teardown = installGestures();
      // 窗口尺寸变了，清单要重新贴到「批注」按钮上方（它自己不会跟着走）。
      const replace = () => {
        if (panelOpen) renderPanel();
      };
      if (window.addEventListener) window.addEventListener("resize", replace);
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: 60, label: "批注" }, AnnotateButton),
      );
      ctx.on("dispose", () => {
        if (teardown) teardown();
        teardown = null;
        if (window.removeEventListener) window.removeEventListener("resize", replace);
        if (panelEl) panelEl.remove();
        panelEl = null;
        btnEl = null;
        // 样式标签是插件自己插进 head 的，卸载/热重载时要一起清掉，否则旧 CSS 一直留着。
        const css = document.getElementById("dsh-annotate-css");
        if (css) css.remove();
        subs.clear();
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    // 自测入口：只给 test/selftest.mjs 用，宿主不会读。
    exports.__test = {
      pushItem,
      buildPrompt,
      KIND_LABEL,
      hitAt,
      imageRef,
      zoneOf,
      pinSyncRelevant,
      pins() {
        return pinsProbe;
      },
      renderPanel,
      setPanelOpen,
      doSend,
      doUndo,
      hasBackup: () => sentBackup !== null,
      setComposer(fn) {
        composerSend = fn;
      },
      setSession(id) {
        currentSession = String(id == null ? "" : id);
      },
      reset() {
        buckets.clear();
        sentBackup = null;
        sendHint = "";
        currentSession = "";
      },
      setItems(v) {
        bucket().items = v;
      },
      getItems() {
        return list();
      },
    };

    return module.exports;
  },
});
