import type { ReactNode } from 'react';
import { DOC_CONTENT, type Block } from './content';
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

/** One docs page: title, lead and body, from `DOC_CONTENT` (the same data /llms-full.txt is built from). */
export function DocArticle({ slug }: { slug: DocSlug }) {
  const page = docPage(slug)!;
  const body = DOC_CONTENT[slug];
  return (
    <>
      <H1>{page.title}</H1>
      {body.updated ? (
        <p className="mt-2 text-caption text-mute">
          Last updated: {body.updated}
        </p>
      ) : null}
      <Lead>
        <Inline text={body.lead} />
      </Lead>
      {body.blocks.map(renderBlock)}
    </>
  );
}
