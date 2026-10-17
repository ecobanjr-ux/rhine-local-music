/** Archive fields are plain text, including inside HTML attributes. */
export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/**
 * 封面格：有**同源**地址就画 `<img loading="lazy">`，没有就画既有占位。
 * 放在这里是因为它有两处调用方（专辑架 / 搜索结果行在 music-app，歌单与音乐人组的面板行在
 * playlists-ui），而"没有封面就画占位、绝不按 id 造一个会 404 的 URL"这条判据（F3）只该有一个出处。
 * 传进来的 url 只可能是同源的（第三方地址从不出服务端），这里不做第二次校验。
 */
export function coverImage(url: string, alt: string, className = "") {
  return url
    ? `<img class="${className}" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy">`
    : `<span class="cover-placeholder">♪</span>`;
}
