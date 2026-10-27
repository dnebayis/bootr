export const OPEN_SEARCH_EVENT = 'bootr:open-search';

export function openSearch(query = '') {
  window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT, { detail: { query } }));
}
