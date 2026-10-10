const MarkdownModule = require('markdown-it');
const sanitizeHtml = require('sanitize-html');
const MarkdownIt = MarkdownModule.default ?? MarkdownModule;

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
markdown.validateLink = (value) => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
};

function renderContent(body = '') {
  return sanitizeHtml(markdown.render(body), {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'em', 's',
      'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'img',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    allowedAttributes: { a: ['href', 'title', 'rel'], img: ['src', 'alt', 'title'], ol: ['start'] },
    allowedSchemes: ['http', 'https'],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attributes) => ({ tagName, attribs: { ...attributes, rel: 'noopener noreferrer' } }),
    },
  });
}

module.exports = { renderContent };
