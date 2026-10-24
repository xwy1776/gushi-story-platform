/**
 * 段落文本采样工具（C4-② 图文对齐配套）
 *
 * 场景提取 / 场景状态更新都会把段落文本送入 LLM，此前用 `slice(0, N)` 只截头部：
 * 段落超长时，后半部分（常常是动作高潮/关键转折）被整段丢弃，属于"图片内容与
 * 正文不符"的一个直接来源。改为超限时**头 + 尾采样**，兼顾开场与收尾。
 *
 * 纯函数、零依赖，便于单测。
 */

/**
 * 采样段落文本：不超限原样返回；超限时返回 头部 + 省略标记 + 尾部。
 * 头部保留 maxChars - 500 字符（至少 200），尾部保留 400 字符——
 * 关键画面常出现在段尾（高潮/转折），必须保留。
 */
export function sampleSegmentText(text: string, maxChars = 1500): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  if (text.length <= maxChars) return text;

  const tailChars = Math.min(400, Math.floor(maxChars / 3));
  const headChars = Math.max(200, maxChars - tailChars - 100);
  return `${text.slice(0, headChars)}\n……（中间省略）……\n${text.slice(-tailChars)}`;
}
