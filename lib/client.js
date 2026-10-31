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

    // ---------------- 数据 ----------------
    // 极简扁平：{ id, kind, ref, x, y, note, on }。x/y 只有 kind=image 才有意义。
    // 全部放在模块作用域：不挂在任何 React 组件的 state 上，右栏开合 / 输入框插槽
    // 卸载重挂 / 会话重渲染都不会动到这份清单。
    let seq = 0;
    let items = [];
    let panelOpen = false;
    let sendHint = "";
    const subs = new Set();

    const KIND_LABEL = { text: "对话文字", image: "对话图片", panel: "侧栏面板" };

    function pushItem(list, { kind, ref, x, y, note }) {
      const text = String(note == null ? "" : note).trim();
      if (!text) return list; // 没有要求就没有批注
      list.push({
        id: ++seq,
        kind: KIND_LABEL[kind] ? kind : "text",
        ref: String(ref == null ? "" : ref).trim(),
        x: x == null ? null : x,
        y: y == null ? null : y,
        note: text,
        on: true,
      });
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

      .an-panel {
        position: fixed; right: 14px; bottom: 84px; z-index: 9999;
        width: 320px; max-height: min(70vh, 560px); display: flex; flex-direction: column;
        border-radius: 10px; overflow: hidden; font-size: 12px;
        color: var(--dsw-alias-label-primary, #1f1f1f);
        background: var(--dsw-alias-bg-elevated, #fff);
        border: 1px solid var(--dsw-alias-line-1, rgba(0,0,0,.14));
        box-shadow: 0 10px 30px rgba(0,0,0,.16);
      }

      /* PDF / 文档预览的常驻角标：指针进到 iframe 里之后父文档收不到 mouseup，
         只能靠这块小按钮进批注（不挡 PDF 自己的滚动，只有 24px 宽）。 */
      .an-pin {
        all: unset; position: fixed; z-index: 9998; cursor: pointer;
        height: 22px; padding: 0 8px; border-radius: 6px;
        font-size: 11px; line-height: 22px; opacity: .7; user-select: none;
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
      .an-hint { margin-top: 6px; font-size: 11px; opacity: .6; }

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
      .an-tip-ref { opacity: .6; font-size: 11px; margin-bottom: 6px; max-height: 32px;
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

    function el(tag, cls) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      return e;
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

      const head = el("div", "an-head");
      const title = el("span");
      title.textContent = "批注清单";
      const count = el("span", "an-badge");
      count.textContent = items.length ? "共 " + items.length + " 条" : "";
      const close = el("button", "an-x");
      close.type = "button";
      close.textContent = "✕";
      close.title = "收起";
      close.dataset.act = "close";
      head.append(title, count, close);

      const list = el("div", "an-list");
      if (!items.length) {
        const empty = el("div", "an-empty");
        empty.textContent = "还没有批注。选中对话里的文字，或点一下对话里的图片，再点「＋ 批注」。";
        list.append(empty);
      } else {
        for (const item of items) list.append(rowEl(item));
      }

      const foot = el("div", "an-foot");
      const chosen = items.filter((i) => i.on).length;
      const send = el("button", "an-send");
      send.type = "button";
      send.dataset.act = "send";
      send.disabled = !chosen;
      send.textContent = chosen ? "发送批注（" + chosen + " 条）" : "发送批注";
      foot.append(send);
      if (sendHint) {
        const hint = el("div", "an-hint");
        hint.textContent = sendHint;
        foot.append(hint);
      }

      panelEl.append(head, list, foot);
    }

    function rowEl(item) {
      const row = el("div", "an-row");
      row.dataset.off = item.on ? "0" : "1";

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

    function onPanelClick(e) {
      const hit = e.target instanceof Element ? e.target.closest("[data-act]") : null;
      if (!hit) return;
      const act = hit.dataset.act;
      const id = Number(hit.dataset.id);
      if (act === "close") {
        setPanelOpen(false);
        return;
      }
      if (act === "toggle") {
        const item = items.find((i) => i.id === id);
        if (item) item.on = !item.on;
        notify();
        return;
      }
      if (act === "del") {
        items = items.filter((i) => i.id !== id);
        notify();
        return;
      }
      if (act === "send") {
        const text = buildPrompt(items);
        if (!text) return;
        sendHint = composerSend && composerSend(text) ? "已插入输入框" : "当前会话没有可写回的输入框";
        notify();
        setTimeout(() => {
          sendHint = "";
          renderPanel();
        }, 2500);
      }
    }

    function notify() {
      renderPanel();
      for (const f of subs) f();
    }

    function setPanelOpen(v) {
      if (panelOpen === v) return;
      panelOpen = v;
      notify();
    }

    // ---------------- 手势批注 ----------------
    // ponytail: 「侧栏面板 / 对话」只用来给批注打来源标签（宿主没暴露右栏的 DOM
    // 钩子）。它绝不参与「能不能批注」的判断——否则右半边任何空白点击都会冒批注。
    const PANEL_SPLIT = 0.62;
    const zoneOf = (e) => (e.clientX / window.innerWidth > PANEL_SPLIT ? "panel" : null);

    // 一次点击够不够格弹批注入口：够格返回 pending，不够格返回 null。
    // 判据只有三条，且全都要落到「有内容的东西」上：
    //   img > 输入框之外的文字选区 > iframe / canvas 预览容器。
    // zone 只影响来源标签（侧栏面板 / 对话），不参与放行判断。
    function hitAt(target, { zone, selText, cx, cy }) {
      const img = target.closest("img");
      if (img) {
        const r = img.getBoundingClientRect();
        const x = r.width ? Math.min(1, Math.max(0, (cx - r.left) / r.width)) : 0.5;
        const y = r.height ? Math.min(1, Math.max(0, (cy - r.top) / r.height)) : 0.5;
        return { kind: zone ? "panel" : "image", ref: img.getAttribute("alt") || "", x, y };
      }
      const editable = target.closest("input, textarea, [contenteditable='true'], [contenteditable='']");
      if (selText && !editable) return { kind: zone || "text", ref: selText, x: null, y: null };
      const frame = target.closest("iframe, embed, object, canvas");
      if (frame) {
        return { kind: "panel", ref: "<" + String(frame.tagName || "").toLowerCase() + ">", x: null, y: null };
      }
      return null;
    }

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
          pushItem(items, { ...pending, note: input.value });
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
      // mouseup——事件全被框架内部吃掉。所以给每块预览挂一个常驻小角标，
      // 点角标即批注这块预览（不挡 PDF 自己滚动，只有 22px 宽）。
      let pins = [];
      let pinTick = 0;
      const previewRef = (node) => {
        const src = String(node.getAttribute("src") || node.getAttribute("data") || "");
        const tail = src.split(/[?#]/)[0].split("/").pop();
        return tail || "<" + String(node.tagName || "").toLowerCase() + ">";
      };
      const syncPins = () => {
        if (!document.querySelectorAll || !document.body) return;
        const all = Array.prototype.slice.call(document.querySelectorAll("iframe, embed, object"));
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
              offer({ kind: "panel", ref: previewRef(node), x: null, y: null }, r.left + r.width / 2, r.top + 26);
            };
            document.body.appendChild(b);
            return { node, el: b };
          });
        }
        for (const p of pins) {
          const r = p.node.getBoundingClientRect();
          p.el.style.left = Math.max(6, r.right - p.el.offsetWidth - 10) + "px";
          p.el.style.top = Math.max(6, r.top + 10) + "px";
        }
      };
      const schedulePins = () => {
        if (pinTick) return;
        pinTick = setTimeout(() => {
          pinTick = 0;
          syncPins();
        }, 60);
      };
      syncPins();
      const mo = typeof MutationObserver === "function" ? new MutationObserver(schedulePins) : null;
      if (mo) mo.observe(document.body, { childList: true, subtree: true });
      if (window.addEventListener) window.addEventListener("resize", schedulePins);
      document.addEventListener("scroll", schedulePins, true);

      // 只有真的点到「有内容的东西」才给批注入口（判据见 hitAt）。
      // 其它一律不弹——尤其是右半边的空白处。
      const onUp = (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target || target.closest("[" + UI_ATTR + "]")) return;

        const sel = window.getSelection();
        const selText = sel && sel.rangeCount ? String(sel).trim() : "";
        const hit = hitAt(target, { zone: zoneOf(e), selText, cx: e.clientX, cy: e.clientY });
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
        if (e.key === "Escape") close();
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
      return items;
    }

    function AnnotateButton(props) {
      const list = useItems();
      const draft = String(props?.useInput?.((s) => s?.draft) ?? "");
      const draftRev = props?.useInput?.((s) => s?.draftRev);
      const actions = props?.inputActions;

      // 面板挂在 body 上，拿不到插槽 props：把「写回草稿」这个能力登记出去。
      useEffect(() => {
        const mine = (text) => {
          const cur = String(draft || "").replace(/\s+$/, "");
          const next = cur ? cur + "\n\n" + text : text;
          if (actions?.setDraft) {
            actions.setDraft(next);
            return true;
          }
          if (actions?.insertText) {
            actions.insertText(next, { start: 0, end: String(draft || "").length, draftRev });
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
        list.length ? h("span", { className: "an-badge" }, String(list.length)) : null,
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
      renderPanel,
      setPanelOpen,
      reset() {
        items = [];
        seq = 0;
      },
      setItems(v) {
        items = v;
      },
      getItems() {
        return items;
      },
    };

    return module.exports;
  },
});
