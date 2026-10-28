import type { ReactNode } from 'react';
import { inlineText } from '@/lib/docs/inline';
import { DOC_CONTENT, docOutline, type Block } from './content';
import { docPage, type DocSlug } from './pages';
import { H1, H2, H3, Inline, Lead, Note, OL, P, Pre, Table, UL } from './Prose';

function renderBlock(b: Block, i: number): ReactNode {
  switch (b.t) {
    case 'h2':
      return (
        <H2 key={i} id={b.id}>
          <Inline text={b.text} />
        </H2>
      );
    case 'h3':
      return (
        <H3 key={i} id={b.id}>
          <Inline text={b.text} />
        </H3>
      );
    case 'p':
      return (
        <P key={i}>
          <Inline text={b.text} />
        </P>
      );
    case 'ul':
    case 'ol': {
      const List = b.t === 'ul' ? UL : OL;
      return (
        <List key={i}>
          {b.items.map((it, j) => (
            <li key={j}>
              <Inline text={it} />
            </li>
          ))}
        </List>
      );
    }
    case 'code':
      return (
        <Pre key={i} label={b.label}>
          {b.code}
        </Pre>
      );
    case 'table':
      return <Table key={i} head={b.head} numeric={b.numeric} rows={b.rows.map((r) => r.map((c, j) => <Inline key={j} text={c} />))} />;
    case 'note':
      return (
        <Note key={i}>
          <Inline text={b.text} />
        </Note>
      );
  }
}

/** "On this page": the page's sections, in a sticky rail beside the text on wide screens. */
function Outline({ slug }: { slug: DocSlug }) {
  const items = docOutline(slug);
  if (items.length < 3) return null;
  return (
    <nav aria-label="On this page" className="hidden xl:sticky xl:top-20 xl:block xl:self-start">
      <div className="px-2.5 pb-1 text-caption text-mute">On this page</div>
      <ul className="flex flex-col">
        {items.map((it) => (
          <li key={it.id}>
            <a href={`#${it.id}`} className="block rounded-sm px-2.5 py-1 text-sm text-mute transition-colors duration-150 hover:text-ink">
              {inlineText(it.text)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** One docs page: title, lead and body, from `DOC_CONTENT` (the same data /llms-full.txt is built from). */
export function DocArticle({ slug }: { slug: DocSlug }) {
  const page = docPage(slug)!;
  const body = DOC_CONTENT[slug];
  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,720px)_200px] xl:gap-10">
      <article className="min-w-0 max-w-[720px] pb-8">
        <H1>{page.title}</H1>
        {body.updated ? <p className="mt-2 text-caption text-mute">Last updated: {body.updated}</p> : null}
        <Lead>
          <Inline text={body.lead} />
        </Lead>
        {body.blocks.map(renderBlock)}
      </article>
      <Outline slug={slug} />
    </div>
  );
}
