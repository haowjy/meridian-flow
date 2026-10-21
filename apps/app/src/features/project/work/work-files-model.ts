/** The Work Files tab's pure rules: name search. */
export type WorkFileSearch = (name: string) => boolean;

export function workFileSearch(search: string): WorkFileSearch {
  const query = search.trim().toLowerCase();
  return (name) => !query || name.toLowerCase().includes(query);
}
