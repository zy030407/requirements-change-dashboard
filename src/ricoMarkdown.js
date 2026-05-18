import MarkdownIt from "markdown-it";

const ricoMd = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false
});

ricoMd.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const href = token.attrGet("href") || "";

  if (href.startsWith("wiki:")) {
    token.attrSet("href", "#");
    token.attrSet("data-wiki-target", safeDecode(href.slice(5)));
    token.attrJoin("class", "wiki-internal-link");
    removeAttr(token, "target");
    removeAttr(token, "rel");
    return self.renderToken(tokens, index, options);
  }

  if (href.startsWith("wiki-missing:")) {
    token.attrSet("href", "#");
    token.attrSet("data-wiki-missing", safeDecode(href.slice(13)));
    token.attrJoin("class", "wiki-missing-link");
    removeAttr(token, "target");
    removeAttr(token, "rel");
    return self.renderToken(tokens, index, options);
  }

  token.attrSet("target", "_blank");
  token.attrSet("rel", "noreferrer");
  return self.renderToken(tokens, index, options);
};

ricoMd.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index];
  token.attrSet("loading", "lazy");
  return self.renderToken(tokens, index, options);
};

ricoMd.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = token.info ? ricoMd.utils.escapeHtml(token.info.trim().split(/\s+/)[0]) : "";
  const code = ricoMd.utils.escapeHtml(token.content);

  if (language.toLowerCase() === "mermaid") {
    return [
      '<section class="rico-diagram-block">',
      '<div class="rico-diagram-head"><span>结构图</span><small>Mermaid</small></div>',
      `<div class="rico-mermaid">${code}</div>`,
      "</section>"
    ].join("");
  }

  return `<section class="rico-code-block"${language ? ` data-language="${language}"` : ""}><pre><code>${code}</code></pre></section>`;
};

export function renderRicoMarkdown(markdown = "") {
  const normalized = preprocessMarkdown(markdown);
  return ricoMd.render(normalized);
}

function preprocessMarkdown(content) {
  return String(content || "")
    .replace(/^(\s*(?:\d+\.|-|\*)\s+[^:\n]+)\n\s*:\s*(.+?)$/gm, "$1: $2")
    .replace(/^(\s*(?:\d+\.|-|\*)\s+.+?:)\s*\n\s+(.+?)$/gm, "$1 $2")
    .replace(/^(\s*(?:\d+\.|-|\*)\s+[^:\n]+)\n:\s*(.+?)$/gm, "$1: $2")
    .replace(/^(\s*(?:\d+\.|-|\*)\s+.+?)\n\n\s+(.+?)$/gm, "$1 $2");
}

function removeAttr(token, name) {
  const index = token.attrIndex(name);
  if (index >= 0) token.attrs.splice(index, 1);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
