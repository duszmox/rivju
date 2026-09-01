import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '#/lib/utils.ts'
import type { Node, Parent, Root } from 'mdast'

/**
 * Renders untrusted GitLab-authored markdown (MR descriptions, notes).
 *
 * Raw HTML is deliberately not enabled — `rehype-raw` would let a merge request
 * author inject markup into the app shell. react-markdown's default URL
 * transform also drops `javascript:` hrefs, so links stay inert.
 *
 * `baseUrl` matters more than it looks: GitLab stores description links and
 * `/uploads/...` attachments relative to the project, and the packaged renderer
 * runs on `file://`, where every relative URL resolves to nothing. Passing the
 * merge request's `webUrl` rewrites them back to the GitLab instance.
 */
export function Markdown({
  value,
  baseUrl,
  className,
}: {
  value: string
  baseUrl?: string
  className?: string
}) {
  const absolute = (url: string | undefined) => {
    if (!url || !baseUrl) return url
    try {
      return new URL(url, baseUrl).href
    } catch {
      return url
    }
  }

  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none prose-headings:text-(--sea-ink) prose-p:text-(--sea-ink) prose-li:text-(--sea-ink) prose-strong:text-(--sea-ink) prose-a:text-(--lagoon-deep) prose-code:text-(--sea-ink) prose-code:before:content-none prose-code:after:content-none',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkStripHtmlComments]}
        components={{
          // `node` is react-markdown's internal mdast handle; spreading it onto
          // the element would emit a literal node="[object Object]" attribute.
          a: ({ node: _node, href, children, ...rest }) => (
            <a
              {...rest}
              href={absolute(href)}
              target="_blank"
              rel="noreferrer noopener"
            >
              {children}
            </a>
          ),
          img: ({ node: _node, src, alt, ...rest }) => (
            <img
              {...rest}
              src={typeof src === 'string' ? absolute(src) : src}
              alt={alt ?? ''}
            />
          ),
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  )
}

/** A closed comment, including the malformed-but-common `<!--- … -->`. */
const CLOSED_COMMENT = /<!--[\s\S]*?-->/g
/** `<!-->`, `<!--->`, and comments the author never closed. */
const DANGLING_COMMENT = /<!--(?:-?>|[\s\S]*$)/

/**
 * Drops HTML comments from the tree.
 *
 * MR templates are largely comments ("<!-- describe your change -->"), and with
 * raw HTML disabled those would otherwise render as visible escaped text.
 * Stripping on the mdast tree rather than the source string leaves comments
 * inside fenced or inline code alone — this app reviews diffs, so a literal
 * `<!-- -->` in a code sample has to survive.
 */
function remarkStripHtmlComments() {
  return (tree: Root) => stripComments(tree)
}

function stripComments(node: Node): void {
  const parent = node as Parent
  if (!Array.isArray(parent.children)) return
  parent.children = parent.children.filter((child) => {
    if (child.type !== 'html') {
      stripComments(child)
      return true
    }
    child.value = child.value
      .replace(CLOSED_COMMENT, '')
      .replace(DANGLING_COMMENT, '')
    return child.value.trim() !== ''
  })
}
