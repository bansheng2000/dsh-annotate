/**
 * dsh-annotate 宿主侧：只负责被 loader 加载成一个合法插件条目。
 * 所有功能都在客户端（lib/client.js）：批注是纯粹的前端交互，没有服务端状态、
 * 没有路由、没有落盘——批注只在内存里活着，发出去就只是输入框里的一段文字。
 */

const name = "dsh-annotate";

const inject = [];

export { name, inject };

export function apply() {}
