export function generateStorageKey(source: string, id: string): string {
  return `${source}+${id}`;
}

export function splitStorageKey(key: string): [source: string, id: string] {
  const separator = key.indexOf('+');
  if (separator === -1) return [key, ''];
  return [key.slice(0, separator), key.slice(separator + 1)];
}
